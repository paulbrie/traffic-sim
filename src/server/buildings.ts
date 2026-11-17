"use server";

import { name } from "@gdp-ts/core";
import type { GeoRef } from "@/engine/types";
import { PlanId } from "@/lib/ids";
import { unproject } from "@/lib/osm/area";
import { osmFootprints } from "@/lib/osm/convert";
import { MAX_BUILDINGS, MAX_BUILDINGS_SIDE, type SketchBuildings } from "@/lib/sketch-buildings";
import { assertUser } from "./auth";
import { fetchOsmBuildings, OsmError } from "./osm";
import { planAccess } from "./proofs/plan-access";
import { canEditPlan } from "./proofs/policy";

// Buildings (ticket #267): OpenStreetMap's footprints round a V2 plan's lanes, for its 3D view; the editor keeps them in the sketch.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The buildings over an area of a plan the user can edit (plan metres round `geo`, the sketch's place on Earth), as the
 * sketch keeps them; `capped`: there were more than it keeps (the largest kept).
 */
export async function fetchBuildings(planId: string, geo: GeoRef, area: { minX: number; minY: number; maxX: number; maxY: number }): Promise<{ ok: true; buildings: SketchBuildings; capped: boolean; tagged: number } | { ok: false; error: string }> {
  const me = await assertUser();
  if (typeof planId !== "string" || !UUID.test(planId)) throw new Error("Invalid id");
  const edit = await name(me.id, PlanId(planId), async (user, plan) => !!canEditPlan(await planAccess(user, plan)));
  if (!edit) return { ok: false, error: "You can't change this plan." };
  const g = geo && typeof geo === "object" && Number.isFinite(geo.lat) && Number.isFinite(geo.lon) && Math.abs(geo.lat) <= 85 && Math.abs(geo.lon) <= 180 ? { lat: Number(geo.lat), lon: Number(geo.lon) } : null;
  if (!g) return { ok: false, error: "Place the plan on the map first (Background)." };
  const a = area && typeof area === "object" ? { minX: Number(area.minX), minY: Number(area.minY), maxX: Number(area.maxX), maxY: Number(area.maxY) } : null;
  if (!a || ![a.minX, a.minY, a.maxX, a.maxY].every(Number.isFinite) || a.maxX <= a.minX || a.maxY <= a.minY) return { ok: false, error: "Nothing to fetch the buildings for: draw some lanes first." };
  if (a.maxX - a.minX > MAX_BUILDINGS_SIDE || a.maxY - a.minY > MAX_BUILDINGS_SIDE) return { ok: false, error: `The plan covers too much of the map for its buildings (at most ${MAX_BUILDINGS_SIDE / 1000} km a side).` };
  const nw = unproject(g, { x: a.minX, y: a.minY }), se = unproject(g, { x: a.maxX, y: a.maxY });
  try {
    const data = await fetchOsmBuildings({ south: se.lat, west: nw.lon, north: nw.lat, east: se.lon });
    let fp = osmFootprints(data, g, a);
    const capped = fp.length > MAX_BUILDINGS;
    // (too many: the largest kept)
    if (capped) fp = fp.map(f => ({ f, s: (Math.max(...f.pts.map(p => p.x)) - Math.min(...f.pts.map(p => p.x))) * (Math.max(...f.pts.map(p => p.y)) - Math.min(...f.pts.map(p => p.y))) })).sort((x, y) => y.s - x.s).slice(0, MAX_BUILDINGS).map(x => x.f);
    const list = fp.map(f => ({
      id: f.id, xy: f.pts.flatMap(p => [p.x, p.y]), h: f.h,
      ...(f.use !== "other" ? { use: f.use } : {}), ...(f.name ? { name: f.name } : {}), ...(f.tagged ? { tagged: true as const } : {}),
    }));
    return { ok: true, buildings: { geo: g, at: new Date().toISOString(), list }, capped, tagged: list.filter(b => b.tagged).length };
  } catch (e) {
    if (e instanceof OsmError) return { ok: false, error: e.message };
    console.error("buildings:", e instanceof Error ? e.message : e);
    return { ok: false, error: "Couldn't fetch the buildings; try again." };
  }
}
