"use server";

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { sampleTown } from "@/engine/sample";
import { DEFAULT_SETTINGS, emptyNetwork, type GeoRef, type Network, type PlanSettings } from "@/engine/types";
import { sanitizeNetwork, sanitizeSettings } from "@/engine/validate";
import { sanitizeUnderlay, type Underlay } from "@/lib/underlay";
import { bboxCenter, bboxProblem, bboxSize, ROAD_CLASSES, type BBox, type ImportOptions, type RoadClass } from "@/lib/osm/area";
import { convertOsm, suggestSettings, type ImportStats } from "@/lib/osm/convert";
import { fetchOsm, OsmError } from "./osm";
import { assertUser } from "./auth";
import { sanitizeHeliKeys, type HeliKeys } from "@/lib/heli-keys";
import { assertCity, assertPlan } from "./access";

// Every action checks for a signed-in user and their access to the map (src/server/access.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (s: unknown, max = 120) => (typeof s === "string" ? s.trim().slice(0, max) : "");
function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid id");
}

// ---------------------------------------------------------------- history
/** autosaves by the same person within this window update the newest version instead of adding one */
const SESSION_MS = 3 * 60_000;
/** versions kept per plan (the oldest are dropped) */
const KEEP_VERSIONS = 300;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
interface Snapshot { revision: number; network: Network; settings: PlanSettings; underlay: Underlay | null }

async function recordVersion(tx: Tx, planId: string, userId: string, snap: Snapshot, kind: "create" | "save" | "restore", note = "") {
  const now = new Date();
  if (kind === "save") {
    const [last] = await tx
      .select({ id: schema.planVersions.id, userId: schema.planVersions.userId, kind: schema.planVersions.kind, createdAt: schema.planVersions.createdAt })
      .from(schema.planVersions).where(eq(schema.planVersions.planId, planId)).orderBy(desc(schema.planVersions.createdAt)).limit(1);
    if (last && last.kind === "save" && last.userId === userId && now.getTime() - last.createdAt.getTime() < SESSION_MS) {
      await tx.update(schema.planVersions).set({ ...snap, updatedAt: now }).where(eq(schema.planVersions.id, last.id));
      return;
    }
  }
  await tx.insert(schema.planVersions).values({ planId, userId, kind, note, ...snap, createdAt: now, updatedAt: now });
  // keep the newest KEEP_VERSIONS
  const [cut] = await tx
    .select({ createdAt: schema.planVersions.createdAt })
    .from(schema.planVersions).where(eq(schema.planVersions.planId, planId)).orderBy(desc(schema.planVersions.createdAt)).offset(KEEP_VERSIONS).limit(1);
  if (cut) await tx.delete(schema.planVersions).where(and(eq(schema.planVersions.planId, planId), lt(schema.planVersions.createdAt, sql`${cut.createdAt}::timestamptz + interval '1 millisecond'`)));
}

// ---------------------------------------------------------------- cities (maps)
export async function createCity(input: { name: string; description?: string }) {
  const me = await assertUser();
  const name = clean(input.name);
  if (!name) throw new Error("Give the city a name.");
  const [city] = await db.insert(schema.cities).values({ ownerId: me.id, name, description: clean(input.description, 500) }).returning({ id: schema.cities.id });
  revalidatePath("/");
  return city.id;
}

export async function updateCity(id: string, input: { name: string; description?: string }) {
  const me = await assertUser();
  assertId(id);
  await assertCity(me, id, "owner");
  const name = clean(input.name);
  if (!name) throw new Error("Give the city a name.");
  await db.update(schema.cities).set({ name, description: clean(input.description, 500), updatedAt: new Date() }).where(eq(schema.cities.id, id));
  revalidatePath("/");
  revalidatePath(`/cities/${id}`);
}

export async function deleteCity(id: string) {
  const me = await assertUser();
  assertId(id);
  await assertCity(me, id, "owner");
  await db.delete(schema.cities).where(eq(schema.cities.id, id));
  revalidatePath("/");
}

/**
 * Copies a city with all its plans (and their reference images) into a new city owned by the
 * caller. Anyone who can view a city may copy it; sharing and history are not copied.
 */
