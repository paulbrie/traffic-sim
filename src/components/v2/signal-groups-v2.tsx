"use client";

import { ArrowDown, ArrowUp, Link2Off, Trash2, Waves } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NumberField } from "@/components/workspace/fields";
import {
  applyGreenWave, deleteGroup, greenWave, groupOf, joinGroup, junctionContents, leaveGroup, moveMember, signalPlan, updateGroup, updateMember,
  type SignalPlan, type Sketch, type SketchJunction, type SketchSignalGroup,
} from "@/lib/lane-sketch";
import { useSketchStore } from "@/state/lane-sketch";

const NEW = "__new__", NONE = "__none__";

/**
 * A traffic-light junction's coordination, as V1's: pick or start a signal group, then which of its phases is
 * coordinated, its share of the green and its offset; the group (name, cycle, wave speed, corridor order,
 * green wave) is edited here too. `now`: the cars' time, marked on the timeline while they run.
 */
export function SignalGroupSection({ sketch, junction, plan, now, onPick }: {
  sketch: Sketch; junction: SketchJunction; plan: SignalPlan; now: number | null; onPick: (id: string) => void;
}) {
  const { edit: editSketch } = useSketchStore();
  const group = groupOf(sketch, junction.id), groups = sketch.signalGroups ?? [];
  if (plan.phases.length < 2) return null;
  const pick = (v: string) => {
    if (v === NONE) editSketch(sk => leaveGroup(sk, junction.id));
    else editSketch(sk => joinGroup(sk, junction.id, v === NEW ? null : v)[0]);
  };
  return (
    <div className="grid gap-2 border-t pt-2">
      <span className="text-xs font-medium">Coordination</span>
      <Select value={group?.id ?? NONE} onValueChange={pick}>
        <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label="Signal group"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE} className="text-xs">Runs on its own</SelectItem>
          {groups.map(g => <SelectItem key={g.id} value={g.id} className="text-xs">{g.name} ({g.members.length})</SelectItem>)}
          <SelectItem value={NEW} className="text-xs">+ New signal group</SelectItem>
        </SelectContent>
      </Select>
      {!group
        ? <p className="text-[11px] text-muted-foreground">Put neighbouring lights in the same group to run them on one cycle, with offsets between them so traffic meets green after green.</p>
        : <GroupEditor sketch={sketch} junction={junction} plan={plan} group={group} now={now} onPick={onPick} />}
    </div>
  );
}

