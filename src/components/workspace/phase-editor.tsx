"use client";

import { useSubject } from "subjecto/react";
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MAX_PHASES, type Network, type NodeDef } from "@/engine/types";
import type { CNode } from "@/engine/compile";
import { commit, stats$ } from "@/state/store";
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

  if (!custom) {
    return (
      <Section title="Lanes and phases">
        <p className="text-xs text-muted-foreground">
          The phases are worked out automatically, and all lanes of a road share one light. Set the lights per lane to give
          lanes their own phases, e.g. a protected left-turn arrow.
        </p>
        <Button variant="outline" size="sm" className="justify-self-start" onClick={() => commit(ops.customizePhases(net, simController.compiled, node.id))}>
          Set lights per lane
        </Button>
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
        <Button variant="ghost" size="sm" onClick={() => commit(ops.resetPhases(net, node.id))}><RotateCcw /> Back to automatic</Button>
      </div>
    </Section>
  );
}
