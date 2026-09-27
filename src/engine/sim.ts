/**
 * Gridlock simulator on a free-form road graph.
 *
 * Fixed 0.1 s ticks. Each tick: signals advance, vehicles spawn, every vehicle
 * decides its acceleration against the same snapshot (IDM against the leader in
 * its lane, stop lines, bus stops, curve limits), a MOBIL-style lane-change pass
 * runs, junctions grant reservations for lane connectors that don't conflict,
 * then everyone moves. Deterministic for a given seed.
 */
import { compile, conflicts, exitLane, LW, type CLine, type CNode, type Compiled, type Conn, type CStop, type Edge, type LanePiece, type Movement, type Piece } from "./compile";
import { mulberry32, type Poly } from "./geom";
import type { Network, PlanSettings, Vec } from "./types";

export const DT = 0.1;
const LOOK = 110;
const REQUEST_DIST = 42;

export type Kind = "car" | "truck" | "bus";
export type Dest =
  | { kind: "gateway"; node: CNode }
  | { kind: "edge"; edge: Edge; s: number }
  | { kind: "stop"; stop: CStop };

export interface Vehicle {
  id: number; kind: Kind;
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
  /** turning-proportion decisions already drawn, by edge index */
  splits?: Map<number, Edge>;
}

interface Occ { v: Vehicle; conn: Conn; entered: boolean; /** permissive turn clearing on yellow/all-red */ sneak?: boolean }
interface Req { v: Vehicle; conn: Conn; d: number; at: number }
export interface JunctionEvent {
  /** simulation time, seconds */
  t: number;
  node: string;
  veh: number | null;
  vkind: string | null;
  kind: "approach" | "request" | "grant" | "deny" | "revoke" | "enter" | "leave" | "lane" | "wrong-lane" | "turn-changed" | "reroute" | "signal" | "towed";
  detail: string;
  /** machine-readable bits for analysis (lanes are 1-based) */
  data?: { turn?: string; from?: string; to?: string; lane?: number; outLane?: number; lo?: number; hi?: number; sig?: string | null; code?: string };
}

interface NodeState {
  node: CNode;
  occ: Occ[];
  req: Map<number, Req>;
  phase: number; stage: 0 | 1 | 2; t: number;
  demand: number[];
  phaseOfArm: number[];
  /** per arm: vehicles through during the current green, when it started, and past cycles */
  cyc: { count: number; greenAt: number; hist: { n: number; green: number; at: number }[] }[];
}

export interface Stats {
  count: number; cars: number; trucks: number; buses: number;
  avgSpeed: number; stopped: number; tripsPerMin: number;
  trips: number; towed: number; boarded: number; laneChanges: number;
  history: { t: number; speed: number; stopped: number }[];
}

const KIND_PARAMS = (kind: Kind, r: () => number) =>
  kind === "car"
    ? { len: 4.6, width: 1.9, pref: 0.88 + r() * 0.22, a: 2.0 + r() * 0.5, b: 2.4, bmax: 9, T: 0.9 + r() * 0.4, s0: 1.6, politeness: 0.1 + r() * 0.4 }
    : kind === "truck"
      ? { len: 10 + r() * 2, width: 2.5, pref: 0.8 + r() * 0.08, a: 0.75 + r() * 0.2, b: 1.5, bmax: 6.5, T: 1.6 + r() * 0.3, s0: 3, politeness: 0.5 }
      : { len: 12, width: 2.55, pref: 0.85, a: 0.9, b: 1.6, bmax: 7, T: 1.5, s0: 2.5, politeness: 0.5 };

export class Sim {
  readonly net: Compiled;
  settings: PlanSettings;
  tick = 0;
  vehicles: Vehicle[] = [];
  stats: Stats = { count: 0, cars: 0, trucks: 0, buses: 0, avgSpeed: 0, stopped: 0, tripsPerMin: 0, trips: 0, towed: 0, boarded: 0, laneChanges: 0, history: [] };
  private rng: () => number;
  private nextId = 1;
  private ns: NodeState[];
  private index = new Map<number, Vehicle[]>();
  private groupIndex = new Map<number, Vehicle[]>();
  private ema: Float64Array;
  private tripLog: number[] = [];
  private gateways: CNode[];
  private edgeWeights: number[];
  private totalLen: number;
  private maxSpeed: number;

  constructor(network: Network | Compiled, settings: PlanSettings) {
    this.net = "nodeById" in network ? network : compile(network);
    this.settings = { ...settings };
    this.rng = mulberry32(settings.seed || 7);
    this.ema = new Float64Array(this.net.edges.length);
    this.ns = this.net.nodes.map(node => {
      const phaseOfArm = node.arms.map(() => -1);
      node.phases.forEach((g, p) => g.forEach(ai => (phaseOfArm[ai] = p)));
      return { node, occ: [], req: new Map(), phase: 0, stage: 0, t: 0, demand: node.phases.map(() => -1e9), phaseOfArm, cyc: node.arms.map(() => ({ count: 0, greenAt: 0, hist: [] })) };
    });
    this.gateways = this.net.nodes.filter(n => n.gateway);
    this.edgeWeights = this.net.edges.map(e => Math.max(0, e.length - 6));
    this.totalLen = this.edgeWeights.reduce((a, b) => a + b, 0);
    this.maxSpeed = Math.max(13.9, ...this.net.edges.map(e => e.speed));
  }

  get time() { return this.tick * DT; }

  // ------------------------------------------------------------ helpers
  private moveOf(eIn: Edge, eOut: Edge): Movement | undefined {
    return eIn.to.moves.get(eIn.idx)?.find(m => m.out === eOut);
  }
  /** highest lane index a general-traffic vehicle may use on edge e */
  private maxLane(v: Vehicle, e: Edge) { return v.kind !== "bus" && e.bus ? e.n - 2 : e.n - 1; }
  private lim(v: Vehicle, p: Piece) { return p.kind === "lane" ? Math.min(p.vmax, p.edge.speed * v.pref) : p.vmax; }
  private pick<T>(arr: T[]) { return arr[(this.rng() * arr.length) | 0]; }
  private pickWeighted<T>(arr: T[], w: (x: T) => number) {
    const total = arr.reduce((a, x) => a + w(x), 0);
    let x = this.rng() * total;
    for (const a of arr) { x -= w(a); if (x <= 0) return a; }
    return arr[arr.length - 1];
  }

  private idm(v: Vehicle, gap: number, lv: number, v0: number) {
    const free = 1 - Math.pow(v.v / Math.max(v0, 0.5), 4);
    if (!isFinite(gap)) return v.a * free;
    const ss = v.s0 + Math.max(0, v.v * v.T + (v.v * (v.v - lv)) / (2 * Math.sqrt(v.a * v.b)));
    return v.a * (free - (ss / Math.max(gap, 0.2)) ** 2);
  }

  // ------------------------------------------------------------ routing
  /**
   * A* over directed edges from the end of `start` to a destination.
   * Returns the list of edges after `start`, or null.
   */
  plan(start: Edge, dest: Dest, opts: { avoid?: Movement; firstOuts?: Set<Edge>; bus?: boolean } = {}): Edge[] | null {
    const goal = (e: Edge) =>
      dest.kind === "gateway" ? e.to === dest.node : dest.kind === "edge" ? e === dest.edge : e === dest.stop.edge;
    const target: Vec = dest.kind === "gateway" ? dest.node.pos : dest.kind === "edge" ? dest.edge.to.pos : dest.stop.edge.to.pos;
    const E = this.net.edges.length;
    const g = new Float64Array(E).fill(Infinity), par = new Int32Array(E).fill(-1), closed = new Uint8Array(E);
    const open: { f: number; e: number }[] = [];
    const push = (f: number, e: number) => {
      open.push({ f, e });
      let i = open.length - 1;
      while (i > 0) { const p = (i - 1) >> 1; if (open[p].f <= f) break; [open[p], open[i]] = [open[i], open[p]]; i = p; }
    };
    const pop = () => {
      const top = open[0], last = open.pop()!;
      if (open.length) {
        open[0] = last; let i = 0;
        for (;;) { let c = 2 * i + 1; if (c >= open.length) break; if (c + 1 < open.length && open[c + 1].f < open[c].f) c++; if (open[c].f >= open[i].f) break; [open[c], open[i]] = [open[i], open[c]]; i = c; }
      }
      return top;
    };
    if (dest.kind === "gateway" && start.to === dest.node) return [];
    const h = (e: Edge) => Math.hypot(e.to.pos.x - target.x, e.to.pos.y - target.y) / this.maxSpeed;
    // expand from start without counting it
    const expandFrom = (e: Edge, base: number, first: boolean) => {
      const moves = e.to.moves.get(e.idx); if (!moves) return;
      for (const m of moves) {
        if (first && opts.firstOuts && !opts.firstOuts.has(m.out)) continue;
        if (m.out.busOnly && !opts.bus) continue;
        let c = base + m.out.length / m.out.speed + Math.max(0, this.ema[m.out.idx] - m.out.length / m.out.speed);
        const ctl = e.to.controlled ? (e.to.def.control === "lights" ? 6 : e.to.def.control === "stop" ? 5 : e.to.ringR ? 2 : 3) : 0;
        c += ctl + (m.turn === "L" ? 3 : m.turn === "U" ? 25 : m.turn === "R" ? 1 : 0);
        if (opts.avoid && m === opts.avoid) c += 400;
        if (c < g[m.out.idx]) { g[m.out.idx] = c; par[m.out.idx] = first ? -2 : e.idx; push(c + h(m.out), m.out.idx); }
      }
    };
    expandFrom(start, 0, true);
    let guard = 0;
    while (open.length && guard++ < 50000) {
      const { e: ei } = pop();
      if (closed[ei]) continue;
      closed[ei] = 1;
      const e = this.net.edges[ei];
      if (goal(e)) {
        const out: Edge[] = [];
        let cur = ei;
        while (cur >= 0) { out.push(this.net.edges[cur]); cur = par[cur]; }
        return out.reverse();
      }
      expandFrom(e, g[ei], false);
    }
    return null;
  }

