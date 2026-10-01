/** Simulation engine, bottom layer: shared state, vehicle index, logging, helpers (see ./index.ts). */
import { compile, type CLine, type CNode, type Compiled, type Conn, type CStop, type Edge, type Movement, type Piece } from "../compile";
import { mulberry32 } from "../geom";
import type { Network, PlanSettings } from "../types";
import { resolveParams, type SimParams } from "../params";

export const DT = 0.1;
export const LOOK = 110;
/** entry / exit point rates: over the last 5 minutes (ticks) */
const GATE_WINDOW = 3000;
export const NO_PIECES: readonly Piece[] = [];

export type Kind = "car" | "truck" | "bus";
export type Dest =
  | { kind: "gateway"; node: CNode }
  | { kind: "edge"; edge: Edge; s: number }
  | { kind: "stop"; stop: CStop };

/**
 * What a vehicle crossing the junction at the end of route[ri] from `lane` will do, as far as it only
 * depends on its route (see crossingFor): the movement, the entry lane, the usual exit lane `b0` and the
 * one that suits its next turn `target`, with their crossings. `route` null = empty slot.
 */
export interface XMemo { route: Edge[] | null; ri: number; lane: number; m: Movement | undefined; a: number; b0: number; target: number; c0: readonly Piece[] | null; cT: readonly Piece[] | null }
export const emptyXMemo = (): XMemo => ({ route: null, ri: 0, lane: 0, m: undefined, a: 0, b0: 0, target: 0, c0: null, cT: null });
export interface Vehicle {
  id: number; kind: Kind;
  /** two remembered crossings (this junction and the next), and which slot to reuse next */
  xm: [XMemo, XMemo]; xmNext: number;
  len: number; width: number; a: number; b: number; bmax: number; T: number; s0: number; pref: number; politeness: number; tint: number;
  route: Edge[]; ri: number;
  piece: Piece; s: number; v: number; acc: number; lane: number;
  /** remaining pieces of the junction crossing in progress */
  queue: Piece[];
  trail: Piece[];
  conn: Conn | null; granted: boolean;
  dest: Dest; state: string; wait: number; enterT: number; bornT: number;
  gap: number; leader: Vehicle | null; v0: number;
  reroutes: number; laneChanges: number; lcCool: number; lcOff: number; lcT: number;
  reqAt: number; reqFor: Conn | null; stoppedAt: Conn | null; fixedAt: Edge | null; rerouteAt: Edge | null;
  line: CLine | null; stopIdx: number; pax: number; cap: number; dwell: number;
  dead: boolean;
  /** spawned by an entry point with a set flow (not counted against the car/truck totals) */
  metered: boolean;
  /** a test vehicle sent by hand (index into `tests`), or -1 */
  test?: number;
  /** the last state written to a road's event log */
  logState?: string;
  /** index of the transit flow the vehicle belongs to (-1 = none) */
  flow: number;
  /** index of the zone-to-zone demand it belongs to (-1 = none), and the trip end it was given */
  zflow: number;
  goal: Dest | null;
  /** turning-proportion decisions already drawn, by edge index */
  splits?: Map<number, Edge>;
}

export interface Occ { v: Vehicle; conn: Conn; entered: boolean; /** permissive turn clearing on yellow/all-red */ sneak?: boolean }
export interface Req { v: Vehicle; conn: Conn; d: number; at: number }
export interface JunctionEvent {
  /** simulation time, seconds */
  t: number;
  /** the junction it happened at ("" for events on a road) */
  node: string;
  /** events on a road: the road (and `data.lane`) */
  link?: string;
  veh: number | null;
  vkind: string | null;
  kind: "approach" | "request" | "grant" | "deny" | "revoke" | "enter" | "leave" | "lane" | "wrong-lane" | "turn-changed" | "reroute" | "signal" | "towed"
    | "appear" | "enter-road" | "state" | "leave-road" | "exit" | "arrive";
  detail: string;
  /** machine-readable bits for analysis (lanes are 1-based) */
  data?: { turn?: string; from?: string; to?: string; lane?: number; outLane?: number; lo?: number; hi?: number; sig?: string | null; code?: string };
}

export interface NodeState {
  node: CNode;
  occ: Occ[];
  req: Map<number, Req>;
  phase: number; stage: 0 | 1 | 2; t: number;
  demand: number[];
  /** per arm: vehicles through during the current green, when it started, and past cycles */
  cyc: { count: number; greenAt: number; hist: { n: number; green: number; at: number }[] }[];
}

