/**
 * TomTom's traffic APIs fetched (tickets #33, #261): the flow tiles and the incidents over an area. Plain fetch, no
 * framework: the editor's live traffic (src/server/traffic.ts), its incidents route and the traffic recorder
 * (scripts/traffic-collect.ts) share it. The key goes in the URL only, never in a message.
 */
import type { GeoArea } from "@/engine/types";
import { decodeFlowTile, FLOW_ZOOM, tilesFor, type FlowLine } from "./tomtom";

const API = "https://api.tomtom.com";
/** tiles fetched at once */
export const TILE_PARALLEL = 8;

/** what to tell the user (no key in it) */
export class TomTomError extends Error {}

async function tomtom(path: string, key: string): Promise<Response> {
  const r = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  // (the message without the URL: it carries the key)
  if (r.status === 403 || r.status === 401) throw new TomTomError("TomTom refused the key (TOMTOM_API).");
  if (r.status === 429) throw new TomTomError("TomTom's quota for the key is used up for now; try again later.");
  return r;
}

/** one flow tile at FLOW_ZOOM: each road's km/h ("absolute") or share of its free-flow speed ("relative") */
export async function fetchFlowTile(style: "absolute" | "relative", x: number, y: number, key: string): Promise<FlowLine[]> {
  const r = await tomtom(`/traffic/map/4/tile/flow/${style}/${FLOW_ZOOM}/${x}/${y}.pbf?tags=[traffic_level,traffic_road_coverage,road_closure,road_category]`, key);
  // (no roads with traffic in it: no content)
  if (r.status === 204) return [];
  if (r.status !== 200) throw new TomTomError(`TomTom answered ${r.status} for a flow tile.`);
  return decodeFlowTile(new Uint8Array(await r.arrayBuffer()), FLOW_ZOOM, x, y);
}

/** `f` on each item, `n` at a time, the results in the items' order */
export async function inPool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]); } }));
  return out;
}

/** both kinds of flow tiles over an area (`tile`: how one is fetched, e.g. through a cache) */
export async function fetchFlow(area: GeoArea, key: string, tile = fetchFlowTile): Promise<{ speeds: FlowLine[]; ratios: FlowLine[]; tiles: number }> {
  const ts = tilesFor(area);
  const [speeds, ratios] = await Promise.all([
    inPool(ts, TILE_PARALLEL, t => tile("absolute", t.x, t.y, key)),
    inPool(ts, TILE_PARALLEL, t => tile("relative", t.x, t.y, key)),
  ]);
  return { speeds: speeds.flat(), ratios: ratios.flat(), tiles: ts.length };
}

/** a jam, roadworks, a closure… on TomTom's map */
export interface Incident {
  id: string;
  /** TomTom's kind: 1 accident, 6 jam, 7 lane closed, 8 road closed, 9 roadworks, … (0 unknown) */
  iconCategory: number;
  /** 0 unknown, 1 minor, 2 moderate, 3 major, 4 undefined (closures, roadworks) */
  magnitudeOfDelay: number;
  /** seconds lost through it, where known */
  delay: number | null;
  from: string | null; to: string | null; description: string | null;
  coordinates: { lat: number; lon: number }[];
}

interface IncidentsResponse {
  incidents?: {
    properties: { id?: string; iconCategory?: number; magnitudeOfDelay?: number; delay?: number | null; from?: string | null; to?: string | null; events?: { description?: string }[] };
    geometry?: { type?: string; coordinates?: [number, number][] };
  }[];
}

/** TomTom's incidents now over an area */
export async function fetchIncidents(a: GeoArea, key: string): Promise<Incident[]> {
  const fields = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,delay,from,to,events{description}}}}";
  const r = await tomtom(`/traffic/services/5/incidentDetails?bbox=${a.west},${a.south},${a.east},${a.north}&fields=${encodeURIComponent(fields)}&language=en-US`, key);
  if (!r.ok) throw new TomTomError(`TomTom answered ${r.status}`);
  const data: IncidentsResponse = await r.json();
  return (data.incidents ?? []).map((f, i) => {
    const p = f.properties;
    return {
      id: p.id ?? String(i),
      iconCategory: p.iconCategory ?? 0,
      magnitudeOfDelay: p.magnitudeOfDelay ?? 0,
      delay: p.delay ?? null,
      from: p.from ?? null, to: p.to ?? null,
      description: p.events?.[0]?.description ?? null,
      coordinates: (f.geometry?.coordinates ?? []).map(([lon, lat]) => ({ lat, lon })),
    };
  });
}
