"use client";

import { Fragment } from "react";
import { Trash2 } from "lucide-react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { Button } from "@/components/ui/button";
import { connShapeKey, connectorHandles, connectorId } from "@/engine/compile";
import { junctionRefs } from "@/engine/refs";
import { connectorsOf } from "@/render/draw2d";
import { commit, network$, select, stats$, ui } from "@/state/store";
import { changeConnection, connectLanes, isManual, lanesLeavingNear, resetConnectors, setConnectorShape } from "@/state/connections";
import { simController } from "@/state/sim-controller";
import { IdChip, NumberField, Section, compass } from "./fields";

const TURN_NAME = { L: "left", S: "ahead", R: "right", U: "U-turn" } as const;
const GLYPH = { L: "←", S: "↑", R: "→", U: "↶" } as const;

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => <Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd></Fragment>)}
    </dl>
  );
}
function Head({ kind, title, id }: { kind: string; title: string; id?: string }) {
  return (
    <div className="border-b px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{kind}{id && <IdChip id={id} />}</div>
      <div className="truncate font-medium">{title}</div>
    </div>
  );
}

/** one lane of one direction of a road */
export function LaneInspector({ id }: { id: string }) {
  useSubject(stats$);
  const [linkId, dirS, laneS] = id.split("|"), dir = Number(dirS), lane = Number(laneS);
  const c = simController.compiled, e = c.edgeByKey.get(`${linkId}:${dir}`), lp = e?.lanes[lane];
  if (!e || !lp) return <div><Head kind="Lane" title="This lane no longer exists" /></div>;
  const n = e.to, arm = e.inArm, moves = (n.moves.get(e.idx) ?? []).filter(m => lane >= m.lo && lane <= m.hi);
  const ref = junctionRefs(c).get(n.def.id);
  const head = compass(e.center.at(e.center.len).x - e.center.at(0).x, e.center.at(e.center.len).y - e.center.at(0).y).name;
  const phases = n.controlled && n.def.control === "lights" ? n.lanePhases[arm]?.[lane] ?? [] : null;
  const live = simController.sim?.laneStats(lp.id);
  const rows: [string, React.ReactNode][] = [
    ["Road", <button key="r" type="button" className="underline-offset-2 hover:underline" onClick={() => select({ kind: "link", id: linkId })}>{e.link.name || "Unnamed road"}</button>],
    ["Heading", head],
    ["Lane", `${lane + 1} of ${e.n} (1 = leftmost)`],
    ["Turns at the end", moves.length ? moves.map(m => GLYPH[m.turn]).join(" ") : "none"],
    ["Bus lane", e.bus && lane === e.n - 1 ? "yes" : "no"],
    ["Length", `${lp.len.toFixed(0)} m`],
    ["Speed limit", `${Math.round(e.speed * 3.6)} km/h`],
    ...(ref ? [["Junction ahead", <button key="j" type="button" className="underline-offset-2 hover:underline" onClick={() => select({ kind: "node", id: n.def.id })}>{ref}</button>] as [string, React.ReactNode]] : []),
    ...(phases ? [["Green in phase", phases.length ? phases.map(p => p + 1).join(", ") : "never"] as [string, React.ReactNode]] : []),
    ...(live ? [["Vehicles now", String(live.vehicles)] as [string, React.ReactNode], ["Their speed", live.vehicles ? `${(live.speed * 3.6).toFixed(0)} km/h` : "–"] as [string, React.ReactNode]] : []),
  ];
  return (
    <div>
      <Head kind="Lane" id={id} title={`${e.link.name || "Unnamed road"} · lane ${lane + 1}`} />
      <Section><Rows rows={rows} /></Section>
      <ConnectFromLane id={id} />
    </div>
  );
}