  // ------------------------------------------------------------ spawning
  private makeVehicle(kind: Kind): Vehicle {
    const r = this.rng;
    const P = KIND_PARAMS(kind, r);
    return {
      id: this.nextId++, kind, ...P, tint: (r() * 6) | 0,
      route: [], ri: 0, piece: this.net.pieces[0], s: 0, v: 0, acc: 0, lane: 0, queue: [], trail: [],
      conn: null, granted: false, dest: { kind: "gateway", node: this.net.nodes[0] }, state: "free", wait: 0,
      enterT: this.tick, bornT: this.tick, gap: Infinity, leader: null, v0: 10,
      reroutes: 0, laneChanges: 0, lcCool: 0, lcOff: 0, lcT: 0,
      reqAt: 0, reqFor: null, stoppedAt: null, fixedAt: null, rerouteAt: null,
      line: null, stopIdx: 0, pax: 0, cap: 50, dwell: 0, dead: false, metered: false,
    };
  }

  private laneClear(p: Piece, s: number, range: number) {
    const list = this.index.get(p.id);
    if (list) for (const u of list) if (Math.abs(u.s - s) < range + u.len) return false;
    return true;
  }
  private addToIndex(v: Vehicle) {
    let l = this.index.get(v.piece.id); if (!l) this.index.set(v.piece.id, (l = [])); l.push(v);
    if (v.piece.kind === "conn") { let g = this.groupIndex.get(v.piece.entryKey); if (!g) this.groupIndex.set(v.piece.entryKey, (g = [])); g.push(v); }
  }

  private randomEdge(): Edge | null {
    if (this.totalLen <= 0) return null;
    let x = this.rng() * this.totalLen;
    for (let i = 0; i < this.net.edges.length; i++) { x -= this.edgeWeights[i]; if (x <= 0) return this.net.edges[i]; }
    return this.net.edges[this.net.edges.length - 1];
  }

  private spawnGeneral(kind: Kind, gate?: CNode): boolean {
    const r = this.rng;
    let edge: Edge | null = null, s = 0, v0 = 0;
    const auto = this.gateways.filter(g => g.def.inflow == null);
    const fromGate = !!gate || (auto.length > 0 && r() < 0.65);
    if (fromGate) {
      const g = gate ?? this.pick(auto);
      edge = g.arms[0].outEdge;
      if (!edge || edge.busOnly) return false;
      v0 = Math.min(9, edge.speed);
    } else {
      edge = this.randomEdge();
      if (!edge || edge.length < 8 || edge.busOnly) return false;
      s = edge.length * (0.2 + r() * 0.6);
    }
    const maxL = kind === "bus" ? edge.n - 1 : Math.max(0, edge.n - (edge.bus ? 2 : 1));
    const lane = (r() * (maxL + 1)) | 0;
    const piece = edge.lanes[lane];
    const sOnLane = s * (piece.len / Math.max(1e-6, edge.length));
    if (!this.laneClear(piece, sOnLane, fromGate ? 14 : 12)) return false;
    let dest: Dest;
    const exits = this.gateways.filter(g => g !== edge!.from && (g.def.exitWeight ?? 1) > 0);
    if (exits.length && r() < 0.6) dest = { kind: "gateway", node: this.pickWeighted(exits, g => g.def.exitWeight ?? 1) };
    else {
      const de = this.randomEdge(); if (!de || de.length < 8 || de.busOnly) return false;
      dest = { kind: "edge", edge: de, s: de.length * (0.2 + r() * 0.6) };
    }
    let route: Edge[];
    if (dest.kind === "edge" && dest.edge === edge && dest.s > sOnLane + 10) route = [edge];
    else {
      const rest = this.plan(edge, dest);
      if (!rest) return false;
      route = [edge, ...rest];
    }
    const v = this.makeVehicle(kind);
    v.route = route; v.ri = 0; v.piece = piece; v.s = sOnLane; v.v = v0; v.lane = lane; v.dest = dest;
    v.metered = !!gate;
    this.applySplit(v);
    this.vehicles.push(v); this.addToIndex(v);
    if (fromGate) { const id = edge.from.def.id; this.entered.set(id, (this.entered.get(id) ?? 0) + 1); }
    return true;
  }

  /** vehicles that crossed each node so far, and the ticks of recent crossings (last minute) */
  private nodeThrough: number[] = [];
  private nodeRecent: number[][] = [];

  /** live numbers for one junction (for labels and the inspector) */
  junctionStats(nodeIdx: number) {
    const n = this.net.nodes[nodeIdx];
    const recent = this.nodeRecent[nodeIdx] ?? [];
    const since = this.tick - 600;
    while (recent.length && recent[0] < since) recent.shift();
    const window = Math.min(60, Math.max(1, this.time));
    const approaches = n.arms.filter(a => a.inEdge).map(a => {
      const e = a.inEdge!;
      let waiting = 0, queueM = 0;
      for (const lp of e.lanes) for (const v of this.index.get(lp.id) ?? []) {
        if (v.dead || v.v > 1.5) continue;
        const d = lp.len - v.s;
        if (d > 250) continue;
        waiting++; queueM = Math.max(queueM, d + v.len);
      }
      return { link: e.link, dir: e.dir, waiting, queueM };
    });
    return {
      through: this.nodeThrough[nodeIdx] ?? 0,
      perMin: (recent.length * 60) / window,
      waiting: approaches.reduce((s, a) => s + a.waiting, 0),
      approaches,
    };
  }

  /**
   * Traffic lights: vehicles let through per green, for each approach (arm index). `current`
   * counts the green in progress; `history` holds finished cycles (green includes yellow).
   */
  lightCycles(nodeIdx: number) {
    const st = this.ns[nodeIdx];
    return st.node.arms.map((a, i) => {
      if (!a.inEdge) return null;
      const c = st.cyc[i], h = c.hist;
      const green = st.phaseOfArm[i] === st.phase && st.stage < 2;
      const avg = h.length ? h.reduce((s, x) => s + x.n, 0) / h.length : 0;
      const avgGreen = h.length ? h.reduce((s, x) => s + x.green, 0) / h.length : 0;
      return { arm: i, link: a.inEdge.link, dir: a.inEdge.dir, current: green ? c.count : null, history: h, avg, avgGreen };
    });
  }

  // ------------------------------------------------------------ junction event log
  /** node indexes whose events are recorded (see `logAll` to record every junction) */
  logNodes = new Set<number>();
  logAll = false;
  /** recorded events, oldest first (capped) */
  events: JunctionEvent[] = [];
  private lastDeny = new Map<number, string>();
  private logging(n: CNode) { return this.logAll ? n.controlled : this.logNodes.has(n.idx); }
  private ev(n: CNode, v: Vehicle | null, kind: JunctionEvent["kind"], detail = "", data?: JunctionEvent["data"]) {
    if (!this.logging(n)) return;
    this.events.push({ t: Math.round(this.tick) / 10, node: n.def.id, veh: v ? v.id : null, vkind: v ? v.kind : null, kind, detail, ...(data ? { data } : {}) });
    if (this.events.length > 60000) this.events.splice(0, 10000);
  }
  private md(m: Movement, lane?: number, outLane?: number): JunctionEvent["data"] {
    return { turn: m.turn, from: m.in.link.id, to: m.out.link.id, lo: m.lo + 1, hi: m.hi + 1, ...(lane !== undefined ? { lane: lane + 1 } : {}), ...(outLane !== undefined ? { outLane: outLane + 1 } : {}) };
  }
  /** describe a movement for the log: "S lane 2→1 (road NE→SW)" */
  private mv(c: Conn | Movement, lane?: number) {
    const m = "move" in c ? c.move : c;
    const inL = "inLane" in c ? c.inLane : lane, outL = "outLane" in c ? c.outLane : undefined;
    // lanes are numbered from 1 = leftmost (next to the centre line), as in the inspector
    return `${m.turn} from ${m.in.link.name || m.in.link.id}${inL !== undefined ? ` lane ${inL + 1}` : ""} to ${m.out.link.name || m.out.link.id}${outL !== undefined ? ` lane ${outL + 1}` : ""}`;
  }

