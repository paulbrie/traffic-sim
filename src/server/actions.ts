"use server";

import { revalidatePath } from "next/cache";
import { name } from "@gdp-ts/core";
import { sampleTown } from "@/engine/sample";
import { emptyNetwork, type GeoRef, type Network, type PlanSettings } from "@/engine/types";
import { sanitizeNetwork, sanitizeSettings } from "@/engine/validate";
import type { Underlay } from "@/lib/underlay";
import type { Sketch } from "@/lib/lane-sketch";
import { networkToSketch, type ConvertReport } from "@/lib/v1-to-v2";
import { CityId, PlanId, UserId, VersionId } from "@/lib/ids";
import { bboxCenter, bboxProblem, bboxSize, ROAD_CLASSES, type BBox, type ImportOptions, type RoadClass } from "@/lib/osm/area";
import { convertOsm, suggestSettings, type ImportStats } from "@/lib/osm/convert";
import { sanitizeHeliKeys, type HeliKeys } from "@/lib/heli-keys";
import { fetchOsm, OsmError } from "./osm";
import { assertUser } from "./auth";
import { cityAccess } from "./proofs/city-access";
import { planAccess } from "./proofs/plan-access";
import { userIsAdmin } from "./proofs/user-is-admin";
import { versionOfPlan } from "./proofs/version-of-plan";
import { restoreFromFile, type RestoreFileDeps, type RestoreFileInput, type RestoreFileResult } from "./restore-file";
import * as agentPatches from "./data/agent-patches";
import { patchNote } from "@/lib/agent-patch";
import { canEditCity, canEditPlan, canOwnCity, canOwnPlan, refusal } from "./proofs/policy";
import * as cities from "./data/cities";
import * as plans from "./data/plans";
import * as users from "./data/users";
import * as templates from "./data/templates";
import { readPiece, type JunctionPiece } from "@/state/groups";

// Every action checks for a signed-in user, then names the ids it acts on and proves the user's access to
// them (src/server/proofs); the data layer (src/server/data) won't take the ids without those proofs.

export type { ShareResult } from "./data/cities";
export type { SaveResult, VersionRow } from "./data/plans";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s: unknown, max = 120) => (typeof s === "string" ? s.trim().slice(0, max) : "");
function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid id");
}

// ---------------------------------------------------------------- cities (maps)
export async function createCity(input: { name: string; description?: string }) {
  const me = await assertUser();
  const title = clean(input.name);
  if (!title) throw new Error("Give the city a name.");
  const id = await cities.createCity(me.id, { name: title, description: clean(input.description, 500) });
  revalidatePath("/");
  return id;
}

export async function updateCity(id: string, input: { name: string; description?: string }) {
  const me = await assertUser();
  assertId(id);
  const title = clean(input.name);
  await name(me.id, CityId(id), async (user, city) => {
    const a = await cityAccess(user, city), own = canOwnCity(a);
    if (!own) throw refusal(a, "own", "map");
    if (!title) throw new Error("Give the city a name.");
    await cities.updateCity(city, { name: title, description: clean(input.description, 500) }, own);
  });
  revalidatePath("/");
  revalidatePath(`/cities/${id}`);
}

export async function deleteCity(id: string) {
  const me = await assertUser();
  assertId(id);
  await name(me.id, CityId(id), async (user, city) => {
    const a = await cityAccess(user, city), own = canOwnCity(a);
    if (!own) throw refusal(a, "own", "map");
    await cities.deleteCity(city, own);
  });
  revalidatePath("/");
}

/**
 * Copies a city with all its plans (and their reference images) into a new city owned by the
 * caller. Anyone who can view a city may copy it; sharing and history are not copied.
 */
export async function duplicateCity(id: string, input: { name?: string } = {}) {
  const me = await assertUser();
  assertId(id);
  const cityId = await name(me.id, CityId(id), async (user, city) => {
    const view = await cityAccess(user, city);
    if (!view) throw refusal(view, "edit", "map");
    const copy = await cities.duplicateCity(city, user, clean(input.name) || null, view);
    if (!copy) throw new Error("City not found");
    return copy;
  });
  revalidatePath("/");
  return cityId;
}

