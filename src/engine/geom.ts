import type { Vec } from "./types";

/** A sampled polyline with cumulative arc length. */
export class Poly {
  readonly pts: Float64Array;
  readonly cum: Float64Array;
  readonly len: number;
  constructor(pts: ArrayLike<number>) {
    this.pts = Float64Array.from(pts);
    const n = this.pts.length / 2;
    this.cum = new Float64Array(n);
    for (let k = 1; k < n; k++) {
      this.cum[k] = this.cum[k - 1] + Math.hypot(this.pts[2 * k] - this.pts[2 * k - 2], this.pts[2 * k + 1] - this.pts[2 * k - 1]);
    }
    this.len = n > 0 ? this.cum[n - 1] : 0;
  }
  get count() { return this.pts.length / 2; }
  private seg(s: number) {
    const cum = this.cum, n = cum.length;
    if (s <= 0) return 1;
    if (s >= this.len) return n - 1;
    let lo = 1, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < s) lo = mid + 1; else hi = mid; }
    return lo;
  }
  /** point at arc length s (clamped) */
  at(s: number, out: Vec = { x: 0, y: 0 }): Vec {
    const n = this.cum.length, p = this.pts;
    if (n === 1) { out.x = p[0]; out.y = p[1]; return out; }
    const k = this.seg(s), c0 = this.cum[k - 1], c1 = this.cum[k];
    const f = c1 > c0 ? Math.min(1, Math.max(0, (s - c0) / (c1 - c0))) : 0;
    out.x = p[2 * k - 2] + (p[2 * k] - p[2 * k - 2]) * f;
    out.y = p[2 * k - 1] + (p[2 * k + 1] - p[2 * k - 1]) * f;
    return out;
  }
  /** unit tangent at arc length s */
  tangent(s: number, out: Vec = { x: 0, y: 0 }): Vec {
    const p = this.pts, k = this.seg(s);
    const dx = p[2 * k] - p[2 * k - 2], dy = p[2 * k + 1] - p[2 * k - 1], m = Math.hypot(dx, dy) || 1;
    out.x = dx / m; out.y = dy / m;
    return out;
  }
  /** sub-polyline between arc lengths a and b */
  slice(a: number, b: number): Poly {
    a = Math.max(0, Math.min(this.len, a)); b = Math.max(a, Math.min(this.len, b));
    const out: number[] = [];
    const pa = this.at(a); out.push(pa.x, pa.y);
    // (no vertex within 25 cm of either end: a near-zero segment there turns around when the line is
    // offset — a lane beside the centreline — on a curve, and the lane would end pointing backwards)
    for (let k = 0; k < this.cum.length; k++) if (this.cum[k] > a + 0.25 && this.cum[k] < b - 0.25) out.push(this.pts[2 * k], this.pts[2 * k + 1]);
    const pb = this.at(b); out.push(pb.x, pb.y);
    if (out.length === 2) out.push(pb.x + 1e-3, pb.y);
    return new Poly(out);
  }
  reversed(): Poly {
    const n = this.count, out = new Float64Array(n * 2);
    for (let k = 0; k < n; k++) { out[2 * k] = this.pts[2 * (n - 1 - k)]; out[2 * k + 1] = this.pts[2 * (n - 1 - k) + 1]; }
    return new Poly(out);
  }
  /** offset to the right (positive d) using averaged segment normals; y-down screen convention */
  offset(d: number): Poly {
    const n = this.count, p = this.pts, out = new Float64Array(n * 2);
    for (let k = 0; k < n; k++) {
      let tx = 0, ty = 0;
      if (k > 0) { const dx = p[2 * k] - p[2 * k - 2], dy = p[2 * k + 1] - p[2 * k - 1], m = Math.hypot(dx, dy) || 1; tx += dx / m; ty += dy / m; }
      if (k < n - 1) { const dx = p[2 * k + 2] - p[2 * k], dy = p[2 * k + 3] - p[2 * k + 1], m = Math.hypot(dx, dy) || 1; tx += dx / m; ty += dy / m; }
      const m = Math.hypot(tx, ty) || 1;
      // right-hand normal in screen coords (y down): rotate tangent clockwise → (-ty, tx)
      out[2 * k] = p[2 * k] - (ty / m) * d;
      out[2 * k + 1] = p[2 * k + 1] + (tx / m) * d;
    }
    return new Poly(out);
  }
  /**
   * Offset to the right by a distance that changes along the line (`d(s)`), with extra vertices
   * every `step` m between `from` and `to` so the change is smooth.
   */
  offsetBy(d: (s: number) => number, from = 0, to = this.len, step = 4): Poly {
    const at = [...Array.from(this.cum)];
    for (let s = from; s < to; s += step) at.push(s);
    at.push(to);
    const ss = [...new Set(at.filter(s => s >= 0 && s <= this.len).map(s => Math.round(s * 1000) / 1000))].sort((a, b) => a - b);
    const out: number[] = [];
    for (const s of ss) {
      const p = this.at(s), t = this.tangent(Math.min(this.len - 1e-6, s + 1e-6)), off = d(s);
      out.push(p.x - t.y * off, p.y + t.x * off);
    }
    return new Poly(out);
  }
  /** smallest turning radius along the polyline (∞ when straight) */
  minRadius(): number {
    const p = this.pts, n = this.count;
    let best = Infinity;
    for (let k = 1; k < n - 1; k++) {
      const ax = p[2 * k] - p[2 * k - 2], ay = p[2 * k + 1] - p[2 * k - 1];
      const bx = p[2 * k + 2] - p[2 * k], by = p[2 * k + 3] - p[2 * k + 1];
      const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6) continue;
      const ang = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      if (ang < 1e-4) continue;
      best = Math.min(best, ((la + lb) / 2) / ang);
    }
    return best;
  }
  /** distance from point to polyline and the arc length of the closest point */
  project(x: number, y: number): { d: number; s: number } {
    const p = this.pts, n = this.count;
    let best = Infinity, bs = 0;
    for (let k = 1; k < n; k++) {
      const ax = p[2 * k - 2], ay = p[2 * k - 1], bx = p[2 * k], by = p[2 * k + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      const qx = ax + dx * t, qy = ay + dy * t, d = Math.hypot(x - qx, y - qy);
      if (d < best) { best = d; bs = this.cum[k - 1] + t * Math.sqrt(l2); }
    }
    return { d: best, s: bs };
  }
}

