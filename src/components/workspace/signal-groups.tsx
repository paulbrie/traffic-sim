"use client";

import { ArrowDown, ArrowUp, Link2Off, Trash2, Waves } from "lucide-react";
import { useSubject } from "subjecto/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CNode, Compiled, SignalPlan } from "@/engine/compile";
import { junctionRefs } from "@/engine/refs";
import { greenWaveOffsets } from "@/engine/signals";
import type { Network, NodeDef, SignalGroup } from "@/engine/types";
import { simController } from "@/state/sim-controller";
import { commit, select, stats$ } from "@/state/store";
import * as ops from "@/state/ops";
import { NumberField, Section, compass } from "./fields";

const NEW = "__new__", NONE = "__none__";

/** phase label from the directions its approaches come from, e.g. "N + S" */
export const phaseName = (cn: CNode, p: number) =>
  cn.phases[p]?.length ? cn.phases[p].map(i => compass(cn.arms[i].u.x, cn.arms[i].u.y).name).join(" + ") : "All red";

/**
 * Coordination of a traffic-light junction with others: pick or create a group, then set which
 * phase is coordinated, its share of green and its offset. The whole group (cycle, speed, order,
 * green wave) is edited here too, since it is only ever reached through one of its junctions.
 */
export function SignalGroupSection({ net, node }: { net: Network; node: NodeDef }) {
  const c = simController.compiled;
  const cn = c.nodeById.get(node.id);
  if (!cn || node.control !== "lights" || cn.phases.length < 2) return null;
  const group = ops.groupOf(net, node.id);
  const groups = net.signalGroups ?? [];
  const onPick = (v: string) => {
    if (v === NONE) commit(ops.leaveGroup(net, node.id));
    else commit(ops.joinGroup(net, node.id, v === NEW ? null : v)[0]);
  };
  return (
    <Section title="Coordination">
      <Select value={group?.id ?? NONE} onValueChange={onPick}>
        <SelectTrigger className="w-full" aria-label="Signal group"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>Runs on its own</SelectItem>
          {groups.map(g => <SelectItem key={g.id} value={g.id}>{g.name} ({g.members.length})</SelectItem>)}
          <SelectItem value={NEW}>+ New signal group</SelectItem>
        </SelectContent>
      </Select>
      {!group ? (
        <p className="text-xs text-muted-foreground">Put neighbouring lights in the same group to run them on one cycle, with offsets between them so traffic meets green after green.</p>
      ) : <GroupEditor net={net} node={node} cn={cn} group={group} compiled={c} />}
    </Section>
  );
}