// ---------------------------------------------------------------- OpenStreetMap import
export interface OsmAreaInput { bbox: BBox; roads: RoadClass[]; buildings: boolean }
export type OsmImportTarget = { kind: "city"; name: string } | { kind: "plan"; cityId: string; name: string };
export type OsmImportResult = { ok: true; cityId: string; planId: string; stats: ImportStats } | { ok: false; error: string };
export type OsmLoadResult = { ok: true; network: Network; stats: ImportStats } | { ok: false; error: string };

function osmOptions(input: OsmAreaInput): ImportOptions | string {
  const b = input?.bbox;
  const bbox: BBox = { south: Number(b?.south), west: Number(b?.west), north: Number(b?.north), east: Number(b?.east) };
  const problem = bboxProblem(bbox);
  if (problem) return problem;
  const roads = ROAD_CLASSES.map(c => c.id).filter(id => Array.isArray(input.roads) && input.roads.includes(id));
  const buildings = input.buildings === true;
  if (!roads.length && !buildings) return "Choose at least one kind of road, or buildings.";
  return { bbox, roads, buildings };
}

/** download and convert an area; the plan's (0, 0) is at `origin` (default: the area's centre) */
async function loadArea(opts: ImportOptions, origin: GeoRef): Promise<OsmLoadResult> {
  let data;
  try { data = await fetchOsm(opts); } catch (e) {
    if (e instanceof OsmError) return { ok: false, error: e.message };
    throw e;
  }
  const { network, stats } = convertOsm(data, { ...opts, origin });
  if (!network.links.length && !network.buildings?.length) return { ok: false, error: "OpenStreetMap has no roads or buildings of the chosen kinds in this area." };
  return { ok: true, network: sanitizeNetwork(network), stats };
}

const osmNote = (opts: ImportOptions) => {
  const { w, h } = bboxSize(opts.bbox);
  return `Imported from OpenStreetMap on ${new Date().toISOString().slice(0, 10)} (${(w / 1000).toFixed(1)} × ${(h / 1000).toFixed(1)} km). Map data © OpenStreetMap contributors, ODbL.`;
};

/** Creates a plan (in a new city, or an existing one) from an area of OpenStreetMap. */
export async function importOsm(input: OsmAreaInput & { target: OsmImportTarget }): Promise<OsmImportResult> {
  const me = await assertUser();
  const target = input.target;
  if (target?.kind === "plan") {
    assertId(target.cityId);
    // (checked before the download, which takes a while)
    await name(me.id, CityId(target.cityId), async (user, city) => { const a = await cityAccess(user, city); if (!canEditCity(a)) throw refusal(a, "edit", "map"); });
  } else if (target?.kind !== "city") throw new Error("Invalid target");
  const title = clean(target.name);
  if (!title) return { ok: false, error: target.kind === "city" ? "Give the city a name." : "Give the plan a name." };
  const opts = osmOptions(input);
  if (typeof opts === "string") return { ok: false, error: opts };
  const res = await loadArea(opts, bboxCenter(opts.bbox));
  if (!res.ok) return res;
  const note = osmNote(opts), settings = suggestSettings(res.network);
  const ids = target.kind === "city"
    ? await plans.createCityWithPlan(me.id, { name: title, description: "Imported from OpenStreetMap" }, { name: "Current layout", description: note.slice(0, 500), network: res.network, settings, note: "Imported from OpenStreetMap" })
    : await name(me.id, CityId(target.cityId), async (user, city) => {
      // (asked again: access may have changed during the download)
      const a = await cityAccess(user, city), edit = canEditCity(a);
      if (!edit) throw refusal(a, "edit", "map");
      const planId = await plans.createPlan(city, user, { name: title, description: note.slice(0, 500), network: res.network, settings, note: "Imported from OpenStreetMap" }, edit);
      return { cityId: target.cityId, planId };
    });
  revalidatePath("/");
  revalidatePath(`/cities/${ids.cityId}`);
  return { ok: true, ...ids, stats: res.stats };
}

/** Downloads an area for merging into the plan being edited (the editor places and saves it). */
export async function loadOsmArea(input: OsmAreaInput & { origin?: GeoRef | null }): Promise<OsmLoadResult> {
  await assertUser();
  const opts = osmOptions(input);
  if (typeof opts === "string") return { ok: false, error: opts };
  const o = input.origin;
  const origin = o && Number.isFinite(o.lat) && Number.isFinite(o.lon) && Math.abs(o.lat) <= 85 && Math.abs(o.lon) <= 180 ? { lat: o.lat, lon: o.lon } : bboxCenter(opts.bbox);
  return loadArea(opts, origin);
}

