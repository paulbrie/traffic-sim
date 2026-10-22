/**
 * The spatial roundabout experiment (T213): cars drive through a roundabout as a self-driving car would, sensing space, not
 * following lanes. Outside a roundabout they follow the sketch's lanes (a plain IDM follower); at the end of the lane that leads
 * into one they hand over to spatial driving: a fan of distance rays over the 180° ahead (the surface's edges, the island, other
 * cars' bodies: nothing else, no lanes, no connectors, no one's plans), a field that goes round the island the country's way, a
 * gap-seeking steer toward the way out its route asks for, and a speed from the free distance ahead; at that way out's lane they
 * hand back. A separate engine: the main one (lane-sketch-sim.ts) is not used or changed. Plain TypeScript, no framework.
 */
import { demandWays, entryLanes, laneInRate, laneLength, laneOutWeight, nearestOn, pointAt, RouteTable, type Pt, type Sketch, type SketchLane } from "../../lane-sketch";
import { buildSurface, drivable, edgeDist, type Roundabout, type Surface } from "./surface";

// drivers (as the main engine's defaults)
const A_MAX = 1.5, B_COMF = 2, B_MAX = 6, T_HEAD = 1.2, S0 = 2, CAR_LEN = 4.5, TRUCK_LEN = 12, WIDTH = 1.8;
/** spatial driving: rays all the way round (the user's choice, 2026-10-12: as a self-driving car's sensors), every 5°; range (m) */
export const RAYS = 72;
const RANGE0 = 15, RANGE_PER_MS = 3, RANGE_MAX = 45;
/** top speed inside a roundabout (m/s), the tightest turn (m), the corridor's spare width (m) */
const V_RING = 7, R_MIN = 5, MARGIN = 0.35;
/** its path ahead, a point every this many metres */
const PATH_STEP = 0.5;
/** its line nearer the kerb than this (m) and it would be on it */
const KERB = 0.4;
/** its line steered away from a kerb nearer than this (m) */
const KERB_NEAR = 1.6;
/** the sampling planner: curvatures tried (from full left to full right), the time rolled out and its step (s), how often it plans
 * (s), the room it keeps from others (m) */
/** turning out: its way out's start no more than this off the ring's heading (rad) */
const EXIT_TURN = 0.87;
const SAMPLE_K = 9, SAMPLE_H = 2.5, SAMPLE_DT = 0.25, SAMPLE_EVERY = 0.3, SAMPLE_MARGIN = 0.3;
/** standing at a kerb this long (s), it backs up this far (m), at this speed (m/s), the front swinging toward its way */
const KERB_WAIT = 3, BACK_UP = 1.5, BACK_V = 0.7;
/** a tracked car's speed believed at most (m/s): the points its rays hit slide along it as both move */
const TRACK_MAX = 10;
/** speed at a roundabout's line (m/s) */
const ENTRY_V = 4;
/** handing back: past the way out's lane start, within this of its line (m), heading within this of the lane's (rad) */
const HAND_D = 3.5, HAND_A = (70 * Math.PI) / 180;
/** standing still this long a car counts as stuck (s); a group of them none of which moved this long, one is taken off (s) */
const STUCK = 60, CLEAR = 60;

export interface SpatialParams { speed: number; rate: number; seed: number; gap: number; opts?: SpatialOpts }
/** the experiment's own choices, to compare (not the main engine's settings) */
export interface SpatialOpts { exitLine?: boolean; noBlockBox?: boolean; uturnAfterRound?: boolean; /** the sampling planner (T213 step 3) instead of pure pursuit and braking */ sampling?: boolean }
interface PathPos { lane: SketchLane; s: number; len: number }
export interface SpatialCar {
  id: number; len: number; truck: boolean; v: number; still: number; born: number; dest: string; journey: string | null;
  /** following a lane (outside), or driving by sensing (inside a roundabout) */
  mode: "lane" | "spatial";
  at: PathPos | null;
  /** spatial: its front, heading, the roundabout, the way out's lane and its start (the goal), how far into the ring it has come */
  p: Pt; h: number; rb: Roundabout | null; goal: { lane: SketchLane; p: Pt; d: Pt } | null; entering: boolean; entered: number;
  /** the lane it came in on (it stands at its end while waiting to enter), when it began to wait */
  from: SketchLane | null; waitSince: number;
  /** its rays last step (for the drawing, and closing speeds): each the free distance, what it hit (car id, -1 the edge) */
  rays: { d: number; car: number }[] | null;
  /** the angle round it has gone so far (for missed exits) */
  round: number; lastA: number; missed: number;
  /** the cars it has tracked by its rays: the nearest point seen, its velocity, when last seen, how often */
  tracks?: Map<number, { p: Pt; vx: number; vy: number; at: number; n: number }>;
  /** where across the ring it keeps (share of the carriageway's width from the island), chosen going in */
  lane?: number;
  /** its path ahead last step (for the drawing), and what limited it (for looking into it) */
  pathPts?: Pt[]; limit?: string;
  /** backing up from a kerb it can't turn away from: metres still to go back; since when the kerb has held it */
  backing?: number; kerbSince?: number;
  /** the sampling planner's last choice (acceleration, curvature), when made, and since when nothing ahead was safe */
  plan?: { a: number; k: number; at: number }; blockedSince?: number;
}
export interface SpatialStats {
  t: number; vehicles: number; spawned: number; finished: number; heldBack: number; collisions: number; deadlocks: number; missed: number;
  stuck: number; meanTrip: number; spatialNow: number;
}

const mulberry32 = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const angDiff = (a: number, b: number) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const dirOf = (h: number) => ({ x: Math.cos(h), y: Math.sin(h) });

export class SpatialSim {
  t = 0;
  vehicles: SpatialCar[] = [];
  readonly surface: Surface | null;
  private rnd: () => number;
  private routes: RouteTable;
  private nextId = 1;
  private sources: { lane: SketchLane; rate: number; next: number; queue: number }[] = [];
  private outWay = new Map<string, string[]>();
  private spawned = 0; private finished = 0; private heldBack = 0; private collisions = 0; private deadlocks = 0; private missed = 0;
  private tripSum = 0;
  private touching = new Set<string>();
  /** the last collisions (for looking into them) */
  collisionLog: { t: number; a: number; b: number; kinds: string; va: number; vb: number }[] = [];
  /** the lanes leading into each roundabout's connectors (handover where they leave), and the lanes out of it */
  private handIn = new Map<string, { rb: Roundabout; s: number }[]>();
  /** (each way out: its lane, and where on it the roundabout's connectors join it: a road's lane can start inside the junction) */
  private outsOf = new Map<Roundabout, { lane: SketchLane; s: number }[]>();

