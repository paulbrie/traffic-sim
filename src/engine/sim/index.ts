/**
 * Gridlock simulator on a free-form road graph.
 *
 * Fixed 0.1 s ticks. Each tick: signals advance, vehicles spawn, every vehicle
 * decides its acceleration against the same snapshot (IDM against the leader in
 * its lane, stop lines, bus stops, curve limits), a MOBIL-style lane-change pass
 * runs, junctions grant reservations for lane connectors that don't conflict,
 * then everyone moves. Deterministic for a given seed.
 *
 * The class is built in layers, each extending the one below:
 *   base → routing → signals → junctions → motion → demand → Sim (this file: the tick and
 *   the queries renderers use).
 */
import type { LanePiece, Movement, Piece } from "../compile";
import type { Poly } from "../geom";
import type { Vehicle } from "./base";
import { SimDemand } from "./demand";
import { DT, FUEL_APPROACH, type JunctionFuel } from "./base";
import { FUEL_STILL, fuelRate, hasStopStart } from "../fuel";
import { isJunction } from "../refs";

export { DT, FUEL_APPROACH, REV_STATES, type Kind, type Dest, type Vehicle, type JunctionEvent, type Stats, type FuelStats, type JunctionFuel } from "./base";

/** a transit flow's results: vehicles sent, arrived at its exit, diverted to another exit, removed when stuck, waiting to enter, still driving; average travel time (s); failed spawns for lack of a route */
export interface FlowStats { sent: number; arrived: number; diverted: number; towed: number; backlog: number; inPlan: number; avgTravel: number; noRoute: number }

/** a traffic counter's readings: vehicles passing so far (by kind), their average speed (km/h), and the recent rate (vehicles per hour, last 5 minutes) */
export interface CounterStats { total: number; cars: number; trucks: number; buses: number; avgSpeed: number; perHour: number }
/** both directions of a counted road together (null when neither has a reading): speeds averaged over the vehicles, rates added */
export function sumCounters(list: readonly (CounterStats | null | undefined)[]): CounterStats | null {
  const got = list.filter((c): c is CounterStats => !!c);
  if (!got.length) return null;
  const total = got.reduce((s, c) => s + c.total, 0);
  return {
    total, cars: got.reduce((s, c) => s + c.cars, 0), trucks: got.reduce((s, c) => s + c.trucks, 0), buses: got.reduce((s, c) => s + c.buses, 0),
    avgSpeed: total ? got.reduce((s, c) => s + c.avgSpeed * c.total, 0) / total : 0, perHour: got.reduce((s, c) => s + c.perHour, 0),
  };
}
export { LW } from "../compile";