// ---------------------------------------------------------------- sharing

/** Shares a map with an existing account, or changes the access it already has. Owners only. */
export async function shareCity(cityId: string, input: { email: string; access: "read" | "write" }): Promise<cities.ShareResult> {
  const me = await assertUser();
  assertId(cityId);
  const email = clean(input.email, 200).toLowerCase();
  const access = input.access === "write" ? "write" : "read";
  const res = await name(me.id, CityId(cityId), async (user, city) => {
    const a = await cityAccess(user, city), own = canOwnCity(a);
    if (!own) throw refusal(a, "own", "map");
    if (!EMAIL.test(email)) return { ok: false as const, error: "Enter a valid email address." };
    return cities.shareCity(city, email, access, own);
  });
  if (res.ok) revalidatePath(`/cities/${cityId}`);
  return res;
}

/** Owners remove anyone; anyone can remove themselves (leave a shared map). */
export async function unshareCity(cityId: string, userId: string): Promise<cities.ShareResult> {
  const me = await assertUser();
  assertId(cityId); assertId(userId);
  if (userId === me.id) await cities.leaveCity(CityId(cityId), me.id);
  else await name(me.id, CityId(cityId), async (user, city) => {
    const a = await cityAccess(user, city), own = canOwnCity(a);
    if (!own) throw refusal(a, "own", "map");
    await cities.unshareCity(city, UserId(userId), own);
  });
  revalidatePath(`/cities/${cityId}`);
  revalidatePath("/");
  return { ok: true };
}

/** Removes a map someone shared with you from your list. */
export async function leaveCity(cityId: string): Promise<cities.ShareResult> {
  const me = await assertUser();
  assertId(cityId);
  await cities.leaveCity(CityId(cityId), me.id);
  revalidatePath("/");
  return { ok: true };
}

export async function listShares(cityId: string) {
  const me = await assertUser();
  assertId(cityId);
  return name(me.id, CityId(cityId), async (user, city) => {
    const view = await cityAccess(user, city);
    if (!view) throw refusal(view, "edit", "map");
    return cities.listShares(city, view);
  });
}

/** Admins: hand a map to another account (the previous owner keeps edit access). */
export async function transferCity(cityId: string, newOwnerId: string): Promise<cities.ShareResult> {
  const me = await assertUser();
  assertId(cityId); assertId(newOwnerId);
  const res = await name(me.id, async user => {
    const admin = await userIsAdmin(user);
    if (!admin) throw new Error("Admins only");
    return cities.transferCity(CityId(cityId), UserId(newOwnerId), admin);
  });
  if (res.ok) revalidatePath("/admin/maps");
  return res;
}

// ---------------------------------------------------------------- plans
/** A new plan: on the V2 engine (the lane sketch; starts blank), or V1 (blank, or the sample district). */
export async function createPlan(input: { cityId: string; name: string; description?: string; template: "blank" | "sample"; engine?: "v1" | "v2" }) {
  const me = await assertUser();
  assertId(input.cityId);
  const id = await name(me.id, CityId(input.cityId), async (user, city) => {
    const a = await cityAccess(user, city), edit = canEditCity(a);
    if (!edit) throw refusal(a, "edit", "map");
    const engine = input.engine === "v2" ? "v2" : "v1";
    const network = engine === "v1" && input.template === "sample" ? sampleTown() : emptyNetwork();
    return plans.createPlan(city, user, { name: clean(input.name) || "Untitled plan", description: clean(input.description, 500), network, note: "Created", engine }, edit);
  });
  revalidatePath(`/cities/${input.cityId}`);
  revalidatePath("/");
  return id;
}

/** Creates a plan next to an existing one from a network the editor produced (e.g. optimised signal timings). */
export async function createPlanFrom(sourceId: string, input: { name: string; description?: string; network: unknown; settings: unknown }) {
  const me = await assertUser();
  assertId(sourceId);
  const made = await name(me.id, PlanId(sourceId), async (user, source) => {
    const a = await planAccess(user, source), edit = canEditPlan(a);
    if (!edit) throw refusal(a, "edit", "plan");
    const r = await plans.createPlanNextTo(source, user, {
      name: clean(input.name) || "Untitled plan", description: clean(input.description, 500),
      network: sanitizeNetwork(input.network), settings: sanitizeSettings(input.settings), note: clean(input.description, 200) || "Created",
    }, edit);
    if (!r) throw new Error("Plan not found");
    return r;
  });
  revalidatePath(`/cities/${made.cityId}`);
  return made.id;
}

