"use client";

import { AlertTriangle, CircleAlert, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { connectionIssues, exitLane, laneAllowed, type CNode, type Movement } from "@/engine/compile";
import type { Network, NodeDef } from "@/engine/types";
import { commit, select } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { Section, compass } from "./fields";

const TURN_NAME: Record<Movement["turn"], string> = { L: "Left", R: "Right", S: "Straight", U: "U-turn" };
const keyOf = (m: Movement) => `${m.in.key}>${m.out.key}`;
/** the outgoing lane each incoming lane feeds for a turn (null = none), as the engine uses it now */
const current = (m: Movement) => Array.from({ length: m.in.n }, (_, a) => (laneAllowed(m, a) ? exitLane(m, a, false) : null));

/** problems with the lane connections at one node (roads leading nowhere, lanes not fed, crossing paths) */
export function ConnectionIssues({ cn }: { cn: CNode }) {
  const issues = connectionIssues(simController.compiled, cn);
  if (!issues.length) return <p className="text-xs text-muted-foreground">No problems found: every lane leads somewhere and every exit lane is fed.</p>;
  return (
    <ul className="grid gap-1.5">
      {issues.map((i, k) => (
        <li key={k} className="flex gap-1.5 text-xs">
          {i.level === "error" ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />}
          <button type="button" className="text-left hover:underline" onClick={() => i.link && select({ kind: "link", id: i.link })}>{i.message}</button>
        </li>
      ))}
    </ul>
  );
}

/** which lane feeds which, per approach and turn; each can be changed by hand (or put back to automatic) */
export function LaneConnectionsSection({ net, node }: { net: Network; node: NodeDef }) {
  const c = simController.compiled, cn = c.nodeById.get(node.id);
  if (!cn || cn.ringR > 0 || cn.degree < 2) return null;
  const set = (key: string, lanes: (number | null)[] | null) => commit(ops.setLaneMap(net, node.id, key, lanes));
  const shown = new Set<string>();
  const approaches = cn.arms.filter(a => a.inEdge).map(a => ({ arm: a, e: a.inEdge!, moves: cn.moves.get(a.inEdge!.idx) ?? [] }));
  const name = (l: { name: string; id: string }) => l.name || l.id;
  return (
    <Section title="Lane connections">
      <ConnectionIssues cn={cn} />
      {approaches.map(({ arm, e, moves }) => (
        <div key={e.key} className="grid gap-1.5">
          <div className="text-xs font-medium">From {name(e.link)} <span className="text-muted-foreground">({compass(arm.u.x, arm.u.y).name}, {e.n} lane{e.n === 1 ? "" : "s"})</span></div>
          {moves.map(m => {
            const key = keyOf(m), lanes = current(m), manual = !!node.laneMap?.[key];
            shown.add(key);
            return (
              <div key={key} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-1.5 text-xs">
                <span className="truncate" title={`${TURN_NAME[m.turn]} to ${name(m.out.link)}`}>{TURN_NAME[m.turn]} → {name(m.out.link)}</span>
                <span className="flex flex-wrap gap-1">
                  {lanes.map((b, a) => a === e.dropLane ? null : (
                    <label key={a} className="flex items-center gap-0.5 rounded border px-1" title={`Lane ${a + 1} of ${name(e.link)}`}>
                      <span className="text-muted-foreground">{a + 1}→</span>
                      <select
                        className="h-5 bg-transparent font-mono outline-none" value={b === null ? "" : String(b)} aria-label={`${TURN_NAME[m.turn]} to ${name(m.out.link)}: lane ${a + 1} into`}
                        onChange={ev => { const next = [...lanes]; next[a] = ev.target.value === "" ? null : Number(ev.target.value); set(key, next); }}
                      >
                        <option value="">–</option>
                        {Array.from({ length: m.out.n }, (_, q) => <option key={q} value={q}>{q + 1}</option>)}
                      </select>
                    </label>
                  ))}
                </span>
                {manual
                  ? <Button variant="ghost" size="icon" className="size-6" title="Back to automatic" aria-label="Back to automatic" onClick={() => set(key, null)}><RotateCcw className="size-3" /></Button>
                  : <span className="size-6" />}
              </div>
            );
          })}
        </div>
      ))}
      {Object.keys(node.laneMap ?? {}).filter(k => !shown.has(k)).map(k => {
        const [from, to] = k.split(">").map(x => net.links.find(l => l.id === x.split(":")[0]));
        if (!from || !to) return null;
        return (
          <div key={k} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{name(from)} → {name(to)}: switched off by hand</span>
            <Button variant="outline" size="sm" className="h-6" onClick={() => set(k, null)}><RotateCcw className="size-3" /> Restore</Button>
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground">
        Each box is a lane of the approach (1 = leftmost) and the lane it drives into; – means that lane doesn&apos;t take this turn.
        Changes here win over the automatic connections; the arrow puts a turn back to automatic. Lane arrows on the road decide which turns exist.
      </p>
    </Section>
  );
}
