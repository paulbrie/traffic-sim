"use client";

import { useSubject } from "subjecto/react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_PHASES, type Network, type NodeDef } from "@/engine/types";
import { connShapeKey, exitLanesOf, laneAllowed, type CNode } from "@/engine/compile";
import { commit, select, stats$ } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { cn as cx } from "@/lib/utils";
import { NumberField, Section, compass } from "./fields";

const TURN_GLYPH: Record<string, string> = { L: "←", S: "↑", R: "→", U: "↶" };

/**
 * Traffic light phases of one junction, lane by lane: which lanes of which arriving roads get green
 * in each phase, and for how long. Automatic until the user customises it.
 */
export function PhaseEditor({ net, node, cn }: { net: Network; node: NodeDef; cn: CNode }) {
  useSubject(stats$); // live: re-render with the simulation stats (~4×/s) to show the current phase
  const sim = simController.sim;
  const live = sim ? sim.nodeState(cn.idx) : null;
  const custom = (node.phases?.length ?? 0) >= 2;
  const toConn = () => commit(ops.toConnectorPhases(net, simController.compiled, node.id));

  if (cn.signals !== cn) {
    return (
      <Section title="Lanes and phases">
        <p className="text-xs">
          The lights here run from <button type="button" className="font-mono hover:underline" onClick={() => select({ kind: "node", id: cn.signals.def.id })}>{cn.signals.def.id}</button>,
          {" "}set connector by connector for the whole junction.
        </p>
      </Section>
    );
  }
  if (custom && node.phases!.some(p => p.conns)) return <ConnectorPhases net={net} node={node} cn={cn} live={live} />;

  if (!custom) {
    return (
      <Section title="Lanes and phases">
        <p className="text-xs text-muted-foreground">
          The phases are worked out automatically, and all lanes of a road share one light. Set the lights per lane to give
          lanes their own phases, e.g. a protected left-turn arrow.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => commit(ops.customizePhases(net, simController.compiled, node.id))}>Set lights per lane</Button>
          <Button variant="outline" size="sm" onClick={toConn}>Set lights per connector</Button>
        </div>
      </Section>
    );
  }

  const phases = node.phases!;
  // approaches in the junction's arm order, with the road definition and lane turns
  const approaches = cn.arms.map((a, arm) => {
    const e = a.inEdge;
    if (!e) return null;
    const def = net.links.find(l => l.id === e.link.id);
    if (!def) return null;
    const moves = cn.moves.get(e.idx) ?? [];
    const turns = Array.from({ length: e.n }, (_, k) => moves.filter(m => k >= m.lo && k <= m.hi).map(m => TURN_GLYPH[m.turn] ?? "").join(""));
    return { arm, e, def, dir: e.dir, from: compass(a.u.x, a.u.y).name, turns, green: cn.lanePhases[arm] ?? [] };
  }).filter((x): x is NonNullable<typeof x> => !!x);
  const dark = approaches.flatMap(a => a.green.map((ps, k) => (ps.length ? null : `${a.def.name || "road"} from ${a.from}, lane ${k + 1}`)).filter((x): x is string => !!x));

  return (
    <Section title="Lanes and phases">
      <p className="text-xs text-muted-foreground">
        Phases run in this order. Tap a lane to give it green in that phase. Turns across oncoming traffic still give way when the
        oncoming lanes are green too; give them a phase of their own for a protected arrow. A lane green in two phases in a row stays
        green through the change.
      </p>
      {dark.length > 0 && (
        <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-500">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Never green: {dark.join("; ")}.
        </p>
      )}
      {phases.map((ph, p) => {
        const active = live && live.phase === p;
        return (
          <div key={p} className={cx("grid gap-2 rounded-lg border p-2.5", active && (live.stage === 0 ? "border-[var(--sig-go)] bg-[var(--sig-go)]/5" : "border-[var(--sig-slow)] bg-[var(--sig-slow)]/5"))}>
            <div className="flex items-center gap-1">
              <span className="flex-1 text-sm font-medium">
                Phase {p + 1}
                {active && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{live.stage === 0 ? "green now" : live.stage === 1 ? "yellow" : "all red"}</span>}
              </span>
              <Button variant="ghost" size="icon-sm" className="size-7" disabled={p === 0} onClick={() => commit(ops.movePhase(net, node.id, p, -1))} aria-label={`Move phase ${p + 1} earlier`}><ArrowUp /></Button>
              <Button variant="ghost" size="icon-sm" className="size-7" disabled={p === phases.length - 1} onClick={() => commit(ops.movePhase(net, node.id, p, 1))} aria-label={`Move phase ${p + 1} later`}><ArrowDown /></Button>
              <Button variant="ghost" size="icon-sm" className="size-7" disabled={phases.length <= 2} onClick={() => commit(ops.deletePhase(net, node.id, p))} aria-label={`Delete phase ${p + 1}`}><Trash2 /></Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField id={`pg${p}`} label="Green" unit="s" value={ph.green} min={3} max={180} step={1} digits={0} onCommit={v => commit(ops.updatePhase(net, node.id, p, { green: v }), `pg:${node.id}:${p}`)} />
              <NumberField id={`pm${p}`} label="Min green" unit="s" value={ph.minGreen ?? node.signal.minGreen} min={1} max={120} step={1} digits={0} onCommit={v => commit(ops.updatePhase(net, node.id, p, { minGreen: v }), `pm:${node.id}:${p}`)} />
            </div>
            <div className="grid gap-1.5">
              {approaches.map(a => (
                <div key={a.arm} className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs" title={`${a.def.name || "Unnamed road"}, arriving from the ${a.from}`}>
                    {a.def.name || "Unnamed road"} <span className="text-muted-foreground">from {a.from}</span>
                  </span>
                  <div className="flex gap-1" role="group" aria-label={`Lanes of ${a.def.name || "road"} from ${a.from} in phase ${p + 1}`}>
                    {a.turns.map((t, k) => {
                      const on = a.green[k]?.includes(p) ?? false;
                      return (
                        <button
                          key={k} type="button" aria-pressed={on}
                          title={`Lane ${k + 1} (${k === 0 ? "leftmost" : k === a.turns.length - 1 ? "rightmost" : "middle"}): ${on ? "green" : "red"} in phase ${p + 1}`}
                          onClick={() => commit(ops.setLaneGreen(net, a.def.id, a.dir, k, p, !on))}
                          className={cx(
                            "flex h-7 min-w-9 items-center justify-center gap-0.5 rounded-md border px-1.5 font-mono text-xs transition-colors",
                            on ? "border-[var(--sig-go)] bg-[var(--sig-go)] text-white" : "bg-background text-muted-foreground hover:bg-accent",
                          )}
                        >
                          <span className="text-[10px] opacity-70">{k + 1}</span>{t || "·"}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={phases.length >= MAX_PHASES} onClick={() => commit(ops.addPhase(net, node.id))}><Plus /> Add phase</Button>
        <Button variant="outline" size="sm" onClick={toConn} title="Green given connector by connector (e.g. a lane going straight and left, the left on its own arrow)">Per connector</Button>
        <Button variant="ghost" size="sm" onClick={() => commit(ops.resetPhases(net, node.id))}><RotateCcw /> Back to automatic</Button>
      </div>
    </Section>
  );
}

/**
 * Lights per connector: in each phase, which lane connectors get green, over every node of the junction
 * (a lane can be green straight on and red to the left).
 */
function ConnectorPhases({ net, node, cn, live }: { net: Network; node: NodeDef; cn: CNode; live: { phase: number; stage: number } | null }) {
  const phases = node.phases!;
  const name = (l: { name: string; id: string }) => l.name || l.id;
  // per approach (over the junction's nodes) its connectors, lane by lane
  const approaches = cn.cluster.flatMap(k => k.arms.flatMap(a => {
    const e = a.inEdge;
    if (!e) return [];
    const conns = (k.moves.get(e.idx) ?? []).flatMap(m => Array.from({ length: e.n }, (_, lane) => (laneAllowed(m, lane) ? exitLanesOf(m, lane).map(b => ({
      key: connShapeKey(m, lane, b), lane, text: `${lane + 1}${TURN_GLYPH[m.turn] ?? ""}`, title: `Lane ${lane + 1} → ${name(m.out.link)} lane ${b + 1} (${m.turn === "S" ? "straight on" : m.turn === "L" ? "left" : m.turn === "R" ? "right" : "U-turn"})`,
    })) : [])).flat()).sort((x, y) => x.lane - y.lane);
    return conns.length ? [{ key: e.key, label: name(e.link), from: `${compass(a.u.x, a.u.y).name}${k !== cn ? ` at ${k.def.id}` : ""}`, conns }] : [];
  }));
  const sets = phases.map(p => new Set(p.conns ?? []));
  const dark = approaches.flatMap(a => a.conns.filter(c => !sets.some(x => x.has(c.key))).map(c => `${a.label} ${c.title}`));
  return (
    <Section title="Connectors and phases">
      <p className="text-xs text-muted-foreground">
        Phases run in this order. Tap a connector to give it green in that phase{cn.cluster.length > 1 ? " (connectors of every node of this junction are listed: its lights all run from here)" : ""}.
        Turns across oncoming traffic still give way when that traffic is green too.
      </p>
      {dark.length > 0 && (
        <p className="flex gap-2 text-xs text-amber-700 dark:text-amber-500"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Never green: {dark.slice(0, 6).join("; ")}{dark.length > 6 ? ` and ${dark.length - 6} more` : ""}.</p>
      )}
      {phases.map((ph, p) => {
        const active = live && live.phase === p;
        return (
          <div key={p} className={cx("grid gap-2 rounded-lg border p-2.5", active && (live.stage === 0 ? "border-[var(--sig-go)] bg-[var(--sig-go)]/5" : "border-[var(--sig-slow)] bg-[var(--sig-slow)]/5"))}>
            <div className="flex items-center gap-1">
              <span className="flex-1 text-sm font-medium">
                Phase {p + 1}
                {active && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{live.stage === 0 ? "green now" : live.stage === 1 ? "yellow" : "all red"}</span>}
              </span>
              <Button variant="ghost" size="icon-sm" className="size-7" disabled={p === 0} onClick={() => commit(ops.movePhase(net, node.id, p, -1))} aria-label={`Move phase ${p + 1} earlier`}><ArrowUp /></Button>
              <Button variant="ghost" size="icon-sm" className="size-7" disabled={p === phases.length - 1} onClick={() => commit(ops.movePhase(net, node.id, p, 1))} aria-label={`Move phase ${p + 1} later`}><ArrowDown /></Button>
              <Button variant="ghost" size="icon-sm" className="size-7" disabled={phases.length <= 2} onClick={() => commit(ops.deletePhase(net, node.id, p))} aria-label={`Delete phase ${p + 1}`}><Trash2 /></Button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumberField id={`cpg${p}`} label="Green" unit="s" value={ph.green} min={3} max={180} step={1} digits={0} onCommit={v => commit(ops.updatePhase(net, node.id, p, { green: v }), `pg:${node.id}:${p}`)} />
              <NumberField id={`cpm${p}`} label="Min green" unit="s" value={ph.minGreen ?? node.signal.minGreen} min={1} max={120} step={1} digits={0} onCommit={v => commit(ops.updatePhase(net, node.id, p, { minGreen: v }), `pm:${node.id}:${p}`)} />
            </div>
            <div className="grid gap-1.5">
              {approaches.map(a => (
                <div key={a.key} className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate pt-1 text-xs" title={`${a.label}, arriving from the ${a.from}`}>{a.label} <span className="text-muted-foreground">from {a.from}</span></span>
                  <div className="flex max-w-[60%] flex-wrap justify-end gap-1" role="group" aria-label={`Connectors of ${a.label} in phase ${p + 1}`}>
                    {a.conns.map(c => {
                      const on = sets[p].has(c.key);
                      return (
                        <button key={c.key} type="button" aria-pressed={on} title={`${c.title}: ${on ? "green" : "red"} in phase ${p + 1}`}
                          onClick={() => commit(ops.setConnGreen(net, node.id, p, c.key, !on))}
                          className={cx("flex h-7 min-w-9 items-center justify-center rounded-md border px-1.5 font-mono text-xs transition-colors", on ? "border-[var(--sig-go)] bg-[var(--sig-go)] text-white" : "bg-background text-muted-foreground hover:bg-accent")}>
                          {c.text}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={phases.length >= MAX_PHASES} onClick={() => commit(ops.addPhase(net, node.id))}><Plus /> Add phase</Button>
        <Button variant="ghost" size="sm" onClick={() => commit(ops.resetPhases(net, node.id))}><RotateCcw /> Back to automatic</Button>
      </div>
    </Section>
  );
}