  constructor(private sk: Sketch, private params: SpatialParams) {
    this.rnd = mulberry32(params.seed);
    this.routes = new RouteTable(sk);
    this.surface = buildSurface(sk);
    const ways = demandWays(sk);
    this.outWay = new Map(ways.exits.flatMap(w => w.lanes.map(l => [l, w.lanes])));
    for (const rb of this.surface?.roundabouts ?? []) {
      const outs = new Map<string, number>();
      for (const c of sk.connectors) if (rb.connectors.has(c.id)) {
        if (!rb.lanes.has(c.from.lane)) { const l = this.handIn.get(c.from.lane) ?? []; if (!l.some(x => x.rb === rb && Math.abs(x.s - c.from.s) < 0.5)) l.push({ rb, s: c.from.s }); this.handIn.set(c.from.lane, l); }
        if (!rb.lanes.has(c.to.lane)) outs.set(c.to.lane, Math.max(outs.get(c.to.lane) ?? 0, c.to.s));
      }
      this.outsOf.set(rb, [...outs].flatMap(([id, s]) => { const lane = sk.lanes.find(l => l.id === id); return lane ? [{ lane, s }] : []; }));
    }
    for (const lane of entryLanes(sk)) { const rate = laneInRate(lane, sk); if (rate > 0) this.sources.push({ lane, rate, next: this.gap(rate), queue: 0 }); }
    for (const j of sk.journeys ?? []) {
      const from = ways.entries.find(w => w.lanes.includes(j.from))?.lanes ?? [], to = ways.exits.find(w => w.lanes.includes(j.to))?.lanes ?? [];
      if (!from.length || !to.length || !(j.rate > 0)) continue;
      this.journeys.push({ id: j.id, from, to, rate: j.rate, trucks: j.trucks ?? 0, next: this.gap(j.rate) });
    }
  }
  private journeys: { id: string; from: string[]; to: string[]; rate: number; trucks: number; next: number }[] = [];
  private gap(rate: number) { return (-Math.log(1 - this.rnd()) * 3600) / rate; }
  private lane(id: string) { return this.sk.lanes.find(l => l.id === id)!; }

  /** a way out for a car coming in on `lane`, drawn by the ways out's shares among those it can reach */
  private pickDest(lane: string): string | null {
    const rt = this.routes, opts = rt.exits.filter(ex => laneOutWeight(this.lane(ex)) > 0 && rt.from(lane, 0, ex) < Infinity);
    const total = opts.reduce((a, ex) => a + laneOutWeight(this.lane(ex)), 0);
    let r = this.rnd() * total;
    for (const ex of opts) { r -= laneOutWeight(this.lane(ex)); if (r <= 0) return ex; }
    return opts[opts.length - 1] ?? null;
  }
  private outs(dest: string) { return this.outWay.get(dest) ?? [dest]; }

  private spawn(lane: SketchLane, dest: string | null, journey: string | null, truck: boolean) {
    if (!dest) return false;
    const len = truck ? TRUCK_LEN : CAR_LEN;
    // (room at the lane's start: else it waits to come in)
    if (this.vehicles.some(w => w.mode === "lane" && w.at?.lane === lane && w.at.s - w.len < len + S0)) return false;
    const v0 = Math.min(this.vmax(), 8);
    this.vehicles.push({ id: this.nextId++, len, truck, v: v0, still: 0, born: this.t, dest, journey, mode: "lane", at: { lane, s: len, len: laneLength(lane.shape) }, p: { x: 0, y: 0 }, h: 0, rb: null, goal: null, entering: false, entered: 0, from: null, waitSince: 0, rays: null, round: 0, lastA: 0, missed: 0 });
    this.spawned++;
    return true;
  }
  private vmax() { return (this.params.speed || 50) / 3.6; }

  step(dt: number) {
    this.t += dt;
    // arrivals: each lane's own, then the journeys'
    for (const s of this.sources) {
      while (this.t >= s.next) { s.queue++; s.next += this.gap(s.rate); }
      if (s.queue > 0 && this.spawn(s.lane, this.pickDest(s.lane.id), null, false)) s.queue--;
    }
    for (const j of this.journeys) {
      while (this.t >= j.next) {
        j.next += this.gap(j.rate);
        const from = this.lane(j.from[Math.floor(this.rnd() * j.from.length)]), truck = this.rnd() * 100 < j.trucks;
        if (!this.spawn(from, j.to[Math.floor(this.rnd() * j.to.length)], j.id, truck)) this.heldBack++;
      }
    }
    // driving
    const acc = new Map<SpatialCar, number>();
    for (const v of this.vehicles) acc.set(v, v.mode === "lane" ? this.laneAcc(v) : this.spatialStep(v, dt));
    const gone = new Set<SpatialCar>();
    for (const v of this.vehicles) {
      const a = acc.get(v)!;
      v.v = Math.max(0, v.v + a * dt);
      v.still = v.v < 0.1 ? v.still + dt : 0;
      if (v.mode === "lane") this.laneMove(v, dt, gone);
      else this.spatialMove(v, dt);
    }
    if (gone.size) this.vehicles = this.vehicles.filter(v => !gone.has(v));
    this.countCollisions();
    if (Math.floor(this.t) !== Math.floor(this.t - dt)) this.clearLocks();
    for (const s of this.sources) if (s.queue > 0) this.heldBack += 0; // (held back counted per journey; lanes keep a queue)
  }

  // ---------------------------------------------------------------- outside: lanes

