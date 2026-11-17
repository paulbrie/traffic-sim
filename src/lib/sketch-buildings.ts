/**
 * A V2 sketch's buildings (ticket #267): OpenStreetMap's footprints round the lanes, fetched for where the sketch is on
 * Earth (its `geo`) and kept in it, each with a height (from its tags where OSM has one, else guessed from its kind and
 * size: see `osmFootprints`). Shown in 3D, and as footprints on the plan view; the cars don't see them.
 */
import { BUILDING_USES, type BuildingUse, type GeoRef } from "../engine/types";
import type { BBox } from "./osm/area";

interface Pt { x: number; y: number }

/** one footprint: its OSM id (w123, r45_0), its corners as x, y, x, y… (plan metres), its height (m), what it is */
export interface SketchBuilding {
  id: string; xy: number[]; h: number;
  /** none: "other" */
  use?: BuildingUse;
  name?: string;
  /** its height is OSM's (height or building:levels), not guessed */
  tagged?: true;
}
/** the footprints, the place they were fetched for (they fit the sketch while it is still there) and when (ISO) */
export interface SketchBuildings { geo: GeoRef; at: string; list: SketchBuilding[] }

export const BUILDINGS_ATTRIBUTION = "Buildings © OpenStreetMap contributors (ODbL)";
/** metres round the lanes they are fetched for, the most kept, the widest area fetched (m a side) */
export const BUILDINGS_MARGIN = 150, MAX_BUILDINGS = 30_000, MAX_BUILDINGS_SIDE = 8_000;
/** the most corners one keeps */
const MAX_CORNERS = 400;

/** Overpass QL for the buildings in `b` (ways and multipolygons), their nodes' places with them */
export function buildingsQuery(b: BBox): string {
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  return `[out:json][timeout:90];(way["building"](${box});relation["building"]["type"="multipolygon"](${box}););out body;>;out skel qt;`;
}

export function buildingsFit(b: SketchBuildings, geo: GeoRef | undefined): boolean {
  return !!geo && Math.abs(b.geo.lat - geo.lat) < 1e-5 && Math.abs(b.geo.lon - geo.lon) < 1e-5;
}

export function sanitizeBuildings(raw: unknown): SketchBuildings | null {
  const o = raw as Partial<SketchBuildings> | null;
  const n = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  if (!o || typeof o !== "object" || !o.geo || !n(o.geo.lat) || !n(o.geo.lon) || !Array.isArray(o.list)) return null;
  const uses = new Set<string>(BUILDING_USES), seen = new Set<string>(), list: SketchBuilding[] = [];
  for (const b of o.list as Partial<SketchBuilding>[]) {
    if (list.length >= MAX_BUILDINGS) break;
    if (!b || typeof b.id !== "string" || !b.id || b.id.length > 40 || seen.has(b.id) || !n(b.h) || !Array.isArray(b.xy)) continue;
    const xy = b.xy;
    if (xy.length < 6 || xy.length % 2 || xy.length > 2 * MAX_CORNERS || !xy.every(n)) continue;
    seen.add(b.id);
    list.push({
      id: b.id, xy: xy.slice(), h: Math.min(400, Math.max(1, b.h)),
      ...(typeof b.use === "string" && uses.has(b.use) && b.use !== "other" ? { use: b.use } : {}),
      ...(typeof b.name === "string" && b.name ? { name: b.name.slice(0, 120) } : {}),
      ...(b.tagged === true ? { tagged: true as const } : {}),
    });
  }
  return { geo: { lat: o.geo.lat, lon: o.geo.lon }, at: typeof o.at === "string" ? o.at.slice(0, 40) : "", list };
}

/** a footprint's corners */
export function footprintPts(b: SketchBuilding): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < b.xy.length; i += 2) out.push({ x: b.xy[i], y: b.xy[i + 1] });
  return out;
}

const boxes = new WeakMap<SketchBuildings, Float32Array>();
/** each footprint's bounds, minX, minY, maxX, maxY one after the other (worked out once) */
export function buildingBoxes(bs: SketchBuildings): Float32Array {
  let a = boxes.get(bs);
  if (a) return a;
  a = new Float32Array(bs.list.length * 4);
  bs.list.forEach((b, i) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k + 1 < b.xy.length; k += 2) { x0 = Math.min(x0, b.xy[k]); x1 = Math.max(x1, b.xy[k]); y0 = Math.min(y0, b.xy[k + 1]); y1 = Math.max(y1, b.xy[k + 1]); }
    a!.set([x0, y0, x1, y1], i * 4);
  });
  boxes.set(bs, a);
  return a;
}

const USE_LABEL: Record<BuildingUse, string> = { home: "Homes", shop: "Shops", office: "Offices", industry: "Industry", school: "School", civic: "Public building", other: "Building", minor: "Shed or garage" };
export const buildingUseLabel = (b: SketchBuilding) => USE_LABEL[b.use ?? "other"];