  /** the turn this vehicle plans at the end of its current road, and the lanes that allow it */
  nextTurn(v: Vehicle): { node: CNode; move: Movement } | null {
    const e = v.route[v.ri], next = v.route[v.ri + 1];
    if (!e || !next || v.piece.kind !== "lane") return null;
    const m = this.moveOf(e, next);
    return m ? { node: e.to, move: m } : null;
  }

  /** vehicles that took each movement so far, keyed "inEdgeIdx>outEdgeIdx" */
  turnCounts = new Map<string, number>();
  /** vehicles that entered through each entry point so far (by node id) */
  entered = new Map<string, number>();
  /** arrivals waiting to get onto the road at metered entry points */
  private backlog = new Map<CNode, number>();

  /** entry points with a set flow: Poisson arrivals, queued while the entry lane is full */
  private meteredSpawns() {
    const share = this.settings.trucks / Math.max(1, this.settings.cars + this.settings.trucks);
    for (const g of this.gateways) {
      const rate = g.def.inflow;
      if (rate == null || rate <= 0) continue;
      let q = this.backlog.get(g) ?? 0;
      if (this.rng() < (rate / 60) * DT) q = Math.min(30, q + 1);
      if (q > 0 && this.vehicles.length < 8000 && this.spawnGeneral(this.rng() < share ? "truck" : "car", g)) q--;
      this.backlog.set(g, q);
    }
  }

  private spawnBus(line: CLine, k: number): boolean {
    if (line.stops.length < 2) return false;
    const stop = line.stops[k % line.stops.length];
    const e = stop.edge, lane = e.n - 1, piece = e.lanes[lane];
    const s = stop.s * (piece.len / Math.max(1e-6, e.length));
    if (!this.laneClear(piece, s, 16)) return false;
    const v = this.makeVehicle("bus");
    v.line = line; v.stopIdx = k % line.stops.length;
    v.route = [e]; v.ri = 0; v.piece = piece; v.s = s; v.lane = lane; v.dest = { kind: "stop", stop };
    v.dwell = 2;
    this.vehicles.push(v); this.addToIndex(v);
    return true;
  }

  private kill(v: Vehicle, why: "exit" | "arrived" | "towed" | "removed") {
    if (v.dead) return;
    v.dead = true;
    if (why === "exit" || why === "arrived") { this.stats.trips++; this.tripLog.push(this.tick); }
    else if (why === "towed") this.stats.towed++;
  }

  // ------------------------------------------------------------ tick
  step() {
    this.tick++;
    this.updateSignals();
    this.spawnLoop();
    this.buildIndex();
    for (const v of this.vehicles) if (!v.dead) this.think(v);
    for (const v of this.vehicles) if (!v.dead && (v.id + this.tick) % 5 === 0) this.considerLaneChange(v);
    for (const st of this.ns) if (st.node.controlled && !st.node.ring) this.arbitrate(st);
    for (const v of this.vehicles) if (!v.dead) this.move(v);
    if (this.tick % 10 === 0) this.sample();
    if (this.tick % 50 === 0) this.housekeeping();
  }
  run(n: number) { for (let k = 0; k < n; k++) this.step(); }

  private buildIndex() {
    this.index.clear(); this.groupIndex.clear();
    for (const v of this.vehicles) if (!v.dead) this.addToIndex(v);
  }

  private updateSignals() {
    for (const st of this.ns) {
      const n = st.node;
      if (!n.controlled || n.def.control !== "lights" || n.phases.length < 2) continue;
      const sig = n.def.signal;
      st.t += DT;
      if (st.stage === 0) {
        const idle = (this.tick - st.demand[st.phase]) * DT > 2;
        const other = st.demand.some((d, i) => i !== st.phase && (this.tick - d) * DT < 1);
        if ((sig.actuated && st.t > sig.minGreen && idle && other) || st.t >= sig.green) { st.stage = 1; st.t = 0; }
      } else if (st.stage === 1) {
        if (st.t >= sig.yellow) {
          st.stage = 2; st.t = 0;
          // close the cycle for the approaches that just had green
          for (const a of n.phases[st.phase]) {
            const c = st.cyc[a];
            c.hist.push({ n: c.count, green: (this.tick - c.greenAt) * DT, at: this.tick * DT });
            if (c.hist.length > 30) c.hist.shift();
            c.count = 0;
          }
        }
      } else if (st.t >= sig.allRed) {
        st.stage = 0; st.t = 0; st.phase = (st.phase + 1) % n.phases.length;
        if (this.logging(n)) this.ev(n, null, "signal", `green for ${n.phases[st.phase].map(a => n.arms[a].inEdge?.link.name || n.arms[a].link.id).join(" + ") || "nobody (all red)"}`);
        for (const a of n.phases[st.phase]) { st.cyc[a].greenAt = this.tick; st.cyc[a].count = 0; }
      }
    }
  }

  /** signal aspect for traffic arriving on arm `armIdx` of node `nodeIdx` (null = no signal) */
  signalFor(nodeIdx: number, armIdx: number): "green" | "yellow" | "red" | null {
    const st = this.ns[nodeIdx];
    const n = st.node;
    if (!n.controlled || n.def.control !== "lights" || n.phases.length < 2) return null;
    const p = st.phaseOfArm[armIdx];
    if (p !== st.phase) return "red";
    return st.stage === 0 ? "green" : st.stage === 1 ? "yellow" : "red";
  }
  nodeState(nodeIdx: number) { const st = this.ns[nodeIdx]; return { phase: st.phase, stage: st.stage, t: st.t, occupied: st.occ.length, phases: st.node.phases.length }; }
  reservations(): Conn[] { const out: Conn[] = []; for (const st of this.ns) for (const o of st.occ) out.push(o.conn); return out; }

  private spawnLoop() {
    let cars = 0, trucks = 0;
    const busesPerLine = new Map<CLine, number>();
    this.meteredSpawns();
    for (const v of this.vehicles) if (!v.dead && !v.metered) {
      if (v.kind === "car") cars++; else if (v.kind === "truck") trucks++;
      else if (v.line) busesPerLine.set(v.line, (busesPerLine.get(v.line) || 0) + 1);
    }
    // fill up faster when far below the target (large plans with thousands of vehicles)
    if (this.tick % 2 === 0) for (let k = Math.min(8, 1 + Math.floor((this.settings.cars - cars) / 150)); k > 0 && cars < this.settings.cars; k--) { if (this.spawnGeneral("car")) cars++; }
    else for (let k = Math.min(4, 1 + Math.floor((this.settings.trucks - trucks) / 150)); k > 0 && trucks < this.settings.trucks; k--) { if (this.spawnGeneral("truck")) trucks++; }
    if (this.tick % 20 === 0) for (const line of this.net.lines) {
      const have = busesPerLine.get(line) || 0;
      if (have < line.def.buses) this.spawnBus(line, Math.floor((have * line.stops.length) / Math.max(1, line.def.buses)));
      else if (have > line.def.buses) { const b = this.vehicles.find(v => !v.dead && v.line === line); if (b) this.kill(b, "removed"); }
    }
    if (this.tick % 10 === 0) for (const s of this.net.stops) if (this.rng() < 0.12) s.waiting = Math.min(80, s.waiting + 1);
  }

  /**
   * Yellow: go only if stopping would need harder than comfortable braking.
   * Red: go only if the vehicle physically cannot stop before the line.
   */
  private mustGoOnSignal(v: Vehicle, d: number, sig: "yellow" | "red" | null) {
    const vv = v.v * v.v;
    if (sig === "yellow") return d < vv / (2 * v.b * 1.4) + 0.5;
    return d < vv / (2 * v.bmax) + 0.3;
  }

  /** all-way stop, or a stop sign on this approach to a priority junction */
  private mustStop(node: CNode, e: Edge) {
    if (!node.controlled || node.degree < 2) return false;
    return node.def.control === "stop" || (node.def.control === "priority" && e.sign === "stop");
  }

  /** at a priority junction, approaches with a yield or stop sign give way to the others */
  private minor(node: CNode, e: Edge) { return node.def.control === "priority" && !!e.sign; }

  /**
   * Crossings that vehicles on the major (unsigned) approaches of `node` will use within the
   * next few seconds. Minor approaches must not start a conflicting move in front of them.
   */
  private majorTraffic(node: CNode): Conn[] {
    const out: Conn[] = [];
    for (const arm of node.arms) {
      const e = arm.inEdge;
      if (!e || e.sign) continue;
      for (const lp of e.lanes) {
        const list = this.index.get(lp.id); if (!list) continue;
        for (const u of list) {
          if (u.dead || u.route[u.ri] !== e) continue;
          // queued priority traffic that is standing still lets minor traffic in (zip merging)
          if (u.v < 3 && !u.granted) continue;
          const dist = lp.len - u.s, eta = dist / Math.max(u.v, 2);
          if (dist > 70 || eta > 4.5) continue;
          const cross = this.crossingFor(u, u.ri, u.lane);
          if (cross && cross[0].kind === "conn") out.push(cross[0] as Conn);
        }
      }
    }
    return out;
  }