  /** where a car on a lane leaves it: into a roundabout (handover at `s`), or its end */
  private leaveAt(v: SpatialCar): { s: number; rb: Roundabout | null } {
    const lane = v.at!.lane, hs = this.handIn.get(lane.id);
    if (hs?.length) return { s: hs[0].s, rb: hs[0].rb };
    return { s: v.at!.len, rb: null };
  }
  private laneAcc(v: SpatialCar) {
    const at = v.at!, out0 = this.leaveAt(v);
    // (coming up to a roundabout: slow to the speed of a give-way line by its line, as one would)
    const vm = out0.rb ? Math.min(this.vmax(), Math.sqrt(ENTRY_V * ENTRY_V + 2 * B_COMF * Math.max(0, out0.s - at.s))) : this.vmax();
    let gap = Infinity, lead = 0;
    for (const w of this.vehicles) {
      if (w === v) continue;
      // (the car ahead on its lane; or one waiting at its end to go into the roundabout, or just gone in, its body still over it)
      let ws: number | null = null;
      if (w.mode === "lane" && w.at!.lane === at.lane && w.at!.s > at.s) ws = w.at!.s;
      else if (w.mode === "spatial" && w.from === at.lane && w.entered < w.len + 1) ws = this.leaveAt({ ...v }).s + w.entered;
      if (ws === null) continue;
      const g = ws - w.len - at.s;
      if (g < gap) { gap = g; lead = w.v; }
    }
    // (into a roundabout: up to its line, where spatial driving takes over)
    const out = this.leaveAt(v);
    const isExit = !out.rb && this.outs(v.dest).includes(at.lane.id);
    if (!out.rb && !isExit) { const g = at.len - at.s + 1; if (g < gap) { gap = g; lead = 0; } }
    const sStar = S0 + Math.max(0, v.v * T_HEAD + (v.v * (v.v - lead)) / (2 * Math.sqrt(A_MAX * B_COMF)));
    const a = A_MAX * (1 - (v.v / vm) ** 4 - (gap < Infinity ? (sStar / Math.max(gap, 0.1)) ** 2 : 0));
    return Math.max(-B_MAX, a);
  }
  private laneMove(v: SpatialCar, dt: number, gone: Set<SpatialCar>) {
    const at = v.at!, out = this.leaveAt(v);
    at.s += v.v * dt;
    if (out.rb && at.s >= out.s) { this.handOver(v, out.rb, out.s); return; }
    if (at.s >= at.len) {
      gone.add(v); this.finished++; this.tripSum += this.t - v.born;
    }
  }

  /** at the end of the lane into a roundabout: spatial driving from here, its goal the way out its route asks for */
  private handOver(v: SpatialCar, rb: Roundabout, s: number) {
    const lane = v.at!.lane, pa = pointAt(lane.shape, Math.min(s, laneLength(lane.shape)));
    const rt = this.routes, dests = this.outs(v.dest);
    let best: { lane: SketchLane; s: number } | null = null, bc = Infinity;
    for (const o of this.outsOf.get(rb) ?? []) {
      const c = Math.min(...dests.map(d => rt.from(o.lane.id, o.s, d)));
      if (c < bc) { bc = c; best = o; }
    }
    if (!best) { best = (this.outsOf.get(rb) ?? [])[0] ?? null; }
    const g = best ? pointAt(best.lane.shape, best.s) : null;
    Object.assign(v, { mode: "spatial", at: null, p: pa.p, h: Math.atan2(pa.d.y, pa.d.x), rb, goal: best && g ? { lane: best.lane, p: g.p, d: g.d } : null, entering: true, entered: 0, from: lane, waitSince: this.t, rays: null, tracks: new Map(), lane: undefined, round: 0, lastA: Math.atan2(pa.p.y - rb.c.y, pa.p.x - rb.c.x) });
  }

  // ---------------------------------------------------------------- inside: sensing and planning

  /** the rays: from its front, all round, each to the surface's edge or another car's body (nothing else known; its own body not seen) */
  private sense(v: SpatialCar) {
    const s = this.surface!, range = Math.min(RANGE_MAX, RANGE0 + RANGE_PER_MS * v.v), out: { d: number; car: number }[] = [];
    const others = this.vehicles.filter(w => w !== v && Math.hypot(this.front(w).x - v.p.x, this.front(w).y - v.p.y) < range + w.len + 2);
    const bodies = others.map(w => ({ id: w.id, ...this.body(w) }));
    for (let i = 0; i < RAYS; i++) {
      const a = this.rayAngle(v, i), ux = Math.cos(a), uy = Math.sin(a);
      // (along the ray, in steps as long as the ground allows: to where it leaves the drivable surface)
      let t = 0.2, hit = range;
      while (t < range) {
        const q = { x: v.p.x + ux * t, y: v.p.y + uy * t };
        if (!drivable(s, q)) { hit = t; break; }
        t += Math.max(0.15, edgeDist(s, q));
      }
      let car = -1;
      for (const b of bodies) { const tc = rayBox(v.p, ux, uy, b); if (tc !== null && tc < hit) { hit = tc; car = b.id; } }
      out.push({ d: hit, car });
    }
    return out;
  }

  /**
   * What it has tracked of the cars its rays hit: the nearest point of each seen, and how that point moves (smoothed), as a
   * lidar tracker would; one not seen for half a second is dropped. Nothing of their plans: only where they are, and going.
   */
  private track(v: SpatialCar, rays: { d: number; car: number }[], dt: number) {
    // (each car seen: the middle of the points its rays hit on it, steadier than the nearest one, which slides along its side)
    const sum = new Map<number, { x: number; y: number; n: number }>();
    rays.forEach((x, i) => {
      if (x.car < 0) return;
      const a = this.rayAngle(v, i), o = sum.get(x.car) ?? { x: 0, y: 0, n: 0 };
      o.x += v.p.x + Math.cos(a) * x.d; o.y += v.p.y + Math.sin(a) * x.d; o.n++;
      sum.set(x.car, o);
    });
    const seen = new Map([...sum].map(([id, o]) => [id, { x: o.x / o.n, y: o.y / o.n }]));
    const tr = (v.tracks ??= new Map());
    for (const [id, q] of seen) {
      const o = tr.get(id);
      if (!o) tr.set(id, { p: q, vx: 0, vy: 0, at: this.t, n: 0 });
      else {
        let vx = (q.x - o.p.x) / dt, vy = (q.y - o.p.y) / dt;
        const sp = Math.hypot(vx, vy);
        if (sp > TRACK_MAX) { vx *= TRACK_MAX / sp; vy *= TRACK_MAX / sp; }
        const k = o.n ? 0.2 : 1;
        tr.set(id, { p: q, vx: o.vx + (vx - o.vx) * k, vy: o.vy + (vy - o.vy) * k, at: this.t, n: o.n + 1 });
      }
    }
    for (const [id, o] of tr) if (this.t - o.at > 0.5) tr.delete(id);
  }
  /** ray `i`'s direction: straight ahead first, round the full circle */
  private rayAngle(v: SpatialCar, i: number) { return v.h + (2 * Math.PI * i) / RAYS; }