/**
 * Pedestrians at one zebra crossing (one per road at a junction; a crossing on a plain road has
 * one): people waiting at the kerb and since when, the group on the crossing and when it will be
 * across, and totals.
 */
export interface PedCross {
  waiting: number; since: number;
  crossing: number; from: number; until: number;
  /** when the road's traffic last turned red (lights); pedestrians may step out only early in that red */
  redSince: number;
  /** pedestrians have claimed the crossing: no new vehicle may drive over it */
  claim: boolean;
  crossed: number; waitSum: number;
}

/** what happened to a transit flow's vehicles */
export interface FlowState {
  /** entered the plan, reached the flow's exit, left by another exit, removed when stuck */
  sent: number; arrived: number; diverted: number; towed: number;
  /** sum of the arrived vehicles' travel times (s) */
  travelSum: number;
  /** arrivals waiting to get onto the road at the entry point */
  backlog: number;
  /** spawn attempts that found no route to the exit */
  noRoute: number;
}

/** a traffic counter on one direction of a road: vehicles passing the middle of the road */
export interface Counter {
  total: number; cars: number; trucks: number; buses: number;
  /** sum of passing speeds (m/s), for the average */
  speedSum: number;
  /** ticks of recent passes (last 5 minutes) */
  recent: number[];
}

/** one test vehicle: where it was sent, and how it went (time in s once it has left the plan) */
export interface TestTrip { id: number; from: string; to: string; lane: number; sentAt: number; done: null | "arrived" | "elsewhere" | "stuck"; time: number }

export interface Stats {
  count: number; cars: number; trucks: number; buses: number;
  avgSpeed: number; stopped: number; tripsPerMin: number;
  trips: number; towed: number; boarded: number; laneChanges: number;
  history: { t: number; speed: number; stopped: number }[];
}

export const KIND_PARAMS = (kind: Kind, r: () => number, P: SimParams = resolveParams()) =>
  kind === "car"
    ? { len: 4.6, width: 1.9, pref: P.speedPref + r() * 0.22, a: P.carAccel + r() * 0.5, b: P.carBrake, bmax: 9, T: P.carHeadway + r() * 0.4, s0: P.carMinGap, politeness: P.politeness + r() * 0.4 }
    : kind === "truck"
      ? { len: 10 + r() * 2, width: 2.5, pref: 0.8 + r() * 0.08, a: P.truckAccel + r() * 0.2, b: 1.5, bmax: 6.5, T: P.truckHeadway + r() * 0.3, s0: 3, politeness: 0.5 }
      : { len: 12, width: 2.55, pref: 0.85, a: 0.9, b: 1.6, bmax: 7, T: 1.5, s0: 2.5, politeness: 0.5 };

/**
 * Vehicles on each piece (lane, connector, ring stretch), rebuilt every tick. Lists are kept and
 * emptied rather than reallocated; an unused piece has no list (or an empty one).
 */
export class PieceIndex {
  private lists: (Vehicle[] | undefined)[] = [];
  private used: number[] = [];
  /** the same lists sorted by position (built on first use, until the list changes) */
  private views: (SortedView | undefined)[] = [];
  get(id: number): Vehicle[] | undefined { return this.lists[id]; }
  add(id: number, v: Vehicle) {
    let l = this.lists[id];
    if (!l) this.lists[id] = l = [];
    if (!l.length) this.used.push(id);
    l.push(v);
    const sv = this.views[id]; if (sv) sv.fresh = false;
  }
  clear() { for (const id of this.used) { this.lists[id]!.length = 0; const sv = this.views[id]; if (sv) sv.fresh = false; } this.used.length = 0; }
  /**
   * Vehicles on a piece by position (s ascending; equal positions keep list order), each with its
   * place in the list (`ord`, for breaking ties exactly as a scan of the list would) and the longest
   * vehicle's length. Only valid while positions don't change (sort again after a list changes).
   */
  sorted(id: number): SortedView | undefined {
    const l = this.lists[id];
    if (!l || !l.length) return undefined;
    let sv = this.views[id];
    if (sv && sv.fresh) return sv;
    if (!sv) this.views[id] = sv = { vs: [], ord: [], maxLen: 0, fresh: false };
    // insertion sort by (s, place in the list) into reused arrays: no allocation, and short lists are cheap
    const vs = sv.vs, ord = sv.ord, n = l.length;
    vs.length = n; ord.length = n;
    let maxLen = 0;
    for (let i = 0; i < n; i++) {
      const u = l[i], s = u.s;
      if (u.len > maxLen) maxLen = u.len;
      let j = i - 1;
      while (j >= 0 && vs[j].s > s) { vs[j + 1] = vs[j]; ord[j + 1] = ord[j]; j--; }
      vs[j + 1] = u; ord[j + 1] = i;
    }
    sv.maxLen = maxLen; sv.fresh = true;
    return sv;
  }
}
export interface SortedView { vs: Vehicle[]; ord: number[]; maxLen: number; fresh: boolean }