  /** pieces this vehicle would drive through at the end of edge route[ri] from `lane` */
  private crossingFor(v: Vehicle, ri: number, lane: number): Piece[] | null {
    const e = v.route[ri], next = v.route[ri + 1];
    if (!e || !next) return null;
    const m = this.moveOf(e, next);
    if (!m) return null;
    const a = Math.min(lane, e.n - 1);
    // a granted crossing is kept, so the choice below can't change under the vehicle's wheels
    if (v.conn && !e.to.ring && v.conn.role === "turn" && v.conn.move === m && v.conn.inLane === a) return this.net.crossing(m, a, v.conn.outLane);
    // a pending request keeps its exit lane too (no flip-flopping while waiting at a red light),
    // unless that lane has no room any more
    const rq = v.reqFor;
    if (rq && !e.to.ring && rq.role === "turn" && rq.move === m && rq.inLane === a && this.exitRoom(this.ns[e.to.idx], rq, v)) return this.net.crossing(m, a, rq.outLane);
    return this.net.crossing(m, a, this.chooseExitLane(v, m, a, ri + 1));
  }

  /**
   * Exit lane for a vehicle crossing from lane `a`: when the road it joins has more lanes than
   * the turn uses, pick the one that suits the vehicle's *next* turn (left lane before a left
   * turn, and so on), staying within this lane's share of the exit so parallel turns don't cross.
   */
  private chooseExitLane(v: Vehicle, m: Movement, a: number, outIdx: number): number {
    const isBus = v.kind === "bus";
    const b0 = exitLane(m, a, isBus);
    if (m.turn === "U" || (isBus && m.out.bus)) return b0;
    const out = m.out;
    const usable = out.bus && !isBus ? out.n - 1 : out.n;
    const k = m.hi - m.lo + 1, j = Math.min(k - 1, Math.max(0, a - m.lo));
    if (usable <= k) return b0;
    const bLo = Math.floor((j * usable) / k), bHi = Math.max(bLo, Math.floor(((j + 1) * usable) / k) - 1);
    const want = this.laneTarget(v, outIdx);
    let target = b0;
    if (want) target = Math.min(Math.max(b0, want.lo), want.hi);
    target = Math.min(bHi, Math.max(bLo, target));
    if (target === b0) return b0;
    // only worth it if that lane isn't backed up to the junction; otherwise take the usual lane
    const lp = out.lanes[target];
    let rear = Infinity;
    for (const u of this.index.get(lp.id) ?? []) rear = Math.min(rear, u.s - u.len);
    return rear > 10 ? target : b0;
  }

  /** lanes the vehicle will need on route edge `idx` for the next junction it turns at */
  private laneTarget(v: Vehicle, idx: number): { lo: number; hi: number } | null {
    const e0 = v.route[idx];
    if (!e0) return null;
    for (let k = idx, hop = 0; hop < 5; k++, hop++) {
      const ek = v.route[k], nk = v.route[k + 1];
      if (!ek || !nk || ek.n !== e0.n) return null;
      const mk = this.moveOf(ek, nk);
      if (!mk) return null;
      if (ek.to.controlled || ek.to.degree !== 2) {
        const many = (ek.to.moves.get(ek.idx)?.length || 0) > 1;
        return many ? { lo: mk.lo, hi: mk.hi } : null;
      }
    }
    return null;
  }

  /** gap acceptance for joining a roundabout ring at entry `c` */
  private canEnterRing(v: Vehicle, c: Conn): boolean {
    const n = c.node, ring = n.ring!, m = ring.length, k = c.arm;
    // only the front vehicle of its lane may commit
    for (const u of this.index.get(v.piece.id) || []) if (u !== v && u.s > v.s) return false;
    // one vehicle at a time per arm: nobody else entering or committed to enter here
    for (const u of this.vehicles) {
      if (u === v || u.dead) continue;
      if (u.piece.kind === "conn" && u.piece.role === "entry" && u.piece.node === n && u.piece.arm === k) return false;
      if (u.granted && u.conn && u.conn.role === "entry" && u.conn.node === n && u.conn.arm === k && u.piece.kind === "lane") return false;
    }
    // keep the ring from filling up (it would lock itself)
    let onRing = 0, circ = 0;
    for (const ra of ring) { circ += ra.pass.len + ra.between.len; onRing += (this.index.get(ra.pass.id)?.length || 0) + (this.index.get(ra.between.id)?.length || 0); }
    if (onRing + 1 > Math.max(2, Math.floor(circ / 11))) return false;
    const pass = ring[k].pass, prevBetween = ring[(k + 1) % m].between;
    const critical = 3.2;
    for (const u of this.index.get(pass.id) || []) {
      const d = pass.len - u.s;
      if (d < 8 || d / Math.max(u.v, 1) < critical) return false;
    }
    for (const u of this.index.get(prevBetween.id) || []) {
      const nextPiece = u.queue[0];
      if (nextPiece && nextPiece.kind === "conn" && nextPiece.role === "exit" && nextPiece.arm === k) continue; // leaving before us
      const d = prevBetween.len - u.s + pass.len;
      if (d < 8 || d / Math.max(u.v, 1) < critical) return false;
    }
    // room just after the merge point
    const between = ring[k].between;
    for (const u of this.index.get(between.id) || []) if (u.s - u.len < v.len + 2) return false;
    return true;
  }