export class Sim extends SimDemand {
  // ------------------------------------------------------------ tick
  step() {
    this.tick++;
    this.updateSignals();
    this.spawnLoop();
    this.buildIndex();
    if (this.revs.length) this.updateReversibles();
    for (const v of this.vehicles) if (!v.dead) this.think(v);
    if (this.logLinks.size || this.logVehicles.size) this.logStates();
    for (const v of this.vehicles) if (!v.dead && (v.id + this.tick) % 5 === 0) this.considerLaneChange(v);
    this.updatePeds();
    for (const st of this.ns) if (st.node.controlled && !st.node.ring) this.arbitrate(st);
    const fuel = this.syncFuel();
    for (const v of this.vehicles) if (!v.dead) {
      const v1 = v.v, p = v.piece, s = v.s;
      this.move(v); if (!v.broken && v.v < 0.3 * v.v0) v.jam += DT;
      if (fuel) this.burnFuel(v, v1, p, s);
    }
    if (this.P.breakdownsPerHour > 0 && this.rng() < (this.P.breakdownsPerHour * DT) / 3600) this.randomBreakdown();
    if (this.tick % 10 === 0) this.sample();
    if (this.tick % 50 === 0) this.housekeeping();
  }
  run(n: number) { for (let k = 0; k < n; k++) this.step(); }
  /**
   * These vehicles break down (engine failure) or are wrecked (war mode): each stays in its lane as an
   * obstacle until towed. A junction it had booked but not entered is given back. How many there were.
   */
  breakDown(ids: number[], wreck: boolean): number {
    const want = new Set(ids);
    let n = 0;
    for (const v of this.vehicles) {
      // (a broken-down vehicle can still be wrecked; nothing else changes twice)
      if (v.dead || !want.has(v.id) || (v.broken && !(wreck && v.broken === 1))) continue;
      v.broken = wreck ? 2 : 1; v.brokenAt = this.tick; n++;
      if (wreck) { v.v = 0; v.acc = 0; }
      if (v.piece.kind === "lane") {
        v.granted = false; v.conn = null; v.reqFor = null; v.early = null;
        this.evRoad(v.piece.edge, v, "breakdown", wreck ? "destroyed: a wreck in its lane" : "engine failure: stops in its lane, hazard lights on");
      }
    }
    return n;
  }
  /** tow these broken-down (or wrecked) vehicles away now */
  tow(ids: number[]): number {
    const want = new Set(ids);
    let n = 0;
    for (const v of this.vehicles) if (!v.dead && v.broken && want.has(v.id)) { this.kill(v, v.broken === 2 ? "destroyed" : "towed"); n++; }
    return n;
  }
  /** an engine fails: a vehicle driving along a road, picked at random */
  protected randomBreakdown() {
    const list = this.vehicles.filter(v => !v.dead && !v.broken && v.piece.kind === "lane" && v.v > 3 && v.test === undefined);
    if (list.length) this.breakDown([list[Math.floor(this.rng() * list.length)].id], false);
  }
  /** road and vehicle event logs: what each vehicle on a logged road (or being logged) is doing, when that changes */
  protected logStates() {
    for (const v of this.vehicles) {
      if (v.dead || v.piece.kind !== "lane" || (!this.roadLogged(v.piece.edge) && !this.vehLogged(v))) continue;
      if (v.logState !== undefined && v.logState !== v.state) {
        const lead = v.leader && v.gap < 60 ? `, ${v.gap.toFixed(1)} m behind #${v.leader.id}` : "";
        this.evRoad(v.piece.edge, v, "state", `${v.logState} → ${v.state} at ${(v.v * 3.6).toFixed(0)} km/h, ${(v.piece.len - v.s).toFixed(0)} m before the end${lead}`);
      }
      v.logState = v.state;
    }
  }
  protected housekeeping() {
    for (let k = 0; k < this.ema.length; k++) if (this.ema[k] > 0) {
      const e = this.net.edges[k], ff = e.length / e.speed;
      this.ema[k] += (ff - this.ema[k]) * 0.04;
    }
    this.vehicles = this.vehicles.filter(v => !v.dead);
  }
  protected sample() {
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
  // ------------------------------------------------------------ transit flows
  /** what happened to transit flow `i`'s vehicles so far (average travel time in s, 0 before any arrived) */
  flowStats(i: number): FlowStats | null {
    const f = this.flowState[i];
    if (!f) return null;
    return { sent: f.sent, arrived: f.arrived, diverted: f.diverted, towed: f.towed, backlog: f.backlog, noRoute: f.noRoute, avgTravel: f.arrived ? f.travelSum / f.arrived : 0, inPlan: f.sent - f.arrived - f.diverted - f.towed };
  }

  /** results of zone-to-zone demand `i` (same meaning as a transit flow's) */
  zoneFlowStats(i: number): FlowStats | null {
    const f = this.zoneFlowState[i];
    if (!f) return null;
    return { sent: f.sent, arrived: f.arrived, diverted: f.diverted, towed: f.towed, backlog: f.backlog, noRoute: f.noRoute, avgTravel: f.arrived ? f.travelSum / f.arrived : 0, inPlan: f.sent - f.arrived - f.diverted - f.towed };
  }

  // ------------------------------------------------------------ traffic counters
  /** readings of the counter on edge `edgeIdx` (null = no counter there) */
  counterStats(edgeIdx: number): CounterStats | null {
    const c = this.counters[edgeIdx];
    if (!c) return null;
    const since = this.tick - 3000;
    while (c.recent.length && c.recent[0] < since) c.recent.shift();
    const window = Math.min(300, Math.max(1, this.time));
    return { total: c.total, cars: c.cars, trucks: c.trucks, buses: c.buses, avgSpeed: c.total ? (c.speedSum / c.total) * 3.6 : 0, perHour: (c.recent.length * 3600) / window };
  }

  // ------------------------------------------------------------ fuel
  /** is anything measured (the whole plan, or junctions with `fuel` on) */
  private fuelAny = false;
  private fuelSynced = false;
  /**
   * Per edge, the road leading into a junction its fuel counts towards (index, -1 = none) and how far
   * that road's stop line is beyond its own end (m): roads joined end to end at plain road points count
   * towards the junction they lead to, as long as they are within FUEL_APPROACH of it.
   */
  private fuelTo: Int32Array | null = null;
  private fuelExtra: Float64Array | null = null;
  /** start or stop measuring as the settings change (a junction starts afresh when it is switched on); whether anything is measured */
  protected syncFuel(): boolean {
    const all = this.settings.fuel === true;
    if (this.fuelSynced && all === this.fuelAll) return this.fuelAny;
    this.fuelSynced = true; this.fuelAll = all;
    if (!this.fuelTo) this.fuelTargets();
    let any = all;
    for (const n of this.net.nodes) {
      const on = all || n.def.fuel === true, f = this.nodeFuel[n.idx];
      if (on) any = true;
      if (on && f.since < 0) {
        Object.assign(f, { since: this.tick, through0: this.nodeThrough[n.idx] ?? 0, inside: 0, idleTime: 0 });
        for (const a of n.arms) if (a.inEdge) { this.edgeFuel[a.inEdge.idx] = 0; this.edgeIdle[a.inEdge.idx] = 0; }
      } else if (!on) f.since = -1;
    }
    this.stats.fuel = all ? { total: 0, idle: 0, km: 0, idleTime: 0, trips: 0, tripFuel: 0, since: this.time } : undefined;
    this.fuelAny = any;
    return any;
  }
  private fuelTargets() {
    const E = this.net.edges.length, to = new Int32Array(E).fill(-1), extra = new Float64Array(E);
    for (const e of this.net.edges) {
      let cur = e, d = 0, guard = 0;
      // through plain road points (one way on) to the junction ahead
      while (!isJunction(cur.to) && !cur.to.gateway && d < FUEL_APPROACH && guard++ < 50) {
        const on = (this.movesFrom[cur.idx] ?? []).filter(m => m.turn !== "U");
        if (on.length !== 1) break;
        cur = on[0].out; d += cur.length;
      }
      if (isJunction(cur.to) && d < FUEL_APPROACH) { to[e.idx] = cur.idx; extra[e.idx] = d; }
    }
    this.fuelTo = to; this.fuelExtra = extra;
  }
  /** fuel a vehicle burnt this tick, going from speed `v1` to its speed now, from position `s` on piece `p` */
  protected burnFuel(v: Vehicle, v1: number, p: Piece, s: number) {
    if (v.broken) return; // engine off (failed, or wrecked)
    const P = this.P, vAvg = (v1 + v.v) / 2, still = vAvg < FUEL_STILL;
    const idle = still && hasStopStart(v.id, P.stopStartShare) ? 0 : (v.kind === "car" ? P.fuelIdleCar : P.fuelIdleTruck) / 3.6;
    const mL = fuelRate(v.kind, vAvg, (v.v - v1) / DT, idle) * DT;
    // standing still in traffic (a bus at its stop is not)
    const jam = still && v.dwell <= 0;
    const F = this.stats.fuel;
    if (F) {
      v.fuel = (v.fuel ?? 0) + mL;
      F.total += mL / 1000; F.km += (vAvg * DT) / 1000;
      if (jam) { v.fuelIdle = (v.fuelIdle ?? 0) + mL; F.idle += mL / 1000; F.idleTime += DT; }
    }
    if (p.kind === "lane") {
      const k = this.fuelTo![p.edge.idx];
      if (k < 0 || p.len - s + this.fuelExtra![p.edge.idx] > FUEL_APPROACH) return;
      const f = this.nodeFuel[this.net.edges[k].to.idx];
      if (f.since < 0) return;
      this.edgeFuel[k] += mL;
      if (jam) { this.edgeIdle[k] += mL; f.idleTime += DT; }
    } else {
      const f = this.nodeFuel[p.node.idx];
      if (f.since >= 0) f.inside += mL;
    }
  }
  /** fuel measured at junction `nodeIdx` (null when it isn't measured) */
  junctionFuel(nodeIdx: number): JunctionFuel | null {
    const f = this.nodeFuel[nodeIdx], n = this.net.nodes[nodeIdx];
    if (!f || f.since < 0 || !n) return null;
    const approaches = n.arms.filter(a => a.inEdge).map(a => ({ total: this.edgeFuel[a.inEdge!.idx] / 1000, idle: this.edgeIdle[a.inEdge!.idx] / 1000 }));
    const onRoads = approaches.reduce((x, a) => x + a.total, 0);
    return {
      total: onRoads + f.inside / 1000, idle: approaches.reduce((x, a) => x + a.idle, 0), inside: f.inside / 1000, idleTime: f.idleTime,
      crossed: (this.nodeThrough[nodeIdx] ?? 0) - f.through0, since: f.since * DT, approaches,
    };
  }

  // ------------------------------------------------------------ queries for renderers
  /** front and rear of the vehicle body in world metres (with lane-change smoothing) */
  /**
   * Turn signal: -1 left, 1 right, 0 off. Lit while changing lane, in the last 45 m before a
   * junction where the vehicle turns, and while turning through it.
   */
  /** turn signal: −1 left, 1 right, 2 both (hazard lights, broken down), 0 none */
  blinker(v: Vehicle): -1 | 0 | 1 | 2 {
    if (v.dead || v.broken === 2) return 0;
    if (v.broken) return 2;
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