export async function duplicateCity(id: string, input: { name?: string } = {}) {
  const me = await assertUser();
  assertId(id);
  await assertCity(me, id, "read");
  const [src] = await db.select().from(schema.cities).where(eq(schema.cities.id, id));
  if (!src) throw new Error("City not found");
  const name = clean(input.name) || `${src.name} (copy)`.slice(0, 120);
  const cityId = await db.transaction(async tx => {
    const [city] = await tx.insert(schema.cities).values({ ownerId: me.id, name, description: src.description }).returning({ id: schema.cities.id });
    const plans = await tx.select().from(schema.plans).where(eq(schema.plans.cityId, id)).orderBy(asc(schema.plans.createdAt));
    for (const p of plans) {
      const [copy] = await tx.insert(schema.plans)
        .values({ cityId: city.id, name: p.name, description: p.description, network: p.network, settings: p.settings, underlay: p.underlay })
        .returning();
      await tx.execute(sql`insert into plan_images (plan_id, mime, data, bytes) select ${copy.id}, mime, data, bytes from plan_images where plan_id = ${p.id}`);
      await recordVersion(tx, copy.id, me.id, { revision: copy.revision, network: copy.network, settings: copy.settings, underlay: copy.underlay }, "create", `Copied from “${src.name} / ${p.name}”`);
    }
    return city.id;
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
  if (target?.kind === "plan") { assertId(target.cityId); await assertCity(me, target.cityId, "write"); }
  else if (target?.kind !== "city") throw new Error("Invalid target");
  const name = clean(target.name);
  if (!name) return { ok: false, error: target.kind === "city" ? "Give the city a name." : "Give the plan a name." };
  const opts = osmOptions(input);
  if (typeof opts === "string") return { ok: false, error: opts };
  const res = await loadArea(opts, bboxCenter(opts.bbox));
  if (!res.ok) return res;
  const note = osmNote(opts);
  const ids = await db.transaction(async tx => {
    const cityId = target.kind === "plan" ? target.cityId
      : (await tx.insert(schema.cities).values({ ownerId: me.id, name, description: "Imported from OpenStreetMap" }).returning({ id: schema.cities.id }))[0].id;
    const [plan] = await tx.insert(schema.plans)
      .values({ cityId, name: target.kind === "plan" ? name : "Current layout", description: note.slice(0, 500), network: res.network, settings: suggestSettings(res.network) })
      .returning();
    await recordVersion(tx, plan.id, me.id, { revision: plan.revision, network: plan.network, settings: plan.settings, underlay: null }, "create", "Imported from OpenStreetMap");
    await tx.update(schema.cities).set({ updatedAt: new Date() }).where(eq(schema.cities.id, cityId));
    return { cityId, planId: plan.id };
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
export type ShareResult = { ok: true } | { ok: false; error: string };

/** Shares a map with an existing account, or changes the access it already has. Owners only. */
export async function shareCity(cityId: string, input: { email: string; access: "read" | "write" }): Promise<ShareResult> {
  const me = await assertUser();
  assertId(cityId);
  await assertCity(me, cityId, "owner");
  const email = clean(input.email, 200).toLowerCase();
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  const access = input.access === "write" ? "write" : "read";
  const [target] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!target) return { ok: false, error: `No account for ${email}. They can create a free one on the sign-in page, then you can share with them.` };
  const [city] = await db.select({ ownerId: schema.cities.ownerId }).from(schema.cities).where(eq(schema.cities.id, cityId));
  if (city?.ownerId === target.id) return { ok: false, error: "That's the owner of this map." };
  await db.insert(schema.cityShares).values({ cityId, userId: target.id, access })
    .onConflictDoUpdate({ target: [schema.cityShares.cityId, schema.cityShares.userId], set: { access } });
  revalidatePath(`/cities/${cityId}`);
  return { ok: true };
}

/** Owners remove anyone; anyone can remove themselves (leave a shared map). */
export async function unshareCity(cityId: string, userId: string): Promise<ShareResult> {
  const me = await assertUser();
  assertId(cityId); assertId(userId);
  if (userId !== me.id) await assertCity(me, cityId, "owner");
  await db.delete(schema.cityShares).where(and(eq(schema.cityShares.cityId, cityId), eq(schema.cityShares.userId, userId)));
  revalidatePath(`/cities/${cityId}`);
  revalidatePath("/");
  return { ok: true };
}

/** Removes a map someone shared with you from your list. */
export async function leaveCity(cityId: string): Promise<ShareResult> {
  const me = await assertUser();
  assertId(cityId);
  await db.delete(schema.cityShares).where(and(eq(schema.cityShares.cityId, cityId), eq(schema.cityShares.userId, me.id)));
  revalidatePath("/");
  return { ok: true };
}

export async function listShares(cityId: string) {
  const me = await assertUser();
  assertId(cityId);
  await assertCity(me, cityId, "read");
  return db
    .select({ userId: schema.users.id, email: schema.users.email, name: schema.users.name, access: schema.cityShares.access })
    .from(schema.cityShares)
    .innerJoin(schema.users, eq(schema.users.id, schema.cityShares.userId))
    .where(eq(schema.cityShares.cityId, cityId))
    .orderBy(asc(schema.users.email));
}

/** Admins: hand a map to another account (the previous owner keeps edit access). */
export async function transferCity(cityId: string, newOwnerId: string): Promise<ShareResult> {
  await assertUser("admin");
  assertId(cityId); assertId(newOwnerId);
  const [city] = await db.select({ ownerId: schema.cities.ownerId }).from(schema.cities).where(eq(schema.cities.id, cityId));
  if (!city) return { ok: false, error: "Map not found." };
  const [target] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, newOwnerId));
  if (!target) return { ok: false, error: "User not found." };
  await db.transaction(async tx => {
    await tx.update(schema.cities).set({ ownerId: newOwnerId }).where(eq(schema.cities.id, cityId));
    await tx.delete(schema.cityShares).where(and(eq(schema.cityShares.cityId, cityId), eq(schema.cityShares.userId, newOwnerId)));
    if (city.ownerId && city.ownerId !== newOwnerId) {
      await tx.insert(schema.cityShares).values({ cityId, userId: city.ownerId, access: "write" }).onConflictDoNothing();
    }
  });
  revalidatePath("/admin/maps");
  return { ok: true };
}

// ---------------------------------------------------------------- plans
export async function createPlan(input: { cityId: string; name: string; description?: string; template: "blank" | "sample" }) {
  const me = await assertUser();
  assertId(input.cityId);
  await assertCity(me, input.cityId, "write");
  const name = clean(input.name) || "Untitled plan";
  const network = input.template === "sample" ? sampleTown() : emptyNetwork();
  const id = await db.transaction(async tx => {
    const [plan] = await tx
      .insert(schema.plans)
      .values({ cityId: input.cityId, name, description: clean(input.description, 500), network, settings: DEFAULT_SETTINGS })
      .returning();
    await recordVersion(tx, plan.id, me.id, { revision: plan.revision, network: plan.network, settings: plan.settings, underlay: null }, "create", "Created");
    await tx.update(schema.cities).set({ updatedAt: new Date() }).where(eq(schema.cities.id, input.cityId));
    return plan.id;
  });
  revalidatePath(`/cities/${input.cityId}`);
  revalidatePath("/");
  return id;
}

/** Creates a plan next to an existing one from a network the editor produced (e.g. optimised signal timings). */
export async function createPlanFrom(sourceId: string, input: { name: string; description?: string; network: unknown; settings: unknown }) {
  const me = await assertUser();
  assertId(sourceId);
  const { cityId } = await assertPlan(me, sourceId, "write");
  const network = sanitizeNetwork(input.network), settings = sanitizeSettings(input.settings);
  const name = clean(input.name) || "Untitled plan";
  const id = await db.transaction(async tx => {
    const [plan] = await tx.insert(schema.plans).values({ cityId, name, description: clean(input.description, 500), network, settings }).returning();
    await recordVersion(tx, plan.id, me.id, { revision: plan.revision, network: plan.network, settings: plan.settings, underlay: null }, "create", clean(input.description, 200) || "Created");
    await tx.update(schema.cities).set({ updatedAt: new Date() }).where(eq(schema.cities.id, cityId));
    return plan.id;
  });
  revalidatePath(`/cities/${cityId}`);
  return id;
}

export async function duplicatePlan(id: string) {
  const me = await assertUser();
  assertId(id);
  await assertPlan(me, id, "write");
  const [src] = await db.select().from(schema.plans).where(eq(schema.plans.id, id));
  if (!src) throw new Error("Plan not found");
  const planId = await db.transaction(async tx => {
    const [plan] = await tx
      .insert(schema.plans)
      .values({ cityId: src.cityId, name: `${src.name} (copy)`.slice(0, 120), description: src.description, network: src.network, settings: src.settings, underlay: src.underlay })
      .returning();
    // copy the reference image with the plan
    await tx.execute(sql`insert into plan_images (plan_id, mime, data, bytes) select ${plan.id}, mime, data, bytes from plan_images where plan_id = ${id}`);
    await recordVersion(tx, plan.id, me.id, { revision: plan.revision, network: plan.network, settings: plan.settings, underlay: plan.underlay }, "create", `Copied from “${src.name}”`);
    return plan.id;
  });
  revalidatePath(`/cities/${src.cityId}`);
  return planId;
}

export async function updatePlanInfo(id: string, input: { name: string; description?: string }) {
  const me = await assertUser();
  assertId(id);
  await assertPlan(me, id, "write");
  const name = clean(input.name);
  if (!name) throw new Error("Give the plan a name.");
  const [row] = await db.update(schema.plans).set({ name, description: clean(input.description, 500), updatedAt: new Date() }).where(eq(schema.plans.id, id)).returning({ cityId: schema.plans.cityId });
  if (row) revalidatePath(`/cities/${row.cityId}`);
  revalidatePath(`/plans/${id}`);
}

/** Deleting also drops the plan's history, so only the map's owner may do it. */
export async function deletePlan(id: string) {
  const me = await assertUser();
  assertId(id);
  await assertPlan(me, id, "owner");
  const [row] = await db.delete(schema.plans).where(eq(schema.plans.id, id)).returning({ cityId: schema.plans.cityId });
  if (row) revalidatePath(`/cities/${row.cityId}`);
}

export type SaveResult = { ok: true; revision: number; savedAt: string } | { ok: false; reason: "conflict" | "missing" | "forbidden"; revision?: number };

/**
 * The plan as it is now, for an open page that heard it changed (see /api/plans/[planId]/live): its
 * revision, contents, and who saved it last (with that save's note).
 */
export async function fetchPlanState(id: string): Promise<{ revision: number; savedAt: string; network: Network; settings: PlanSettings; underlay: Underlay | null; by: string | null; note: string } | null> {
  const me = await assertUser();
  assertId(id);
  try { await assertPlan(me, id, "read"); } catch { return null; }
  const [p] = await db.select({ revision: schema.plans.revision, updatedAt: schema.plans.updatedAt, network: schema.plans.network, settings: schema.plans.settings, underlay: schema.plans.underlay }).from(schema.plans).where(eq(schema.plans.id, id));
  if (!p) return null;
  const [v] = await db.select({ note: schema.planVersions.note, name: schema.users.name, email: schema.users.email })
    .from(schema.planVersions).leftJoin(schema.users, eq(schema.users.id, schema.planVersions.userId))
    .where(eq(schema.planVersions.planId, id)).orderBy(desc(schema.planVersions.updatedAt)).limit(1);
  return {
    revision: p.revision, savedAt: p.updatedAt.toISOString(), network: sanitizeNetwork(p.network), settings: sanitizeSettings(p.settings), underlay: sanitizeUnderlay(p.underlay),
    by: v ? v.name || v.email || null : null, note: v?.note ?? "",
  };
}

/** Saves the plan if nobody else saved in between (optimistic concurrency on `revision`), and records it in the history. */
/**
 * Saves the open plan. With `keepBuildings` the client left the (unchanged) buildings out of
 * `network`, and the ones already stored are kept, so large imported plans save quickly.
 */
export async function savePlan(id: string, input: { network: unknown; keepBuildings?: boolean; settings: unknown; underlay?: unknown; revision: number; force?: boolean }): Promise<SaveResult> {
  const me = await assertUser();
  assertId(id);
  try { await assertPlan(me, id, "write"); } catch { return { ok: false, reason: "forbidden" }; }
  let raw = input.network;
  if (input.keepBuildings && raw && typeof raw === "object") {
    const [cur] = await db.select({ buildings: sql`${schema.plans.network}->'buildings'`.mapWith(schema.plans.network) }).from(schema.plans).where(eq(schema.plans.id, id));
    const kept = cur?.buildings as unknown as Network["buildings"] | null;
    // put them back before sanitising, so zone members that are buildings survive
    if (Array.isArray(kept) && kept.length) raw = { ...raw, buildings: kept };
  }
  const network = sanitizeNetwork(raw);
  const settings = sanitizeSettings(input.settings);
  const underlay = sanitizeUnderlay(input.underlay);
  const now = new Date();
  const where = input.force ? eq(schema.plans.id, id) : and(eq(schema.plans.id, id), eq(schema.plans.revision, input.revision));
  const row = await db.transaction(async tx => {
    const [r] = await tx
      .update(schema.plans)
      .set({ network, settings, underlay, revision: sql`${schema.plans.revision} + 1`, updatedAt: now })
      .where(where)
      .returning({ revision: schema.plans.revision, cityId: schema.plans.cityId });
    if (!r) return null;
    await recordVersion(tx, id, me.id, { revision: r.revision, network, settings, underlay }, "save");
    await tx.update(schema.cities).set({ updatedAt: now }).where(eq(schema.cities.id, r.cityId));
    return r;
  });
  if (row) return { ok: true, revision: row.revision, savedAt: now.toISOString() };
  const [cur] = await db.select({ revision: schema.plans.revision }).from(schema.plans).where(eq(schema.plans.id, id));
  return cur ? { ok: false, reason: "conflict", revision: cur.revision } : { ok: false, reason: "missing" };
}

// ---------------------------------------------------------------- history / rollback
export interface VersionRow {
  id: string; revision: number; kind: string; note: string; by: string | null;
  createdAt: string; updatedAt: string; roads: number; nodes: number; stops: number; lines: number;
}

export async function listPlanVersions(planId: string): Promise<VersionRow[]> {
  const me = await assertUser();
  assertId(planId);
  await assertPlan(me, planId, "read");
  const v = schema.planVersions;
  const rows = await db
    .select({
      id: v.id, revision: v.revision, kind: v.kind, note: v.note, createdAt: v.createdAt, updatedAt: v.updatedAt,
      byName: schema.users.name, byEmail: schema.users.email,
      roads: sql<number>`jsonb_array_length(${v.network}->'links')`,
      nodes: sql<number>`jsonb_array_length(${v.network}->'nodes')`,
      stops: sql<number>`jsonb_array_length(${v.network}->'stops')`,
      lines: sql<number>`jsonb_array_length(${v.network}->'lines')`,
    })
    .from(v)
    .leftJoin(schema.users, eq(schema.users.id, v.userId))
    .where(eq(v.planId, planId))
    .orderBy(desc(v.createdAt))
    .limit(KEEP_VERSIONS);
  return rows.map(r => ({
    id: r.id, revision: r.revision, kind: r.kind, note: r.note, by: r.byName || r.byEmail || null,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    roads: r.roads ?? 0, nodes: r.nodes ?? 0, stops: r.stops ?? 0, lines: r.lines ?? 0,
  }));
}

/** Puts a saved version back as the plan's current state (itself recorded, so a restore can be undone). */
export async function restorePlanVersion(planId: string, versionId: string): Promise<{ ok: true; revision: number } | { ok: false; error: string }> {
  const me = await assertUser();
  assertId(planId); assertId(versionId);
  await assertPlan(me, planId, "write");
  const [ver] = await db.select().from(schema.planVersions).where(and(eq(schema.planVersions.id, versionId), eq(schema.planVersions.planId, planId)));
  if (!ver) return { ok: false, error: "That version no longer exists." };
  const network = sanitizeNetwork(ver.network), settings = sanitizeSettings(ver.settings), underlay = sanitizeUnderlay(ver.underlay);
  const now = new Date();
  const when = ver.updatedAt.toISOString().slice(0, 16).replace("T", " ");
  const revision = await db.transaction(async tx => {
    const [r] = await tx.update(schema.plans)
      .set({ network, settings, underlay, revision: sql`${schema.plans.revision} + 1`, updatedAt: now })
      .where(eq(schema.plans.id, planId)).returning({ revision: schema.plans.revision, cityId: schema.plans.cityId });
    if (!r) return null;
    await recordVersion(tx, planId, me.id, { revision: r.revision, network, settings, underlay }, "restore", `Restored the version from ${when} UTC (revision ${ver.revision})`);
    await tx.update(schema.cities).set({ updatedAt: now }).where(eq(schema.cities.id, r.cityId));
    return r.revision;
  });
  if (revision == null) return { ok: false, error: "Plan not found." };
  revalidatePath(`/plans/${planId}`);
  return { ok: true, revision };
}

/** save the signed-in user's helicopter keys (with their account) */
export async function saveHeliKeys(input: unknown): Promise<{ ok: true; keys: HeliKeys } | { ok: false; error: string }> {
  const user = await assertUser();
  const keys = sanitizeHeliKeys(input);
  try {
    await db.insert(schema.userPrefs).values({ userId: user.id, heliKeys: keys, updatedAt: new Date() })
      .onConflictDoUpdate({ target: schema.userPrefs.userId, set: { heliKeys: keys, updatedAt: new Date() } });
    return { ok: true, keys };
  } catch {
    return { ok: false, error: "Couldn't save the keys (has the database been updated? npm run db:migrate)." };
  }
}

/** save whether the signed-in user has war mode on (with their account) */
export async function saveWarMode(on: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await assertUser();
  const warMode = on === true;
  try {
    await db.insert(schema.userPrefs).values({ userId: user.id, warMode, updatedAt: new Date() })
      .onConflictDoUpdate({ target: schema.userPrefs.userId, set: { warMode, updatedAt: new Date() } });
    return { ok: true };
  } catch {
    return { ok: false, error: "Couldn't save war mode (has the database been updated? npm run db:migrate)." };
  }
}
