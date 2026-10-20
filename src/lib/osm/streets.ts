/**
 * The street names near a point, from OpenStreetMap (ticket #48): the named roads around it (an Overpass `around`
 * query, their tags and geometry), nearest first by the distance to each street's line, one entry per name. For
 * the V1 map's right-click menu: "the closest street name from the click", to name the road there.
 */
import { project } from "./area";

/** how far around the click to look (m) */
export const STREETS_RADIUS = 200;

/** the road kinds a street name may come from (not footpaths, tracks or steps) */
const STREET_KINDS = [
  "motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service",
  "pedestrian", "road", "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
];

/** Overpass QL: the named streets within `radius` m of the point, with their tags and geometry */
export function streetsQuery(lat: number, lon: number, radius = STREETS_RADIUS): string {
  const at = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return `[out:json][timeout:15];way(around:${Math.round(radius)},${at})["highway"~"^(${STREET_KINDS.join("|")})$"]["name"];out tags geom;`;
}

/** the part of an Overpass answer this reads: ways with their tags and geometry */
export interface StreetsData { elements: { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }[] }

export interface StreetNear {
  name: string;
  /** distance from the point to the street's line (m) */
  distance: number;
  /** its OSM road kind (residential, primary…) */
  kind: string;
  /** the nearest of its ways, on openstreetmap.org/way/<id> */
  wayId: number;
}

/** distance from p to the segment a–b (plane coordinates, m) */
function toSegment(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * The named streets of an Overpass answer, nearest the point first, one per name (a street is often several
 * ways: the nearest counts), at most `max`.
 */
export function nearestStreets(data: StreetsData, lat: number, lon: number, max = 5): StreetNear[] {
  const ref = { lat, lon }, p = { x: 0, y: 0 };
  const best = new Map<string, StreetNear>();
  for (const el of data.elements ?? []) {
    const name = el.tags?.name?.trim();
    if (el.type !== "way" || !name || !el.geometry?.length) continue;
    const pts = el.geometry.map(g => project(ref, g.lat, g.lon));
    let d = pts.length === 1 ? Math.hypot(pts[0].x, pts[0].y) : Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, toSegment(p, pts[i - 1], pts[i]));
    const was = best.get(name);
    if (!was || d < was.distance) best.set(name, { name, distance: d, kind: el.tags?.highway ?? "road", wayId: el.id });
  }
  return [...best.values()].sort((a, b) => a.distance - b.distance).slice(0, max);
}

/**
 * Nominatim's reverse geocoding (the fast way, when Overpass is slow): the street nearest the point, with its line.
 * `zoom=17`: major and minor streets.
 */
export function nominatimReverseUrl(lat: number, lon: number): string {
  return `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}&zoom=17&polygon_geojson=1&polygon_threshold=0.00002`;
}

/** the part of a Nominatim reverse answer this reads */
export interface NominatimReverse {
  osm_type?: string; osm_id?: number; category?: string; type?: string; name?: string;
  lat?: string; lon?: string;
  address?: { road?: string; pedestrian?: string };
  geojson?: { type?: string; coordinates?: unknown };
}

/**
 * The street of a Nominatim reverse answer, its distance from the point to its line (or to the answer's point): a
 * street itself (a `highway` way with a name), else the road of the address found. Null when it names none.
 */
export function streetFromNominatim(r: NominatimReverse, lat: number, lon: number): StreetNear | null {
  const isStreet = r.category === "highway" && !!r.name?.trim();
  const name = (isStreet ? r.name : r.address?.road ?? r.address?.pedestrian)?.trim();
  if (!name) return null;
  // its lines ([lon, lat] pairs) when it's the street itself, each on its own; a point otherwise
  const g = r.geojson, lines: [number, number][][] =
    isStreet && g?.type === "LineString" && Array.isArray(g.coordinates) ? [g.coordinates as [number, number][]]
    : isStreet && g?.type === "MultiLineString" && Array.isArray(g.coordinates) ? (g.coordinates as [number, number][][])
    : r.lat && r.lon ? [[[Number(r.lon), Number(r.lat)]]] : [];
  const tags = { name, highway: isStreet ? r.type ?? "road" : "road" };
  const elements = lines.map(line => ({
    type: "way", id: r.osm_id ?? 0, tags,
    geometry: line.filter(c => Number.isFinite(c[0]) && Number.isFinite(c[1])).map(([x, y]) => ({ lat: y, lon: x })),
  }));
  const [near] = nearestStreets({ elements }, lat, lon);
  return near ?? null;
}

/** two lists of streets as one: one entry per name (the nearer), nearest first */
export function mergeStreets(a: StreetNear[], b: StreetNear[], max = 5): StreetNear[] {
  const best = new Map<string, StreetNear>();
  for (const s of [...a, ...b]) { const was = best.get(s.name); if (!was || s.distance < was.distance) best.set(s.name, s); }
  return [...best.values()].sort((x, y) => x.distance - y.distance).slice(0, max);
}