  private think(v: Vehicle) {
    v.lcCool -= DT;
    if (v.lcT > 0) v.lcT = Math.max(0, v.lcT - DT / 1.4);
    if (v.dwell > 0) { v.state = "boarding"; v.acc = 0; v.leader = null; v.gap = Infinity; return; }

    let acc = -v.s, gap = Infinity, lv = 0, leader: Vehicle | null = null;
    let stopD = Infinity, stopKind: "junction" | "stop" | null = null, brake = Infinity;
    let pendConn: Conn | null = null, pendD = 0;
    const curLim = this.lim(v, v.piece);

    // walk pieces ahead
    let p: Piece | null = v.piece, ri = v.ri, lane = v.lane, first = true;
    let q: Piece[] = v.queue;
    while (p && acc < LOOK) {
      // leaders on this piece (plus vehicles on sibling connectors from the same entry lane,
      // and vehicles about to merge onto a roundabout ring stretch)
      if (!leader) {
        const lists: (Vehicle[] | undefined)[] = p.kind === "conn" && p.role !== "exit" ? [this.groupIndex.get(p.entryKey)] : [this.index.get(p.id)];
        for (const list of lists) if (list) for (const u of list) {
          if (u === v) continue;
          if (first && !(u.s > v.s || (u.s === v.s && u.id > v.id))) continue;
          const gg = acc + u.s - u.len;
          if (gg < gap) { gap = gg; lv = u.v; leader = u; }
        }
        const vp = v.piece;
        const mergingHere = vp.kind === "conn" && vp.role === "entry" && p.kind === "ring" && vp.node === p.node && p.node.ring![vp.arm].between === p;
        if (p.kind === "ring" && p.part === "between" && !first && !mergingHere) {
          const ring = p.node.ring!;
          for (const [, list] of this.groupIndex) for (const u of list) {
            if (u === v || u.piece.kind !== "conn" || u.piece.role !== "entry" || u.piece.node !== p.node || ring[u.piece.arm].between !== p) continue;
            if (u.s < u.piece.len - 4) continue;
            const gg = acc + (u.s - u.piece.len) - u.len;
            if (gg < gap) { gap = gg; lv = u.v; leader = u; }
          }
        }
      }
      if (!first) {
        const vl = this.lim(v, p);
        if (vl < v.v) { const need = (vl * vl - v.v * v.v) / (2 * Math.max(acc, 1)); if (need < brake) brake = need; }
      }
      // bus stop on this lane piece
      if (p.kind === "lane" && v.dest.kind === "stop" && p.edge === v.dest.stop.edge && ri === v.route.length - 1) {
        const sOn = v.dest.stop.s * (p.len / Math.max(1e-6, p.edge.length));
        const d = acc + sOn;
        if (d > -0.5 && d < stopD) { stopD = d; stopKind = "stop"; }
      }
      const endD = acc + p.len;
      // what comes after this piece?
      if (p.kind === "lane") {
        const e = p.edge;
        const cross = this.crossingFor(v, ri, lane);
        if (!cross) break; // route ends on this edge (exit or destination)
        const node = e.to, c0 = cross[0] as Conn;
        if (node.controlled && !(first && v.granted && v.conn === c0)) {
          if (first) { pendConn = c0; pendD = endD; }
          if (endD < stopD) { stopD = endD; stopKind = "junction"; }
          break;
        }
        p = cross[0]; q = cross.slice(1);
      } else if (q.length) {
        p = q[0]; q = q.slice(1);
      } else if (p.kind === "conn") {
        const np: LanePiece = p.outEdge.lanes[p.outLane];
        lane = p.outLane; ri++; p = np; q = [];
      } else break;
      acc = endD; first = false;
    }

    v.v0 = curLim;
    const sq = 2 * Math.sqrt(v.a * v.b);
    const free = 1 - Math.pow(v.v / Math.max(curLim, 0.5), 4);
    let a = this.idm(v, gap, lv, curLim);
    if (stopKind) {
      const g2 = stopD - (stopKind === "stop" ? 0 : 0.8);
      const ss = (stopKind === "stop" ? 0.2 : 0.5) + Math.max(0, v.v * v.T * 0.6 + (v.v * v.v) / sq);
      const a2 = v.a * (free - (ss / Math.max(g2, 0.2)) ** 2);
      if (a2 < a) a = a2;
    }
    if (brake < a) a = brake;
    v.acc = Math.max(-v.bmax, a);
    v.gap = gap; v.leader = leader;

    v.wait = v.v < 0.3 ? v.wait + DT : 0;
    // junction request
    if (pendConn) {
      const node = pendConn.node, st = this.ns[node.idx], e = pendConn.inEdge;
      // the vehicle's own movement (a roundabout entry piece is shared by all turns from that arm)
      const m = (v.route[v.ri] === e && v.route[v.ri + 1] ? this.moveOf(e, v.route[v.ri + 1]) : undefined) ?? pendConn.move;
      // wrong lane for the planned turn and too late to change: take a turn this lane allows
      const wrongLane = v.lane < m.lo || v.lane > m.hi;
      // a turning share was drawn for this junction: keep trying to reach the right lane for a while
      // …but never for long while standing at the line, where it blocks everyone behind it
      const committed = !!v.splits?.has(e.idx) && !(pendD < 8 && v.wait > 6);
      if (pendD < 14 && wrongLane && v.fixedAt !== e && !committed) {
        v.fixedAt = e;
        const moves = node.moves.get(e.idx) || [];
        const ok = new Set(moves.filter(x => v.lane >= x.lo && v.lane <= x.hi).map(x => x.out));
        let rest = ok.size ? this.plan(e, v.dest, { firstOuts: ok, bus: v.kind === "bus" }) : null;
        let retarget = "";
        if (!rest && ok.size && v.kind !== "bus") {
          // the destination is only reachable through the turn it can no longer make: leave the
          // area by whichever exit is reachable from this lane
          for (const g of [...this.gateways].sort(() => this.rng() - 0.5)) {
            const d: Dest = { kind: "gateway", node: g };
            const r = e.to === g ? null : this.plan(e, d, { firstOuts: ok });
            if (r) { v.dest = d; rest = r; retarget = " (new destination)"; break; }
          }
        }
        if (rest) {
          v.route = [...v.route.slice(0, v.ri + 1), ...rest]; v.reroutes++;
          v.splits?.delete(e.idx);
          const nm = this.moveOf(e, rest[0]);
          this.ev(node, v, "turn-changed", `in lane ${v.lane + 1}, which does not allow ${this.mv(m)} (lanes ${m.lo + 1}-${m.hi + 1}); takes ${nm ? this.mv(nm, v.lane) : "another way"} instead${retarget}`);
        } else this.ev(node, v, "wrong-lane", `in lane ${v.lane + 1}, needs lanes ${m.lo + 1}-${m.hi + 1} for ${this.mv(m)}; no allowed turn from this lane`);
        return;
      }
      if (wrongLane && pendD < 14 && v.reqFor !== pendConn && this.lastDeny.get(v.id) !== `wl${e.idx}`) {
        this.lastDeny.set(v.id, `wl${e.idx}`);
        this.ev(node, v, "wrong-lane", `in lane ${v.lane + 1}, needs lanes ${m.lo + 1}-${m.hi + 1} for ${this.mv(m)} (turning share); waits to change lane`);
      }
      // a wrong-lane vehicle doesn't ask for the junction until it has changed lane or picked a turn
      // its lane allows; only a vehicle that found no alternative at all goes as it is
      const laneOk = !wrongLane || (v.fixedAt === e && !committed);
      if (node.ring) {
        // roundabout: yield to circulating traffic, then commit
        if (pendD < 22 && laneOk && v.reqFor !== pendConn) {
          v.reqFor = pendConn; v.reqAt = this.tick;
          this.ev(node, v, "request", `${this.mv(m, v.lane)} · ${pendD.toFixed(0)} m from the line, ${(v.v * 3.6).toFixed(0)} km/h`);
        }
        if (pendD < 22 && laneOk && !(v.granted && v.conn === pendConn) && this.canEnterRing(v, pendConn)) {
          v.conn = pendConn; v.granted = true;
          this.ev(node, v, "grant", `gap in the roundabout · ${this.mv(m, v.lane)}`, this.md(m, v.lane));
        }
        v.state = v.v < 0.6 && pendD < 8 ? "yielding" : leader && gap < 30 ? "following" : "free";
        if (v.wait > 150 && !(leader && leader.piece === v.piece && gap < 12)) { this.ev(node, v, "towed", `stuck 150 s waiting to enter the roundabout`); this.kill(v, "towed"); }
        return;
      }
      const stopFirst = this.mustStop(node, e);
      if (stopFirst && v.stoppedAt !== pendConn && pendD < 3 && v.v < 0.25) { v.stoppedAt = pendConn; if (v.reqFor === pendConn) v.reqFor = null; }
      const mayAsk = (!stopFirst || v.stoppedAt === pendConn) && laneOk;
      // only the first vehicle in a lane (or one following a vehicle that may go) asks for the junction
      const behindWaiting = !!leader && leader.piece === v.piece && !(leader.granted && leader.conn);
      if (pendD < REQUEST_DIST && mayAsk && !behindWaiting) {
        if (v.reqFor !== pendConn) {
          v.reqFor = pendConn; v.reqAt = this.tick;
          this.ev(node, v, "request", `${node.ring ? this.mv(m, v.lane) : this.mv(pendConn)} · ${pendD.toFixed(0)} m from the line, ${(v.v * 3.6).toFixed(0)} km/h${stopFirst ? " · after stopping" : ""}`);
        }
        const arm = node.arms.findIndex(x => x.inEdge === e);
        if (arm >= 0 && st.phaseOfArm[arm] >= 0) st.demand[st.phaseOfArm[arm]] = this.tick;
        const cur = st.req.get(pendConn.entryKey);
        if (!cur || pendD < cur.d) st.req.set(pendConn.entryKey, { v, conn: pendConn, d: pendD, at: v.reqAt });
      }
    }

    // state + stuck handling
    if (stopKind === "junction" && stopD < 8 && v.v < 0.6 && pendConn) {
      const node = pendConn.node;
      const arm = node.arms.findIndex(x => x.inEdge === pendConn!.inEdge);
      const sig = arm >= 0 ? this.signalFor(node.idx, arm) : null;
      v.state = sig && sig !== "green" ? "red light" : this.mustStop(node, pendConn.inEdge) ? "stop sign" : "yielding";
    } else if (leader && gap < 25 && v.v < 1) v.state = "queued";
    else if (leader && gap < 30) v.state = "following";
    else v.state = "free";

    // towing clears a vehicle that is itself stuck; one waiting in a queue behind others is left alone
    const inQueue = !!leader && leader.piece === v.piece && gap < 12;
    if (v.wait > 150 && !inQueue) { if (pendConn) this.ev(pendConn.node, v, "towed", `stuck 150 s waiting for ${this.mv(pendConn)}`); this.kill(v, "towed"); }
    else if (v.wait > 40 && pendConn && v.rerouteAt !== pendConn.inEdge && v.kind !== "bus" && !v.splits?.has(pendConn.inEdge.idx)) {
      v.rerouteAt = pendConn.inEdge;
      const e = pendConn.inEdge, node = pendConn.node;
      const ok = new Set((node.moves.get(e.idx) || []).filter(x => v.lane >= x.lo && v.lane <= x.hi).map(x => x.out));
      const rest = this.plan(e, v.dest, { avoid: pendConn.move, firstOuts: ok.size ? ok : undefined, bus: false });
      if (rest && rest[0] !== pendConn.move.out) {
        v.route = [...v.route.slice(0, v.ri + 1), ...rest]; v.reroutes++;
        const nm = this.moveOf(e, rest[0]);
        this.ev(node, v, "reroute", `waited ${v.wait.toFixed(0)} s for ${this.mv(pendConn.move)}; now ${nm ? this.mv(nm, v.lane) : "?"}`);
      }
    }
  }

