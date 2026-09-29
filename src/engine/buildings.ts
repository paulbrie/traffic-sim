/** Buildings as traffic sources: footprint maths, trip weights and where each one meets the road network. */
import type { Edge } from "./compile";
import type { BuildingDef, BuildingUse, LinkDef, Vec } from "./types";
import type { Poly } from "./geom";

/** footprint area (m²) */
export function polyArea(pts: Vec[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(a) / 2;
}

/** area-weighted centroid (falls back to the vertex average for degenerate outlines) */
export function polyCentroid(pts: Vec[]): Vec {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const f = pts[j].x * pts[i].y - pts[i].x * pts[j].y;
    a += f; cx += (pts[j].x + pts[i].x) * f; cy += (pts[j].y + pts[i].y) * f;
  }
  if (Math.abs(a) < 1e-6) return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPoly(pts: Vec[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** trips per 100 m² of floor, relative (homes = 1) */
export const USE_RATE: Record<BuildingUse, number> = { home: 1, shop: 3, office: 1.6, industry: 0.6, school: 2, civic: 1.5, other: 0.8, minor: 0 };
export const USE_LABEL: Record<BuildingUse, string> = {
  home: "Homes", shop: "Shops", office: "Offices", industry: "Industry", school: "School", civic: "Public building", other: "Other", minor: "Shed / garage (no traffic)",
};
export const FLOOR_HEIGHT = 3.2;

/** relative number of trips a building starts and ends (its explicit weight, or use × floor area) */
export function tripWeight(b: BuildingDef): number {
  if (typeof b.trips === "number") return Math.max(0, b.trips);
  const floors = Math.max(1, Math.round(b.height / FLOOR_HEIGHT));
  return Math.round(((polyArea(b.pts) * floors) / 100) * USE_RATE[b.use] * 10) / 10;
}

/** a building's access point: where vehicles start and end their trips */
export interface Place {
  building: BuildingDef;
  w: number;
  /** the directions of the nearest road a vehicle may use, with the distance along each (m) */
  opts: { edge: Edge; s: number }[];
  /** point on the road centreline nearest the building */
  road: Vec;
  door: Vec;
}

/** farthest a building may be from a road and still generate traffic (m) */
export const MAX_ACCESS = 150;

/**
 * Attach every building to the nearest road that ordinary traffic can stop on (not bus-only,
 * not motorways, long enough to hold a vehicle).
 */
export function attachBuildings(buildings: BuildingDef[], links: { link: LinkDef; center: Poly; ef: Edge | null; eb: Edge | null }[]): Place[] {
  if (!buildings.length) return [];
  const CELL = 25;
  const grid = new Map<string, { li: number; x: number; y: number }[]>();
  const usable = (e: Edge | null) => !!e && !e.busOnly && e.length >= 10 && e.speed < 80 / 3.6;
  links.forEach((l, li) => {
    if (!usable(l.ef) && !usable(l.eb)) return;
    const n = Math.max(1, Math.ceil(l.center.len / 6));
    for (let k = 0; k <= n; k++) {
      const p = l.center.at((l.center.len * k) / n);
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      let c = grid.get(key); if (!c) grid.set(key, (c = [])); c.push({ li, x: p.x, y: p.y });
    }
  });
  const out: Place[] = [];
  for (const b of buildings) {
    const w = tripWeight(b);
    if (!(w > 0)) continue;
    const door = polyCentroid(b.pts);
    const gx = Math.floor(door.x / CELL), gy = Math.floor(door.y / CELL);
    let best = -1, bd = Infinity;
    for (let r = 0; r <= Math.ceil(MAX_ACCESS / CELL); r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        for (const s of grid.get(`${gx + dx},${gy + dy}`) ?? []) {
          const d = Math.hypot(s.x - door.x, s.y - door.y);
          if (d < bd) { bd = d; best = s.li; }
        }
      }
      // anything in a farther ring is at least (r * CELL) away
      if (best >= 0 && bd <= r * CELL) break;
    }
    if (best < 0 || bd > MAX_ACCESS + 6) continue;
    const l = links[best], pr = l.center.project(door.x, door.y), L = l.center.len;
    const opts: Place["opts"] = [];
    for (const e of [l.ef, l.eb]) {
      if (!e || !usable(e)) continue;
      const along = (e.dir === 1 ? pr.s : L - pr.s) - e.trimA;
      opts.push({ edge: e, s: Math.max(3, Math.min(e.length - 3, along)) });
    }
    if (opts.length) out.push({ building: b, w, opts, road: l.center.at(pr.s), door });
  }
  return out;
}
