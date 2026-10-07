"use client";

import { useState } from "react";
import { AlertTriangle, CircleAlert, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { connectionIssues, currentTargets, throughConns, type CNode, type Edge, type Movement } from "@/engine/compile";
import type { LaneTargets, Network, NodeDef } from "@/engine/types";
import { connectLanes, isManual, lanesLeavingNear, resetConnectors, setTurnTargets } from "@/state/connections";
import { junctionOf, resetJunctionConnectors } from "@/state/junctions";
import { commit, select } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { Section, compass } from "./fields";

const TURN_NAME: Record<Movement["turn"], string> = { L: "Left", R: "Right", S: "Straight", U: "U-turn" };
const keyOf = (m: Movement) => `${m.in.key}>${m.out.key}`;
/** the outgoing lane(s) each incoming lane feeds for a turn (null = none), as the engine uses it now */
const current = (m: Movement) => currentTargets(m);
const first = (t: LaneTargets) => (t == null ? null : Array.isArray(t) ? t[0] : t);

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
  // (a junction drawn by hand: every road end on its outline, from its leading node)
  const hand = junctionOf(net, node.id);
  if (!cn || cn.ringR > 0 || (cn.degree < 2 && !hand)) return null;
  const members = hand ? cn.cluster.filter(k => k.lead === cn) : [cn];
  const set = (key: string, lanes: LaneTargets[]) => commit(setTurnTargets(net, c, key, lanes));
  const defs = members.map(k => ops.nodeById(net, k.def.id) ?? k.def);
  const manual = !hand && isManual(node), count = defs.reduce((s, d) => s + (d.connectors?.length ?? 0), 0);
  /** an approach with no connectors of its own (it gets the automatic ones) */
  const defAt = (e: Edge) => defs[members.indexOf(e.to)] ?? node;
  const auto = (key: string) => { const e = c.edgeByKey.get(key), d = e ? defAt(e) : node; return !hand && !!d.connectors && !d.connectors.some(x => x.in === key) && !d.closed?.includes(key); };
  const shown = new Set<string>();
  const through = new Set([...throughConns(c, cn)].map(x => x.move));
  const approaches = members.flatMap(k => k.arms.filter(a => a.inEdge).map(a => ({ arm: a, e: a.inEdge!, moves: k.moves.get(a.inEdge!.idx) ?? [] })));
  const name = (l: { name: string; id: string }) => l.name || l.id;
  return (
    <Section title="Lane connections">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className={manual || hand ? "font-medium" : "text-muted-foreground"}>
          {hand ? `${count} connector${count === 1 ? "" : "s"} across the junction` : node.connectors ? `Set by hand: ${count} connector${count === 1 ? "" : "s"}` : manual ? "Partly set by hand" : "Automatic, from the roads and their lane arrows"}
        </span>
        {manual && <Button variant="outline" size="sm" className="h-6" onClick={() => commit(resetConnectors(net, node.id))}><RotateCcw className="size-3" /> Back to automatic</Button>}
        {hand && <Button variant="outline" size="sm" className="h-6" title="The connectors the roads would have meeting at one point" onClick={() => commit(resetJunctionConnectors(net, hand))}><RotateCcw className="size-3" /> Usual connectors</Button>}
      </div>
      {cn.cluster.length > 1 && !hand && (
        <p className="text-xs">
          One junction with {cn.cluster.filter(k => k !== cn).map((k, i) => (
            <span key={k.def.id}>{i ? ", " : ""}<button type="button" className="font-mono hover:underline" onClick={() => select({ kind: "node", id: k.def.id })}>{k.def.id}</button></span>
          ))}: connectors link their roads, so they give way to each other&apos;s traffic as one junction (and share its control).
        </p>
      )}
      <ConnectionIssues cn={cn} />
      {approaches.map(({ arm, e, moves }) => (
        <div key={e.key} className="grid gap-1.5">
          <div className="text-xs font-medium">From {name(e.link)} <span className="text-muted-foreground">({compass(arm.u.x, arm.u.y).name}, {e.n} lane{e.n === 1 ? "" : "s"}{auto(e.key) ? ", automatic" : defAt(e).closed?.includes(e.key) && !moves.length ? ", no connectors" : ""})</span></div>
          {moves.map(m => {
            const key = keyOf(m), lanes = current(m), byTurn = !node.connectors && !!node.laneMap?.[key];
            shown.add(key);
            return (
              <div key={key} className="grid grid-cols-[6.5rem_1fr_auto] items-center gap-1.5 text-xs">
                <span className="truncate" title={`${TURN_NAME[m.turn]} to ${name(m.out.link)}${through.has(m) ? ": drives through without stopping (no other path here crosses or joins it)" : ""}`}>
                  {TURN_NAME[m.turn]} → {name(m.out.link)}{through.has(m) && <span className="ml-1 rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-700 dark:text-emerald-400">through</span>}
                </span>
                <span className="flex flex-wrap gap-1">
                  {lanes.map((t, a) => { const b = first(t), extra = Array.isArray(t) ? t.slice(1) : []; return a === e.dropLane ? null : (
                    <label key={a} className="flex items-center gap-0.5 rounded border px-1" title={`Lane ${a + 1} of ${name(e.link)}${extra.length ? ` (also into lane ${extra.map(x => x + 1).join(", ")}; picking here keeps just one)` : ""}`}>
                      <span className="text-muted-foreground">{a + 1}→</span>
                      <select
                        className="h-5 bg-transparent font-mono outline-none" value={b === null ? "" : String(b)} aria-label={`${TURN_NAME[m.turn]} to ${name(m.out.link)}: lane ${a + 1} into`}
                        onChange={ev => { const next = [...lanes]; next[a] = ev.target.value === "" ? null : Number(ev.target.value); set(key, next); }}
                      >
                        <option value="">–</option>
                        {Array.from({ length: m.out.n }, (_, q) => <option key={q} value={q}>{q + 1}</option>)}
                      </select>
                      {extra.length > 0 && <span className="font-mono text-muted-foreground">+{extra.map(x => x + 1).join("+")}</span>}
                    </label>
                  ); })}
                </span>
                {byTurn
                  ? <Button variant="ghost" size="icon" className="size-6" title="Back to automatic" aria-label="Back to automatic" onClick={() => commit(ops.setLaneMap(net, node.id, key, null))}><RotateCcw className="size-3" /></Button>
                  : <span className="size-6" />}
              </div>
            );
          })}
        </div>
      ))}
      <AddConnector net={net} members={members} />
      {Object.keys((!node.connectors && node.laneMap) || {}).filter(k => !shown.has(k)).map(k => {
        const [from, to] = k.split(">").map(x => net.links.find(l => l.id === x.split(":")[0]));
        if (!from || !to) return null;
        return (
          <div key={k} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{name(from)} → {name(to)}: switched off by hand</span>
            <Button variant="outline" size="sm" className="h-6" onClick={() => commit(ops.setLaneMap(net, node.id, k, null))}><RotateCcw className="size-3" /> Restore</Button>
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground">
        Each box is a lane of the approach (1 = leftmost) and the lane it drives into; – means that lane doesn&apos;t take this turn.
        The connectors are worked out from the roads and their lane arrows until you change one: then the junction&apos;s whole set is
        kept as it is, and only a road with none of its own (one added since) gets automatic ones.
      </p>
      <p className="text-[11px] text-muted-foreground">
        A turn marked <span className="text-emerald-700 dark:text-emerald-400">through</span> crosses and joins no other path here, so its
        traffic drives on without stopping (e.g. the far side of a two-way road when the side road only turns right in and out).
        Switch off the turns that cross a direction to leave that direction out of the junction.
      </p>
    </Section>
  );
}

/** add a lane connector: from a lane of a road coming in to a lane of a road going out (a new turn if need be) */
function AddConnector({ net, members }: { net: Network; members: CNode[] }) {
  const arms = members.flatMap(k => k.arms);
  const ins = arms.flatMap(a => (a.inEdge ? [{ a, e: a.inEdge }] : [])), outs = arms.flatMap(a => (a.outEdge ? [{ a, e: a.outEdge }] : []));
  const [from, setFrom] = useState(""), [to, setTo] = useState("");
  // (a road's end with nothing leaving it: lanes starting at other nodes nearby can still be joined)
  if (!ins.length) return null;
  const label = (x: { a: CNode["arms"][number]; e: Edge }) => `${x.e.link.name || x.e.link.id} (${compass(x.a.u.x, x.a.u.y).name})`;
  const opts = (list: typeof ins) => list.flatMap(x => Array.from({ length: x.e.n }, (_, k) => ({ value: `${x.e.key}|${k}`, text: `${label(x)} · lane ${k + 1}` })));
  // from a lane picked: the lanes leaving here, and those starting at other nodes nearby (one junction with them then)
  const [fk, fa] = from ? from.split("|") : ["", ""], fe = arms.find(x => x.inEdge?.key === fk)?.inEdge;
  const farOuts = fe ? lanesLeavingNear(simController.compiled, fe, Number(fa)).filter(x => !members.includes(x.e.from)) : [];
  const add = () => {
    const [ik, a] = from.split("|"), [ok, b] = to.split("|");
    const ein = arms.find(x => x.inEdge?.key === ik)?.inEdge;
    if (!ein) return;
    // (adds to what the lane feeds now: one lane can feed several)
    const r = connectLanes(net, simController.compiled, ik, Number(a), ok, Number(b));
    if (r) commit(r.net);
    setFrom(""); setTo("");
  };
  const sel = "h-7 w-full rounded border bg-transparent px-1 text-xs";
  return (
    <div className="grid gap-1.5 rounded-md border border-dashed p-2">
      <div className="text-xs font-medium">Add a connector</div>
      <select className={sel} value={from} onChange={e => { setFrom(e.target.value); setTo(""); }} aria-label="From lane">
        <option value="">From… (a lane coming in)</option>
        {opts(ins).map(o => <option key={o.value} value={o.value}>{o.text}</option>)}
      </select>
      <select className={sel} value={to} onChange={e => setTo(e.target.value)} aria-label="To lane">
        <option value="">To… (a lane going out)</option>
        {opts(outs).map(o => <option key={o.value} value={o.value}>{o.text}</option>)}
        {farOuts.length > 0 && (
          <optgroup label="Starting nearby (makes one junction with it)">
            {farOuts.map(x => <option key={`${x.e.key}|${x.lp.lane}`} value={`${x.e.key}|${x.lp.lane}`}>{x.e.link.name || x.e.link.id} at {x.e.from.def.id} · lane {x.lp.lane + 1}</option>)}
          </optgroup>
        )}
      </select>
      <Button size="sm" variant="outline" className="justify-self-start" disabled={!from || !to} onClick={add}><Plus /> Add connector</Button>
      <p className="text-[11px] text-muted-foreground">Connects those two lanes through the junction, even where no turn existed (it becomes a turn here, allowed whatever the lane arrows say). A lane starting at another node nearby (up to 60 m, e.g. the other carriageway) can be joined too: both then make one junction.</p>
    </div>
  );
}