  // ------------------------------------------------------------ lane changes
  private neededLanes(v: Vehicle): { lo: number; hi: number; urgent: number } {
    const p = v.piece as LanePiece, e = p.edge;
    let lo = 0, hi = this.maxLane(v, e);
    const toEnd = p.len - v.s;
    let urgent = Infinity;
    const next = v.route[v.ri + 1];
    const m = next ? this.moveOf(e, next) : undefined;
    // through road joints (two roads meeting, same lanes): line up early for the junction beyond
    if (m && !e.to.controlled && e.to.degree === 2 && m.out.n === e.n) {
      let dist = toEnd, k = v.ri + 1;
      for (let hop = 0; hop < 4; hop++) {
        const ek = v.route[k], nk = v.route[k + 1];
        if (!ek || !nk || ek.n !== e.n) break;
        dist += ek.length;
        const mk = this.moveOf(ek, nk);
        if (!mk) break;
        if (ek.to.controlled || ek.to.degree !== 2) {
          const manyK = (ek.to.moves.get(ek.idx)?.length || 0) > 1;
          if (manyK && (mk.lo > lo || mk.hi < hi) && dist < 250) { lo = Math.max(lo, mk.lo); hi = Math.min(hi, mk.hi); urgent = dist; }
          break;
        }
        k++;
      }
    }
    if (m) {
      const many = (e.to.moves.get(e.idx)?.length || 0) > 1 || e.to.controlled;
      if (many && (m.lo > lo || m.hi < hi)) { lo = Math.max(lo, m.lo); hi = Math.min(hi, m.hi); urgent = toEnd; }
      if (!e.to.controlled && m.out.n - 1 < hi) { hi = m.out.n - 1; urgent = toEnd; }
      // cars may enter the bus lane only just before a right turn
      if (v.kind !== "bus" && e.bus && m.turn === "R" && toEnd < 40) hi = Math.max(hi, e.n - 1);
    }
    if (v.kind === "bus") {
      const stopHere = v.dest.kind === "stop" && v.dest.stop.edge === e;
      if ((stopHere || e.bus) && hi >= e.n - 1) { lo = e.n - 1; urgent = Math.min(urgent, toEnd); }
    }
    if (lo > hi) lo = hi;
    return { lo, hi, urgent };
  }

  private laneLeader(v: Vehicle, c: number) {
    const e = (v.piece as LanePiece).edge, piece = e.lanes[c];
    const s = v.s * (piece.len / (v.piece as LanePiece).len);
    let best: Vehicle | null = null, gap = Infinity;
    const list = this.index.get(piece.id);
    if (list) for (const u of list) { if (u === v || u.s <= s) continue; const gg = u.s - u.len - s; if (gg < gap) { gap = gg; best = u; } }
    return { u: best, gap, v: best ? best.v : 0 };
  }
  private laneFollower(v: Vehicle, c: number) {
    const e = (v.piece as LanePiece).edge, piece = e.lanes[c];
    const s = v.s * (piece.len / (v.piece as LanePiece).len);
    let best: Vehicle | null = null, gap = Infinity;
    const list = this.index.get(piece.id);
    if (list) for (const u of list) { if (u === v || u.s > s) continue; const gg = s - v.len - u.s; if (gg < gap) { gap = gg; best = u; } }
    return { u: best, gap };
  }

  private considerLaneChange(v: Vehicle) {
    if (v.dwell > 0 || v.lcCool > 0 || v.piece.kind !== "lane") return;
    const p = v.piece, e = p.edge;
    if (e.n <= 1 || v.s < 2 || v.s > p.len - (v.v < 1 ? 0.3 : 3) || v.granted) return;
    const need = this.neededLanes(v), a = v.lane;
    const dir = a < need.lo ? 1 : a > need.hi ? -1 : 0;
    const aCur = this.idm(v, v.gap, v.leader ? v.leader.v : 0, v.v0);
    let best = -1, bestGain = 0;
    for (const c of [a - 1, a + 1]) {
      if (c < 0 || c >= e.n) continue;
      const mandatory = dir !== 0 && Math.sign(c - a) === dir;
      if (dir !== 0 && !mandatory) continue;
      if (!mandatory && (c < need.lo || c > need.hi)) continue;
      const L = this.laneLeader(v, c), F = this.laneFollower(v, c);
      // squeezing into a slow queue to reach a turning lane: neighbours let you in
      const courtesy = mandatory && v.v < 3 && (!F.u || F.u.v < 4);
      if (L.gap < (courtesy ? 0.8 : 1.5 + 0.25 * v.v)) continue;
      let fLoss = 0;
      if (F.u) {
        if (F.gap < (courtesy ? 0.8 : 1.5)) continue;
        const fNew = this.idm(F.u, F.gap, v.v, F.u.v0);
        if (fNew < (courtesy ? -6 : -3)) continue;
        fLoss = Math.max(0, F.u.acc - fNew);
      }
      const aNew = this.idm(v, L.gap, L.v, v.v0);
      let gain = aNew - aCur - v.politeness * fLoss + (c > a ? 0.08 : -0.08);
      if (v.kind === "truck") gain += c > a ? 0.25 : -0.25;
      if (mandatory) gain += need.urgent < 60 ? 5 : 1;
      if (gain > (mandatory ? 0 : 0.3) && gain > bestGain) { best = c; bestGain = gain; }
    }
    if (best < 0) return;
    const np = e.lanes[best];
    v.s = Math.min(np.len - 0.01, v.s * (np.len / p.len));
    v.lcOff = (v.lcT > 0 ? v.lcOff * v.lcT : 0) + (p.offset - np.offset);
    v.lcT = 1; v.lcCool = 3.5; v.laneChanges++; this.stats.laneChanges++;
    if (e.to.controlled && p.len - v.s < 150) this.ev(e.to, v, "lane", `lane ${v.lane + 1} → ${best + 1} ${(p.len - v.s).toFixed(0)} m before the junction${this.neededLanes(v).lo !== 0 || this.neededLanes(v).hi !== e.n - 1 ? ` (needs lanes ${this.neededLanes(v).lo + 1}-${this.neededLanes(v).hi + 1})` : ""}`);
    v.piece = np; v.lane = best;
    if (v.reqFor && v.reqFor.inEdge === e) { v.reqFor = null; }
  }

