/**
 * Running the simulation in a Web Worker: the worker owns the `Sim` and sends snapshots of what the
 * user interface shows (vehicle poses, signal states, statistics, new junction events, details of
 * what is selected); the page keeps a `SimMirror` that answers the same questions the renderers and
 * panels ask a `Sim` (`vehicles`, `pose`, `signalFor`, `junctionStats`, …) from the latest snapshot.
 *
 * Framework-free, so both sides can be tested in Node.
 */
import { pieceLevel, pieceZ, type CNode, type Compiled } from "../compile";
import { isJunction } from "../refs";
import { signalAspect, type Aspect } from "../signals";
import type { JunctionEvent, Kind, RevStateCode, Stats, TestTrip, Vehicle } from "./base";

/** a pedestrian crossing right now: its arm, people waiting, people crossing and how far across (0..1) */
export interface PedView { arm: number; waiting: number; crossing: number; progress: number }
/** pedestrians at a junction so far: crossed, average wait (s), waiting now */
export interface PedStats { crossed: number; avgWait: number; waiting: number }
import type { CounterStats, FlowStats, Sim } from "./index";

const KINDS: Kind[] = ["car", "truck", "bus"];
/** floats per vehicle in `Snapshot.geo`: front x, y, rear x, y, speed, desired speed, length, width, blinker, level drawn at, elevation */
const G = 11;

export type JunctionStats = ReturnType<Sim["junctionStats"]>;
export type LightCycles = ReturnType<Sim["lightCycles"]>;
export type NodeState = ReturnType<Sim["nodeState"]>;

/** what the inspector shows about one vehicle (worked out where the vehicle is) */
export interface VehicleDetail {
  id: number; kind: Kind; state: string;
  v: number; v0: number; acc: number; gap: number;
  road: string; lane: number | null; lanes: number | null;
  heading: string; wait: number; laneChanges: number; reroutes: number;
  a: number; b: number; pax: number; cap: number;
  nextTurn: { node: string; turn: "L" | "S" | "R" | "U"; lo: number; hi: number } | null;
  /** route ahead as x, y pairs */
  route: number[];
}

/** what the page wants beyond the vehicles and lights */
export interface Watch {
  /** vehicle whose details to send */
  vehicle: number | null;
  /** junctions whose light cycles to send */
  nodes: number[];
  /** send the reserved paths through junctions */
  reservations: boolean;
}

export interface Snapshot {
  tick: number;
  stats: Stats;
  ids: Int32Array; kinds: Uint8Array; tints: Uint8Array; states: Uint16Array;
  /** state names used by `states` */
  stateNames: string[];
  geo: Float32Array;
  /** per node: phase, stage, time in stage, vehicles in the junction, position in the group cycle (NaN = none) */
  phase: Int16Array; stage: Int8Array; stageT: Float32Array; occupied: Int16Array; cycleAt: Float32Array;
  /** passengers waiting at each stop (compiled order) */
  waiting: Float32Array;
  /** junction events since the previous snapshot; `resetEvents` = replace the list instead */
  events: JunctionEvent[]; resetEvents: boolean;
  /** sent every half second or so (absent = unchanged) */
  junctions?: (JunctionStats | null)[];
  cycles?: [number, LightCycles][];
  turnCounts?: [string, number][];
  entered?: [string, number][];
  exited?: [string, number][];
  /** per entry / exit point: vehicles per hour in and out (last 5 minutes) */
  gateRates?: [string, number, number][];
  /** traffic counters by edge key ("linkId:dir") */
  counters?: [string, CounterStats][];
  /** transit flows by flow id */
  flows?: [string, FlowStats][];
  /** zone-to-zone demand by its id */
  zoneFlows?: [string, FlowStats][];
  /** test vehicles sent by hand */
  tests?: TestTrip[];
  /** pedestrian crossings, by node index (only junctions with pedestrians) */
  peds: [number, PedView[]][];
  /** pedestrians who crossed and their average wait, by node index (sent every half second or so) */
  pedStats?: [number, PedStats][];
  /** per lane piece id: vehicles on it, and their mean speed (m/s), as pairs */
  lanes?: Float32Array;
  /** reserved paths as x, y pairs (when watched) */
  reservations?: Float32Array[];
  vehicle?: VehicleDetail | null;
  /** reversible corridors (compiled order): their lane's state (see REV_STATES) and how long in it, etc. */
  rev?: RevView[];
}
/** a reversible corridor's lane as the page sees it */
export interface RevView { state: RevStateCode; t: number; inside: number; density: [number, number]; hold: "closed" | "1" | "2" | null }

// ---------------------------------------------------------------- worker side