function GroupEditor({ sketch, junction, plan, group, now, onPick }: {
  sketch: Sketch; junction: SketchJunction; plan: SignalPlan; group: SketchSignalGroup; now: number | null; onPick: (id: string) => void;
}) {
  const { edit: editSketch } = useSketchStore();
  const me = group.members.find(m => m.junction === junction.id)!, idx = group.members.indexOf(me);
  const wave = greenWave(sketch, group), c = plan.coord;
  const seq = c ? plan.phases.map((p, i) => ({ p, i })).sort((a, b) => a.p.start - b.p.start) : [];
  return (
    <div className="grid gap-2.5">
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Group name
          <Input className="h-7 text-xs text-foreground" defaultValue={group.name} key={group.id + group.name}
            onBlur={e => { const v = e.currentTarget.value.trim(); if (v && v !== group.name) editSketch(sk => updateGroup(sk, group.id, { name: v.slice(0, 80) })); }}
            onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} />
        </label>
        <Button variant="ghost" size="icon-sm" aria-label="Delete the group" title="Delete the group (its lights go back to running on their own)" onClick={() => editSketch(sk => deleteGroup(sk, group.id))}><Trash2 /></Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField id={`g-cycle-${group.id}`} label="Cycle (whole group)" unit="s" value={group.cycle} min={20} max={240} step={5} digits={0} onCommit={v => editSketch(sk => updateGroup(sk, group.id, { cycle: Math.round(v) }))} />
        <NumberField id={`g-speed-${group.id}`} label="Wave speed" unit="km/h" value={group.speed} min={10} max={130} step={5} digits={0} onCommit={v => editSketch(sk => updateGroup(sk, group.id, { speed: v }))} />
      </div>
      <div className="grid gap-2 rounded-md border p-2">
        <div className="text-xs">This junction <span className="text-muted-foreground">(#{idx + 1} in the corridor)</span></div>
        <label className="grid gap-1 text-[11px] text-muted-foreground">
          Coordinated phase
          <Select value={String(Math.min(me.phase, plan.phases.length - 1))} onValueChange={v => editSketch(sk => updateMember(sk, junction.id, { phase: Number(v) }))}>
            <SelectTrigger size="sm" className="h-7 w-full text-xs text-foreground" aria-label="Coordinated phase"><SelectValue /></SelectTrigger>
            <SelectContent>{plan.phases.map((p, i) => <SelectItem key={i} value={String(i)} className="text-xs">{p.name}</SelectItem>)}</SelectContent>
          </Select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <NumberField id={`m-offset-${junction.id}`} label="Offset" unit="s" value={me.offset} min={0} max={group.cycle} step={1} digits={0} onCommit={v => editSketch(sk => updateMember(sk, junction.id, { offset: v }))} />
          <NumberField id={`m-share-${junction.id}`} label="Its share of green" unit="%" value={Math.round(me.share * 100)} min={20} max={85} step={5} digits={0} onCommit={v => editSketch(sk => updateMember(sk, junction.id, { share: v / 100 }))} />
        </div>
        {c && (
          <p className="text-[11px] text-muted-foreground">
            {seq.map(({ p }) => `${p.green.toFixed(0)} s for ${p.name}`).join(", then ")}; {plan.amber} s amber + {plan.allRed} s all red after each. Fixed (not actuated) while in the group.
            {c.stretched ? ` The cycle is too short for ${plan.phases.length} phases here: this junction runs ${c.stretched.toFixed(0)} s and drifts out of step.` : ""}
          </p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-7" disabled={idx === 0} onClick={() => editSketch(sk => moveMember(sk, junction.id, -1))}><ArrowUp /> Earlier</Button>
          <Button size="sm" variant="outline" className="h-7" disabled={idx === group.members.length - 1} onClick={() => editSketch(sk => moveMember(sk, junction.id, 1))}><ArrowDown /> Later</Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => editSketch(sk => leaveGroup(sk, junction.id))}><Link2Off /> Leave group</Button>
        </div>
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">Corridor, in driving order</span>
          <Button size="sm" variant="secondary" className="h-7" disabled={group.members.length < 2}
            title="Set every offset from the driving time between the junctions at the wave speed"
            onClick={() => editSketch(sk => applyGreenWave(sk, group.id))}><Waves /> Green wave</Button>
        </div>
        <Timeline sketch={sketch} group={group} current={junction.id} now={now} gaps={wave.gaps} onPick={onPick} />
        <p className="text-[11px] text-muted-foreground">
          One cycle per junction: dark green is the coordinated phase. With Green wave, each green starts when a car leaving the junction before at the start of its green gets there at {group.speed.toFixed(0)} km/h (by road).
        </p>
      </div>
    </div>
  );
}

/** a row per member over one cycle of the group: its coordinated green, the other greens, amber and all red; the cars' time marked */
function Timeline({ sketch, group, current, now, gaps, onPick }: {
  sketch: Sketch; group: SketchSignalGroup; current: string; now: number | null; gaps: (number | null)[]; onPick: (id: string) => void;
}) {
  const W = 240, H = 16, C = group.cycle, x = (t: number) => (t / C) * W;
  return (
    <div className="grid gap-1">
      {group.members.map((m, i) => {
        const j = sketch.junctions.find(y => y.id === m.junction), plan = j ? signalPlan(sketch, j, junctionContents(sketch, j)) : null;
        const segs: { a: number; b: number; kind: "main" | "other" | "amber" }[] = [];
        if (plan?.coord) for (const [k, p] of plan.phases.entries()) {
          const a = plan.coord.offset + p.start;
          segs.push({ a, b: a + p.green, kind: k === plan.coord.phase ? "main" : "other" });
          segs.push({ a: a + p.green, b: a + p.green + plan.amber + plan.allRed, kind: "amber" });
        }
        // (wrapped into one cycle)
        const bars = segs.flatMap(s => {
          const a = ((s.a % C) + C) % C, len = Math.min(C, s.b - s.a);
          return a + len <= C ? [{ a, b: a + len, kind: s.kind }] : [{ a, b: C, kind: s.kind }, { a: 0, b: a + len - C, kind: s.kind }];
        });
        const nowX = now !== null && plan ? x(((now % C) + C) % C) : null;
        return (
          <button key={m.junction} type="button" onClick={() => onPick(m.junction)}
            className={`grid grid-cols-[4.5rem_1fr_2.4rem] items-center gap-2 rounded px-1 text-left text-[11px] hover:bg-muted ${m.junction === current ? "bg-muted" : ""}`}
            title={gaps[i] !== null ? `${gaps[i]!.toFixed(0)} m by road after the junction before` : i > 0 ? "No way by road from the junction before" : undefined}>
            <span className="truncate">{j?.name ?? "(gone)"}</span>
            <svg viewBox={`0 0 ${W} ${H}`} className="h-4 w-full" preserveAspectRatio="none" aria-hidden>
              <rect x={0} y={3} width={W} height={H - 6} fill="var(--muted)" />
              {bars.map((b, k) => <rect key={k} x={x(b.a)} y={3} width={Math.max(0.5, x(b.b) - x(b.a))} height={H - 6} fill={b.kind === "main" ? "#2f9e5a" : b.kind === "other" ? "#8aa39a" : "#e0a526"} />)}
              {nowX !== null && <line x1={nowX} x2={nowX} y1={0} y2={H} stroke="currentColor" strokeWidth={1.5} />}
            </svg>
            <span className="text-right font-mono tabular text-muted-foreground">{m.offset.toFixed(0)} s</span>
          </button>
        );
      })}
    </div>
  );
}