  // ------------------------------------------------------------ junctions
  private arbitrate(st: NodeState) {
    st.occ = st.occ.filter(o => {
      const v = o.v;
      if (v.dead) return false;
      // someone cut in ahead of a waiting grant holder (a late lane change): it must queue again
      if (!o.entered && v.piece.kind === "lane" && v.piece.edge === o.conn.inEdge) {
        const ahead = (this.index.get(v.piece.id) ?? []).some(u => u !== v && !u.dead && u.s > v.s && !(u.granted && u.conn));
        if (ahead) { this.ev(st.node, v, "revoke", "a vehicle cut in ahead in the same lane"); v.granted = false; v.conn = null; return false; }
      }
      if (v.piece === o.conn) { o.entered = true; return true; }
      if (!o.entered) return v.conn === o.conn && v.granted;
      return v.piece.kind === "lane" && v.piece.edge === o.conn.outEdge && v.trail[0] === o.conn && v.s <= v.len + 1;
    });
    // at traffic lights a green-light grant is only a promise: if the light changes before the
    // vehicle reaches the stop line, it must stop unless it is too close to do so safely
    if (st.node.def.control === "lights" && st.node.phases.length >= 2) {
      st.occ = st.occ.filter(o => {
        if (o.entered || o.sneak) return true;
        const v = o.v;
        if (v.piece.kind !== "lane" || v.piece.edge !== o.conn.inEdge) return true;
        const arm = st.node.arms.findIndex(x => x.inEdge === o.conn.inEdge);
        const sig = this.signalFor(st.node.idx, arm);
        if (sig === "green" || sig === null) return true;
        const d = v.piece.len - v.s;
        if (!this.mustGoOnSignal(v, d, sig)) { this.ev(st.node, v, "revoke", `light turned ${sig} ${d.toFixed(0)} m before the line; stops`); v.granted = false; v.conn = null; return false; }
        return true;
      });
    }
    // give way / stop: a minor-road grant is withdrawn if priority traffic turns up before the
    // vehicle has committed (it can still stop comfortably at the line)
    const n0 = st.node;
    const signedNode = n0.def.control === "priority" && n0.arms.some(a => a.inEdge?.sign);
    const majorNow = signedNode ? this.majorTraffic(n0) : [];
    if (majorNow.length) {
      st.occ = st.occ.filter(o => {
        if (o.entered || !this.minor(n0, o.conn.inEdge)) return true;
        const v = o.v;
        if (v.piece.kind !== "lane" || v.piece.edge !== o.conn.inEdge) return true;
        if (!majorNow.some(b => conflicts(o.conn, b) || b.outEdge === o.conn.outEdge)) return true;
        if (this.mustGoOnSignal(v, v.piece.len - v.s, "yellow")) return true;
        this.ev(n0, v, "revoke", "priority traffic arrived; waits again"); v.granted = false; v.conn = null; return false;
      });
    }
    if (!st.req.size) return;
    const reqs = [...st.req.values()];
    st.req.clear();
    const n = st.node, lights = n.def.control === "lights" && n.phases.length >= 2;
    if (lights) reqs.sort((a, b) => (a.conn.move.turn === "L" ? 1 : 0) - (b.conn.move.turn === "L" ? 1 : 0) || a.at - b.at || a.v.id - b.v.id);
    else reqs.sort((a, b) => a.at - b.at || a.v.id - b.v.id);
    // priority junction with signed approaches: majors go first, minors wait for a gap
    const signed = signedNode;
    if (signed) reqs.sort((a, b) => (this.minor(n, a.conn.inEdge) ? 1 : 0) - (this.minor(n, b.conn.inEdge) ? 1 : 0));
    const major = majorNow;
    const blockers: Conn[] = [];
    const log = this.logging(n);
    const deny = (v: Vehicle, why: string) => {
      if (!log || this.lastDeny.get(v.id) === why) return;
      this.lastDeny.set(v.id, why);
      const code = why.startsWith("path") ? "conflict" : why.startsWith("crosses") ? "queue-conflict" : why.startsWith("gives") ? "give-way" : why.startsWith("no room") ? "exit-full" : why.includes("light") ? "signal" : "other";
      this.ev(n, v, "deny", why, { code });
    };
    const who = (c: Conn) => { const o = st.occ.find(x => x.conn === c); return o ? `#${o.v.id} (${this.mv(c)})` : this.mv(c); };
    for (const r of reqs) {
      const c = r.conn;
      let sneak = false;
      if (lights) {
        const arm = n.arms.findIndex(x => x.inEdge === c.inEdge);
        const sig = this.signalFor(n.idx, arm);
        // a permissive turn waiting at the line for oncoming traffic clears on the yellow / all-red
        // of its own phase, once oncoming traffic has stopped (the conflict checks below still apply)
        sneak = sig !== "green" && st.phaseOfArm[arm] === st.phase && (c.move.turn === "L" || c.move.turn === "U")
          && r.d < 4 && r.v.v < 1 && this.tick - r.at > 30;
        if (sig !== "green" && !sneak && !this.mustGoOnSignal(r.v, r.d, sig)) { deny(r.v, `${sig} light`); continue; }
      }
      let ok = true, why = "";
      for (const o of st.occ) if (conflicts(c, o.conn)) { ok = false; why = log ? `path crosses ${who(o.conn)}` : ""; break; }
      if (ok) for (const b of blockers) if (conflicts(c, b)) { ok = false; why = log ? `crosses the path of a vehicle ahead in the queue (${this.mv(b)})` : ""; break; }
      if (ok && signed && this.minor(n, c.inEdge)) {
        // giving way means not crossing *or* joining the road in front of priority traffic
        const clash = (b: Conn) => conflicts(c, b) || b.outEdge === c.outEdge;
        for (const b of major) if (clash(b)) { ok = false; why = log ? `gives way to priority traffic (${this.mv(b)})` : ""; break; }
        if (ok) for (const o of st.occ) if (!o.conn.inEdge.sign && clash(o.conn)) { ok = false; why = log ? `gives way to #${o.v.id} (${this.mv(o.conn)})` : ""; break; }
      }
      if (ok && !this.exitRoom(st, c, r.v)) { ok = false; why = log ? `no room on the exit (${c.outEdge.link.name || c.outEdge.link.id} lane ${c.outLane + 1})` : ""; }
      if (ok) {
        r.v.conn = c; r.v.granted = true; st.occ.push({ v: r.v, conn: c, entered: false, sneak });
        if (log) { this.lastDeny.delete(r.v.id); this.ev(n, r.v, "grant", `${this.mv(c)} · ${r.d.toFixed(0)} m from the line, waited ${((this.tick - r.at) / 10).toFixed(1)} s${sneak ? " · clears on the change (oncoming stopped)" : ""}`, this.md(c.move, c.inLane, c.outLane)); }
      } else { blockers.push(c); deny(r.v, why); }
    }
  }

  private exitRoom(st: NodeState, c: Conn, v: Vehicle) {
    const out = c.outEdge.lanes[c.outLane];
    let rear = Infinity;
    const list = this.index.get(out.id);
    // room that will be there by the time we arrive: a vehicle already driving away frees space
    if (list) for (const u of list) rear = Math.min(rear, u.s - u.len + (u.v > 1.5 ? u.v * 2 : 0));
    let need = v.len + 1.5;
    for (const o of st.occ) if (!o.entered && o.conn.outEdge === c.outEdge && o.conn.outLane === c.outLane) need += o.v.len + 2;
    return rear >= need || out.len < need;
  }

  // ------------------------------------------------------------ movement
  private move(v: Vehicle) {
    if (v.dwell > 0) { v.dwell -= DT; if (v.dwell <= 0) this.busDepart(v); return; }
    v.v = Math.max(0, v.v + v.acc * DT);
    v.s += v.v * DT;
    let guard = 0;
    while (v.s >= v.piece.len && guard++ < 8) {
      const p = v.piece;
      if (p.kind === "lane") {
        const e = p.edge, next = v.route[v.ri + 1];
        if (!next) {
          this.recordEma(v, e);
          if (v.dest.kind === "gateway" && e.to === v.dest.node) { this.kill(v, "exit"); return; }
          this.kill(v, "removed"); return;
        }
        const cross = this.crossingFor(v, v.ri, v.lane);
        if (!cross) { this.kill(v, "removed"); return; }
        if (e.to.controlled && (!v.granted || v.conn !== cross[0])) { v.s = p.len - 0.01; v.v = 0; return; }
        this.recordEma(v, e);
        v.s -= p.len; v.trail = [p, ...v.trail].slice(0, 2);
        v.piece = cross[0]; v.queue = cross.slice(1);
        if (cross[0].kind === "conn") {
          const realMove = this.moveOf(e, next);
          const sigNow = e.to.def.control === "lights" ? this.signalFor(e.to.idx, e.to.arms.findIndex(a => a.inEdge === e)) : null;
          this.ev(e.to, v, "enter", `${e.to.ring && realMove ? this.mv(realMove, v.lane) : this.mv(cross[0])} at ${(v.v * 3.6).toFixed(0)} km/h${sigNow ? ` · light ${sigNow}` : ""}`,
            { ...this.md(realMove ?? cross[0].move, v.lane, e.to.ring ? undefined : cross[0].outLane), sig: sigNow });
          const k = `${e.idx}>${cross[0].move.out.idx}`; this.turnCounts.set(k, (this.turnCounts.get(k) ?? 0) + 1);
          const ni = e.to.idx; this.nodeThrough[ni] = (this.nodeThrough[ni] ?? 0) + 1;
          if (e.to.def.control === "lights") { const arm = e.to.arms.findIndex(a => a.inEdge === e); if (arm >= 0) this.ns[ni].cyc[arm].count++; }
          (this.nodeRecent[ni] ??= []).push(this.tick);
        }
      } else if (v.queue.length) {
        v.s -= p.len; v.trail = [p, ...v.trail].slice(0, 2);
        v.piece = v.queue[0]; v.queue = v.queue.slice(1);
      } else if (p.kind === "conn") {
        const np = p.outEdge.lanes[p.outLane];
        v.s -= p.len; v.trail = [p, ...v.trail].slice(0, 2); v.piece = np;
        this.ev(p.node, v, "leave", `onto ${p.outEdge.link.name || p.outEdge.link.id} lane ${p.outLane + 1}`, { to: p.outEdge.link.id, outLane: p.outLane + 1 });
        v.ri++; v.lane = p.outLane; v.conn = null; v.granted = false; v.enterT = this.tick;
        v.stoppedAt = null; v.fixedAt = null;
        this.replan(v);
      } else { this.kill(v, "removed"); return; }
    }
    // destinations along an edge
    if (v.piece.kind === "lane" && v.ri === v.route.length - 1) {
      const e = v.piece.edge, f = v.piece.len / Math.max(1e-6, e.length);
      if (v.dest.kind === "edge" && v.dest.edge === e && v.s >= v.dest.s * f) this.kill(v, "arrived");
      else if (v.dest.kind === "stop" && v.dest.stop.edge === e && v.s >= v.dest.stop.s * f - 0.6) { v.v = 0; this.busArrive(v); }
    }
  }

  private recordEma(v: Vehicle, e: Edge) {
    if (v.kind === "bus") return;
    const dur = (this.tick - v.enterT) * DT;
    this.ema[e.idx] = this.ema[e.idx] > 0 ? this.ema[e.idx] * 0.8 + dur * 0.2 : dur;
  }

