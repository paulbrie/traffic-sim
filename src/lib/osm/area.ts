/**
 * Importing from OpenStreetMap: the area to fetch, which roads to keep, and the projection from
 * latitude/longitude to plan metres. Shared by the import dialog (browser) and the server.
 */
import type { GeoArea, GeoRef, Vec } from "@/engine/types";

export type BBox = GeoArea;

const R = 6378137;
const rad = (d: number) => (d * Math.PI) / 180;

/** plan metres (x east, y south) of a latitude/longitude, relative to `ref` */
export function project(ref: GeoRef, lat: number, lon: number): Vec {
  return { x: R * rad(lon - ref.lon) * Math.cos(rad(ref.lat)), y: -R * rad(lat - ref.lat) };
}

export function unproject(ref: GeoRef, p: Vec): { lat: number; lon: number } {
  return { lat: ref.lat - (p.y / R) * (180 / Math.PI), lon: ref.lon + (p.x / (R * Math.cos(rad(ref.lat)))) * (180 / Math.PI) };
}

export const bboxCenter = (b: BBox): GeoRef => ({ lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 });

/** width and height of an area in metres */
export function bboxSize(b: BBox): { w: number; h: number } {
  const c = bboxCenter(b), sw = project(c, b.south, b.west), ne = project(c, b.north, b.east);
  return { w: Math.abs(ne.x - sw.x), h: Math.abs(sw.y - ne.y) };
}

/** largest area one import may cover (Overpass answers slowly and plans get heavy beyond this) */
export const MAX_SIDE = 6000;
export const MAX_AREA = 20_000_000;

export function bboxProblem(b: BBox): string | null {
  const ok = [b.south, b.north].every(v => Number.isFinite(v) && Math.abs(v) <= 85) && [b.west, b.east].every(v => Number.isFinite(v) && Math.abs(v) <= 180);
  if (!ok || b.south >= b.north || b.west >= b.east) return "Choose an area on the map.";
  const { w, h } = bboxSize(b);
  if (w < 50 || h < 50) return "The area is too small; zoom out a little.";
  if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) return `The area is too large (${(w / 1000).toFixed(1)} × ${(h / 1000).toFixed(1)} km). Import at most ${MAX_SIDE / 1000} km across and ${MAX_AREA / 1e6} km²; zoom in, or import neighbouring parts one after the other.`;
  return null;
}

export type RoadClass = "motorway" | "main" | "local" | "residential" | "service";

export const ROAD_CLASSES: { id: RoadClass; label: string; hint: string; highways: string[] }[] = [
  { id: "motorway", label: "Motorways and trunk roads", hint: "incl. slip roads", highways: ["motorway", "motorway_link", "trunk", "trunk_link"] },
  { id: "main", label: "Primary and secondary roads", hint: "boulevards, main streets", highways: ["primary", "primary_link", "secondary", "secondary_link"] },
  { id: "local", label: "Tertiary and unclassified", hint: "connecting streets", highways: ["tertiary", "tertiary_link", "unclassified"] },
  { id: "residential", label: "Residential streets", hint: "incl. living streets", highways: ["residential", "living_street"] },
  { id: "service", label: "Service roads", hint: "access roads, alleys (can add a lot of roads)", highways: ["service"] },
];

export const DEFAULT_ROAD_CLASSES: RoadClass[] = ["motorway", "main", "local", "residential"];

export interface ImportOptions {
  bbox: BBox;
  roads: RoadClass[];
  buildings: boolean;
}

export function highwaysFor(classes: RoadClass[]): string[] {
  return ROAD_CLASSES.filter(c => classes.includes(c.id)).flatMap(c => c.highways);
}

/** Overpass QL for the chosen roads (with their nodes' tags: signals, stop signs) and buildings */
export function overpassQuery(o: ImportOptions): string {
  const b = `${o.bbox.south},${o.bbox.west},${o.bbox.north},${o.bbox.east}`;
  const hw = highwaysFor(o.roads);
  const parts: string[] = [];
  if (hw.length) parts.push(`way["highway"~"^(${hw.join("|")})$"]["area"!="yes"](${b});`);
  if (o.buildings) parts.push(`way["building"](${b});`, `relation["building"]["type"="multipolygon"](${b});`);
  return `[out:json][timeout:180][maxsize:268435456];(${parts.join("")});out body;>;out body qt;`;
}

/**
 * Line a new frame up with the frames already imported: an edge that nearly touches or overlaps
 * an imported frame (within 40% of the new frame, at most 250 m) is moved onto that frame's edge,
 * so roads crossing the seam meet at the same points. Returns the frame unchanged when nothing is near.
 */
export function snapToAreas(b: BBox, areas: BBox[]): BBox {
  const { w, h } = bboxSize(b);
  const c = bboxCenter(b);
  const mLat = 1 / 110540, mLon = 1 / (111320 * Math.cos(rad(c.lat)));
  const tolLon = Math.min(250, 0.4 * w) * mLon, tolLat = Math.min(250, 0.4 * h) * mLat;
  const out = { ...b };
  for (const a of areas) {
    const overlapNS = out.south < a.north && out.north > a.south;
    if (overlapNS) {
      if (Math.abs(out.west - a.east) < tolLon && out.east > a.east) out.west = a.east;
      else if (Math.abs(out.east - a.west) < tolLon && out.west < a.west) out.east = a.west;
    }
    // (checked after the sides moved, so a frame already lined up beside `a` stays as it is)
    if (out.west < a.east && out.east > a.west) {
      if (Math.abs(out.south - a.north) < tolLat && out.north > a.north) out.south = a.north;
      else if (Math.abs(out.north - a.south) < tolLat && out.south < a.south) out.north = a.south;
    }
  }
  return out;
}