export function cubicPoints(a: Vec, c1: Vec, c2: Vec, b: Vec, n: number): number[] {
  const out: number[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push(
      u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    );
  }
  return out;
}

/** smooth connector between two lane ends (positions + unit tangents) */
export function connectorPoints(p: Vec, tp: Vec, q: Vec, tq: Vec, n = 14, reach?: readonly [number, number]): number[] {
  const dist = Math.hypot(q.x - p.x, q.y - p.y);
  if (dist < 1e-3) return [p.x, p.y, q.x + 1e-3, q.y];
  const [k1, k2] = reach ?? connectorReach(p, tp, q, tq);
  return cubicPoints(p, { x: p.x + tp.x * k1, y: p.y + tp.y * k1 }, { x: q.x - tq.x * k2, y: q.y - tq.y * k2 }, q, n);
}
/**
 * How far a lane connector's curve handles reach along the lane it leaves (k1) and back along the lane
 * it joins (k2), in metres: the automatic shape. Handles along the lanes keep the path tangent to both.
 */
export function connectorReach(p: Vec, tp: Vec, q: Vec, tq: Vec): [number, number] {
  const dist = Math.hypot(q.x - p.x, q.y - p.y);
  const cross = tp.x * tq.y - tp.y * tq.x;
  const dx = q.x - p.x, dy = q.y - p.y;
  // how far ahead the exit lies along each lane's own direction
  const ahead1 = dx * tp.x + dy * tp.y, ahead2 = dx * tq.x + dy * tq.y;
  let k1 = dist * 0.4, k2 = dist * 0.4;
  if (Math.abs(cross) > 0.35) {
    // a real turn: aim both handles at where the two lane lines meet
    const t = (dx * tq.y - dy * tq.x) / cross;
    const s = (dx * tp.y - dy * tp.x) / cross;
    if (t > 0 && s > 0 && t < dist * 1.6 && s < dist * 1.6) { k1 = t * 0.6; k2 = s * 0.6; }
  } else if (ahead1 > 0 && ahead2 > 0) {
    // (nearly) straight across, possibly shifting lanes: a gentle S whose handles never
    // reach past the exit, so the path can't loop back or kink
    k1 = Math.min(dist * 0.4, ahead1 * 0.45);
    k2 = Math.min(dist * 0.4, ahead2 * 0.45);
  }
  // never let a handle overshoot the other end (that is what makes zig-zags)
  k1 = Math.min(k1, dist * 0.75); k2 = Math.min(k2, dist * 0.75);
  return [k1, k2];
}

export const angleOf = (v: Vec) => Math.atan2(v.y, v.x);
/** signed angle from a to b, positive = clockwise on screen (a right turn when driving) */
export const signedAngle = (a: Vec, b: Vec) => Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y);
export const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y);
export const normAngle = (a: number) => { while (a <= -Math.PI) a += 2 * Math.PI; while (a > Math.PI) a -= 2 * Math.PI; return a; };

export function mulberry32(seed: number) {
  let a = seed | 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** convex hull (monotone chain) of points */
export function hull(points: Vec[]): Vec[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec[] = [], upper: Vec[] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}
