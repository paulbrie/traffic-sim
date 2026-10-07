/** Simulation engine, bottom layer: shared state, vehicle index, logging, helpers (see ./index.ts). */
import { compile, type CLine, type CNode, type Compiled, type Conn, type CStop, type Edge, type LanePiece, type Movement, type Piece } from "../compile";
import { mulberry32 } from "../geom";
import type { Network, PlanSettings } from "../types";
import { resolveParams, type SimParams } from "../params";
import { isJunction, junctionRefs } from "../refs";
import { crossingSpan } from "../crossings";
import { PARKING } from "../types";
import { CAR_LEN, accessLen, bodyOnPath } from "../parking";
import { exitLanesOf, laneAllowed } from "../compile";

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
  /**
   * the junction after the one it is crossing (or has been let into), asked for early because its
   * line is near: the crossing it asked for, when, how far off it is now (m), and whether it may go
   */
  early?: { conn: Conn; at: number; d: number; granted: boolean } | null;
  dest: Dest; state: string; wait: number; enterT: number; bornT: number;
  /** seconds spent in traffic so far: stopped, queuing or crawling (under 30% of the speed it wants here) */
  jam: number;
  /** 1: its engine failed (rolls to a stop, hazard lights on); 2: wrecked (stopped where it was hit). Either
   *  way it stays in its lane as an obstacle from `brokenAt` (tick) until towed away */
  broken: 0 | 1 | 2; brokenAt: number;
  gap: number; leader: Vehicle | null; v0: number;
  /** an aggressive driver: wants to go over the limit (see SimParams.aggressiveShare) */
  aggressive: boolean;
  reroutes: number; laneChanges: number; lcCool: number; lcOff: number; lcT: number;
  /** the lane-change glide runs over this many metres (one through a joint whose lanes aren't in line), not over time */
  lcBy?: number;
  /** just out of a bay: how far its front and rear were from where they are now, eased away as blendT runs down (1 → 0, over a second) */
  blend?: { fx: number; fy: number; rx: number; ry: number }; blendT?: number;
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
  /** fuel burnt so far (mL), and of it standing still in traffic, while the whole plan's fuel is measured */
  fuel?: number; fuelIdle?: number;
  /** driving to park: the row (index into net.parking) and the bay kept for it; `parkWait`: by it, waiting to turn in */
  park?: { row: number; bay: number } | null; parkWait?: boolean;
  /** when it started waiting by its bay (tick) */
  parkSince?: number;
  /** when the console was last told it has waited very long in a jam (tick) */
  stuckAt?: number;
  /**
   * On a bay's path (see BayAccess), like a connector: in or out, how far along it (m); `inLane`: part of the
   * car is in the lane (it is in the lane's traffic only then); `go`: pulling out, it has its gap in the lane.
   */
  bayMove?: { row: number; bay: number; way: "in" | "out"; s: number; inLane: boolean; go: boolean; ready?: boolean } | null;
}

/** a row of parking bays as it is now: per bay the tick its car leaves (0 = free, -1 = kept for a car on its way), and totals */
export interface ParkState {
  until: Float64Array;
  /** cars waiting to set off for the row (arrivals), cars that parked, pulled out, found it full */
  queue: number; parked: number; left: number; full: number;
}
/** a row of parking bays' numbers: bays, taken now, kept for cars on their way, and the totals so far */
export interface ParkingStats { bays: number; taken: number; coming: number; parked: number; left: number; full: number }

/** where a lane or a path through a junction runs over a crossing drawn by hand (arc length on that piece) */
export interface CrossOn { k: number; piece: Piece; s0: number; s1: number }
/**
 * Something that shouldn't happen in traffic, kept for the console to debug with: a vehicle taken off the
 * plan (towed after being stuck, a breakdown towed, a wreck cleared, one with no way on), one waiting very long
 * in a jam (left where it is), or two vehicles overlapping. `x`, `y` where (world m), `at` on what (a road or a junction).
 */
export interface SimProblem {
  t: number; kind: "towed" | "breakdown" | "wreck" | "removed" | "overlap" | "stuck";
  veh: number; vkind: Vehicle["kind"]; other?: number; x: number; y: number; at: string; detail: string;
}
/** a stretch (from s0 to s1, m along it) of a lane or junction path that a car's body sweeps on a bay's path */
export interface SweepSpan { piece: Piece; s0: number; s1: number }
/** a crossing drawn by hand as the simulation sees it: its pedestrians, what runs over it, and the lights it follows */
export interface CrossInfo { ped: PedCross; on: CrossOn[]; lit: CNode | null; through: Conn[] }