/** remembers what was sent already, to send only what is new */
export class SnapshotWriter {
  private lastEvent: JunctionEvent | null = null;
  private periodicAt = -Infinity;

  write(sim: Sim, watch: Watch, now: number): { snap: Snapshot; transfer: ArrayBuffer[] } {
    const live = sim.vehicles.filter(v => !v.dead), n = live.length;
    const ids = new Int32Array(n), kinds = new Uint8Array(n), tints = new Uint8Array(n), states = new Uint16Array(n), geo = new Float32Array(n * G);
    const stateNames: string[] = [], stateIdx = new Map<string, number>();
    live.forEach((v, i) => {
      ids[i] = v.id; kinds[i] = KINDS.indexOf(v.kind); tints[i] = v.tint;
      let si = stateIdx.get(v.state);
      if (si === undefined) { si = stateNames.length; stateNames.push(v.state); stateIdx.set(v.state, si); }
      states[i] = si;
      const p = sim.pose(v), o = i * G;
      geo[o] = p.fx; geo[o + 1] = p.fy; geo[o + 2] = p.rx; geo[o + 3] = p.ry;
      geo[o + 4] = v.v; geo[o + 5] = v.v0; geo[o + 6] = v.len; geo[o + 7] = v.width; geo[o + 8] = sim.blinker(v);
      geo[o + 9] = pieceLevel(v.piece); geo[o + 10] = pieceZ(sim.net, v.piece, v.s);
    });
    const N = sim.net.nodes.length;
    const phase = new Int16Array(N), stage = new Int8Array(N), stageT = new Float32Array(N), occupied = new Int16Array(N), cycleAt = new Float32Array(N);
    for (let k = 0; k < N; k++) {
      const st = sim.nodeState(k);
      phase[k] = st.phase; stage[k] = st.stage; stageT[k] = st.t; occupied[k] = st.occupied; cycleAt[k] = st.cycleAt ?? NaN;
    }
    const waiting = Float32Array.from(sim.net.stops, s => s.waiting);
    // new events: those after the last one sent (the log drops old entries when it gets long)
    const all = sim.events;
    let from = 0, resetEvents = false;
    if (this.lastEvent) {
      const at = all.lastIndexOf(this.lastEvent);
      if (at >= 0) from = at + 1; else resetEvents = true;
    } else resetEvents = true;
    const events = all.slice(from);
    this.lastEvent = all.length ? all[all.length - 1] : null;

    const snap: Snapshot = {
      tick: sim.tick, stats: { ...sim.stats, history: sim.stats.history.slice() },
      ids, kinds, tints, states, stateNames, geo, phase, stage, stageT, occupied, cycleAt, waiting, events, resetEvents,
      peds: sim.net.nodes.filter(n => n.peds > 0).map(n => [n.idx, sim.pedView(n.idx)] as [number, PedView[]]),
      ...(sim.net.corridors.length ? { rev: sim.net.corridors.map(c => sim.reversibleState(c.idx)!) } : {}),
    };
    const transfer = [ids.buffer, kinds.buffer, tints.buffer, states.buffer, geo.buffer, phase.buffer, stage.buffer, stageT.buffer, occupied.buffer, cycleAt.buffer, waiting.buffer] as ArrayBuffer[];

    if (now - this.periodicAt > 450) {
      this.periodicAt = now;
      snap.junctions = sim.net.nodes.map(nd => (isJunction(nd) ? sim.junctionStats(nd.idx) : null));
      snap.turnCounts = [...sim.turnCounts];
      snap.entered = [...sim.entered];
      snap.exited = [...sim.exited];
      snap.gateRates = sim.gateRates();
      snap.flows = sim.net.flows.map(f => [f.def.id, sim.flowStats(f.idx)!]);
      snap.zoneFlows = sim.net.zoneFlows.map(f => [f.def.id, sim.zoneFlowStats(f.idx)!]);
      snap.tests = sim.tests.map(t => ({ ...t }));
      snap.pedStats = sim.net.nodes.filter(n => n.peds > 0).map(n => [n.idx, sim.pedStats(n.idx)!] as [number, PedStats]);
      // lanes are the first pieces, numbered the same on both sides
      let nl = 0;
      for (const p of sim.net.pieces) if (p.kind === "lane") nl = Math.max(nl, p.id + 1);
      const lanes = new Float32Array(nl * 2);
      for (const v of live) if (v.piece.kind === "lane" && v.piece.id < nl) { lanes[v.piece.id * 2]++; lanes[v.piece.id * 2 + 1] += v.v; }
      for (let i = 0; i < nl; i++) if (lanes[i * 2]) lanes[i * 2 + 1] /= lanes[i * 2];
      snap.lanes = lanes;
      transfer.push(lanes.buffer as ArrayBuffer);
      snap.counters = sim.net.edges.flatMap(e => { const c = sim.counterStats(e.idx); return c ? [[e.key, c] as [string, CounterStats]] : []; });
    }
    snap.cycles = watch.nodes.filter(k => k >= 0 && k < N).map(k => [k, sim.lightCycles(k)]);
    if (watch.reservations) {
      snap.reservations = sim.reservations().map(c => Float32Array.from(c.poly.pts));
      transfer.push(...snap.reservations.map(r => r.buffer as ArrayBuffer));
    }
    if (watch.vehicle !== null) {
      const v = live.find(x => x.id === watch.vehicle);
      snap.vehicle = v ? vehicleDetail(sim, v) : null;
    }
    return { snap, transfer };
  }

