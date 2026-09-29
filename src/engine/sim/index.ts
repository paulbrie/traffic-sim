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

export { DT, type Kind, type Dest, type Vehicle, type JunctionEvent, type Stats } from "./base";
export { LW } from "../compile";

export class Sim extends SimDemand {
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
