import "server-only";
import { overpassQuery, type ImportOptions } from "@/lib/osm/area";
import type { OsmData } from "@/lib/osm/convert";
import { nearestStreets, nominatimReverseUrl, streetFromNominatim, streetsQuery, type NominatimReverse, type StreetNear, type StreetsData } from "@/lib/osm/streets";

/** public Overpass instances, tried in order when one is busy */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export class OsmError extends Error {}

/**
 * The named streets near a point, nearest first (ticket #48): a small `around` query, a short timeout per instance
 * (the list in the V2 map's right-click menu; the nearest one comes faster from Nominatim, below).
 */
export async function fetchStreetsNear(lat: number, lon: number): Promise<StreetNear[]> {
  const body = new URLSearchParams({ data: streetsQuery(lat, lon) });
  let last = "";
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST", body, cache: "no-store",
        headers: { "User-Agent": "Gridlock traffic simulator (street names)", Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) { last = `${new URL(url).host} answered ${res.status}`; continue; }
      const data = (await res.json()) as StreetsData & { remark?: string };
      if (!Array.isArray(data.elements)) { last = "unexpected answer"; continue; }
      if (data.remark && /error|timed out|out of memory/i.test(data.remark)) { last = data.remark; continue; }
      return nearestStreets(data, lat, lon);
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  console.error("OpenStreetMap street names failed:", last);
  throw new OsmError("OpenStreetMap's data service is busy or unreachable right now. Try again in a minute.");
}

// Nominatim's usage policy: at most one request a second, from this server, with a User-Agent that says who we are
let nominatimNext = 0;

/** The street nearest a point, from Nominatim's reverse geocoding (about 0.3 s), or null when it names none there. */
export async function fetchNominatimStreet(lat: number, lon: number): Promise<StreetNear | null> {
  const wait = nominatimNext - Date.now();
  nominatimNext = Math.max(Date.now(), nominatimNext) + 1100;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  try {
    const res = await fetch(nominatimReverseUrl(lat, lon), {
      cache: "no-store",
      headers: { "User-Agent": "Gridlock traffic simulator (street names; paul.cloud.teleporthq.ai/projects/trafficsim)", Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) throw new Error(`Nominatim answered ${res.status}`);
    return streetFromNominatim((await res.json()) as NominatimReverse, lat, lon);
  } catch (e) {
    console.error("Nominatim street name failed:", e instanceof Error ? e.message : String(e));
    throw new OsmError("OpenStreetMap's geocoder is busy or unreachable right now. Try again in a minute.");
  }
}

/** Downloads the roads and buildings of an area from OpenStreetMap (via the Overpass API). */
export async function fetchOsm(opts: ImportOptions): Promise<OsmData> {
  const body = new URLSearchParams({ data: overpassQuery(opts) });
  let last = "";
  for (const url of ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST", body, cache: "no-store",
        headers: { "User-Agent": "Gridlock traffic simulator (OpenStreetMap import)", Accept: "application/json" },
        signal: AbortSignal.timeout(180_000),
      });
      if (!res.ok) { last = `${new URL(url).host} answered ${res.status}`; continue; }
      const data = (await res.json()) as OsmData & { remark?: string };
      if (!Array.isArray(data.elements)) { last = "unexpected answer"; continue; }
      // Overpass reports timeouts and memory limits as a remark next to partial data
      if (data.remark && /error|timed out|out of memory/i.test(data.remark)) { last = data.remark; continue; }
      return data;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
  }
  console.error("OpenStreetMap import failed:", last);
  throw new OsmError("OpenStreetMap's data service is busy or unreachable right now. Try again in a minute, or choose a smaller area.");
}
