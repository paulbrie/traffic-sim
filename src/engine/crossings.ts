/**
 * Zebra crossings drawn by hand (CrossingDef): their stripes, and where a lane or a path through a
 * junction runs over them. Framework-free.
 */
import type { Poly } from "./geom";
import type { CrossingDef, Network, Vec } from "./types";

export interface CCrossing {
  idx: number; def: CrossingDef;
  /** unit vector from kerb to kerb (a → b), the one across it (along the traffic), and its length (m) */
  u: Vec; v: Vec; len: number;
  /** its outline: a, b and the two sides `width` apart */
  corners: Vec[];
}

export function compileCrossings(net: Network): CCrossing[] {
  return (net.crossings ?? []).map((def, idx) => {
    const dx = def.b.x - def.a.x, dy = def.b.y - def.a.y, len = Math.hypot(dx, dy) || 1, u = { x: dx / len, y: dy / len }, v = { x: -u.y, y: u.x }, h = def.width / 2;
    const corners = [
      { x: def.a.x + v.x * h, y: def.a.y + v.y * h }, { x: def.b.x + v.x * h, y: def.b.y + v.y * h },
      { x: def.b.x - v.x * h, y: def.b.y - v.y * h }, { x: def.a.x - v.x * h, y: def.a.y - v.y * h },
    ];
    return { idx, def, u, v, len, corners };
  });
}

/** is a point on the crossing (with `pad` m to spare along the traffic) */
export function onCrossing(c: CCrossing, x: number, y: number, pad = 0): boolean {
  const qx = x - c.def.a.x, qy = y - c.def.a.y, along = qx * c.u.x + qy * c.u.y, across = qx * c.v.x + qy * c.v.y;
  return along >= 0 && along <= c.len && Math.abs(across) <= c.def.width / 2 + pad;
}

/** the stretch (arc length from..to on `poly`) that runs over the crossing, or null */
export function crossingSpan(c: CCrossing, poly: Poly): [number, number] | null {
  // (quick reject: the polyline's box against the crossing's)
  const xs = c.corners.map(p => p.x), ys = c.corners.map(p => p.y), pts = poly.pts;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < pts.length; k += 2) { x0 = Math.min(x0, pts[k]); x1 = Math.max(x1, pts[k]); y0 = Math.min(y0, pts[k + 1]); y1 = Math.max(y1, pts[k + 1]); }
  if (x1 < Math.min(...xs) || x0 > Math.max(...xs) || y1 < Math.min(...ys) || y0 > Math.max(...ys)) return null;
  let lo = -1, hi = -1;
  const step = 0.25, p = { x: 0, y: 0 };
  for (let s = 0; s <= poly.len + 1e-9; s += step) {
    poly.at(Math.min(s, poly.len), p);
    if (onCrossing(c, p.x, p.y)) { if (lo < 0) lo = s; hi = Math.min(s, poly.len); }
  }
  return lo < 0 ? null : [Math.max(0, lo - step / 2), Math.min(poly.len, hi + step / 2)];
}