/** draw a lane connector from the end of this lane to a lane leaving the junction there (on the map, or from the list) */
function ConnectFromLane({ id }: { id: string }) {
  const [from] = useDeepSubject(ui, "connectFrom");
  const [linkId, dirS, laneS] = id.split("|"), lane = Number(laneS);
  const c = simController.compiled, e = c.edgeByKey.get(`${linkId}:${dirS}`);
  // (also from a lane ending at a plain road point: to a lane starting at another node nearby)
  if (!e || e.to.ringR > 0 || e.to.gateway || e.to.degree < 1) return null;
  const ref = junctionRefs(c).get(e.to.def.id) ?? "the junction";
  const picking = from === id;
  const add = (outKey: string, b: number) => {
    const r = connectLanes(network$.getValue(), c, e.key, lane, outKey, b);
    if (!r) return;
    ui.getValue().connectFrom = null;
    commit(r.net);
    select({ kind: "connector", id: r.id });
  };
  const outs = e.to.arms.flatMap(a => (a.outEdge ? [{ a, o: a.outEdge }] : []));
  // lanes starting at other nodes nearby (joining one makes one junction with that node)
  const far = [...new Map(lanesLeavingNear(c, e, lane).filter(x => x.e.from !== e.to).map(x => [x.e.key, x.e])).values()];
  // the connectors starting from this lane now
  const mine = connectorsOf(c).filter(v => v.move.in === e && v.inLane === lane);
  const dirOf = (o: typeof e) => { const a = e.to.arms.find(x => x.outEdge === o); return a ? compass(a.u.x, a.u.y).name : `at ${o.from.def.id}`; };
  return (
    <Section title="Lane connectors">
      {mine.length ? (
        <ul className="grid gap-1">
          {mine.map(v => {
            const vid = connectorId(v);
            return (
              <li key={vid} className="flex items-center gap-1.5 text-xs">
                <span className="w-4 text-center font-mono">{GLYPH[v.move.turn]}</span>
                <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" title={vid} onClick={() => select({ kind: "connector", id: vid })}>
                  {v.move.out.link.name || v.move.out.link.id} ({dirOf(v.move.out)}) · lane {v.outLane + 1}
                </button>
                <Button variant="ghost" size="icon" className="size-6" aria-label="Remove this connector" title="Remove this connector"
                  onClick={() => commit(changeConnection(network$.getValue(), c, e.key, lane, v.move.out.key, v.outLane, null))}><Trash2 className="size-3" /></Button>
              </li>
            );
          })}
        </ul>
      ) : <p className="text-xs text-muted-foreground">No connector starts from this lane: traffic in it can&apos;t get through {ref}.</p>}
      <div className="text-xs font-medium">Add a connector</div>
      <Button size="sm" variant={picking ? "secondary" : "outline"} className="justify-self-start" onClick={() => { ui.getValue().connectFrom = picking ? null : id; }}>
        {picking ? "Done (Esc)" : "Pick lanes on the map"}
      </Button>
      <p className="text-xs text-muted-foreground">
        {picking ? `Click lanes leaving ${ref} (highlighted) to connect lane ${lane + 1} to them, as many as you like.` : `To lanes leaving ${ref} (as many as you like), even where there was no turn. Or pick them here:`}
      </p>
      <div className="grid gap-1.5">
        {[...outs.map(({ a, o }) => ({ o, where: compass(a.u.x, a.u.y).name })), ...far.map(o => ({ o, where: `starts at ${o.from.def.id}, nearby` }))].map(({ o, where }) => (
          <div key={o.key} className="flex flex-wrap items-center gap-1 text-xs">
            <span className="mr-1 truncate text-muted-foreground">{o.link.name || o.link.id} ({where})</span>
            {Array.from({ length: o.n }, (_, b) => {
              const has = mine.some(v => v.move.out === o && v.outLane === b);
              return <Button key={b} size="sm" variant={has ? "secondary" : "outline"} className="h-6 px-2 text-xs" disabled={has} title={has ? "Already connected" : undefined} onClick={() => add(o.key, b)}>lane {b + 1}</Button>;
            })}
          </div>
        ))}
      </div>
    </Section>
  );
}

/** change where this lane goes on this turn, or take it off the turn (sets the junction's lane connections) */
function ConnectorEdit({ v }: { v: ReturnType<typeof connectorsOf>[number] }) {
  const m = v.move, nodeId = v.node.def.id;
  const manual = isManual(v.node.def);
  // (only this connector: the lane's other connectors stay)
  const apply = (b: number | null) => {
    commit(changeConnection(network$.getValue(), simController.compiled, m.in.key, v.inLane, m.out.key, v.outLane, b));
    select(b === null ? { kind: "node", id: nodeId } : { kind: "connector", id: connectorId({ ...v, outLane: b }) });
  };
  return (
    <Section title="Change this connection">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Into lane of {m.out.link.name || m.out.link.id}</span>
        <select className="h-7 rounded border bg-transparent px-1 font-mono text-sm" value={v.outLane} onChange={e => apply(Number(e.target.value))} aria-label="Into lane">
          {Array.from({ length: m.out.n }, (_, q) => <option key={q} value={q}>{q + 1}</option>)}
        </select>
      </label>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => apply(null)}>Remove this connection</Button>
        {manual && <Button variant="ghost" size="sm" title="All of this junction's connectors back to automatic" onClick={() => { commit(resetConnectors(network$.getValue(), nodeId)); select({ kind: "node", id: nodeId }); }}>Junction back to automatic</Button>}
      </div>
      <p className="text-[11px] text-muted-foreground">Lane {v.inLane + 1} of {m.in.link.name || m.in.link.id}. All the lane connections of this junction are listed in its inspector.</p>
    </Section>
  );
}

