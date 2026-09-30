"use client";

import { useMemo, useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { connectorId, type CNode, type ConnectorView, type Edge, type LanePiece } from "@/engine/compile";
import { junctionRefs, isJunction } from "@/engine/refs";
import { polyArea, polyCentroid, tripWeight, USE_LABEL } from "@/engine/buildings";
import { BUILDING_USES, LEVELS, MAX_LANES, type BuildingDef, type BuildingUse, type Control, type LinkDef, type Network, type NodeDef, type StopDef, type ZoneDef } from "@/engine/types";
import type { VehicleView } from "@/engine/sim/mirror";
import { connectorsOf } from "@/render/draw2d";
import { commit, LAYERS, network$, select, stats$, ui, type LayerId, type Selection } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { sendView } from "@/state/commands";
import * as ops from "@/state/ops";
import { compass } from "./fields";
import { entryLabel } from "./flows";
import { DataTable, type Column } from "./data-table";

const CONTROLS: { value: Control; label: string }[] = [
  { value: "priority", label: "Priority" }, { value: "stop", label: "All-way stop" }, { value: "lights", label: "Lights" },
  { value: "roundabout", label: "Roundabout" }, { value: "free", label: "Free" },
];
const TURN = { L: "←", S: "↑", R: "→", U: "↶" } as const;
const kmh = (ms: number) => Math.round(ms * 3.6);

/** A table of every object in the chosen layer (TransModeler's "dataview"), under the map. */
export function Dataview() {
  const [layerSel] = useDeepSubject(ui, "layer");
  const [selection] = useDeepSubject(ui, "selection");
  const [net] = useSubject(network$);
  useSubject(stats$); // live columns (~4×/s)
  const [filter, setFilter] = useState("");
  const layer: LayerId = layerSel === "all" ? "roads" : layerSel;
  const c = simController.compiled, sim = simController.sim;
  const version = simController.version;
  const refs = useMemo(() => junctionRefs(c), [c]);
  const nodeName = (id: string) => refs.get(id) ?? (ops.linksAt(net, id).length === 1 ? entryLabel(net, id) : "point");
  const heading = (e: Edge) => { const a = e.center.at(0), b = e.center.at(e.center.len); return compass(b.x - a.x, b.y - a.y).name; };
  const edgeLive = (e: Edge | undefined) => {
    if (!e || !sim) return { n: 0, v: 0 };
    let n = 0, s = 0;
    for (const lp of e.lanes) { const st = sim.laneStats(lp.id); n += st.vehicles; s += st.vehicles * st.speed; }
    return { n, v: n ? s / n : 0 };
  };
  const readOnly = ui.getValue().readOnly;
  const vehTick = layer === "vehicles" ? sim?.tick ?? 0 : 0, hasSim = !!sim;
  const ed = <T,>(e: T) => (readOnly ? undefined : e);
  const live = (label: string) => (sim ? label : `${label} (run traffic)`);

  // one table definition per layer: rows, columns, row key, what a row selects and where it is
  type Def<R> = { rows: R[]; cols: Column<R>[]; key: (r: R) => string; sel: (r: R) => Selection; at: (r: R) => { x: number; y: number } | null };
  const def = useMemo((): Def<unknown> => {
    void version;
    const byId = (id: string) => ops.nodeById(net, id);
    switch (layer) {
      case "roads":
      case "counters": {
        const rows = layer === "roads" ? net.links : net.links.filter(l => l.counter);
        const len = (l: LinkDef) => { const A = byId(l.from), B = byId(l.to); return A && B ? ops.linkLength(l, A, B) : 0; };
        const both = (l: LinkDef) => { const f = edgeLive(c.edgeByKey.get(`${l.id}:1`)), b = edgeLive(c.edgeByKey.get(`${l.id}:-1`)); const n = f.n + b.n; return { n, v: n ? (f.n * f.v + b.n * b.v) / n : 0 }; };
        const cols: Column<LinkDef>[] = layer === "roads" ? [
          { key: "name", label: "Name", width: 190, value: l => l.name, edit: ed({ kind: "text" as const, commit: (l, v) => commit(ops.updateLink(network$.getValue(), l.id, { name: String(v).slice(0, 120) })) }) },
          { key: "from", label: "From", width: 150, value: l => nodeName(l.from) },
          { key: "to", label: "To", width: 150, value: l => nodeName(l.to) },
          { key: "len", label: "Length m", width: 80, align: "right", value: l => Math.round(len(l)) },
          { key: "f", label: "Lanes →", width: 68, align: "right", value: l => l.lanesF, edit: ed({ kind: "number" as const, min: 0, max: MAX_LANES, commit: (l, v) => { const n = Math.round(Number(v)); if (n + l.lanesB > 0) commit(ops.setLanes(network$.getValue(), l.id, n, l.lanesB)); } }) },
          { key: "b", label: "Lanes ←", width: 68, align: "right", value: l => l.lanesB, edit: ed({ kind: "number" as const, min: 0, max: MAX_LANES, commit: (l, v) => { const n = Math.round(Number(v)); if (n + l.lanesF > 0) commit(ops.setLanes(network$.getValue(), l.id, l.lanesF, n)); } }) },
          { key: "speed", label: "km/h limit", width: 76, align: "right", value: l => l.speed, edit: ed({ kind: "number" as const, min: 10, max: 130, commit: (l, v) => commit(ops.updateLink(network$.getValue(), l.id, { speed: Math.round(Number(v)) })) }) },
          { key: "level", label: "Level", width: 56, align: "right", value: l => l.level ?? 0, edit: ed({ kind: "number" as const, min: LEVELS.min, max: LEVELS.max, commit: (l, v) => { const n = Math.round(Number(v)); commit(ops.updateLink(network$.getValue(), l.id, { level: n || undefined })); } }) },
          { key: "bus", label: "Bus lanes", width: 70, value: l => (l.busF || l.busB ? "yes" : "") },
          { key: "counter", label: "Counter", width: 64, value: l => !!l.counter, edit: ed({ kind: "check" as const, commit: (l, v) => commit(ops.updateLink(network$.getValue(), l.id, { counter: v ? true : undefined })) }) },
          { key: "veh", label: live("Vehicles"), width: 110, align: "right", value: l => (sim ? both(l).n : null) },
          { key: "v", label: "Speed now", width: 80, align: "right", value: l => (sim && both(l).n ? kmh(both(l).v) : null) },
        ] : [
          { key: "name", label: "Road", width: 200, value: l => l.name || "Unnamed road" },
          ...([1, -1] as const).flatMap(d => [
            { key: `n${d}`, label: d === 1 ? "Vehicles →" : "Vehicles ←", width: 90, align: "right" as const, value: (l: LinkDef) => sim?.counter(l.id, d)?.total ?? null },
            { key: `h${d}`, label: d === 1 ? "Per hour →" : "Per hour ←", width: 90, align: "right" as const, value: (l: LinkDef) => { const r = sim?.counter(l.id, d); return r ? Math.round(r.perHour) : null; } },
            { key: `v${d}`, label: d === 1 ? "km/h →" : "km/h ←", width: 70, align: "right" as const, value: (l: LinkDef) => { const r = sim?.counter(l.id, d); return r && r.total ? Math.round(r.avgSpeed) : null; } },
          ]),
        ];
        return { rows, cols, key: l => (l as LinkDef).id, sel: l => ({ kind: "link", id: (l as LinkDef).id }), at: l => { const e = c.edgeByKey.get(`${(l as LinkDef).id}:1`) ?? c.edgeByKey.get(`${(l as LinkDef).id}:-1`); return e ? e.center.at(e.center.len / 2) : null; } } as Def<unknown>;
      }
      case "lanes": {
        const rows = c.edges.flatMap(e => e.lanes.map(lp => ({ e, lp })));
        type R = { e: Edge; lp: LanePiece };
        const cols: Column<R>[] = [
          { key: "road", label: "Road", width: 190, value: r => r.e.link.name || "Unnamed road" },
          { key: "head", label: "Heading", width: 70, value: r => heading(r.e) },
          { key: "lane", label: "Lane", width: 60, align: "right", value: r => `${r.lp.lane + 1}/${r.e.n}` },
          { key: "turns", label: "Turns", width: 70, value: r => (r.e.to.moves.get(r.e.idx) ?? []).filter(m => r.lp.lane >= m.lo && r.lp.lane <= m.hi).map(m => TURN[m.turn]).join(" ") },
          { key: "bus", label: "Bus", width: 50, value: r => (r.e.bus && r.lp.lane === r.e.n - 1 ? "yes" : "") },
          { key: "len", label: "Length m", width: 80, align: "right", value: r => Math.round(r.lp.len) },
          { key: "veh", label: live("Vehicles"), width: 110, align: "right", value: r => (sim ? sim.laneStats(r.lp.id).vehicles : null) },
          { key: "v", label: "Speed now", width: 80, align: "right", value: r => { const st = sim?.laneStats(r.lp.id); return st && st.vehicles ? kmh(st.speed) : null; } },
        ];
        return { rows, cols, key: r => `${(r as R).e.link.id}|${(r as R).e.dir}|${(r as R).lp.lane}`, sel: r => ({ kind: "lane", id: `${(r as R).e.link.id}|${(r as R).e.dir}|${(r as R).lp.lane}` }), at: r => (r as R).lp.poly.at((r as R).lp.len / 2) } as Def<unknown>;
      }
      case "junctions":
      case "signals": {
        const rows = c.nodes.filter(n => isJunction(n) && (layer === "junctions" || n.def.control === "lights"));
        const cols: Column<CNode>[] = [
          { key: "ref", label: "Ref", width: 50, value: n => refs.get(n.def.id) ?? "" },
          { key: "roads", label: "Roads", width: 280, value: n => [...new Set(n.arms.map(a => a.link.name || "unnamed"))].join(" × ") },
          ...(layer === "junctions" ? [
            { key: "ctl", label: "Control", width: 120, value: (n: CNode) => n.def.control, edit: ed({ kind: "select" as const, options: CONTROLS, commit: (n: CNode, v: string | number | boolean) => commit(ops.updateNode(network$.getValue(), n.def.id, { control: v as Control })) }) },
            { key: "arms", label: "Arms", width: 50, align: "right" as const, value: (n: CNode) => n.degree },
          ] : [
            { key: "phases", label: "Phases", width: 60, align: "right" as const, value: (n: CNode) => n.phases.length },
            { key: "green", label: "Green s", width: 110, value: (n: CNode) => n.phaseGreen.join(" / "), edit: n0(ed) },
            { key: "now", label: live("Now"), width: 100, value: (n: CNode) => { if (!sim) return null; const st = sim.nodeState(n.idx); return `${st.phase + 1} · ${["green", "yellow", "all red"][st.stage]}`; } },
          ]),
          { key: "through", label: live("Through"), width: 100, align: "right", value: n => (sim ? sim.junctionStats(n.idx).through : null) },
          { key: "pm", label: "Per min", width: 70, align: "right", value: n => (sim ? Math.round(sim.junctionStats(n.idx).perMin) : null) },
          { key: "wait", label: "Waiting", width: 70, align: "right", value: n => (sim ? sim.junctionStats(n.idx).waiting : null) },
        ];
        return { rows, cols, key: n => (n as CNode).def.id, sel: n => ({ kind: "node", id: (n as CNode).def.id }), at: n => (n as CNode).pos } as Def<unknown>;
      }
      case "connectors": {
        const rows = connectorsOf(c);
        const cols: Column<ConnectorView>[] = [
          { key: "j", label: "Junction", width: 70, value: v => refs.get(v.node.def.id) ?? "" },
          { key: "turn", label: "Turn", width: 50, value: v => TURN[v.move.turn] },
          { key: "from", label: "From", width: 220, value: v => `${v.move.in.link.name || "unnamed"} · lane ${v.inLane + 1}` },
          { key: "to", label: "To", width: 220, value: v => `${v.move.out.link.name || "unnamed"} · lane ${v.outLane + 1}` },
          { key: "ctl", label: "Control", width: 90, value: v => v.node.def.control },
          { key: "taken", label: live("Vehicles on turn"), width: 130, align: "right", value: v => sim?.turnCounts.get(`${v.move.in.idx}>${v.move.out.idx}`) ?? (sim ? 0 : null) },
        ];
        return { rows, cols, key: v => connectorId(v as ConnectorView), sel: v => ({ kind: "connector", id: connectorId(v as ConnectorView) }), at: v => ({ x: (v as ConnectorView).pts[0], y: (v as ConnectorView).pts[1] }) } as Def<unknown>;
      }
      case "entries": {
        const rows = ops.entryPoints(net);
        const cols: Column<NodeDef>[] = [
          { key: "name", label: "Entry / exit", width: 240, value: n => entryLabel(net, n.id) },
          { key: "inflow", label: "Inflow veh/min", width: 110, align: "right", value: n => n.inflow ?? null, edit: ed({ kind: "number" as const, min: 0, max: 120, commit: (n: NodeDef, v: string | number | boolean) => commit(ops.updateNode(network$.getValue(), n.id, { inflow: Number(v) })) }) },
          { key: "exitw", label: "Exit share ×", width: 90, align: "right", value: n => n.exitWeight ?? 1, edit: ed({ kind: "number" as const, min: 0, max: 100, commit: (n: NodeDef, v: string | number | boolean) => commit(ops.updateNode(network$.getValue(), n.id, { exitWeight: Number(v) === 1 ? null : Number(v) })) }) },
          { key: "flows", label: "Transit flows", width: 100, align: "right", value: n => (net.flows ?? []).filter(f => f.from === n.id).length },
          { key: "entered", label: live("Entered"), width: 100, align: "right", value: n => (sim ? sim.entered.get(n.id) ?? 0 : null) },
          { key: "exited", label: live("Left"), width: 90, align: "right", value: n => (sim ? sim.exited.get(n.id) ?? 0 : null) },
          { key: "inH", label: live("In/h"), width: 80, align: "right", value: n => (sim ? Math.round(sim.gateRates.get(n.id)?.[0] ?? 0) : null) },
          { key: "outH", label: live("Out/h"), width: 80, align: "right", value: n => (sim ? Math.round(sim.gateRates.get(n.id)?.[1] ?? 0) : null) },
        ];
        return { rows, cols, key: n => (n as NodeDef).id, sel: n => ({ kind: "node", id: (n as NodeDef).id }), at: n => n as NodeDef } as Def<unknown>;
      }
      case "stops": {
        const cols: Column<StopDef>[] = [
          { key: "name", label: "Name", width: 180, value: s => s.name, edit: ed({ kind: "text" as const, commit: (s: StopDef, v: string | number | boolean) => commit(ops.updateStop(network$.getValue(), s.id, { name: String(v).slice(0, 80) })) }) },
          { key: "road", label: "Road", width: 200, value: s => ops.linkById(net, s.link)?.name || "unnamed" },
          { key: "lines", label: "Lines", width: 160, value: s => net.lines.filter(l => l.stops.includes(s.id)).map(l => l.name).join(", ") },
          { key: "wait", label: live("Waiting"), width: 100, align: "right", value: s => (sim ? Math.floor(c.stopById.get(s.id)?.waiting ?? 0) : null) },
        ];
        return { rows: net.stops, cols, key: s => (s as StopDef).id, sel: s => ({ kind: "stop", id: (s as StopDef).id }), at: s => { const st = c.stopById.get((s as StopDef).id); return st ? st.edge.center.at(st.edge.trimA + st.s) : null; } } as Def<unknown>;
      }
      case "buildings": {
        const cols: Column<BuildingDef>[] = [
          { key: "name", label: "Name", width: 180, value: b => b.name ?? "" },
          { key: "use", label: "Use", width: 150, value: b => b.use, edit: ed({ kind: "select" as const, options: BUILDING_USES.map(u => ({ value: u, label: USE_LABEL[u] })), commit: (b: BuildingDef, v: string | number | boolean) => commit(ops.updateBuilding(network$.getValue(), b.id, { use: v as BuildingUse })) }) },
          { key: "h", label: "Height m", width: 80, align: "right", value: b => b.height, edit: ed({ kind: "number" as const, min: 2, max: 400, commit: (b: BuildingDef, v: string | number | boolean) => commit(ops.updateBuilding(network$.getValue(), b.id, { height: Number(v) })) }) },
          { key: "area", label: "Footprint m²", width: 100, align: "right", value: b => Math.round(polyArea(b.pts)) },
          { key: "trips", label: "Trip weight", width: 90, align: "right", value: b => tripWeight(b), edit: ed({ kind: "number" as const, min: 0, max: 100000, commit: (b: BuildingDef, v: string | number | boolean) => commit(ops.updateBuilding(network$.getValue(), b.id, { trips: Number(v) })) }) },
          { key: "zone", label: "Zone", width: 120, value: b => zoneOf(net, "building", b.id) },
        ];
        return { rows: net.buildings ?? [], cols, key: b => (b as BuildingDef).id, sel: b => ({ kind: "building", id: (b as BuildingDef).id }), at: b => polyCentroid((b as BuildingDef).pts) } as Def<unknown>;
      }
      case "vehicles": {
        const cols: Column<VehicleView>[] = [
          { key: "id", label: "#", width: 70, align: "right", value: v => v.id },
          { key: "kind", label: "Kind", width: 70, value: v => v.kind },
          { key: "speed", label: "km/h", width: 70, align: "right", value: v => kmh(v.v) },
          { key: "want", label: "Desired", width: 70, align: "right", value: v => kmh(v.v0) },
          { key: "state", label: "State", width: 120, value: v => v.state },
        ];
        return { rows: sim ? sim.vehicles.slice() : [], cols, key: v => String((v as VehicleView).id), sel: v => ({ kind: "vehicle", id: String((v as VehicleView).id) }), at: v => ({ x: ((v as VehicleView).fx + (v as VehicleView).rx) / 2, y: ((v as VehicleView).fy + (v as VehicleView).ry) / 2 }) } as Def<unknown>;
      }
      case "zones": {
        const zs = net.zones ?? [], dm = net.zoneFlows ?? [];
        const perH = (z: ZoneDef, dir: "from" | "to") => dm.filter(f => f[dir] === z.id).reduce((a, f) => a + f.rate, 0);
        const arrived = (z: ZoneDef, dir: "from" | "to") => (sim ? dm.filter(f => f[dir] === z.id).reduce((a, f) => a + (sim.zoneFlow(f.id)?.arrived ?? 0), 0) : null);
        const cols: Column<ZoneDef>[] = [
          { key: "c", label: "", width: 30, value: z => z.color, render: z => <span className="inline-block size-3 rounded-full" style={{ background: z.color }} /> },
          { key: "name", label: "Zone", width: 160, value: z => z.name, edit: ed({ kind: "text" as const, commit: (z: ZoneDef, v: string | number | boolean) => String(v).trim() && commit(ops.updateZone(network$.getValue(), z.id, { name: String(v).trim().slice(0, 60) })) }) },
          { key: "e", label: "Entry points", width: 90, align: "right", value: z => z.members.filter(m => m.kind === "entry").length },
          { key: "b", label: "Buildings", width: 80, align: "right", value: z => z.members.filter(m => m.kind === "building").length },
          { key: "out", label: "Trips out /h", width: 90, align: "right", value: z => perH(z, "from") },
          { key: "in", label: "Trips in /h", width: 90, align: "right", value: z => perH(z, "to") },
          { key: "ao", label: live("Arrived from here"), width: 130, align: "right", value: z => arrived(z, "from") },
          { key: "ai", label: "Arrived here", width: 100, align: "right", value: z => arrived(z, "to") },
        ];
        const centre = (z: ZoneDef) => {
          const pts = z.members.map(m => (m.kind === "entry" ? ops.nodeById(net, m.id) : (() => { const b = net.buildings?.find(x => x.id === m.id); return b ? polyCentroid(b.pts) : undefined; })())).filter((p): p is { x: number; y: number } => !!p);
          return pts.length ? { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length } : null;
        };
        return { rows: zs, cols, key: z => (z as ZoneDef).id, sel: z => ({ kind: "zone", id: (z as ZoneDef).id }), at: z => centre(z as ZoneDef) } as Def<unknown>;
      }
      default:
        return { rows: [], cols: [], key: () => "", sel: () => ({ kind: "link", id: "" }), at: () => null };
    }
    // live columns are read at render; rows only change with the network (or, for vehicles, each snapshot)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, net, c, version, readOnly, vehTick, hasSim]);

  // every table starts with the objects' IDs (to refer to them precisely)
  const cols = useMemo(() => (def.cols.length ? [{ key: "_id", label: "ID", width: 118, value: (r: unknown) => def.key(r) } as Column<unknown>, ...def.cols] : []), [def]);
  const selKey = selection ? (selection.kind === "node" || selection.kind === "link" || selection.kind === "stop" || selection.kind === "building" || selection.kind === "vehicle" || selection.kind === "lane" || selection.kind === "connector" || selection.kind === "zone" ? selection.id : null) : null;
  return (
    <div className="flex h-72 shrink-0 flex-col border-t bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">{LAYERS.find(l => l.id === layer)?.label}</span>
        <span className="text-xs text-muted-foreground">{def.rows.length} {def.rows.length === 1 ? "row" : "rows"}</span>
        {layerSel === "all" && <span className="text-xs text-muted-foreground">· choose a layer in the top bar to see other objects</span>}
        <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter…" aria-label="Filter rows" className="ml-auto h-7 w-48 text-xs" />
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Close the data table" onClick={() => { ui.getValue().dataview = false; }}><X /></Button>
      </div>
      {cols.length ? (
        <DataTable rows={def.rows} cols={cols} rowKey={def.key} selected={selKey} filter={filter}
          onRow={r => { select(def.sel(r)); const p = def.at(r); if (p) sendView("focus", p.x, p.y); }} />
      ) : <p className="p-3 text-sm text-muted-foreground">Nothing to list for this layer yet.</p>}
    </div>
  );
}

/** green time column for signals: editable when the junction runs automatic phases (one time for all) */
function n0(ed: <T>(e: T) => T | undefined) {
  return ed({
    kind: "number" as const, min: 3, max: 180,
    commit: (n: CNode, v: string | number | boolean) => {
      const net = network$.getValue(), def = ops.nodeById(net, n.def.id);
      if (!def) return;
      if (def.phases?.length) commit(ops.updateNode(net, def.id, { phases: def.phases.map(p => ({ ...p, green: Number(v) })) }));
      else commit(ops.updateNode(net, def.id, { signal: { ...def.signal, green: Number(v) } }));
    },
  });
}

/** the zone an entry point or building belongs to (by name; "" = none) */
export function zoneOf(net: Network, kind: "entry" | "building", id: string): string {
  return net.zones?.find(z => z.members.some(m => m.kind === kind && m.id === id))?.name ?? "";
}