/**
 * A V2 copy of a V1 plan: its network converted to a lane sketch (lanes, connectors, junctions, signs,
 * lights, roundabouts; see lib/v1-to-v2), next to it in its city. Its id, and what was converted and left out.
 */
export async function convertPlanToV2(id: string): Promise<{ id: string; report: ConvertReport }> {
  const me = await assertUser();
  assertId(id);
  const made = await name(me.id, PlanId(id), async (user, plan) => {
    const a = await planAccess(user, plan), edit = canEditPlan(a);
    if (!edit) throw refusal(a, "edit", "plan");
    const state = await plans.planState(plan, edit);
    if (!state) throw new Error("Plan not found");
    const { sketch, report } = networkToSketch(state.network);
    if (!sketch.lanes.length) throw new Error("This plan has no roads to convert.");
    const r = await plans.createV2From(plan, user, { sketch, note: `Converted from V1: ${report.lanes} lanes, ${report.connectors} connectors, ${report.junctions} junctions${report.tidy.folded || report.tidy.kinks || report.tidy.extended ? ` (tidied: ${report.tidy.folded} very short lanes folded into their connectors, ${report.tidy.kinks} points doubling back taken out, ${report.tidy.extended} short ways in or out lengthened)` : ""}` }, edit);
    if (!r) throw new Error("Plan not found");
    return { ...r, report };
  });
  revalidatePath(`/cities/${made.cityId}`);
  return { id: made.id, report: made.report };
}

export async function duplicatePlan(id: string) {
  const me = await assertUser();
  assertId(id);
  const made = await name(me.id, PlanId(id), async (user, plan) => {
    const a = await planAccess(user, plan), edit = canEditPlan(a);
    if (!edit) throw refusal(a, "edit", "plan");
    const r = await plans.duplicatePlan(plan, user, edit);
    if (!r) throw new Error("Plan not found");
    return r;
  });
  revalidatePath(`/cities/${made.cityId}`);
  return made.id;
}

export async function updatePlanInfo(id: string, input: { name: string; description?: string }) {
  const me = await assertUser();
  assertId(id);
  const title = clean(input.name);
  const cityId = await name(me.id, PlanId(id), async (user, plan) => {
    const a = await planAccess(user, plan), edit = canEditPlan(a);
    if (!edit) throw refusal(a, "edit", "plan");
    if (!title) throw new Error("Give the plan a name.");
    return plans.updatePlanInfo(plan, { name: title, description: clean(input.description, 500) }, edit);
  });
  if (cityId) revalidatePath(`/cities/${cityId}`);
  revalidatePath(`/plans/${id}`);
}

/** Deleting also drops the plan's history, so only the map's owner may do it. */
export async function deletePlan(id: string) {
  const me = await assertUser();
  assertId(id);
  const cityId = await name(me.id, PlanId(id), async (user, plan) => {
    const a = await planAccess(user, plan), own = canOwnPlan(a);
    if (!own) throw refusal(a, "own", "plan");
    return plans.deletePlan(plan, own);
  });
  if (cityId) revalidatePath(`/cities/${cityId}`);
}

/**
 * The plan as it is now, for an open page that heard it changed (see /api/plans/[planId]/live): its
 * revision, contents, and who saved it last (with that save's note).
 */
export async function fetchPlanState(id: string): Promise<{ revision: number; savedAt: string; network: Network; settings: PlanSettings; underlay: Underlay | null; sketch: Sketch | null; by: string | null; note: string } | null> {
  const me = await assertUser();
  assertId(id);
  return name(me.id, PlanId(id), async (user, plan) => {
    const view = await planAccess(user, plan);
    return view ? plans.planState(plan, view) : null;
  });
}

/**
 * Saves the open plan if nobody else saved in between (optimistic concurrency on `revision`), and records it in
 * the history. With `keepBuildings` the client left the (unchanged) buildings out of `network`, and the ones
 * already stored are kept, so large imported plans save quickly.
 */