/** a reversible corridor's middle lane: closed, open to direction 1, closing (clearing) from direction 1, open to 2, closing from 2 */
export const REV_STATES = ["closed", "open 1", "clearing 1", "open 2", "clearing 2"] as const;
export type RevStateCode = 0 | 1 | 2 | 3 | 4;
export interface RevState {
  state: RevStateCode;
  /** tick the state began */
  since: number;
  /** set by hand (Sim.reversibleCommand): what it should be, overriding the corridor's mode; null = its mode decides */
  hold: "closed" | "1" | "2" | null;
  /** the direction it was last open to (1, 2), so a timer alternates */
  last: 1 | 2;
  /** vehicles in the middle lane (counted while clearing) */
  inside: number;
  /** vehicles per km per lane each way (dynamic mode; updated every few seconds) */
  density: [number, number];
}

export interface Occ { v: Vehicle; conn: Conn; entered: boolean; /** permissive turn clearing on yellow/all-red */ sneak?: boolean }
export interface Req { v: Vehicle; conn: Conn; d: number; at: number; /** asked before reaching the road into the junction (see Vehicle.early) */ early?: boolean }
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
    | "appear" | "enter-road" | "state" | "leave-road" | "exit" | "arrive" | "reversible" | "breakdown";
  detail: string;
  /** machine-readable bits for analysis (lanes are 1-based) */
  data?: { turn?: string; from?: string; to?: string; lane?: number; outLane?: number; lo?: number; hi?: number; sig?: string | null; code?: string };
}

export interface NodeState {
  node: CNode;
  occ: Occ[];
  req: Map<number, Req>;
  phase: number; stage: 0 | 1 | 2; t: number;
  /** the phase before this one (-1: none yet) */
  prev: number;
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
  /** the whole plan's fuel use (PlanSettings.fuel on), see FuelStats */
  fuel?: FuelStats;
}

/**
 * Fuel burnt across the plan since it was switched on (litres): all of it, the part standing still
 * in traffic (waiting at lights, queuing), the distance driven (km) and vehicle-seconds standing
 * still; trips started and finished while it was on, and their fuel; when it was switched on (s).
 */
export interface FuelStats { total: number; idle: number; km: number; idleTime: number; trips: number; tripFuel: number; since: number }

/** fuel measured at one junction since `since` (s): what vehicles burnt on its approaches and in it (see PlanSettings.fuelNodes) */
export interface JunctionFuel {
  /** litres in all, of it standing still, of it inside the junction; vehicle-seconds standing still on the approaches */
  total: number; idle: number; inside: number; idleTime: number;
  /** vehicles that crossed while it was measured */
  crossed: number;
  since: number;
  /** per road leading in (in the order of junctionStats().approaches): litres, and of it standing still */
  approaches: { total: number; idle: number }[];
}

/** fuel per junction is measured on this much of each road leading in (m before the stop line) */
export const FUEL_APPROACH = 300;

/** a junction's fuel tallies (mL; idle time in s); `since` = tick measuring began, -1 = not measured */
export interface NodeFuel { since: number; through0: number; inside: number; idleTime: number }