  /** forget what was sent (a new simulation, or the log was cleared) */
  reset() { this.lastEvent = null; this.periodicAt = -Infinity; }
}

function vehicleDetail(sim: Sim, v: Vehicle): VehicleDetail {
  const e = v.piece.kind === "lane" ? v.piece.edge : null;
  const nt = sim.nextTurn(v);
  return {
    id: v.id, kind: v.kind, state: v.state, v: v.v, v0: v.v0, acc: v.acc, gap: v.gap,
    road: e ? e.link.name || "unnamed" : v.piece.kind === "ring" ? "roundabout" : "junction",
    lane: e ? v.lane : null, lanes: e ? e.n : null,
    heading: v.dest.kind === "gateway" ? "leaving the plan" : v.dest.kind === "stop" ? `stop ${v.dest.stop.def.name}` : `${v.dest.edge.link.name || "a road"}`,
    wait: v.wait, laneChanges: v.laneChanges, reroutes: v.reroutes, a: v.a, b: v.b, pax: v.pax, cap: v.cap,
    nextTurn: nt ? { node: nt.node.def.id, turn: nt.move.turn, lo: nt.move.lo, hi: nt.move.hi } : null,
    route: sim.routeAhead(v, 800),
  };
}

// ---------------------------------------------------------------- page side

/** a vehicle as the page sees it (a view into the latest snapshot) */
export interface VehicleView {
  id: number; kind: Kind; tint: number; state: string; dead: false;
  v: number; v0: number; len: number; width: number;
  fx: number; fy: number; rx: number; ry: number; blink: -1 | 0 | 1;
  /** the elevation level it is drawn at, and its height in levels (see LinkDef.level) */
  level: number; z: number;
}

/** Answers the page's questions about the running simulation from the latest snapshot. */
export class SimMirror {
  tick = 0;
  stats: Stats = { count: 0, cars: 0, trucks: 0, buses: 0, avgSpeed: 0, stopped: 0, tripsPerMin: 0, trips: 0, towed: 0, boarded: 0, laneChanges: 0, history: [] };
  vehicles: VehicleView[] = [];
  events: JunctionEvent[] = [];
  turnCounts = new Map<string, number>();
  entered = new Map<string, number>();
  exited = new Map<string, number>();
  gateRates = new Map<string, [number, number]>();
  counters = new Map<string, CounterStats>();
  flows = new Map<string, FlowStats>();
  zoneFlows = new Map<string, FlowStats>();
  tests: TestTrip[] = [];
  private pedsNow = new Map<number, PedView[]>();
  private pedTotals = new Map<number, PedStats>();
  private laneLive: Float32Array = new Float32Array(0);
  vehicle: VehicleDetail | null = null;
  private snap: Snapshot | null = null;
  private junctions: (JunctionStats | null)[] = [];
  private cycles = new Map<number, LightCycles>();
  private reserved: Float32Array[] = [];

  constructor(readonly net: Compiled) {}

  get time() { return this.tick * 0.1; }