  /** re-plan the rest of the route after entering a new edge */
  private replan(v: Vehicle) {
    const e = v.route[v.ri];
    if (v.dest.kind === "edge" && v.dest.edge === e) { v.route = v.route.slice(0, v.ri + 1); return; }
    if (v.dest.kind === "stop" && v.dest.stop.edge === e) { v.route = v.route.slice(0, v.ri + 1); return; }
    if (v.dest.kind === "gateway" && e.to === v.dest.node) { v.route = v.route.slice(0, v.ri + 1); return; }
    if (this.rng() < 0.5 || v.route.length <= v.ri + 1) {
      // keep the turn at the coming junction if we already sit in a lane for it (we picked the
      // lane on the way in); only re-think the route beyond it
      const oldNext = v.route[v.ri + 1], m0 = oldNext ? this.moveOf(e, oldNext) : undefined;
      let rest: Edge[] | null = null;
      if (m0 && v.lane >= m0.lo && v.lane <= m0.hi) {
        const tail = oldNext.to === (v.dest.kind === "gateway" ? v.dest.node : null) || (v.dest.kind === "edge" && v.dest.edge === oldNext) || (v.dest.kind === "stop" && v.dest.stop.edge === oldNext) ? [] : this.plan(oldNext, v.dest, { bus: v.kind === "bus" });
        if (tail) rest = [oldNext, ...tail];
      }
      rest ??= this.plan(e, v.dest, { bus: v.kind === "bus" });
      if (rest) v.route = [...v.route.slice(0, v.ri + 1), ...rest];
    }
    this.applySplit(v);
    if (v.route.length > 60) { const cut = v.ri; v.route = v.route.slice(cut); v.ri = 0; }
  }

  /**
   * Turning proportions: when a vehicle starts along an edge whose junction has a split set,
   * it draws its exit from the split and re-plans from there (keeping its destination if it
   * can still get there, otherwise heading for the nearest way out).
   */
  private applySplit(v: Vehicle) {
    if (v.kind === "bus") return;
    // decide this junction and the next one, so there is a whole road to get into the right lane
    this.applySplitAt(v, v.ri);
    this.applySplitAt(v, v.ri + 1);
  }

  private applySplitAt(v: Vehicle, i: number) {
    const e = v.route[i];
    if (!e) return;
    if ((v.dest.kind === "edge" && v.dest.edge === e) || (v.dest.kind === "gateway" && e.to === v.dest.node)) return;
    const split = e.dir === 1 ? e.link.splitF : e.link.splitB;
    if (!split) return;
    const moves = (e.to.moves.get(e.idx) ?? []).filter(m => !m.out.busOnly);
    let out = v.splits?.get(e.idx);
    if (!out || !moves.some(m => m.out === out)) {
      const weights = moves.map(m => split[m.out.link.id] ?? 0);
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) return;
      let x = this.rng() * total, k = 0;
      for (; k < moves.length - 1; k++) { x -= weights[k]; if (x <= 0) break; }
      out = moves[k].out;
      (v.splits ??= new Map()).set(e.idx, out);
    }
    if (v.route[i + 1] === out) return;
    let rest = this.plan(out, v.dest);
    if (!rest && !(v.dest.kind === "edge" && v.dest.edge === out)) {
      // the old destination is behind us: leave by whichever exit is reachable
      for (const g of [...this.gateways].sort(() => this.rng() - 0.5)) {
        const d: Dest = { kind: "gateway", node: g };
        const r = out.to === g ? [] : this.plan(out, d);
        if (r) { v.dest = d; rest = r; break; }
      }
    }
    v.route = [...v.route.slice(0, i + 1), out, ...(rest ?? [])];
  }

  private busArrive(v: Vehicle) {
    if (v.dest.kind !== "stop") return;
    const stop = v.dest.stop;
    const alight = Math.floor(v.pax * (0.25 + this.rng() * 0.35));
    v.pax -= alight;
    const board = Math.min(Math.floor(stop.waiting), v.cap - v.pax);
    stop.waiting -= board; v.pax += board; this.stats.boarded += board;
    v.dwell = 3 + 0.5 * alight + 0.8 * board;
  }

  private busDepart(v: Vehicle) {
    v.dwell = 0;
    const line = v.line;
    if (!line || line.stops.length < 2) { v.dwell = 5; return; }
    v.stopIdx = (v.stopIdx + 1) % line.stops.length;
    const next = line.stops[v.stopIdx];
    v.dest = { kind: "stop", stop: next };
    const e = v.route[v.ri];
    if (next.edge === e && next.s * (v.piece.len / e.length) > v.s + 5) { v.route = v.route.slice(0, v.ri + 1); return; }
    const rest = this.plan(e, v.dest, { bus: true });
    if (rest) v.route = [...v.route.slice(0, v.ri + 1), ...rest];
    else v.dwell = 5;
  }

  private housekeeping() {
    for (let k = 0; k < this.ema.length; k++) if (this.ema[k] > 0) {
      const e = this.net.edges[k], ff = e.length / e.speed;
      this.ema[k] += (ff - this.ema[k]) * 0.04;
    }
    this.vehicles = this.vehicles.filter(v => !v.dead);
  }

  private sample() {
    let n = 0, cars = 0, trucks = 0, buses = 0, sp = 0, stopped = 0;
    for (const v of this.vehicles) {
      if (v.dead) continue;
      n++; if (v.kind === "car") cars++; else if (v.kind === "truck") trucks++; else buses++;
      sp += v.v;
      if (v.v < 0.5 && v.dwell <= 0) stopped++;
    }
    const cutoff = this.tick - 600;
    while (this.tripLog.length && this.tripLog[0] < cutoff) this.tripLog.shift();
    const S = this.stats;
    S.count = n; S.cars = cars; S.trucks = trucks; S.buses = buses;
    S.avgSpeed = n ? (sp / n) * 3.6 : 0;
    S.stopped = n ? stopped / n : 0;
    S.tripsPerMin = this.time < 60 ? (this.tripLog.length * 60) / Math.max(10, this.time) : this.tripLog.length;
    S.history.push({ t: this.time, speed: S.avgSpeed, stopped: S.stopped });
    if (S.history.length > 180) S.history.shift();
  }

  // ------------------------------------------------------------ queries for renderers
  /** front and rear of the vehicle body in world metres (with lane-change smoothing) */
  /**
   * Turn signal: -1 left, 1 right, 0 off. Lit while changing lane, in the last 45 m before a
   * junction where the vehicle turns, and while turning through it.
   */
  blinker(v: Vehicle): -1 | 0 | 1 {
    if (v.dead) return 0;
    if (v.lcT > 0.1 && Math.abs(v.lcOff) > 0.5) return v.lcOff < 0 ? 1 : -1;
    let m: Movement | null = null;
    const p = v.piece;
    if (p.kind === "conn") m = p.role === "turn" ? p.move : null;
    else if (p.kind === "lane") {
      const e = v.route[v.ri], next = v.route[v.ri + 1];
      if (e && next && p.edge === e && p.len - v.s < 45) m = this.moveOf(e, next) ?? null;
    }
    if (!m || m.node.ring) return 0;
    return m.turn === "L" || m.turn === "U" ? -1 : m.turn === "R" ? 1 : 0;
  }
  /** blink phase shared by all vehicles (about 1.25 flashes per second) */
  get blinkOn() { return Math.floor(this.tick / 4) % 2 === 0; }

  pose(v: Vehicle): { fx: number; fy: number; rx: number; ry: number } {
    const f = v.piece.poly.at(v.s);
    let d = v.s - v.len, poly: Poly = v.piece.poly, k = 0;
    while (d < 0 && k < v.trail.length) { poly = v.trail[k].poly; d += poly.len; k++; }
    const r = poly.at(Math.max(0, d));
    let dx = f.x - r.x, dy = f.y - r.y, m = Math.hypot(dx, dy);
    if (m < 0.2) {
      const t = v.piece.poly.tangent(v.s);
      r.x = f.x - t.x * v.len; r.y = f.y - t.y * v.len; dx = t.x * v.len; dy = t.y * v.len; m = v.len;
    }
    if (v.lcT > 0) {
      const e = v.lcT * v.lcT * (3 - 2 * v.lcT), sh = v.lcOff * e, nx = -dy / m, ny = dx / m;
      f.x += nx * sh; f.y += ny * sh; r.x += nx * sh * 0.85; r.y += ny * sh * 0.85;
    }
    return { fx: f.x, fy: f.y, rx: r.x, ry: r.y };
  }
  routeAhead(v: Vehicle, maxDist = 500): number[] {
    const pts: number[] = [];
    let p: Piece | null = v.piece, ri = v.ri, lane = v.lane, from = v.s, total = 0, q = v.queue;
    while (p && total < maxDist) {
      const L = p.len;
      for (let k = 0; k <= 6; k++) { const pt = p.poly.at(from + ((L - from) * k) / 6); pts.push(pt.x, pt.y); }
      total += L - from; from = 0;
      if (p.kind === "lane") {
        const cross = this.crossingFor(v, ri, lane); if (!cross) break;
        p = cross[0]; q = cross.slice(1);
      } else if (q.length) { p = q[0]; q = q.slice(1); }
      else if (p.kind === "conn") { const np: LanePiece = p.outEdge.lanes[p.outLane]; lane = p.outLane; ri++; p = np; }
      else break;
    }
    return pts;
  }
  vehicleNear(x: number, y: number, radius = 6): Vehicle | null {
    let best: Vehicle | null = null, bd = radius;
    for (const v of this.vehicles) {
      if (v.dead) continue;
      const q = this.pose(v), d = Math.hypot((q.fx + q.rx) / 2 - x, (q.fy + q.ry) / 2 - y);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
}

export { LW };
