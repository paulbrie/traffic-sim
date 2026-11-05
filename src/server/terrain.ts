"use server";

import { inflateSync } from "node:zlib";
import { name } from "@gdp-ts/core";
import type { GeoRef } from "@/engine/types";
import { PlanId } from "@/lib/ids";
import { decodeTerrariumPng, TERRARIUM_URL, terrainFromTiles, type SketchTerrain, type TileHeights } from "@/lib/terrain";
import { assertUser } from "./auth";
import { planAccess } from "./proofs/plan-access";
import { canEditPlan } from "./proofs/policy";

// Terrain (ticket #130): the ground's heights under a plan, from AWS's open terrain tiles (no key). The editor keeps the
// grid in the sketch; tiles are kept here a while, as the same place is often fetched again (moved a little, more lanes).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** tiles kept (heights, about 256 KB each), the oldest let go first */
const KEEP = 200;
const tiles = new Map<string, TileHeights>();
const PARALLEL = 8;

async function tile(z: number, x: number, y: number): Promise<TileHeights> {
  const id = `${z}/${x}/${y}`, kept = tiles.get(id);
  if (kept) { tiles.delete(id); tiles.set(id, kept); return kept; }
  const r = await fetch(TERRARIUM_URL(z, x, y), { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`the terrain tiles answered ${r.status}`);
  const t = decodeTerrariumPng(new Uint8Array(await r.arrayBuffer()), d => new Uint8Array(inflateSync(d)));
  tiles.set(id, t);
  while (tiles.size > KEEP) tiles.delete(tiles.keys().next().value!);
  return t;
}

/**
 * The ground's heights over an area of a plan the user can edit (plan metres round `geo`, the sketch's place on Earth), as
 * the grid the sketch keeps.
 */
export async function fetchTerrain(planId: string, geo: GeoRef, area: { minX: number; minY: number; maxX: number; maxY: number }): Promise<{ ok: true; terrain: SketchTerrain } | { ok: false; error: string }> {
  const me = await assertUser();
  if (typeof planId !== "string" || !UUID.test(planId)) throw new Error("Invalid id");
  const edit = await name(me.id, PlanId(planId), async (user, plan) => !!canEditPlan(await planAccess(user, plan)));
  if (!edit) return { ok: false, error: "You can't change this plan." };
  const g = geo && typeof geo === "object" && Number.isFinite(geo.lat) && Number.isFinite(geo.lon) && Math.abs(geo.lat) <= 85 && Math.abs(geo.lon) <= 180 ? { lat: Number(geo.lat), lon: Number(geo.lon) } : null;
  if (!g) return { ok: false, error: "Place the plan on the map first (Background)." };
  const a = area && typeof area === "object" ? { minX: Number(area.minX), minY: Number(area.minY), maxX: Number(area.maxX), maxY: Number(area.maxY) } : null;
  if (!a || ![a.minX, a.minY, a.maxX, a.maxY].every(Number.isFinite) || a.maxX <= a.minX || a.maxY <= a.minY) return { ok: false, error: "Nothing to fetch the terrain for: draw some lanes first." };
  if (a.maxX - a.minX > 30_000 || a.maxY - a.minY > 30_000) return { ok: false, error: "The plan covers too much of the map for its terrain (at most 30 km a side)." };
  try {
    return { ok: true, terrain: await terrainFromTiles(g, a, tile, PARALLEL) };
  } catch (e) {
    console.error("terrain:", e instanceof Error ? e.message : e);
    return { ok: false, error: "Couldn't fetch the terrain; try again." };
  }
}
