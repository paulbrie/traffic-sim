/**
 * Roads drawn over each other: lanes of two roads (or a road and a lane in none) running alongside closer than a lane's width
 * for a stretch, outside junctions and at the same level. Cars on them would drive through one another; the simulation sees a
 * crossing as long as the stretch, and they give way to each other along all of it. Usually a road traced twice, or a way back
 * drawn on top of the way there.
 */
import { hasLevels, insidePolygon, outlinePath, samples, zAt, type Pt, type Sketch } from "./lane-sketch";

export interface DrawnOver {
  /** the two roads (a lane in none: its own id), and the lanes the longest stretch is between */
  roads: [string, string]; lanes: [string, string];
  /** the stretch's length (m) and its middle */
  length: number; at: Pt;
}

/** a stretch at least this long (m) */
export const DRAWN_OVER_MIN = 20;
/** closer than a lane's width less this (m): lanes beside each other drawn a little off aren't counted */
const SLACK = 0.5;
/** samples along each lane (m), and the grid the lanes' pieces are filed in (m) */
const STEP = 2, CELL = 10;

const kept = new WeakMap<Sketch["lanes"], DrawnOver[]>();

/** the pairs of roads drawn over each other, each once (its longest stretch), the longest first */
export function roadsDrawnOver(sk: Sketch): DrawnOver[] {
  const was = kept.get(sk.lanes);
  if (was) return was;
  const roadOf = new Map<string, string>();
  for (const r of sk.roads) for (const id of r.lanes) roadOf.set(id, r.id);
  const road = (id: string) => roadOf.get(id) ?? id;
  // (a lane joined end to start to another: where they meet is where one goes on into the other)
  const joined = new Set(sk.connectors.map(c => `${c.from.lane}|${c.to.lane}`));
  const levels = hasLevels(sk);
  const junctions = sk.junctions.map(j => outlinePath(j)).filter(o => o.length >= 3).map(o => ({ o, box: boxOf(o) }));
  const inJunction = (p: Pt) => junctions.some(({ o, box }) => p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1 && insidePolygon(p, o));

  // each lane's path, and its pieces filed by grid cell
  const lanes = sk.lanes.map(l => ({ id: l.id, w: l.width ?? 3.5, pts: samples(l.shape) }));
  const grid = new Map<string, { k: number; i: number }[]>();
  lanes.forEach((l, k) => {
    for (let i = 0; i + 1 < l.pts.length; i++) {
      const a = l.pts[i], b = l.pts[i + 1];
      for (let cx = Math.floor(Math.min(a.x, b.x) / CELL); cx <= Math.floor(Math.max(a.x, b.x) / CELL); cx++)
        for (let cy = Math.floor(Math.min(a.y, b.y) / CELL); cy <= Math.floor(Math.max(a.y, b.y) / CELL); cy++) {
          const key = `${cx},${cy}`, list = grid.get(key);
          if (list) list.push({ k, i }); else grid.set(key, [{ k, i }]);
        }
    }
  });

  const best = new Map<string, DrawnOver>();
  lanes.forEach((A, ka) => {
    // (the stretch with each other lane so far: where it started and was last seen, along this one and as points)
    const runs = new Map<number, { s0: number; s1: number; p0: Pt; p1: Pt }>();
    const close = (kb: number) => {
      const r = runs.get(kb)!;
      runs.delete(kb);
      const length = r.s1 - r.s0;
      if (length < DRAWN_OVER_MIN) return;
      const B = lanes[kb], ra = road(A.id), rb = road(B.id), key = ra < rb ? `${ra}|${rb}` : `${rb}|${ra}`;
      const x = best.get(key);
      if (!x || length > x.length) best.set(key, { roads: [ra, rb], lanes: [A.id, B.id], length, at: { x: (r.p0.x + r.p1.x) / 2, y: (r.p0.y + r.p1.y) / 2 } });
    };
    for (const { p, along } of resample(A.pts, STEP)) {
      const seen = new Set<number>();
      if (!inJunction(p)) {
        const cx = Math.floor(p.x / CELL), cy = Math.floor(p.y / CELL);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const { k, i } of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (k <= ka || seen.has(k)) continue;
          const B = lanes[k];
          if (road(B.id) === road(A.id) || joined.has(`${A.id}|${B.id}`) || joined.has(`${B.id}|${A.id}`)) continue;
          if (distToSegment(p, B.pts[i], B.pts[i + 1]) >= Math.min(A.w, B.w) - SLACK) continue;
          if (levels && Math.abs(zAt(sk, A.id, along) - zAt(sk, B.id, nearestAlong(B.pts, p))) >= 0.5) continue;
          seen.add(k);
          const r = runs.get(k);
          if (r) { r.s1 = along; r.p1 = p; } else runs.set(k, { s0: along, s1: along, p0: p, p1: p });
        }
      }
      // (a stretch ends where the other lane is no longer near)
      for (const k of [...runs.keys()]) if (!seen.has(k) && along - runs.get(k)!.s1 > STEP * 1.5) close(k);
    }
    for (const k of [...runs.keys()]) close(k);
  });
  const out = [...best.values()].sort((a, b) => b.length - a.length);
  kept.set(sk.lanes, out);
  return out;
}

function boxOf(o: Pt[]) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of o) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  return { x0, y0, x1, y1 };
}

/** points every `step` m along a path, with how far along each is */
function resample(pts: Pt[], step: number) {
  const out: { p: Pt; along: number }[] = [];
  let along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], len = Math.hypot(b.x - a.x, b.y - a.y);
    for (let t = out.length ? Math.ceil(along / step) * step - along : 0; t < len; t += step) out.push({ p: { x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len }, along: along + t });
    along += len;
  }
  return out;
}

function distToSegment(p: Pt, a: Pt, b: Pt) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** how far along a path its nearest point to `p` is */
function nearestAlong(pts: Pt[], p: Pt) {
  let best = Infinity, at = 0, along = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy, len = Math.sqrt(l2);
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0, d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    if (d < best) { best = d; at = along + t * len; }
    along += len;
  }
  return at;
}
