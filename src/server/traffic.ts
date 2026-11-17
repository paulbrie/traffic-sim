"use server";

import { name } from "@gdp-ts/core";
import type { GeoArea } from "@/engine/types";
import { PlanId } from "@/lib/ids";
import { bboxProblem } from "@/lib/osm/area";
import { MAX_TILES, tilesFor, type FlowLine, type TrafficSnapshot } from "@/lib/tomtom";
import { fetchFlow, fetchFlowTile, TomTomError } from "@/lib/tomtom-api";
import { assertUser } from "./auth";
import { trafficHistoryInfo, type TrafficHistoryInfo } from "./data/traffic-history";
import { listTrafficSamples, type TrafficSampleInfo } from "./data/traffic-samples";
import { planAccess } from "./proofs/plan-access";

// Live traffic from TomTom (ticket #33): the key (TOMTOM_API) stays on the server; the editor gets the decoded lines.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** a tile fetched is kept this long (ms): TomTom's flow changes about once a minute, and every tile counts against the key's quota */
const TILE_TTL = 90_000;
const tiles = new Map<string, { t: number; lines: FlowLine[] }>();

async function flowTile(style: "absolute" | "relative", x: number, y: number, key: string): Promise<FlowLine[]> {
  const id = `${style}/${x}/${y}`, kept = tiles.get(id);
  if (kept && Date.now() - kept.t < TILE_TTL) return kept.lines;
  const lines = await fetchFlowTile(style, x, y, key);
  if (tiles.size > 2000) for (const [k, v] of tiles) if (Date.now() - v.t >= TILE_TTL) tiles.delete(k);
  tiles.set(id, { t: Date.now(), lines });
  return lines;
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
    const { speeds, ratios } = await fetchFlow(a, key, flowTile);
    return { ok: true, snapshot: { at: new Date().toISOString(), area: a, speeds, ratios } };
  } catch (e) {
    if (e instanceof TomTomError) return { ok: false, error: e.message };
    console.error("TomTom traffic:", e instanceof Error ? e.message.replace(key, "<key>") : e);
    return { ok: false, error: "Couldn't reach TomTom; try again." };
  }
}

/** (ticket #261) how much of TomTom's traffic is recorded for a plan the user can open (null: they can't) */
export async function getTrafficHistoryInfo(planId: string): Promise<TrafficHistoryInfo | null> {
  const me = await assertUser();
  if (typeof planId !== "string" || !UUID.test(planId)) throw new Error("Invalid id");
  return name(me.id, PlanId(planId), async (user, plan) => {
    const view = await planAccess(user, plan);
    return view ? trafficHistoryInfo(plan, view) : null;
  });
}

/** (ticket #261) the samples recorded for a plan the user can open, oldest first, for the replay (none: they can't) */
export async function getTrafficSamples(planId: string): Promise<TrafficSampleInfo[]> {
  const me = await assertUser();
  if (typeof planId !== "string" || !UUID.test(planId)) throw new Error("Invalid id");
  return name(me.id, PlanId(planId), async (user, plan) => {
    const view = await planAccess(user, plan);
    return view ? listTrafficSamples(plan, view) : [];
  });
}