  /**
   * The free distance along heading `a`: to the first thing within the car's corridor (its width and a margin) that its rays
   * show, and to where a tracked car is going to cross that corridor within `H` seconds ahead of it getting there (it must stop
   * short of that); and how fast what limits it moves along the corridor.
   */
  private corridor(v: SpatialCar, rays: { d: number; car: number }[], a: number, H: number) {
    const cx = Math.cos(a), cy = Math.sin(a);
    let free = Infinity, leadV = 0;
    rays.forEach((x, i) => {
      const b = this.rayAngle(v, i), qx = Math.cos(b) * x.d, qy = Math.sin(b) * x.d;
      const along = qx * cx + qy * cy, side = Math.abs(-qx * cy + qy * cx);
      if (along > 0 && side < WIDTH / 2 + MARGIN && along < free) {
        free = along;
        const o = x.car >= 0 ? v.tracks?.get(x.car) : undefined;
        leadV = o ? Math.max(0, o.vx * cx + o.vy * cy) : 0;
      }
    });
    if (!Number.isFinite(free)) free = RANGE_MAX;
    for (const o of v.tracks?.values() ?? []) {
      if (o.n < 4 || Math.hypot(o.vx, o.vy) < 0.5) continue;
      for (let tau = 0.25; tau <= H; tau += 0.25) {
        const qx = o.p.x + o.vx * tau - v.p.x, qy = o.p.y + o.vy * tau - v.p.y;
        const along = qx * cx + qy * cy, side = Math.abs(-qx * cy + qy * cx);
        if (along <= 0.5 || side > WIDTH + MARGIN) continue;
        // (it will be across this corridor `along` metres on: if this one would be there by then (or nearly), it stops short of it)
        if (v.v * tau + 2 > along - 3 && along - 3 < free) { free = Math.max(0, along - 3); leadV = Math.max(0, o.vx * cx + o.vy * cy); }
        break;
      }
    }
    return { free, leadV };
  }

