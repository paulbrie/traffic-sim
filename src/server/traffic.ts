"use server";

import { name } from "@gdp-ts/core";
import type { GeoArea } from "@/engine/types";
import { PlanId } from "@/lib/ids";
import { bboxProblem } from "@/lib/osm/area";
import { decodeFlowTile, FLOW_ZOOM, MAX_TILES, tilesFor, type FlowLine, type TrafficSnapshot } from "@/lib/tomtom";
import { assertUser } from "./auth";
import { planAccess } from "./proofs/plan-access";

// Live traffic from TomTom (ticket #33): the key (TOMTOM_API) stays on the server; the editor gets the decoded lines.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API = "https://api.tomtom.com";
/** a tile fetched is kept this long (ms): TomTom's flow changes about once a minute, and every tile counts against the key's quota */
const TILE_TTL = 90_000;
const tiles = new Map<string, { t: number; lines: FlowLine[] }>();
/** tiles fetched at once */
const PARALLEL = 8;

class TomTomError extends Error {}

async function tomtom(path: string, key: string): Promise<Response> {
  const r = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`, { cache: "no-store", signal: AbortSignal.timeout(20_000) });
  // (the message without the URL: it carries the key)
  if (r.status === 403 || r.status === 401) throw new TomTomError("TomTom refused the key (TOMTOM_API).");
  if (r.status === 429) throw new TomTomError("TomTom's quota for the key is used up for now; try again later.");
  return r;
}

async function flowTile(style: "absolute" | "relative", x: number, y: number, key: string): Promise<FlowLine[]> {
  const id = `${style}/${FLOW_ZOOM}/${x}/${y}`, kept = tiles.get(id);
  if (kept && Date.now() - kept.t < TILE_TTL) return kept.lines;
  const r = await tomtom(`/traffic/map/4/tile/flow/${id}.pbf?tags=[traffic_level,traffic_road_coverage,road_closure,road_category]`, key);
  // (no roads with traffic in it: no content)
  const lines = r.status === 200 ? decodeFlowTile(new Uint8Array(await r.arrayBuffer()), FLOW_ZOOM, x, y) : [];
  if (r.status !== 200 && r.status !== 204) throw new TomTomError(`TomTom answered ${r.status} for a flow tile.`);
  if (tiles.size > 2000) for (const [k, v] of tiles) if (Date.now() - v.t >= TILE_TTL) tiles.delete(k);
  tiles.set(id, { t: Date.now(), lines });
  return lines;
}

async function inPool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await f(items[i]); } }));
  return out;
}

/**
 * TomTom's traffic now over an area of a plan the user can open: each road's speed and its share of the free-flow
 * speed (flow tiles, both styles). (Its incidents: /api/plans/[planId]/traffic.)
 */
export async function fetchLiveTraffic(planId: string, area: GeoArea): Promise<{ ok: true; snapshot: TrafficSnapshot } | { ok: false; error: string }> {
  const me = await assertUser();
  if (typeof planId !== "string" || !UUID.test(planId)) throw new Error("Invalid id");
  const view = await name(me.id, PlanId(planId), async (user, plan) => !!(await planAccess(user, plan)));
  if (!view) return { ok: false, error: "You can't open this plan." };
  const a = area && typeof area === "object" ? { south: Number(area.south), west: Number(area.west), north: Number(area.north), east: Number(area.east) } : null;
  const problem = a ? bboxProblem(a) : "Choose an area on the map.";
  if (problem || !a) return { ok: false, error: problem ?? "Choose an area on the map." };
  const key = process.env.TOMTOM_API;
  if (!key) return { ok: false, error: "No TomTom key on the server (TOMTOM_API)." };
  const ts = tilesFor(a);
  if (ts.length > MAX_TILES) return { ok: false, error: `The plan covers too much of the map for one fetch (${ts.length} tiles, at most ${MAX_TILES}).` };
  try {
    const [speeds, ratios] = await Promise.all([
      inPool(ts, PARALLEL, t => flowTile("absolute", t.x, t.y, key)),
      inPool(ts, PARALLEL, t => flowTile("relative", t.x, t.y, key)),
    ]);
    return { ok: true, snapshot: { at: new Date().toISOString(), area: a, speeds: speeds.flat(), ratios: ratios.flat() } };
  } catch (e) {
    if (e instanceof TomTomError) return { ok: false, error: e.message };
    console.error("TomTom traffic:", e instanceof Error ? e.message.replace(key, "<key>") : e);
    return { ok: false, error: "Couldn't reach TomTom; try again." };
  }
}