function GroupEditor({ net, node, cn, group, compiled }: { net: Network; node: NodeDef; cn: CNode; group: SignalGroup; compiled: Compiled }) {
  useSubject(stats$); // keep the "now" marker moving while traffic runs
  const refs = junctionRefs(compiled);
  const me = group.members.find(m => m.node === node.id)!;
  const idx = group.members.indexOf(me);
  const plan = cn.coord;
  const wave = greenWaveOffsets(compiled, group);
  const now = simController.sim ? simController.sim.time : null;
  return (
    <div className="grid gap-3">
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <label className="grid gap-1 text-xs text-muted-foreground">
          Group name
          <Input className="h-8 text-sm text-foreground" defaultValue={group.name} key={group.id + group.name}
            onBlur={e => { const v = e.currentTarget.value.trim(); if (v && v !== group.name) commit(ops.updateGroup(net, group.id, { name: v.slice(0, 80) })); }}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        </label>
        <Button variant="ghost" size="icon-sm" aria-label="Delete group" title="Delete the group (its lights go back to running on their own)" onClick={() => commit(ops.deleteGroup(net, group.id))}><Trash2 /></Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField id="g-cycle" label="Cycle (whole group)" unit="s" value={group.cycle} min={20} max={240} step={5} digits={0} onCommit={v => commit(ops.updateGroup(net, group.id, { cycle: Math.round(v) }), `gc:${group.id}`)} />
        <NumberField id="g-speed" label="Wave speed" unit="km/h" value={group.speed} min={10} max={130} step={5} digits={0} onCommit={v => commit(ops.updateGroup(net, group.id, { speed: v }), `gs:${group.id}`)} />
      </div>

      <div className="grid gap-2 rounded-md border p-2.5">
        <div className="text-sm">This junction <span className="text-muted-foreground">({refs.get(node.id) ?? "?"}, #{idx + 1} in the corridor)</span></div>
        <label className="grid gap-1 text-xs text-muted-foreground">
          Coordinated phase
          <Select value={String(me.phase)} onValueChange={v => commit(ops.updateMember(net, node.id, { phase: Number(v) }))}>
            <SelectTrigger size="sm" className="w-full text-foreground" aria-label="Coordinated phase"><SelectValue /></SelectTrigger>
            <SelectContent>{cn.phases.map((_, p) => <SelectItem key={p} value={String(p)}>From {phaseName(cn, p)}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="m-offset" label="Offset" unit="s" value={me.offset} min={0} max={group.cycle} step={1} digits={0} onCommit={v => commit(ops.updateMember(net, node.id, { offset: v }), `mo:${node.id}`)} />
          <NumberField id="m-share" label="Its share of green" unit="%" value={Math.round(me.share * 100)} min={20} max={85} step={5} digits={0} onCommit={v => commit(ops.updateMember(net, node.id, { share: v / 100 }), `ms:${node.id}`)} />
        </div>
        {plan && (
          <p className="text-xs text-muted-foreground">
            Green {plan.seq[0].green.toFixed(0)} s for {phaseName(cn, plan.seq[0].phase)}, then {plan.seq.slice(1).map(s => `${s.green.toFixed(0)} s for ${phaseName(cn, s.phase)}`).join(", ")}; {plan.yellow} s yellow + {plan.allRed} s all red after each.
            {plan.stretched ? ` The cycle is too short for ${cn.phases.length} phases here: this junction runs ${plan.stretched.toFixed(0)} s and drifts out of sync.` : ""}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-7" disabled={idx === 0} onClick={() => commit(ops.moveMember(net, node.id, -1))}><ArrowUp /> Earlier</Button>
          <Button size="sm" variant="outline" className="h-7" disabled={idx === group.members.length - 1} onClick={() => commit(ops.moveMember(net, node.id, 1))}><ArrowDown /> Later</Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => commit(ops.leaveGroup(net, node.id))}><Link2Off /> Leave group</Button>
        </div>
      </div>

      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">Corridor, in driving order</span>
          <Button size="sm" variant="secondary" className="h-7" disabled={group.members.length < 2}
            title="Set every offset from the driving time between junctions at the wave speed"
            onClick={() => commit(ops.applyGreenWave(net, compiled, group.id))}><Waves /> Green wave</Button>
        </div>
        <Timeline group={group} compiled={compiled} refs={refs} current={node.id} now={now} gaps={wave.gaps} />
        <p className="text-[11px] text-muted-foreground">
          Bars show one cycle per junction: green is the coordinated phase. With Green wave, each green starts when a car leaving the previous junction at the start of its green arrives at {group.speed.toFixed(0)} km/h. Traffic in the opposite direction gets the wave only if the spacing happens to suit it.
        </p>
      </div>
    </div>
  );
}

/** one row per junction over a single cycle: coordinated green, other greens, yellow / all red */
function Timeline({ group, compiled, refs, current, now, gaps }: {
  group: SignalGroup; compiled: Compiled; refs: Map<string, string>; current: string; now: number | null; gaps: (number | null)[];
}) {
  const W = 240, row = 16, C = group.cycle;
  const x = (t: number) => (t / C) * W;
  return (
    <div className="grid gap-1">
      {group.members.map((m, i) => {
        const cn = compiled.nodeById.get(m.node), plan: SignalPlan | null = cn?.coord ?? null;
        const segs: { a: number; b: number; kind: "main" | "other" | "amber" }[] = [];
        if (plan) {
          let t = plan.offset;
          plan.seq.forEach((s, k) => {
            segs.push({ a: t, b: t + s.green, kind: k === 0 ? "main" : "other" }); t += s.green;
            segs.push({ a: t, b: t + plan.yellow + plan.allRed, kind: "amber" }); t += plan.yellow + plan.allRed;
          });
        }
        // wrap segments into [0, C)
        const bars = segs.flatMap(s => {
          const a = ((s.a % C) + C) % C, len = Math.min(C, s.b - s.a);
          return a + len <= C ? [{ a, b: a + len, kind: s.kind }] : [{ a, b: C, kind: s.kind }, { a: 0, b: a + len - C, kind: s.kind }];
        });
        const nowX = now != null && plan ? x((((now - 0) % C) + C) % C) : null;
        return (
          <button key={m.node} type="button" onClick={() => select({ kind: "node", id: m.node })}
            className={`grid grid-cols-[2.4rem_1fr_3.2rem] items-center gap-2 rounded px-1 text-left text-xs hover:bg-muted ${m.node === current ? "bg-muted" : ""}`}
            title={gaps[i] != null ? `${gaps[i]!.toFixed(0)} m after the previous junction` : undefined}>
            <span className="font-mono">{refs.get(m.node) ?? "?"}</span>
            <svg viewBox={`0 0 ${W} ${row}`} className="h-4 w-full" preserveAspectRatio="none" aria-hidden>
              <rect x={0} y={3} width={W} height={row - 6} fill="var(--muted)" />
              {bars.map((b, k) => (
                <rect key={k} x={x(b.a)} y={3} width={Math.max(0.5, x(b.b) - x(b.a))} height={row - 6}
                  fill={b.kind === "main" ? "#2f9e5a" : b.kind === "other" ? "#8aa39a" : "#e0a526"} />
              ))}
              {nowX != null && <line x1={nowX} x2={nowX} y1={0} y2={row} stroke="currentColor" strokeWidth={1.5} />}
            </svg>
            <span className="text-right font-mono tabular text-muted-foreground">{m.offset.toFixed(0)} s</span>
          </button>
        );
      })}
    </div>
  );
}