  /**
   * Where a car at `p` heading `h` wants to go next (an aim point), from the map alone: round the island the ring's way at its own
   * distance out (inside for a far way out, outside for a near one, as drivers keep to a side), out to the outside before its way
   * out, then to its way out's lane and along it. No lanes or connectors: the island's middle and reach, and the goal.
   */
  private aimFor(v: SpatialCar, p: Pt): { aim: Pt; toGo: number } {
    const rb = v.rb!, g = v.goal!, alpha = Math.atan2(p.y - rb.c.y, p.x - rb.c.x), r = Math.hypot(p.x - rb.c.x, p.y - rb.c.y);
    const deg = ((Math.round((alpha * 180) / Math.PI) % 360) + 360) % 360, rIn = rb.rIn[deg], W = Math.max(2.5, Math.min(rb.width, rb.rOut[deg] - rIn));
    const ga = Math.atan2(g.p.y - rb.c.y, g.p.x - rb.c.x);
    const toGo = ((((ga - alpha) * rb.sense) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), dGoal = Math.hypot(g.p.x - p.x, g.p.y - p.y);
    // (its way out about abreast, a little ahead: out to the lane's start, then along it (no cutting across what lies between))
    // (its way out about abreast, a little ahead: onto its lane's line, aiming a little down it from where it would join it)
    const o = this.params.opts ?? {};
    // (its way out ahead within a gentle turn: its lane's start no more than 50° off the ring's way from here (or nearly abreast))
    if (this.exitNow(v, p, toGo) || (toGo > 6 && dGoal < 6 && (!o.uturnAfterRound || v.round > Math.PI))) {
      if (!o.exitLine) return { aim: dGoal > 5 ? g.p : { x: g.p.x + g.d.x * 8, y: g.p.y + g.d.y * 8 }, toGo };
      const along = (p.x - g.p.x) * g.d.x + (p.y - g.p.y) * g.d.y, sAim = Math.max(3, Math.min(15, along + 5));
      return { aim: pointAt(g.lane.shape, Math.min(sAim, laneLength(g.lane.shape))).p, toGo };
    }
    const rT = rIn + W * (toGo < 1.5 ? 0.78 : v.lane!), ahead = Math.min(0.7, 5 / Math.max(r, rT)), b = alpha + rb.sense * ahead;
    return { aim: { x: rb.c.x + rT * Math.cos(b), y: rb.c.y + rT * Math.sin(b) }, toGo };
  }
  /** time to turn out: its way out's lane start ahead the ring's way (within 1.2 rad round) and no more than 50° off the ring's
   * heading from here, so a gentle turn takes it there; or nearly abreast of it (T213: exits far out down a road as near ones) */
  private exitNow(v: SpatialCar, p: Pt, toGo: number) {
    const rb = v.rb!, g = v.goal!, a = Math.atan2(p.y - rb.c.y, p.x - rb.c.x), tan = Math.atan2(rb.sense * Math.cos(a), -rb.sense * Math.sin(a));
    return toGo < 0.25 || (toGo < 1.2 && Math.abs(angDiff(Math.atan2(g.p.y - p.y, g.p.x - p.x), tan)) < EXIT_TURN);
  }
  /** its path ahead, as it would drive it (turning no tighter than it can): points every PATH_STEP m, up to `len` m */
  private pathAhead(v: SpatialCar, len: number): Pt[] {
    let p = v.p, h = v.h;
    const out: Pt[] = [p], maxTurn = PATH_STEP / R_MIN;
    for (let s = PATH_STEP; s <= len; s += PATH_STEP) {
      const { aim } = this.aimFor(v, p);
      const want = Math.atan2(aim.y - p.y, aim.x - p.x) + this.kerbPush(p, h);
      h += Math.max(-maxTurn, Math.min(maxTurn, angDiff(want, h)));
      p = { x: p.x + Math.cos(h) * PATH_STEP, y: p.y + Math.sin(h) * PATH_STEP };
      out.push(p);
    }
    return out;
  }
  /** near a kerb (within KERB_NEAR m of the paving's edge): a turn away from it, toward the side with more room (rad) */
  private kerbPush(p: Pt, h: number) {
    const s = this.surface!, e = edgeDist(s, p);
    if (e >= KERB_NEAR || !drivable(s, p)) return 0;
    const lx = -Math.sin(h), ly = Math.cos(h);
    const room = (k: number) => { const q = { x: p.x + lx * k, y: p.y + ly * k }; return drivable(s, q) ? edgeDist(s, q) : 0; };
    return Math.sign(room(0.8) - room(-0.8)) * 0.7 * (KERB_NEAR - e);
  }
  /**
   * How far along its path before it must stop: the first thing its rays hit within half its width (and a margin) of the path
   * (the kerb too, if the path ran into it), and the first place a tracked car is going to be across the path within `H` s of
   * this one getting there; and how fast what limits it moves along the path.
   */
  private pathFree(v: SpatialCar, rays: { d: number; car: number }[], path: Pt[], H: number) {
    let free = (path.length - 1) * PATH_STEP, leadV = v.v > 0 ? Infinity : 0, limit = "path end";
    const reachK = (q: Pt, w: number) => { for (let k = 1; k < path.length; k++) if (Math.hypot(q.x - path[k].x, q.y - path[k].y) < w) return k; return -1; };
    // (the kerb: where its body on the path would leave the paving (nearer the edge than half its width))
    const s = this.surface!;
    // (at its line, the first metres ahead are where its lane ran on: not looked at for the kerb)
    for (let k = v.entering && v.entered < 2 ? 5 : 2; k < path.length; k++) if (!drivable(s, path[k]) || edgeDist(s, path[k]) < KERB) { free = k * PATH_STEP; leadV = 0; limit = "kerb"; break; }
    // (cars: what its rays hit on them near the path)
    rays.forEach((x, i) => {
      if (x.car < 0) return;
      const a = this.rayAngle(v, i), q = { x: v.p.x + Math.cos(a) * x.d, y: v.p.y + Math.sin(a) * x.d };
      const k = reachK(q, WIDTH / 2 + MARGIN);
      if (k > 0 && k * PATH_STEP < free) {
        free = k * PATH_STEP; limit = `car ${x.car}`;
        const o = v.tracks?.get(x.car), d = this.dirAt(path, k);
        leadV = o ? Math.max(0, o.vx * d.x + o.vy * d.y) : 0;
      }
    });
    // (one going to cross its path: who goes first, from where they are, as the rules have it. Going in, it gives way to all that
    // come round within the gap; on the ring, not to one still outside it (that one gives way), else to one there first)
    const rb = v.rb!, onRing = (q: Pt) => { const a = Math.atan2(q.y - rb.c.y, q.x - rb.c.x), d = ((Math.round((a * 180) / Math.PI) % 360) + 360) % 360; return Math.hypot(q.x - rb.c.x, q.y - rb.c.y) <= rb.rIn[d] + rb.width + 0.5; };
    const going = v.entering && v.entered < 0.5;
    for (const o of v.tracks?.values() ?? []) {
      if (o.n < 4 || Math.hypot(o.vx, o.vy) < 0.5) continue;
      if (!going && !onRing(o.p)) continue;
      for (let tau = 0.25; tau <= H; tau += 0.25) {
        const q = { x: o.p.x + o.vx * tau, y: o.p.y + o.vy * tau }, k = reachK(q, WIDTH + MARGIN);
        if (k < 0) continue;
        // (it will be across the path k steps on at tau: this one gives way if that one gets there first (going in: within the gap))
        const s = k * PATH_STEP, mine = s / Math.max(v.v, 1.5);
        if ((going || tau < mine + 0.5) && s - 4 < free) { free = Math.max(0, s - 4); limit = "coming"; const d = this.dirAt(path, k); leadV = Math.max(0, o.vx * d.x + o.vy * d.y); }
        break;
      }
    }
    return { free, leadV: Number.isFinite(leadV) ? leadV : v.v, limit };
  }
  private dirAt(path: Pt[], k: number) { const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k)], l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; }

  /** a spatial car's acceleration this step; its heading turned along its path */
  private spatialStep(v: SpatialCar, dt: number) {
    const rays = this.sense(v);
    v.rays = rays;
    this.track(v, rays, dt);
    if (v.lane === undefined) { const { toGo } = this.aimFor({ ...v, lane: 0.5 } as SpatialCar, v.p); v.lane = toGo > Math.PI ? 0.4 : 0.7; }
    const len = Math.min(RANGE_MAX, 10 + 3 * v.v + (v.entering ? 10 : 0)), path = this.pathAhead(v, len);
    // (going in: what comes round looked at further ahead, the gap accepted and the time to get in; after 10 s waiting, less)
    const patient = this.t - v.waitSince > 10, H = v.entering ? (patient ? 1.5 : this.params.gap + 2) : 3;
    const { free, leadV, limit } = this.pathFree(v, rays, path, H);
    v.pathPts = path; v.limit = `${limit} at ${free.toFixed(1)} m`;
    // (standing at a kerb it can't turn away from: a short, slow back-up, only with room behind and nothing coming from there)
    if (v.backing && v.backing > 0) return 0;
    if (limit === "kerb" && free < 2 && v.v < 0.1 && !(v.entering && v.entered < 0.5)) {
      v.kerbSince ??= this.t;
      if (this.t - v.kerbSince > KERB_WAIT && this.clearBehind(v, rays)) { v.backing = BACK_UP; v.kerbSince = undefined; return 0; }
    } else v.kerbSince = undefined;
    // (not into the ring unless it can get clear in it: room along its path past where it joins the carriageway round the island,
    // its own length and more, as a driver doesn't stop across the ring (no blocking the box))
    if (v.entering && v.entered < 0.5 && !(this.params.opts?.noBlockBox ?? true)) {
      if (free < Math.min(12, path.length * PATH_STEP - 1)) return this.stopAt(v, 0.3);
    } else if (v.entering && v.entered < 0.5) {
      const rb = v.rb!, kJoin = path.findIndex(q => { const a = Math.atan2(q.y - rb.c.y, q.x - rb.c.x), d = ((Math.round((a * 180) / Math.PI) % 360) + 360) % 360; return Math.hypot(q.x - rb.c.x, q.y - rb.c.y) < rb.rIn[d] + rb.width * 0.95; });
      const sJoin = kJoin < 0 ? 0 : kJoin * PATH_STEP, needIn = Math.min(path.length * PATH_STEP - 1, sJoin + v.len + 6);
      if (free < needIn) return this.stopAt(v, 0.3);
    }
    if (this.params.opts?.sampling) return this.sampled(v, rays, path, dt);
    // (steering: pure pursuit on its path, 3 m ahead; standing, it can't turn)
    const tgt = path[Math.min(path.length - 1, Math.round(3 / PATH_STEP))], want = Math.atan2(tgt.y - v.p.y, tgt.x - v.p.x);
    const wMax = v.v / R_MIN, w = Math.max(-wMax, Math.min(wMax, 2.5 * angDiff(want, v.h)));
    v.h += w * dt;
    // (speed: following what holds its path, at most the ring's speed)
    const gapM = Math.max(0.1, free - 0.3);
    const sStar = 1 + Math.max(0, v.v * 0.9 + (v.v * (v.v - leadV)) / (2 * Math.sqrt(A_MAX * B_COMF)));
    return Math.max(-B_MAX, A_MAX * (1 - (v.v / V_RING) ** 4 - (sStar / gapM) ** 2));
  }
  /**
   * The sampling planner (a dynamic window, as robots thread gaps): short manoeuvres tried, each a curvature held and an
   * acceleration, rolled out SAMPLE_H s; one that keeps its corners on the paving and its body clear of what its rays show of
   * others (moved on by how they were tracked moving; one still outside the ring, which gives way to it, not moved on) is safe;
   * of the safe ones the best by progress along its guidance line, lining up with it, room kept and a steady wheel; none safe, the
   * one that meets trouble latest; and standing with none safe a while, a back-up tried as one of them. Planned every
   * SAMPLE_EVERY s, the choice held between.
   */
  private sampled(v: SpatialCar, rays: { d: number; car: number }[], path: Pt[], dt: number) {
    if (!v.plan || this.t - v.plan.at >= SAMPLE_EVERY - 1e-6) v.plan = { ...this.choose(v, rays, path), at: this.t };
    const { a, k } = v.plan;
    if (a < -50) { v.backing = BACK_UP; v.plan = undefined; return 0; }
    v.h += v.v * k * dt;
    return a;
  }
  private choose(v: SpatialCar, rays: { d: number; car: number }[], path: Pt[]) {
    const s = this.surface!, rb = v.rb!, going = v.entering && v.entered < 0.5;
    const onRing = (q: Pt) => { const a = Math.atan2(q.y - rb.c.y, q.x - rb.c.x), d = ((Math.round((a * 180) / Math.PI) % 360) + 360) % 360; return Math.hypot(q.x - rb.c.x, q.y - rb.c.y) <= rb.rIn[d] + rb.width + 0.5; };
    // (what its rays show of other cars: the points hit, each with how its car was tracked moving)
    const pts: { x: number; y: number; vx: number; vy: number }[] = [];
    rays.forEach((x, i) => {
      if (x.car < 0 || x.d > 25) return;
      const a = this.rayAngle(v, i), o = v.tracks?.get(x.car), moves = o && o.n >= 4 && Math.hypot(o.vx, o.vy) >= 0.5 && (going || onRing(o.p));
      pts.push({ x: v.p.x + Math.cos(a) * x.d, y: v.p.y + Math.sin(a) * x.d, vx: moves ? o!.vx : 0, vy: moves ? o!.vy : 0 });
    });
    const kMax = 1 / R_MIN, prevK = v.plan?.k ?? 0;
    // (circling: not going in, not yet turning out to its way out)
    const { toGo } = this.aimFor(v, v.p);
    const circling = !v.entering && !this.exitNow(v, v.p, toGo) && toGo <= 6;
    const a0 = Math.atan2(v.p.y - rb.c.y, v.p.x - rb.c.x), deg0 = ((Math.round((a0 * 180) / Math.PI) % 360) + 360) % 360;
    const rT = rb.rIn[deg0] + Math.max(2.5, Math.min(rb.width, rb.rOut[deg0] - rb.rIn[deg0])) * (toGo < 1.5 ? 0.78 : v.lane ?? 0.5);
    let best = { a: -B_MAX, k: 0 }, bestScore = -Infinity, anySafe = false, anyMoves = false;
    const accs = [-B_MAX, -B_COMF, 0, A_MAX];
    for (let ki = 0; ki <= SAMPLE_K; ki++) for (const a of accs) {
      // (the last: following its guidance line, the wheel turned afresh at each step of the roll-out, as a lattice planner's
      // path-following candidates do; the others a curvature held)
      const k = ki === SAMPLE_K ? NaN : -kMax + (2 * kMax * ki) / (SAMPLE_K - 1);
      const r = this.rollout(v, a, k, pts, s, path);
      let score: number;
      if (r.hit === Infinity) {
        anySafe = true;
        if (Math.hypot(r.end.x - v.p.x, r.end.y - v.p.y) > 1) anyMoves = true;
        if (circling) {
          // (round the ring: progress is the way round it made, at whatever distance out, a little held to its own distance and the
          // ring's heading: a gap round a stopped car beats waiting behind it)
          const a1 = Math.atan2(r.end.y - rb.c.y, r.end.x - rb.c.x), r1 = Math.hypot(r.end.x - rb.c.x, r.end.y - rb.c.y);
          const made = angDiff(a1, a0) * rb.sense * r1, tan1 = Math.atan2(rb.sense * Math.cos(a1), -rb.sense * Math.sin(a1));
          score = 100 + 1.0 * made - 0.3 * Math.abs(r1 - rT) - 1.0 * Math.abs(angDiff(r.endH, tan1)) + 0.3 * Math.min(r.room, 3) - 0.4 * Math.abs(k - prevK) * R_MIN;
        } else {
          // (going in or out: progress along its guidance line, the end's distance off it and heading off it, room kept, a steady wheel)
          const g = guideAt(path, r.end);
          score = 100 + 1.0 * g.along - 1.5 * g.off - 2.0 * Math.abs(angDiff(r.endH, g.h)) + 0.3 * Math.min(r.room, 3) - 0.4 * Math.abs(k - prevK) * R_MIN;
        }
      } else score = 10 * r.hit - (a > 0 ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = { a, k: Number.isNaN(k) ? r.k0 : k }; }
    }
    // (standing, nothing that gets it anywhere safe for a while (standing still always is): a careful back-up, if there is room
    // behind and nothing coming from there)
    if ((!anySafe || !anyMoves) && v.v < 0.1 && !going) {
      v.blockedSince ??= this.t;
      if (this.t - v.blockedSince > KERB_WAIT && this.clearBehind(v, rays)) { v.blockedSince = undefined; return { a: -100, k: 0 }; }
    } else v.blockedSince = undefined;
    return best;
  }
  /** a manoeuvre rolled out: when it first meets the kerb or another car (Infinity: not within SAMPLE_H s), where it ends, the least room */
  private rollout(v: SpatialCar, a: number, k0: number, pts: { x: number; y: number; vx: number; vy: number }[], s: Surface, path: Pt[]) {
    // (following the guidance line: pure pursuit on it, 3 m ahead of the nearest point, at each step)
    const follow = Number.isNaN(k0), pursue = (x: number, y: number, h: number) => {
      const g = guideAt(path, { x, y }), t = path[Math.min(path.length - 1, Math.round(g.along / PATH_STEP) + Math.round(3 / PATH_STEP))];
      const al = angDiff(Math.atan2(t.y - y, t.x - x), h), d = Math.max(1, Math.hypot(t.x - x, t.y - y));
      return Math.max(-1 / R_MIN, Math.min(1 / R_MIN, (2 * Math.sin(al)) / d));
    };
    let k = follow ? pursue(v.p.x, v.p.y, v.h) : k0;
    const kFirst = k;
    let x = v.p.x, y = v.p.y, h = v.h, sp = v.v, room = Infinity;
    const n = Math.round(SAMPLE_H / SAMPLE_DT);
    // (as things stand: the room to each point now, and which corners are on the paving: a manoeuvre is judged by not making
    // things worse than they are, so one standing close to another, or a corner just over a kerb, can still move)
    const dx0 = Math.cos(h), dy0 = Math.sin(h), cx0 = x - dx0 * (v.len / 2), cy0 = y - dy0 * (v.len / 2);
    const gap0 = pts.map(q => { const qx = q.x - cx0, qy = q.y - cy0; return Math.max(Math.abs(qx * dx0 + qy * dy0) - v.len / 2, Math.abs(-qx * dy0 + qy * dx0) - WIDTH / 2); });
    const cornerOk0 = ([[0, 1], [0, -1], [-v.len, 1], [-v.len, -1]] as const).map(([f, l]) => drivable(s, { x: x + dx0 * f - dy0 * l * (WIDTH / 2), y: y + dy0 * f + dx0 * l * (WIDTH / 2) }));
    for (let j = 1; j <= n; j++) {
      const tau = j * SAMPLE_DT;
      sp = Math.max(0, Math.min(V_RING, sp + a * SAMPLE_DT));
      if (follow && j > 1) k = pursue(x, y, h);
      h += sp * k * SAMPLE_DT;
      x += Math.cos(h) * sp * SAMPLE_DT; y += Math.sin(h) * sp * SAMPLE_DT;
      const dx = Math.cos(h), dy = Math.sin(h), lx = -dy, ly = dx;
      // (its corners on the paving)
      const corners = [[0, 1], [0, -1], [-v.len, 1], [-v.len, -1]] as const;
      for (let c = 0; c < 4; c++) {
        const [f, l] = corners[c], q = { x: x + dx * f + lx * l * (WIDTH / 2), y: y + dy * f + ly * l * (WIDTH / 2) };
        if (cornerOk0[c] && !drivable(s, q)) return { hit: tau, end: { x, y }, endH: h, room: 0, what: "kerb", k0: kFirst };
      }
      // (clear of the others, as they will be by then)
      const cx = x - dx * (v.len / 2), cy = y - dy * (v.len / 2);
      for (let i = 0; i < pts.length; i++) {
        const q = pts[i], qx = q.x + q.vx * tau - cx, qy = q.y + q.vy * tau - cy, al = Math.abs(qx * dx + qy * dy) - v.len / 2, lt = Math.abs(qx * lx + qy * ly) - WIDTH / 2;
        const gap = Math.max(al, lt);
        if (gap < Math.min(SAMPLE_MARGIN, gap0[i] - 0.02)) return { hit: tau, end: { x, y }, endH: h, room: 0, what: `car (point ${i}, moving ${Math.hypot(q.vx, q.vy).toFixed(1)})`, k0: kFirst };
        if (gap < room) room = gap;
      }
    }
    return { hit: Infinity, end: { x, y }, endH: h, room, what: "", k0: kFirst };
  }

  /** room to back up: the rays within 30° of straight back free past its own length by the back-up and a metre, and no car seen
   * behind moving toward it */
  private clearBehind(v: SpatialCar, rays: { d: number; car: number }[]) {
    for (let i = 0; i < RAYS; i++) {
      const a = angDiff(this.rayAngle(v, i), v.h + Math.PI);
      if (Math.abs(a) < Math.PI / 6 && rays[i].d < v.len + BACK_UP + 1) return false;
    }
    const back = dirOf(v.h + Math.PI);
    for (const o of v.tracks?.values() ?? []) {
      const rx = o.p.x - v.p.x, ry = o.p.y - v.p.y, behind = rx * back.x + ry * back.y;
      if (behind > 0 && behind < v.len + 10 && -(o.vx * back.x + o.vy * back.y) > 0.5) return false;
    }
    return true;
  }
  /** brake to stand where it is, about `d` metres on at most */
  private stopAt(v: SpatialCar, d: number) { return v.v < 0.05 ? -v.v / 0.1 : -Math.min(B_MAX, (v.v * v.v) / (2 * Math.max(0.1, d))); }

  private spatialMove(v: SpatialCar, dt: number) {
    if (v.backing && v.backing > 0) {
      const tgt = v.pathPts?.[Math.min((v.pathPts?.length ?? 1) - 1, 6)], want = tgt ? Math.atan2(tgt.y - v.p.y, tgt.x - v.p.x) : v.h;
      v.h -= Math.sign(angDiff(want, v.h)) * (BACK_V / R_MIN) * dt;
      const b = dirOf(v.h), step = Math.min(v.backing, BACK_V * dt);
      v.p = { x: v.p.x - b.x * step, y: v.p.y - b.y * step };
      v.backing -= step; v.v = 0; v.still = 0;
      return;
    }
    const d = dirOf(v.h);
    v.p = { x: v.p.x + d.x * v.v * dt, y: v.p.y + d.y * v.v * dt };
    if (v.entering) { v.entered += v.v * dt; if (v.entered > v.len + 1) v.entering = false; }
    const rb = v.rb!, a = Math.atan2(v.p.y - rb.c.y, v.p.x - rb.c.x);
    v.round += angDiff(a, v.lastA) * rb.sense; v.lastA = a;
    if (v.round > 2 * Math.PI + 0.5) { v.missed++; this.missed++; v.round -= 2 * Math.PI; }
    // (at its way out, heading along it: back on the lane)
    const g = v.goal;
    const along = g ? (v.p.x - g.p.x) * g.d.x + (v.p.y - g.p.y) * g.d.y : 0, side = g ? Math.abs(-(v.p.x - g.p.x) * g.d.y + (v.p.y - g.p.y) * g.d.x) : 0;
    if (g && along > -1 && side < HAND_D && Math.abs(angDiff(v.h, Math.atan2(g.d.y, g.d.x))) < HAND_A) {
      const s = nearestOn(g.lane.shape, v.p).s;
      Object.assign(v, { mode: "lane", at: { lane: g.lane, s: Math.max(0.1, s), len: laneLength(g.lane.shape) }, rb: null, goal: null, rays: null, from: null });
    }
  }

  // ---------------------------------------------------------------- bodies, collisions, stuck groups

  private front(v: SpatialCar): Pt { return v.mode === "lane" ? pointAt(v.at!.lane.shape, Math.min(v.at!.s, v.at!.len)).p : v.p; }
  private heading(v: SpatialCar): Pt { if (v.mode === "lane") return pointAt(v.at!.lane.shape, Math.min(v.at!.s, v.at!.len)).d; return dirOf(v.h); }
  /** its body: middle, direction, length, width */
  body(v: SpatialCar) {
    const f = this.front(v), d = this.heading(v);
    return { c: { x: f.x - (d.x * v.len) / 2, y: f.y - (d.y * v.len) / 2 }, d, len: v.len, w: WIDTH };
  }
  private countCollisions() {
    const bs = this.vehicles.map(v => ({ v, b: this.body(v) })), now = new Set<string>();
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const A = bs[i], B = bs[j];
      if (Math.hypot(A.b.c.x - B.b.c.x, A.b.c.y - B.b.c.y) > (A.v.len + B.v.len) / 2 + 2) continue;
      // (two on the same lane, one behind the other: the follower keeps its gap, their boxes on a bend may just touch)
      if (A.v.mode === "lane" && B.v.mode === "lane" && A.v.at!.lane === B.v.at!.lane) continue;
      if (!boxesOverlap(A.b, B.b, 0.15)) continue;
      const k = `${Math.min(A.v.id, B.v.id)}-${Math.max(A.v.id, B.v.id)}`;
      now.add(k);
      if (!this.touching.has(k)) { this.collisions++; this.collisionLog.push({ t: this.t, a: A.v.id, b: B.v.id, kinds: `${A.v.mode}${A.v.entering ? "(in)" : ""}/${B.v.mode}${B.v.entering ? "(in)" : ""}`, va: A.v.v, vb: B.v.v }); if (this.collisionLog.length > 50) this.collisionLog.shift(); }
    }
    this.touching = now;
  }
  /** spatial cars stuck together: none of a group within 20 m of each other moved for CLEAR s: the one stuck longest taken off */
  private clearLocks() {
    const stuck = this.vehicles.filter(v => v.mode === "spatial" && v.still >= CLEAR);
    for (const v of stuck) {
      const group = this.vehicles.filter(w => w.mode === "spatial" && Math.hypot(w.p.x - v.p.x, w.p.y - v.p.y) < 20);
      if (group.every(w => w.still >= CLEAR)) {
        const out = group.reduce((a, b) => (b.still > a.still ? b : a));
        this.vehicles = this.vehicles.filter(w => w !== out);
        this.deadlocks++;
        return;
      }
    }
  }

  stats(): SpatialStats {
    return { t: this.t, vehicles: this.vehicles.length, spawned: this.spawned, finished: this.finished, heldBack: this.heldBack + this.sources.reduce((a, s) => a + s.queue, 0), collisions: this.collisions, deadlocks: this.deadlocks, missed: this.missed, stuck: this.vehicles.filter(v => v.still > STUCK).length, meanTrip: this.finished ? this.tripSum / this.finished : 0, spatialNow: this.vehicles.filter(v => v.mode === "spatial").length };
  }
  /** what the page draws: each car's body, and for the spatial ones their rays' ends and their goal */
  poses() {
    return this.vehicles.map(v => {
      const b = this.body(v);
      return { id: v.id, p: b.c, d: b.d, len: v.len, share: v.v / Math.max(1, this.vmax()), spatial: v.mode === "spatial",
        ...(v.mode === "spatial" && v.rays ? { from: v.p, rays: v.rays.map((x, i) => { const a = this.rayAngle(v, i); return { x: v.p.x + Math.cos(a) * x.d, y: v.p.y + Math.sin(a) * x.d, car: x.car >= 0 }; }) } : {}),
        ...(v.goal ? { goal: v.goal.p } : {}) };
    });
  }
}