/** State, the vehicle index, logging and helpers shared by every layer. */
export abstract class SimBase {
  readonly net: Compiled;
  private _settings!: PlanSettings;
  /** the run's parameters (defaults plus the plan's own), kept in step with `settings` */
  P: SimParams = resolveParams();
  get settings(): PlanSettings { return this._settings; }
  set settings(s: PlanSettings) { this._settings = s; this.P = resolveParams(s.params); }
  tick = 0;
  vehicles: Vehicle[] = [];
  stats: Stats = { count: 0, cars: 0, trucks: 0, buses: 0, avgSpeed: 0, stopped: 0, tripsPerMin: 0, trips: 0, towed: 0, boarded: 0, laneChanges: 0, history: [] };
  protected rng: () => number;
  /** test vehicles sent by hand, in order */
  tests: TestTrip[] = [];
  protected nextId = 1;
  protected ns: NodeState[];
  /** pedestrian crossings by node index and arm (empty where there are no pedestrians) */
  protected peds: PedCross[][];
  /** pedestrians use their own random numbers, so adding them leaves the rest of a run as it was */
  protected pedRng: () => number;
  protected index = new PieceIndex();
  protected groupIndex = new Map<number, Vehicle[]>();
  protected ema: Float64Array;
  protected tripLog: number[] = [];
  protected gateways: CNode[];
  protected edgeWeights: number[];
  protected totalLen: number;
  /** turn from one edge into another, by inIdx * edges + outIdx */
  protected moveTab = new Map<number, Movement>();
  // routing constants: free-flow time per edge, turns out of each edge, delay at each junction
  protected freeTime: Float64Array;
  protected movesFrom: (Movement[] | undefined)[];
  protected nodeDelay: Float64Array;
  // route search buffers (see plan)
  protected aG = new Float64Array(0); protected aPar = new Int32Array(0); protected aSeen = new Uint32Array(0); protected aClosed = new Uint32Array(0);
  protected aGen = 0; protected aHeapF = new Float64Array(256); protected aHeapE = new Int32Array(256);
  /** cumulative building trip weights, parallel to net.places */
  protected placeCum: Float64Array;
  protected maxSpeed: number;
  /**
   * Vehicles entering, or cleared to enter, each roundabout (a superset: callers check the live
   * state). Rebuilt every tick and added to when a vehicle is cleared, so roundabout checks look at
   * a handful of vehicles instead of every vehicle in the plan.
   */
  protected ringClaims = new Map<CNode, Vehicle[]>();
  /** transit flows, parallel to net.flows */
  protected flowState: FlowState[] = [];
  /** zone-to-zone demand, parallel to net.zoneFlows */
  protected zoneFlowState: FlowState[] = [];
  /** traffic counters by edge index (roads with `counter` on; null elsewhere) */
  protected counters: (Counter | null)[] = [];
  /** vehicles that crossed each node so far, and the ticks of recent crossings (last minute) */
  protected nodeThrough: number[] = [];
  protected nodeRecent: number[][] = [];
  // ------------------------------------------------------------ junction event log
  /** node indexes whose events are recorded (see `logAll` to record every junction) */
  logNodes = new Set<number>();
  logAll = false;
  /** recorded events, oldest first (capped) */
  events: JunctionEvent[] = [];
  protected lastDeny = new Map<number, string>();
  /** vehicles that took each movement so far, keyed "inEdgeIdx>outEdgeIdx" */
  turnCounts = new Map<string, number>();
  /** vehicles that entered through each entry point so far (by node id) */
  entered = new Map<string, number>();
  /** vehicles that left the plan through each exit point so far (by node id) */
  exited = new Map<string, number>();
  /** when vehicles entered / left at each entry point lately (ticks, the last GATE_WINDOW) */
  private gateRecent = new Map<string, { in: number[]; out: number[] }>();
  /** arrivals waiting to get onto the road at metered entry points */
  protected backlog = new Map<CNode, number>();
  constructor(network: Network | Compiled, settings: PlanSettings) {
    this.net = "nodeById" in network ? network : compile(network, { outlines: false });
    this.settings = { ...settings };
    this.rng = mulberry32(settings.seed || 7);
    this.ema = new Float64Array(this.net.edges.length);
    this.ns = this.net.nodes.map(node => {
      return { node, occ: [], req: new Map(), phase: 0, stage: 0, t: 0, demand: node.phases.map(() => -1e9), cyc: node.arms.map(() => ({ count: 0, greenAt: 0, hist: [] })) };
    });
    this.peds = this.net.nodes.map(n => (n.peds > 0 ? (n.degree === 2 ? [n.arms[0]] : n.arms).map(() => ({ waiting: 0, since: 0, crossing: 0, from: 0, until: 0, redSince: -1, claim: false, crossed: 0, waitSum: 0 })) : []));
    this.pedRng = mulberry32(((settings.seed || 7) * 7919) ^ 0x9ed5);
    this.gateways = this.net.nodes.filter(n => n.gateway);
    this.edgeWeights = this.net.edges.map(e => Math.max(0, e.length - 6));
    this.totalLen = this.edgeWeights.reduce((a, b) => a + b, 0);
    const E = this.net.edges.length;
    for (const e of this.net.edges) for (const m of e.to.moves.get(e.idx) ?? []) { const k = e.idx * E + m.out.idx; if (!this.moveTab.has(k)) this.moveTab.set(k, m); }
    this.freeTime = Float64Array.from(this.net.edges, e => e.length / e.speed);
    this.movesFrom = this.net.edges.map(e => e.to.moves.get(e.idx));
    this.nodeDelay = Float64Array.from(this.net.nodes, n => (n.controlled ? (n.def.control === "lights" ? 6 : n.def.control === "stop" ? 5 : n.ringR ? 2 : 3) : 0));
    this.placeCum = new Float64Array(this.net.places.length);
    let acc = 0;
    this.net.places.forEach((p, i) => (this.placeCum[i] = acc += p.w));
    this.maxSpeed = Math.max(13.9, ...this.net.edges.map(e => e.speed));
    this.flowState = this.net.flows.map(() => ({ sent: 0, arrived: 0, diverted: 0, towed: 0, travelSum: 0, backlog: 0, noRoute: 0 }));
    this.zoneFlowState = this.net.zoneFlows.map(() => ({ sent: 0, arrived: 0, diverted: 0, towed: 0, travelSum: 0, backlog: 0, noRoute: 0 }));
    this.counters = this.net.edges.map(e => (e.link.counter ? { total: 0, cars: 0, trucks: 0, buses: 0, speedSum: 0, recent: [] } : null));
  }
  get time() { return this.tick * DT; }
  // ------------------------------------------------------------ helpers
  protected moveOf(eIn: Edge, eOut: Edge): Movement | undefined {
    return this.moveTab.get(eIn.idx * this.net.edges.length + eOut.idx);
  }
  /** arm of `node` that edge `e` arrives on (-1 if it doesn't arrive there) */
  protected armOf(node: CNode, e: Edge) { return e.to === node ? e.inArm : -1; }
  /** highest lane index a general-traffic vehicle may use on edge e */
  protected maxLane(v: Vehicle, e: Edge) { return v.kind !== "bus" && e.bus ? e.n - 2 : e.n - 1; }
  protected lim(v: Vehicle, p: Piece) { return p.kind === "lane" ? Math.min(p.vmax, p.edge.speed * v.pref) : p.vmax * this.P.junctionSpeed; }
  protected pick<T>(arr: T[]) { return arr[(this.rng() * arr.length) | 0]; }
  /** a copy in random order (Fisher–Yates; every order equally likely) */
  protected shuffled<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) { const j = (this.rng() * (i + 1)) | 0; const t = out[i]; out[i] = out[j]; out[j] = t; }
    return out;
  }
  protected pickWeighted<T>(arr: T[], w: (x: T) => number) {
    const total = arr.reduce((a, x) => a + w(x), 0);
    let x = this.rng() * total;
    for (const a of arr) { x -= w(a); if (x <= 0) return a; }
    return arr[arr.length - 1];
  }
  protected idm(v: Vehicle, gap: number, lv: number, v0: number) {
    const fr = v.v / Math.max(v0, 0.5), fr2 = fr * fr, free = 1 - fr2 * fr2;
    if (!isFinite(gap)) return v.a * free;
    const ss = v.s0 + Math.max(0, v.v * v.T + (v.v * (v.v - lv)) / (2 * Math.sqrt(v.a * v.b)));
    const q = ss / Math.max(gap, 0.2);
    return v.a * (free - q * q);
  }
  protected laneClear(p: Piece, s: number, range: number) {
    const list = this.index.get(p.id);
    if (list) for (const u of list) if (Math.abs(u.s - s) < range + u.len) return false;
    return true;
  }
  protected addToIndex(v: Vehicle) {
    this.index.add(v.piece.id, v);
    if (v.piece.kind === "conn") { let g = this.groupIndex.get(v.piece.entryKey); if (!g) this.groupIndex.set(v.piece.entryKey, (g = [])); g.push(v); }
    if (v.piece.kind === "conn" && v.piece.role === "entry" && v.piece.node.ring) this.claimRing(v.piece.node, v);
    else if (v.granted && v.conn?.role === "entry" && v.conn.node.ring) this.claimRing(v.conn.node, v);
  }
  protected claimRing(n: CNode, v: Vehicle) { let l = this.ringClaims.get(n); if (!l) this.ringClaims.set(n, (l = [])); l.push(v); }
  protected buildIndex() {
    this.index.clear(); this.groupIndex.clear(); this.ringClaims.clear();
    for (const v of this.vehicles) if (!v.dead) this.addToIndex(v);
  }
  protected logging(n: CNode) { return this.logAll ? n.controlled : this.logNodes.has(n.idx); }
  /** roads whose vehicle events are recorded (by link id) */
  logLinks = new Set<string>();
  protected roadLogged(e: Edge) { return this.logLinks.size > 0 && this.logLinks.has(e.link.id); }
  /** an event on a road (recorded only for roads being logged) */
  protected evRoad(e: Edge, v: Vehicle, kind: JunctionEvent["kind"], detail: string) {
    if (!this.roadLogged(e)) return;
    const dir = e.dir === 1 ? "→" : "←";
    this.events.push({ t: Math.round(this.tick) / 10, node: "", link: e.link.id, veh: v.id, vkind: v.kind, kind, detail: `${dir} lane ${v.lane + 1} · ${detail}`, data: { lane: v.lane + 1, from: e.link.id } });
    if (this.events.length > 60000) this.events.splice(0, 10000);
  }
  protected ev(n: CNode, v: Vehicle | null, kind: JunctionEvent["kind"], detail = "", data?: JunctionEvent["data"]) {
    if (!this.logging(n)) return;
    this.events.push({ t: Math.round(this.tick) / 10, node: n.def.id, veh: v ? v.id : null, vkind: v ? v.kind : null, kind, detail, ...(data ? { data } : {}) });
    if (this.events.length > 60000) this.events.splice(0, 10000);
  }
  protected md(m: Movement, lane?: number, outLane?: number): JunctionEvent["data"] {
    return { turn: m.turn, from: m.in.link.id, to: m.out.link.id, lo: m.lo + 1, hi: m.hi + 1, ...(lane !== undefined ? { lane: lane + 1 } : {}), ...(outLane !== undefined ? { outLane: outLane + 1 } : {}) };
  }
  /** describe a movement for the log: "S lane 2→1 (road NE→SW)" */
  protected mv(c: Conn | Movement, lane?: number) {
    const m = "move" in c ? c.move : c;
    const inL = "inLane" in c ? c.inLane : lane, outL = "outLane" in c ? c.outLane : undefined;
    // lanes are numbered from 1 = leftmost (next to the centre line), as in the inspector
    return `${m.turn} from ${m.in.link.name || m.in.link.id}${inL !== undefined ? ` lane ${inL + 1}` : ""} to ${m.out.link.name || m.out.link.id}${outL !== undefined ? ` lane ${outL + 1}` : ""}`;
  }
  /** a vehicle passed the middle of a counted road (only observes: nothing here affects traffic) */
  protected countPass(v: Vehicle, edgeIdx: number) {
    const c = this.counters[edgeIdx];
    if (!c) return;
    c.total++; c.speedSum += v.v;
    if (v.kind === "car") c.cars++; else if (v.kind === "truck") c.trucks++; else c.buses++;
    c.recent.push(this.tick);
    const since = this.tick - 3000;
    while (c.recent.length && c.recent[0] < since) c.recent.shift();
  }
  protected countGate(id: string, dir: "in" | "out") {
    const total = dir === "in" ? this.entered : this.exited;
    total.set(id, (total.get(id) ?? 0) + 1);
    let r = this.gateRecent.get(id);
    if (!r) this.gateRecent.set(id, (r = { in: [], out: [] }));
    const list = r[dir];
    list.push(this.tick);
    if (list.length > 64 && list[0] < this.tick - GATE_WINDOW) list.splice(0, list.findIndex(t => t >= this.tick - GATE_WINDOW));
  }
  /** per entry / exit point: vehicles per hour in and out, over the last 5 minutes (or since the start) */
  gateRates(): [string, number, number][] {
    const since = this.tick - GATE_WINDOW, span = Math.max(1, Math.min(GATE_WINDOW, this.tick)) * DT;
    const rate = (l: number[]) => { let k = 0; while (k < l.length && l[k] < since) k++; return ((l.length - k) / span) * 3600; };
    return [...this.gateRecent].map(([id, r]) => [id, rate(r.in), rate(r.out)]);
  }
  protected kill(v: Vehicle, why: "exit" | "arrived" | "towed" | "removed") {
    if (v.dead) return;
    if (why === "exit" && v.piece.kind === "lane") this.countGate(v.piece.edge.to.def.id, "out");
    if (v.piece.kind === "lane") this.evRoad(v.piece.edge, v, why === "exit" ? "exit" : why === "arrived" ? "arrive" : why === "towed" ? "towed" : "leave-road",
      why === "exit" ? "leaves the plan" : why === "arrived" ? "reached its destination" : why === "towed" ? `removed after ${v.wait.toFixed(0)} s stuck (${v.state})` : "removed (no way on)");
    v.dead = true;
    if (v.test !== undefined && v.test >= 0) {
      const t = this.tests[v.test];
      t.done = why === "exit" && v.dest.kind === "gateway" && v.dest.node.def.id === t.to ? "arrived" : why === "towed" ? "stuck" : "elsewhere";
      t.time = (this.tick - v.bornT) * DT;
    }
    if (why === "exit" || why === "arrived") { this.stats.trips++; this.tripLog.push(this.tick); }
    else if (why === "towed") this.stats.towed++;
    if (v.flow >= 0) {
      const f = this.flowState[v.flow], to = this.net.flows[v.flow].to;
      if (why === "exit" && v.dest.kind === "gateway" && v.dest.node === to) { f.arrived++; f.travelSum += (this.tick - v.bornT) * DT; }
      else if (why === "exit") f.diverted++;
      else if (why === "towed") f.towed++;
    }
    if (v.zflow >= 0) {
      const f = this.zoneFlowState[v.zflow];
      if ((why === "exit" || why === "arrived") && v.dest === v.goal) { f.arrived++; f.travelSum += (this.tick - v.bornT) * DT; }
      else if (why === "exit" || why === "arrived") f.diverted++;
      else if (why === "towed") f.towed++;
    }
  }
  protected exitRoom(st: NodeState, c: Conn, v: Vehicle) {
    const out = c.outEdge.lanes[c.outLane];
    let rear = Infinity;
    const list = this.index.get(out.id);
    // room that will be there by the time we arrive: a vehicle already driving away frees space
    // (only when it has free road ahead of it: one about to stop at a queue frees nothing)
    if (list) for (const u of list) rear = Math.min(rear, u.s - u.len + (u.v > 1.5 ? u.v * 2 : 0));
    let need = v.len + 1.5;
    for (const o of st.occ) if (!o.entered && o.conn.outEdge === c.outEdge && o.conn.outLane === c.outLane) need += o.v.len + 2;
    return rear >= need || out.len < need;
  }
}