export async function savePlan(id: string, input: { network: unknown; keepBuildings?: boolean; settings: unknown; underlay?: unknown; sketch?: unknown; revision: number; force?: boolean }): Promise<plans.SaveResult> {
  const me = await assertUser();
  assertId(id);
  return name(me.id, PlanId(id), async (user, plan) => {
    const edit = canEditPlan(await planAccess(user, plan));
    if (!edit) return { ok: false, reason: "forbidden" } as const;
    return plans.savePlan(plan, user, input, edit);
  });
}

// ---------------------------------------------------------------- history / rollback
export async function listPlanVersions(planId: string): Promise<plans.VersionRow[]> {
  const me = await assertUser();
  assertId(planId);
  return name(me.id, PlanId(planId), async (user, plan) => {
    const view = await planAccess(user, plan);
    if (!view) throw refusal(view, "edit", "plan");
    return plans.listPlanVersions(plan, view);
  });
}

/** Puts a saved version back as the plan's current state (itself recorded, so a restore can be undone). */
export async function restorePlanVersion(planId: string, versionId: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
  const me = await assertUser();
  assertId(planId); assertId(versionId);
  const res = await name(me.id, PlanId(planId), VersionId(versionId), async (user, plan, version) => {
    const a = await planAccess(user, plan), edit = canEditPlan(a);
    if (!edit) throw refusal(a, "edit", "plan");
    const ofPlan = await versionOfPlan(version, plan);
    if (!ofPlan) return { ok: false as const, error: "That version no longer exists." };
    const revision = await plans.restorePlanVersion(plan, version, user, { edit, version: ofPlan });
    return revision == null ? { ok: false as const, error: "Plan not found." } : { ok: true as const, revision };
  });
  if (res.ok) revalidatePath(`/plans/${planId}`);
  return res;
}

/**
 * A V2 plan's sketch from a file (History's "Restore from file…" / "Apply changes from file…"), saved as one new
 * revision through the normal save path, with the note, if nobody saved since `revision` (the one the user
 * compared it with).
 */
export async function restorePlanFromFile(planId: string, input: RestoreFileInput): Promise<RestoreFileResult> {
  const me = await assertUser();
  assertId(planId);
  const res = await name(me.id, PlanId(planId), async (user, plan) => {
    const edit = canEditPlan(await planAccess(user, plan));
    // (a patch's own note and kind are only for applying agent patches, below: never from the page's input)
    return restoreFromFile({ ...input, patch: undefined }, fileDeps(user, plan, edit));
  });
  if (res.ok) revalidatePath(`/plans/${planId}`);
  return res;
}

/** the plan as a file action reads and saves it, for one who may edit it (else refused) */
function fileDeps<U, P>(user: Parameters<typeof plans.savePlan<U, P>>[1], plan: Parameters<typeof plans.savePlan<U, P>>[0], edit: Parameters<typeof plans.savePlan<U, P>>[3] | null | undefined | false): RestoreFileDeps {
  return {
    canEdit: !!edit,
    current: async () => {
      const row = edit && (await plans.getPlan(plan, edit));
      return row ? { engine: row.plan.engine, network: row.plan.network, settings: row.plan.settings, underlay: row.plan.underlay, sketch: row.plan.sketch } : null;
    },
    save: async s => (edit ? plans.savePlan(plan, user, s, edit) : { ok: false, reason: "forbidden" }),
  };
}

// ---------------------------------------------------------------- agent patches (T132)

/** The plan's agent patches, for anyone who can see the plan (none for others). */
export async function listAgentPatches(planId: string): Promise<agentPatches.AgentPatchView[]> {
  const me = await assertUser();
  assertId(planId);
  return name(me.id, PlanId(planId), async (user, plan) => {
    const view = await planAccess(user, plan);
    return view ? agentPatches.listAgentPatches(plan, view) : [];
  });
}

/**
 * Applies a pending agent patch, by one who may edit the plan, from the revision its preview was made against:
 * the same path as "Apply changes from file", one new version noted "Agent patch #n (T56, Bob): title".
 */