/** a point against a guidance line: how far along it its nearest point is (m), how far off it, and the line's heading there */
function guideAt(path: Pt[], p: Pt) {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < path.length; i++) { const d = Math.hypot(path[i].x - p.x, path[i].y - p.y); if (d < bd) { bd = d; bi = i; } }
  const a = path[Math.max(0, bi - 1)], b = path[Math.min(path.length - 1, bi + 1)];
  return { along: bi * PATH_STEP, off: bd, h: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** where a ray from `o` along (ux, uy) first meets a box (centre, direction, length, width), or null */
function rayBox(o: Pt, ux: number, uy: number, b: { c: Pt; d: Pt; len: number; w: number }): number | null {
  const ox = o.x - b.c.x, oy = o.y - b.c.y, ax = b.d.x, ay = b.d.y, bx = -ay, by = ax;
  const p0 = ox * ax + oy * ay, q0 = ox * bx + oy * by, pu = ux * ax + uy * ay, qu = ux * bx + uy * by;
  let t0 = 0, t1 = Infinity;
  for (const [s0, su, h] of [[p0, pu, b.len / 2], [q0, qu, b.w / 2]] as const) {
    if (Math.abs(su) < 1e-9) { if (Math.abs(s0) > h) return null; continue; }
    let a = (-h - s0) / su, c = (h - s0) / su;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  return t0;
}
/** do two boxes overlap by more than `slack` metres (separating axes) */
function boxesOverlap(A: { c: Pt; d: Pt; len: number; w: number }, B: { c: Pt; d: Pt; len: number; w: number }, slack: number) {
  const axes = [A.d, { x: -A.d.y, y: A.d.x }, B.d, { x: -B.d.y, y: B.d.x }];
  const half = (X: typeof A, ax: Pt) => (Math.abs(X.d.x * ax.x + X.d.y * ax.y) * X.len) / 2 + (Math.abs(-X.d.y * ax.x + X.d.x * ax.y) * X.w) / 2;
  for (const ax of axes) {
    const dc = Math.abs((A.c.x - B.c.x) * ax.x + (A.c.y - B.c.y) * ax.y);
    if (dc > half(A, ax) + half(B, ax) - slack) return false;
  }
  return true;
}