  /** reversible corridors' lanes (compiled order; empty until the simulation runs) */
  rev: RevView[] = [];
  apply(s: Snapshot) {
    this.snap = s; this.tick = s.tick; this.stats = s.stats;
    const n = s.ids.length, list = this.vehicles;
    list.length = n;
    for (let i = 0; i < n; i++) {
      const o = i * G, v = list[i] ?? (list[i] = {} as VehicleView);
      v.id = s.ids[i]; v.kind = KINDS[s.kinds[i]]; v.tint = s.tints[i]; v.state = s.stateNames[s.states[i]]; v.dead = false;
      v.fx = s.geo[o]; v.fy = s.geo[o + 1]; v.rx = s.geo[o + 2]; v.ry = s.geo[o + 3];
      v.v = s.geo[o + 4]; v.v0 = s.geo[o + 5]; v.len = s.geo[o + 6]; v.width = s.geo[o + 7]; v.blink = s.geo[o + 8] as -1 | 0 | 1;
      v.level = s.geo[o + 9]; v.z = s.geo[o + 10];
    }
    this.net.stops.forEach((st, i) => { st.waiting = s.waiting[i] ?? st.waiting; });
    if (s.resetEvents) this.events = [];
    if (s.events.length) { this.events.push(...s.events); if (this.events.length > 60000) this.events.splice(0, this.events.length - 50000); }
    if (s.junctions) this.junctions = s.junctions;
    if (s.turnCounts) this.turnCounts = new Map(s.turnCounts);
    if (s.entered) this.entered = new Map(s.entered);
    if (s.exited) this.exited = new Map(s.exited);
    if (s.gateRates) this.gateRates = new Map(s.gateRates.map(([id, a, b]) => [id, [a, b]]));
    if (s.counters) this.counters = new Map(s.counters);
    if (s.flows) this.flows = new Map(s.flows);
    if (s.zoneFlows) this.zoneFlows = new Map(s.zoneFlows);
    if (s.tests) this.tests = s.tests;
    this.pedsNow = new Map(s.peds);
    if (s.pedStats) this.pedTotals = new Map(s.pedStats);
    if (s.lanes) this.laneLive = s.lanes;
    if (s.cycles) this.cycles = new Map(s.cycles);
    this.reserved = s.reservations ?? [];
    if (s.vehicle !== undefined) this.vehicle = s.vehicle;
    this.rev = s.rev ?? [];
  }

  pose(v: VehicleView) { return { fx: v.fx, fy: v.fy, rx: v.rx, ry: v.ry }; }
  blinker(v: VehicleView) { return v.blink; }

  vehicleNear(x: number, y: number, radius = 6): VehicleView | null {
    let best: VehicleView | null = null, bd = radius;
    for (const v of this.vehicles) {
      const d = Math.hypot((v.fx + v.rx) / 2 - x, (v.fy + v.ry) / 2 - y);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  signalFor(nodeIdx: number, armIdx: number, lane?: number): Aspect | null {
    const s = this.snap, n: CNode | undefined = this.net.nodes[nodeIdx];
    if (!s || !n) return null;
    return signalAspect(n, s.phase[nodeIdx], s.stage[nodeIdx], armIdx, lane);
  }

  nodeState(nodeIdx: number): NodeState {
    const s = this.snap, n = this.net.nodes[nodeIdx];
    if (!s) return { phase: 0, stage: 0, t: 0, occupied: 0, phases: n?.phases.length ?? 0, cycleAt: null };
    const c = s.cycleAt[nodeIdx];
    return { phase: s.phase[nodeIdx], stage: s.stage[nodeIdx] as 0 | 1 | 2, t: s.stageT[nodeIdx], occupied: s.occupied[nodeIdx], phases: n.phases.length, cycleAt: Number.isNaN(c) ? null : c };
  }

  junctionStats(nodeIdx: number): JunctionStats {
    return this.junctions[nodeIdx] ?? { through: 0, perMin: 0, waiting: 0, approaches: [] };
  }

  /** light cycles of a junction the page watches (empty until the next snapshot after it asked) */
  lightCycles(nodeIdx: number): LightCycles { return this.cycles.get(nodeIdx) ?? []; }

  /** reserved paths through junctions as x, y pairs (when the page asked for them) */
  reservations(): Float32Array[] { return this.reserved; }

  /** readings of the traffic counter on one direction of a road (null = none, or no reading yet) */
  counter(linkId: string, dir: 1 | -1): CounterStats | null { return this.counters.get(`${linkId}:${dir}`) ?? null; }

  /** vehicles on a lane piece right now, and their mean speed (m/s) */
  /** pedestrians at node `idx` right now (one entry per crossing) */
  pedView(idx: number): PedView[] { return this.pedsNow.get(idx) ?? []; }
  /** pedestrians who crossed at node `idx` so far */
  pedStats(idx: number): PedStats | null { return this.pedTotals.get(idx) ?? null; }
  laneStats(pieceId: number): { vehicles: number; speed: number } {
    return { vehicles: this.laneLive[pieceId * 2] ?? 0, speed: this.laneLive[pieceId * 2 + 1] ?? 0 };
  }

  /** results of zone-to-zone demand (by its id) */
  zoneFlow(id: string): FlowStats | null { return this.zoneFlows.get(id) ?? null; }

  /** results of a transit flow (by its id; null before the first reading) */
  flow(id: string): FlowStats | null { return this.flows.get(id) ?? null; }

  /** route ahead of the watched vehicle as x, y pairs */
  routeAhead(v: VehicleView): number[] { return this.vehicle && this.vehicle.id === v.id ? this.vehicle.route : []; }
}