/** the connector's curve: drag its two handles on the map, or type how far they reach */
function ConnectorShape({ v }: { v: ReturnType<typeof connectorsOf>[number] }) {
  const h = connectorHandles(v.node, v.move, v.inLane, v.outLane), key = connShapeKey(v.move, v.inLane, v.outLane), nodeId = v.node.def.id;
  const set = (reach: [number, number] | null, k?: string) => commit(setConnectorShape(network$.getValue(), nodeId, key, reach), k);
  return (
    <Section title="Curve">
      <div className="grid grid-cols-2 gap-2">
        <NumberField id="k1" label="Leaves along its lane" unit="m" value={h.k1} min={0.5} max={200} step={0.5} digits={1} onCommit={x => set([x, h.k2], `k1:${key}`)} />
        <NumberField id="k2" label="Joins along its lane" unit="m" value={h.k2} min={0.5} max={200} step={0.5} digits={1} onCommit={x => set([h.k1, x], `k2:${key}`)} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        {h.custom ? "Shaped by hand." : "Automatic shape."} Drag the two round handles on the map (each slides along its lane; hold Shift to move one freely) to reshape it, or a square end onto another lane end to connect it there;
        the junction&apos;s outline follows its lanes, and vehicles drive the new path.
      </p>
      {h.custom && <Button variant="outline" size="sm" className="justify-self-start" onClick={() => set(null)}>Automatic shape</Button>}
    </Section>
  );
}

/** a lane connector: the path from one lane through a junction into another */
export function ConnectorInspector({ id }: { id: string }) {
  useSubject(stats$);
  const c = simController.compiled;
  const v = connectorsOf(c).find(x => connectorId(x) === id);
  if (!v) return <div><Head kind="Lane connector" title="This connector no longer exists" /></div>;
  const ref = junctionRefs(c).get(v.node.def.id) ?? "junction";
  const inName = v.move.in.link.name || "unnamed road", outName = v.move.out.link.name || "unnamed road";
  const taken = simController.sim?.turnCounts.get(`${v.move.in.idx}>${v.move.out.idx}`);
  const phases = v.node.def.control === "lights" ? v.node.lanePhases[v.move.in.inArm]?.[v.inLane] ?? [] : null;
  const rows: [string, React.ReactNode][] = [
    ["Junction", <button key="j" type="button" className="underline-offset-2 hover:underline" onClick={() => select({ kind: "node", id: v.node.def.id })}>{ref}</button>],
    ["Turn", TURN_NAME[v.move.turn]],
    ["From", `${inName}, lane ${v.inLane + 1}`],
    ["To", `${outName}, lane ${v.outLane + 1}`],
    ["Control", v.node.def.control],
    ...(phases ? [["Green in phase", phases.length ? phases.map(p => p + 1).join(", ") : "never"] as [string, React.ReactNode]] : []),
    ...(taken !== undefined ? [["Vehicles on this turn", String(taken)] as [string, React.ReactNode]] : []),
  ];
  return (
    <div>
      <Head kind="Lane connector" id={id} title={`${ref}: ${TURN_NAME[v.move.turn]} from ${inName}`} />
      <Section>
        <Rows rows={rows} />
        <p className="text-[11px] text-muted-foreground">Vehicles on this turn counts every lane making it. Lane arrows and signal phases are set on the road and the junction.</p>
        <Button variant="outline" size="sm" className="justify-self-start" onClick={() => select({ kind: "link", id: v.move.in.link.id })}>Open the road</Button>
      </Section>
      {v.node.ringR === 0 && <ConnectorShape v={v} />}
      {v.node.ringR === 0 && <ConnectorEdit v={v} />}
    </div>
  );
}
