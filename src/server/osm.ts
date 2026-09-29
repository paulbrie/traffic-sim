import "server-only";
import { overpassQuery, type ImportOptions } from "@/lib/osm/area";
import type { OsmData } from "@/lib/osm/convert";

/** public Overpass instances, tried in order when one is busy */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

export class OsmError extends Error {}

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