export async function applyAgentPatch(planId: string, id: number, revision: number): Promise<RestoreFileResult> {
  const me = await assertUser();
  assertId(planId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown patch." };
  const res = await name(me.id, PlanId(planId), async (user, plan) => {
    const edit = canEditPlan(await planAccess(user, plan));
    if (!edit) return refuse("You can't change this plan.");
    const pt = await agentPatches.pendingPatch(plan, id, edit);
    if (!pt) return refuse("That patch was already decided, or isn't this plan's.");
    const r = await restoreFromFile({ mode: "apply", file: pt.patch, revision, patch: { note: patchNote(pt) } }, fileDeps(user, plan, edit));
    if (r.ok) await agentPatches.decideAgentPatch(plan, user, id, { status: "applied", revision: r.revision }, edit);
    return r;
  });
  if (res.ok) revalidatePath(`/plans/${planId}`);
  return res;
}

const refuse = (error: string): RestoreFileResult => ({ ok: false, error });

/** Rejects a pending agent patch (with an optional note), by one who may edit the plan. */
export async function rejectAgentPatch(planId: string, id: number, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await assertUser();
  assertId(planId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "Unknown patch." };
  return name(me.id, PlanId(planId), async (user, plan) => {
    const edit = canEditPlan(await planAccess(user, plan));
    if (!edit) return { ok: false, error: "You can't change this plan." };
    const done = await agentPatches.decideAgentPatch(plan, user, id, { status: "rejected", note: typeof note === "string" ? note.replace(/\s+/g, " ").trim().slice(0, 500) : "" }, edit);
    return done ? { ok: true } : { ok: false, error: "That patch was already decided, or isn't this plan's." };
  });
}

// ---------------------------------------------------------------- the signed-in user's own preferences

/** save the signed-in user's helicopter keys (with their account) */
export async function saveHeliKeys(input: unknown): Promise<{ ok: true; keys: HeliKeys } | { ok: false; error: string }> {
  const me = await assertUser();
  const keys = sanitizeHeliKeys(input);
  try {
    await users.saveHeliKeys(me.id, keys);
    return { ok: true, keys };
  } catch {
    return { ok: false, error: "Couldn't save the keys (has the database been updated? npm run db:migrate)." };
  }
}

/** save whether the signed-in user has war mode on (with their account) */
export async function saveWarMode(on: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await assertUser();
  try {
    await users.saveWarMode(me.id, on === true);
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save war mode (has the database been updated? npm run db:migrate)." };
  }
}

// ---------------------------------------------------------------- the junction library (the signed-in user's own)

export type LibraryItem = { id: string; name: string; piece: JunctionPiece; createdAt: string };
const MAX_PIECE_BYTES = 2_000_000;

/** the junctions the signed-in user saved, newest first */
export async function listJunctionLibrary(): Promise<{ ok: true; items: LibraryItem[] } | { ok: false; error: string }> {
  const me = await assertUser();
  try {
    const rows = await templates.listTemplates(me.id);
    const items = rows.flatMap(r => { const piece = readPiece(r.piece); return piece ? [{ id: r.id, name: r.name, piece, createdAt: r.createdAt.toISOString() }] : []; });
    return { ok: true, items };
  } catch {
    return { ok: false, error: "Couldn't load the junction library (has the database been updated? npm run db:migrate)." };
  }
}

/** save a junction to the signed-in user's library */
export async function saveToJunctionLibrary(nameIn: unknown, pieceIn: unknown): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const me = await assertUser();
  const piece = readPiece(pieceIn);
  if (!piece) return { ok: false, error: "That isn't a junction." };
  const name = (typeof nameIn === "string" ? nameIn.trim() : "").slice(0, 80) || piece.name || "Junction";
  // (stored as checked, without anything a plan doesn't take)
  const clean = { ...piece, name, net: sanitizeNetwork(piece.net) };
  if (JSON.stringify(clean).length > MAX_PIECE_BYTES) return { ok: false, error: "That junction is too big for the library." };
  try {
    if ((await templates.countTemplates(me.id)) >= templates.MAX_TEMPLATES) return { ok: false, error: `The library is full (${templates.MAX_TEMPLATES} junctions): delete some first.` };
    return { ok: true, id: await templates.addTemplate(me.id, name, clean) };
  } catch {
    return { ok: false, error: "Couldn't save to the junction library (has the database been updated? npm run db:migrate)." };
  }
}

export async function deleteFromJunctionLibrary(id: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await assertUser();
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return { ok: false, error: "Not found." };
  try { await templates.deleteTemplate(me.id, id); return { ok: true }; }
  catch { return { ok: false, error: "Couldn't delete it from the junction library." }; }
}