export const KIND_PARAMS = (kind: Kind, r: () => number, P: SimParams = resolveParams()) =>
  kind === "car"
    // (an aggressive driver wants to go over the limit; the extra draw only when there are any, so runs without stay as they were)
    ? P.aggressiveShare > 0 && r() < P.aggressiveShare / 100
      ? { len: 4.6, width: 1.9, pref: 1 + (P.aggressiveExcess / 100) * (0.2 + 0.8 * r()), aggressive: true, a: P.carAccel + r() * 0.5, b: P.carBrake, bmax: 9, T: P.carHeadway + r() * 0.4, s0: P.carMinGap, politeness: P.politeness + r() * 0.4 }
      : { len: 4.6, width: 1.9, pref: P.speedPref + r() * 0.22, aggressive: false, a: P.carAccel + r() * 0.5, b: P.carBrake, bmax: 9, T: P.carHeadway + r() * 0.4, s0: P.carMinGap, politeness: P.politeness + r() * 0.4 }
    : kind === "truck"
      ? { len: 10 + r() * 2, width: 2.5, pref: 0.8 + r() * 0.08, aggressive: false, a: P.truckAccel + r() * 0.2, b: 1.5, bmax: 6.5, T: P.truckHeadway + r() * 0.3, s0: 3, politeness: 0.5 }
      : { len: 12, width: 2.55, pref: 0.85, aggressive: false, a: 0.9, b: 1.6, bmax: 7, T: 1.5, s0: 2.5, politeness: 0.5 };

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
  // fuel (see ./fuel and Sim.burnFuel): per edge burnt on its last FUEL_APPROACH m (mL), of it standing still; per node tallies
  protected edgeFuel: Float64Array;
  protected edgeIdle: Float64Array;
  protected nodeFuel: NodeFuel[];
  /** whether the whole plan was measured on the previous tick (to notice it being switched) */
  protected fuelAll = false;
  /** reversible corridors, parallel to net.corridors */
  protected revs: RevState[] = [];
  /** rows of parking bays, parallel to net.parking (they use their own random numbers: plans without parking run as before) */
  protected parks: ParkState[] = [];
  protected parkRng: () => number;
  /** crossings drawn by hand, parallel to net.crossings, and what runs over them by piece id */
  protected crosses: CrossInfo[] = [];
  protected crossOn = new Map<number, CrossOn[]>();
  /**
   * Where each bay's ways in and out pass, per row and bay: the stretch of every lane and junction path (any
   * road) a car's body sweeps going in, and coming out. Worked out once, at the start (see initBaySweeps).
   */
  protected sweeps: { in: SweepSpan[]; out: SweepSpan[] }[][] = [];
  /** stretches kept clear by piece id, for cars on a bay's path (going in, or coming out: waiting with priority, or on their way) */
  protected bayHolds = new Map<number, { v: Vehicle; z0: number; z1: number }[]>();
  /**
   * by lane (piece id): vehicles of another lane of the same road partly in this one, changing lanes (or gliding
   * over after a joint whose lanes aren't in line): traffic here keeps clear of them as of a vehicle ahead
   */
  protected ghosts = new Map<number, Vehicle[]>();
  /** by lane (piece id): vehicles on a path through the junction before it, coming into it */
  protected intoLane = new Map<number, Vehicle[]>();
  /** by piece id: vehicles whose front has gone on but whose body is still over it (from `s0` to its end) */
  protected tails = new Map<number, { v: Vehicle; s0: number }[]>();
  /** cars on a bay's path (as of the last index; whether they have set off is read as it is now) */
  protected bayMovers: Vehicle[] = [];
  /** a reversible middle lane open to edge `e`'s direction: vehicles may change into it */
  protected revOpenFor(e: Edge) { return e.corr >= 0 && this.revs[e.corr].state === (e.cdir === 1 ? 1 : 3); }
  /** open or clearing in edge `e`'s direction: vehicles already in the lane carry on */
  protected revInside(e: Edge) { if (e.corr < 0) return false; const s = this.revs[e.corr].state; return e.cdir === 1 ? s === 1 || s === 2 : s === 3 || s === 4; }
  /** may vehicles move into (or be in) lane `k` of edge `e`; `already` = the vehicle is in it now */
  protected laneUsable(e: Edge, k: number, already = false) { return !e.rev || k !== 0 || (already ? this.revInside(e) : this.revOpenFor(e)); }
  // ------------------------------------------------------------ junction event log
  /** node indexes whose events are recorded (see `logAll` to record every junction) */
  logNodes = new Set<number>();
  logAll = false;
  /** recorded events, oldest first (capped) */
  events: JunctionEvent[] = [];
  /** what went wrong (see SimProblem), oldest first, the latest 5000 */
  problems: SimProblem[] = [];
  protected lastDeny = new Map<number, string>();
  /** lanes (by piece id) a vehicle at the junction before is waiting to drive into, for room: when it last asked */
  protected exitWanted = new Map<number, number>();
  /** why the junction ahead last said no, for every vehicle (logged or not): told in the console when one is towed */
  protected denyWhy = new Map<number, string>();
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
      return { node, occ: [], req: new Map(), phase: 0, stage: 0, t: 0, prev: -1, demand: node.phases.map(() => -1e9), cyc: node.arms.map(() => ({ count: 0, greenAt: 0, hist: [] })) };
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
    this.edgeFuel = new Float64Array(this.net.edges.length);
    this.edgeIdle = new Float64Array(this.net.edges.length);
    this.nodeFuel = this.net.nodes.map(() => ({ since: -1, through0: 0, inside: 0, idleTime: 0 }));
    this.parkRng = mulberry32(((settings.seed || 7) * 104729) ^ 0x5a7c);
    this.parks = this.net.parking.map(p => {
      const st: ParkState = { until: new Float64Array(p.bays.length), queue: 0, parked: 0, left: 0, full: 0 };
      // (filled to about its usual share at the start; stays are exponential, so what is left of each is a whole stay again)
      const occ = p.def.occupancy ?? PARKING.occupancy;
      for (let i = 0; i < st.until.length; i++) if (this.parkRng() < occ) st.until[i] = 1 + this.stayTicks(p.def.stay);
      return st;
    });
    this.initCrossings();
    this.initBaySweeps();
    this.revs = this.net.corridors.map(c => {
      const d = c.def, first: RevStateCode = d.mode === "timer" ? (d.open1 > 0 ? 1 : d.open2 > 0 ? 3 : 0) : d.mode === "manual" ? (d.initial === "1" ? 1 : d.initial === "2" ? 3 : 0) : 0;
      return { state: first, since: 0, hold: null, last: first === 3 ? 2 : first === 1 ? 1 : 2, inside: 0, density: [0, 0] };
    });
  }
  get time() { return this.tick * DT; }
  /**
   * What each bay's ways in and out pass over (see `sweeps`): a car's outline (front, middle, rear; middle and
   * both sides) moved along the path every 40 cm, against the lanes near the row (on a 25 m grid).
   */
  private initBaySweeps() {
    if (!this.net.parking.length) return;
    const CELL = 25, grid = new Map<number, Piece[]>(), key = (i: number, j: number) => i * 1_000_003 + j;
    const cellsOf = (x0: number, y0: number, x1: number, y1: number, f: (k: number) => void) => {
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) f(key(i, j));
    };
    const put = (p: Piece) => {
      const pts = p.poly.pts;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < pts.length; k += 2) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]); }
      cellsOf(x0 - 2, y0 - 2, x1 + 2, y1 + 2, k => { const l = grid.get(k); if (l) l.push(p); else grid.set(k, [p]); });
    };
    for (const e of this.net.edges) for (const lp of e.lanes) put(lp);
    // (lanes only: paths through junctions run close together near a lane's start, and would count every car
    // waiting at the junction as in the way; what is about to come out of the junction is checked as it comes)
    const halfWidth = (p: Piece) => (p.kind === "lane" ? p.edge.lw / 2 : p.kind === "conn" ? Math.max(p.inEdge.lw, p.outEdge.lw) / 2 : 1.6);
    const W = 0.95;
    this.sweeps = this.net.parking.map(row => row.access.map(acc => {
      const sweep = (way: "in" | "out"): SweepSpan[] => {
        const L = accessLen(acc, way), spans = new Map<Piece, [number, number]>();
        for (let d = 0; ; d = Math.min(L, d + 0.4)) {
          const b = bodyOnPath(acc, way, d, CAR_LEN), ux = b.fx - b.rx, uy = b.fy - b.ry, m = Math.hypot(ux, uy) || 1, nx = -uy / m, ny = ux / m;
          for (const f of [0, 0.5, 1]) for (const side of [-W, 0, W]) {
            const x = b.rx + ux * f + nx * side, y = b.ry + uy * f + ny * side;
            cellsOf(x, y, x, y, k => {
              for (const p of grid.get(k) ?? []) {
                const pr = p.poly.project(x, y);
                if (pr.d > halfWidth(p) + 0.05) continue;
                const sp = spans.get(p);
                if (sp) { sp[0] = Math.min(sp[0], pr.s); sp[1] = Math.max(sp[1], pr.s); } else spans.set(p, [pr.s, pr.s]);
              }
            });
          }
          if (d >= L) break;
        }
        return [...spans].map(([piece, [a, b]]) => ({ piece, s0: Math.max(0, a - 0.8), s1: Math.min(piece.len, b + 0.8) }));
      };
      return { in: sweep("in"), out: sweep("out") };
    }));
  }
  /** a car's stay in a bay (ticks): around the row's average (exponential, so some stay long) */
  protected stayTicks(stay?: number) { return Math.max(60, -Math.log(1 - this.parkRng() * 0.999) * (stay ?? PARKING.stay) * 600); }
  /**
   * What runs over each crossing drawn by hand: lanes, and paths through the junctions near it (built
   * now, so every path is known), and the traffic lights it follows: a lit junction whose paths cross it,
   * or whose road it is on just before or after the junction. Its pedestrians walk while the straight-on
   * traffic over it has red.
   */
  private initCrossings() {
    if (!this.net.crossings.length) return;
    // (lanes and junctions by 25 m cell, so each crossing only looks at what is near it: plans with thousands
    // of crossings start in moments rather than comparing every crossing with every lane)
    const CELL = 25, grid = new Map<number, LanePiece[]>(), nodeGrid = new Map<number, CNode[]>();
    const key = (i: number, j: number) => i * 1_000_003 + j;
    const cellsOf = (x0: number, y0: number, x1: number, y1: number, f: (k: number) => void) => {
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) f(key(i, j));
    };
    for (const e of this.net.edges) for (const lp of e.lanes) {
      const pts = lp.poly.pts;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < pts.length; k += 2) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]); }
      cellsOf(x0, y0, x1, y1, k => { const l = grid.get(k); if (l) l.push(lp); else grid.set(k, [lp]); });
    }
    for (const n of this.net.nodes) if (n.controlled && !n.ringR) cellsOf(n.pos.x, n.pos.y, n.pos.x, n.pos.y, k => { const l = nodeGrid.get(k); if (l) l.push(n); else nodeGrid.set(k, [n]); });
    for (const c of this.net.crossings) {
      const on: CrossOn[] = [], xs = c.corners.map(p => p.x), ys = c.corners.map(p => p.y);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const add = (piece: Piece) => { const sp = crossingSpan(c, piece.poly); if (sp) on.push({ k: c.idx, piece, s0: sp[0], s1: sp[1] }); };
      const lanes = new Set<LanePiece>();
      cellsOf(x0, y0, x1, y1, k => { for (const lp of grid.get(k) ?? []) lanes.add(lp); });
      for (const lp of lanes) add(lp);
      // junctions whose paths could run over it: those with their point within reach (paths stay within a junction's area)
      const near = new Set<CNode>(), R = 60;
      cellsOf(x0 - R, y0 - R, x1 + R, y1 + R, k => { for (const n of nodeGrid.get(k) ?? []) near.add(n); });
      for (const n of near) for (const ms of n.moves.values()) for (const m of ms) for (let a = 0; a < m.in.n; a++) {
        if (!laneAllowed(m, a)) continue;
        for (const b of exitLanesOf(m, a)) add(this.net.getConn(m, a, b));
      }
      // the lights: a lit junction whose paths run over it, else one whose road it is on near the line
      const conns = on.flatMap(o => (o.piece.kind === "conn" ? [o.piece] : []));
      let lit: CNode | null = conns.find(x => x.node.def.control === "lights")?.node ?? null;
      if (!lit) for (const o of on) if (o.piece.kind === "lane") {
        const e = o.piece.edge;
        if (e.to.def.control === "lights" && e.to.controlled && o.piece.len - o.s1 < 40) { lit = e.to; break; }
        if (e.from.def.control === "lights" && e.from.controlled && o.s0 < 40) { lit = e.from; break; }
      }
      const through: Conn[] = [];
      if (lit) {
        const lanes = new Set(on.filter(o => o.piece.kind === "lane").map(o => o.piece));
        for (const k of lit.cluster) for (const ms of k.moves.values()) for (const m of ms) if (m.turn === "S") for (let a = 0; a < m.in.n; a++) {
          if (!laneAllowed(m, a)) continue;
          for (const b of exitLanesOf(m, a)) {
            const x = this.net.getConn(m, a, b);
            if (conns.includes(x) || lanes.has(m.in.lanes[a]) || lanes.has(m.out.lanes[b])) through.push(x);
          }
        }
      }
      this.crosses.push({ ped: { waiting: 0, since: 0, crossing: 0, from: 0, until: 0, redSince: -1, claim: false, crossed: 0, waitSum: 0 }, on, lit, through });
      for (const o of on) { const l = this.crossOn.get(o.piece.id); if (l) l.push(o); else this.crossOn.set(o.piece.id, [o]); }
    }
  }
  // ------------------------------------------------------------ helpers
  protected moveOf(eIn: Edge, eOut: Edge): Movement | undefined {
    return this.moveTab.get(eIn.idx * this.net.edges.length + eOut.idx);
  }
  /** a junction drawn by hand's road ends, when `n` leads it (else just `n`): what its numbers cover */
  protected handNodes(n: CNode): CNode[] { return n.lead === n ? n.cluster.filter(k => k.lead === n) : [n]; }
  /** arm of `node` that edge `e` arrives on (-1 if it doesn't arrive there) */
  protected armOf(node: CNode, e: Edge) { return e.to === node ? e.inArm : -1; }
  /** highest lane index a general-traffic vehicle may use on edge e */
  protected maxLane(v: Vehicle, e: Edge) { return v.kind !== "bus" && e.bus ? e.n - 2 : e.n - 1; }
  /**
   * The speed a vehicle wants on a piece: the limit times its preference, no faster than the lane allows
   * (the limit, or less on a tight bend); an aggressive driver goes over the limit, but still slows for bends.
   */
  protected lim(v: Vehicle, p: Piece) {
    if (p.kind !== "lane") return p.vmax * this.P.junctionSpeed;
    const cap = v.aggressive && p.vmax >= p.edge.speed ? Infinity : p.vmax;
    return Math.min(cap, p.edge.speed * v.pref);
  }
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
  /**
   * Room to place a vehicle `len` long with its front at `s` on piece `p`: `range` clear before the vehicle ahead,
   * and behind it, `range` and as much as the vehicle there needs to stop (one coming up at speed can't stop
   * short of a car appearing just ahead of it)
   */
  protected laneClear(p: Piece, s: number, range: number, len = 4.6) {
    const list = this.index.get(p.id);
    if (list) for (const u of list) {
      if (u.s > s) { if (u.s - u.len - s < range) return false; }
      else if (s - len - u.s < range + (u.v * u.v) / 6) return false;
    }
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
    // (a car on a bay's path is in its lane's traffic only while part of it is in the lane)
    for (const v of this.vehicles) if (!v.dead && !(v.bayMove && !v.bayMove.inLane)) this.addToIndex(v);
    // (vehicles changing lanes, by the other lane they are partly in)
    this.ghosts.clear();
    for (const v of this.vehicles) {
      if (v.dead || v.lcT <= 0 || v.piece.kind !== "lane") continue;
      const e = v.piece.edge, t = v.lcT, at = v.piece.offset + v.lcOff * t * t * (3 - 2 * t);
      for (const l of e.lanes) if (l !== v.piece && Math.abs(at - l.offset) < e.lw * 0.75) { const g = this.ghosts.get(l.id); if (g) g.push(v); else this.ghosts.set(l.id, [v]); }
    }
    // (vehicles on a path through a junction, by the lane it leads into)
    this.intoLane.clear();
    for (const v of this.vehicles) {
      if (v.dead || v.piece.kind !== "conn") continue;
      const id = v.piece.outEdge.lanes[v.piece.outLane].id, l = this.intoLane.get(id);
      if (l) l.push(v); else this.intoLane.set(id, [v]);
    }
    // (the part of a long vehicle still on the pieces behind its front: from where along each it starts)
    this.tails.clear();
    for (const v of this.vehicles) {
      if (v.dead || v.bayMove || v.s >= v.len) continue;
      let rest = v.len - v.s;
      for (const pc of v.trail) {
        const z = { v, s0: Math.max(0, pc.len - rest) }, l = this.tails.get(pc.id);
        if (l) l.push(z); else this.tails.set(pc.id, [z]);
        rest -= pc.len;
        if (rest <= 0) break;
      }
    }
    // cars about to pull out of a bay with priority: the lane's traffic keeps their stretch clear
    // cars on a bay's path: what their body sweeps (going in, or coming out: committed, or waiting with priority)
    // is kept clear — every lane and junction path it passes over, trucks and all keep off it
    if (this.bayHolds.size) this.bayHolds.clear();
    this.bayMovers.length = 0;
    if (this.parks.length) for (const v of this.vehicles) {
      if (!v.dead && v.bayMove) this.bayMovers.push(v);
      // (by its bay, waiting to turn in across other lanes: traffic there lets it in, as it would a car pulling out)
      if (!v.dead && v.park && v.parkWait && !v.bayMove) {
        for (const sp of this.sweeps[v.park.row]?.[v.park.bay]?.in ?? []) {
          if (sp.piece === v.piece) continue;
          const z = { v, z0: sp.s0, z1: sp.s1 }, l = this.bayHolds.get(sp.piece.id);
          if (l) l.push(z); else this.bayHolds.set(sp.piece.id, [z]);
        }
        continue;
      }
      const bm = v.bayMove;
      // (one waiting with priority asks traffic to stop for it only once the rest of its way out is clear: then
      // stopping lets it out, rather than holding a queue behind a car that can't go anyway)
      if (v.dead || !bm || (bm.way === "out" && !bm.go && (this.net.parking[bm.row].def.giveWay || !bm.ready))) continue;
      for (const sp of this.sweeps[bm.row]?.[bm.bay]?.[bm.way] ?? []) {
        const z = { v, z0: sp.s0, z1: sp.s1 }, l = this.bayHolds.get(sp.piece.id);
        if (l) l.push(z); else this.bayHolds.set(sp.piece.id, [z]);
      }
    }
  }
  protected logging(n: CNode) { return this.logAll ? n.controlled : this.logNodes.has(n.idx); }
  /** roads whose vehicle events are recorded (by link id) */
  logLinks = new Set<string>();
  protected roadLogged(e: Edge) { return this.logLinks.size > 0 && this.logLinks.has(e.link.id); }
  /** vehicles whose events are recorded wherever they go (by vehicle id) */
  logVehicles = new Set<number>();
  protected vehLogged(v: Vehicle | null) { return v !== null && this.logVehicles.size > 0 && this.logVehicles.has(v.id); }
  /** an event on a road (recorded only for roads or vehicles being logged) */
  protected evRoad(e: Edge, v: Vehicle, kind: JunctionEvent["kind"], detail: string) {
    if (!this.roadLogged(e) && !this.vehLogged(v)) return;
    const dir = e.dir === 1 ? "→" : "←";
    this.events.push({ t: Math.round(this.tick) / 10, node: "", link: e.link.id, veh: v.id, vkind: v.kind, kind, detail: `${dir} lane ${v.lane + 1} · ${detail}`, data: { lane: v.lane + 1, from: e.link.id } });
    if (this.events.length > 60000) this.events.splice(0, 10000);
  }
  /** a junction event (recorded at junctions being logged, and for vehicles being logged at real junctions, not joints between road segments) */
  protected ev(n: CNode, v: Vehicle | null, kind: JunctionEvent["kind"], detail = "", data?: JunctionEvent["data"]) {
    if (!this.logging(n) && !(this.vehLogged(v) && isJunction(n))) return;
    this.events.push({ t: Math.round(this.tick) / 10, node: n.def.id, veh: v ? v.id : null, vkind: v ? v.kind : null, kind, detail, ...(data ? { data } : {}) });
    if (this.events.length > 60000) this.events.splice(0, 10000);
  }
  protected md(m: Movement, lane?: number, outLane?: number): JunctionEvent["data"] {
    return { turn: m.turn, from: m.in.link.id, to: m.out.link.id, lo: m.lo + 1, hi: m.hi + 1, ...(lane !== undefined ? { lane: lane + 1 } : {}), ...(outLane !== undefined ? { outLane: outLane + 1 } : {}) };
  }
  private refs: Map<string, string> | null = null;
  /** a node as the log names it: the junction reference shown on the map ("J12"), else what it is and its id */
  protected nodeName(n: CNode) {
    this.refs ??= junctionRefs(this.net);
    // (a point of a junction drawn by hand: the junction)
    const j = n.lead ?? n;
    return this.refs.get(j.def.id) ?? `${n.gateway ? "entry/exit" : n.degree === 2 ? "joint" : "node"} ${n.def.id}`;
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
  /** destroyed: a wreck (war mode) towed away (counted with the towed ones in the flows: gone from the plan) */
  /** where a vehicle is, in words: the road (by name) or the junction */
  protected placeOf(v: Vehicle): string {
    const p = v.piece;
    if (p.kind === "lane") return `road ${p.edge.link.name || p.edge.link.id} (lane ${v.lane + 1})`;
    return `junction ${this.nodeName(p.node)}`;
  }
  protected problem(p: Omit<SimProblem, "t">) {
    this.problems.push({ t: Math.round(this.tick) / 10, ...p });
    if (this.problems.length > 5000) this.problems.splice(0, this.problems.length - 4000);
  }
  /** `detail`: why, for the console (`false`: not a problem — a bus no longer needed on its line) */
  protected kill(v: Vehicle, why: "exit" | "arrived" | "towed" | "removed" | "destroyed", detail?: string | false) {
    if (v.dead) return;
    this.denyWhy.delete(v.id);
    if ((why === "towed" || why === "removed" || why === "destroyed") && detail !== false) {
      const at = v.piece.poly.at(Math.min(v.piece.len, Math.max(0, v.s)));
      const kind = why === "destroyed" ? "wreck" : why === "removed" ? "removed" : v.broken ? "breakdown" : "towed";
      this.problem({ kind, veh: v.id, vkind: v.kind, x: at.x, y: at.y, at: this.placeOf(v),
        detail: detail || (v.broken ? `broke down ${((this.tick - v.brokenAt) * DT).toFixed(0)} s before` : `stuck ${v.wait.toFixed(0)} s (${v.state})`) });
    }
    if (why === "exit" && v.piece.kind === "lane") this.countGate(v.piece.edge.to.def.id, "out");
    if (v.piece.kind === "lane") this.evRoad(v.piece.edge, v, why === "exit" ? "exit" : why === "arrived" ? "arrive" : why === "towed" ? "towed" : "leave-road",
      why === "exit" ? "leaves the plan" : why === "arrived" ? "reached its destination" : why === "towed" ? (v.broken ? `towed away, ${((this.tick - v.brokenAt) * DT).toFixed(0)} s after breaking down` : `removed after ${v.wait.toFixed(0)} s stuck (${v.state})`) : why === "destroyed" ? `wreck towed away, ${((this.tick - v.brokenAt) * DT).toFixed(0)} s after it was destroyed` : "removed (no way on)");
    v.dead = true;
    // (gone before it parked: its bay is free again)
    if (v.park) { const st = this.parks[v.park.row]; if (st.until[v.park.bay] === -1) st.until[v.park.bay] = 0; v.park = null; }
    if (v.bayMove?.way === "out") { const st = this.parks[v.bayMove.row]; if (st.until[v.bayMove.bay] === -2) st.until[v.bayMove.bay] = 0; }
    if (v.test !== undefined && v.test >= 0) {
      const t = this.tests[v.test];
      t.done = why === "exit" && v.dest.kind === "gateway" && v.dest.node.def.id === t.to ? "arrived" : why === "towed" ? "stuck" : "elsewhere";
      t.time = (this.tick - v.bornT) * DT;
    }
    if (why === "exit" || why === "arrived") { this.stats.trips++; this.tripLog.push(this.tick); }
    // (a trip's fuel counts when the whole trip was measured)
    const F = this.stats.fuel;
    if (F && (why === "exit" || why === "arrived") && v.bornT * DT >= F.since) { F.trips++; F.tripFuel += (v.fuel ?? 0) / 1000; }
    else if (why === "towed") this.stats.towed++;
    if (v.flow >= 0) {
      const f = this.flowState[v.flow], to = this.net.flows[v.flow].to;
      if (why === "exit" && v.dest.kind === "gateway" && v.dest.node === to) { f.arrived++; f.travelSum += (this.tick - v.bornT) * DT; }
      else if (why === "exit") f.diverted++;
      else if (why === "towed" || why === "destroyed") f.towed++;
    }
    if (v.zflow >= 0) {
      const f = this.zoneFlowState[v.zflow];
      if ((why === "exit" || why === "arrived") && v.dest === v.goal) { f.arrived++; f.travelSum += (this.tick - v.bornT) * DT; }
      else if (why === "exit" || why === "arrived") f.diverted++;
      else if (why === "towed" || why === "destroyed") f.towed++;
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
    for (const k of st.node.cluster) for (const o of this.ns[k.idx].occ) if (!o.entered && o.conn.outEdge === c.outEdge && o.conn.outLane === c.outLane) need += o.v.len + 2;
    return rear >= need || out.len < need;
  }
}
