// Plans, their history and their reference images. Every function that reads or changes a plan takes a proof
// about that plan (or, to add one, about its city) — src/server/proofs — and one that records who acted (a
// version's author) takes that user, named, so the proof must be about them.
import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Named } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { PlanEngine } from "@/db/schema";
import { DEFAULT_SETTINGS, emptyNetwork, type Network, type PlanSettings } from "@/engine/types";
import { sanitizeNetwork, sanitizeSettings } from "@/engine/validate";
import { sanitizeUnderlay } from "@/lib/underlay";
import { sanitizeSketch, type Sketch } from "@/lib/lane-sketch";
import type { CityId, PlanId, VersionId, ViewerId } from "@/lib/ids";
import type { CanEditCity, CanEditPlan, CanOwnPlan, CanViewPlan } from "../proofs/policy";
import type { VersionOfPlan } from "../proofs/version-of-plan";
import { KEEP_VERSIONS, recordVersion } from "./history";

/** The plan with its city's name, for the editor. */
export async function getPlan<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>) {
  const [row] = await db
    .select({ plan: schema.plans, cityName: schema.cities.name })
    .from(schema.plans)
    .innerJoin(schema.cities, eq(schema.plans.cityId, schema.cities.id))
    .where(eq(schema.plans.id, plan.value));
  return row ?? null;
}

/** A new plan in a city, its first version by `author`. */
export async function createPlan<U, C>(
  city: Named<C, CityId>, author: Named<U, ViewerId>,
  input: { name: string; description: string; network: Network; settings?: PlanSettings; note: string; engine?: PlanEngine },
  _proof: CanEditCity<U, C>,
): Promise<string> {
  return db.transaction(async tx => {
    const [plan] = await tx
      .insert(schema.plans)
      .values({ cityId: city.value, name: input.name, description: input.description, network: input.network, settings: input.settings ?? DEFAULT_SETTINGS, engine: input.engine ?? "v1" })
      .returning();
    await recordVersion(tx, plan.id, author.value, { revision: plan.revision, network: plan.network, settings: plan.settings, underlay: null, sketch: null }, "create", input.note);
    await tx.update(schema.cities).set({ updatedAt: new Date() }).where(eq(schema.cities.id, city.value));
    return plan.id;
  });
}

/** A new city owned by the signed-in user, with one plan in it (an import). */
export async function createCityWithPlan(owner: ViewerId, city: { name: string; description: string }, plan: { name: string; description: string; network: Network; settings: PlanSettings; note: string }) {
  return db.transaction(async tx => {
    const [c] = await tx.insert(schema.cities).values({ ownerId: owner, name: city.name, description: city.description }).returning({ id: schema.cities.id });
    const [p] = await tx.insert(schema.plans).values({ cityId: c.id, name: plan.name, description: plan.description, network: plan.network, settings: plan.settings }).returning();
    await recordVersion(tx, p.id, owner, { revision: p.revision, network: p.network, settings: p.settings, underlay: null, sketch: null }, "create", plan.note);
    return { cityId: c.id, planId: p.id };
  });
}

/** A new plan next to `source` (in its city) from a network the editor produced. Its id and city. */
export async function createPlanNextTo<U, P>(
  source: Named<P, PlanId>, author: Named<U, ViewerId>,
  input: { name: string; description: string; network: Network; settings: PlanSettings; note: string },
  _proof: CanEditPlan<U, P>,
): Promise<{ id: string; cityId: string } | null> {
  const [src] = await db.select({ cityId: schema.plans.cityId }).from(schema.plans).where(eq(schema.plans.id, source.value));
  if (!src) return null;
  const id = await db.transaction(async tx => {
    const [plan] = await tx.insert(schema.plans).values({ cityId: src.cityId, name: input.name, description: input.description, network: input.network, settings: input.settings }).returning();
    await recordVersion(tx, plan.id, author.value, { revision: plan.revision, network: plan.network, settings: plan.settings, underlay: null, sketch: null }, "create", input.note);
    await tx.update(schema.cities).set({ updatedAt: new Date() }).where(eq(schema.cities.id, src.cityId));
    return plan.id;
  });
  return { id, cityId: src.cityId };
}

/** A copy of the plan (and its reference image) in the same city. Its id and city. */
export async function duplicatePlan<U, P>(plan: Named<P, PlanId>, author: Named<U, ViewerId>, _proof: CanEditPlan<U, P>): Promise<{ id: string; cityId: string } | null> {
  const [src] = await db.select().from(schema.plans).where(eq(schema.plans.id, plan.value));
  if (!src) return null;
  const id = await db.transaction(async tx => {
    const [copy] = await tx
      .insert(schema.plans)
      .values({ cityId: src.cityId, name: `${src.name} (copy)`.slice(0, 120), description: src.description, network: src.network, settings: src.settings, underlay: src.underlay, sketch: src.sketch, engine: src.engine })
      .returning();
    await tx.execute(sql`insert into plan_images (plan_id, mime, data, bytes) select ${copy.id}, mime, data, bytes from plan_images where plan_id = ${plan.value}`);
    await recordVersion(tx, copy.id, author.value, { revision: copy.revision, network: copy.network, settings: copy.settings, underlay: copy.underlay, sketch: copy.sketch }, "create", `Copied from “${src.name}”`);
    return copy.id;
  });
  return { id, cityId: src.cityId };
}

/**
 * A V2 plan made from a V1 one (its network converted to a lane sketch by the caller), next to it in its
 * city, with its settings, its reference image and placement. The V1 plan is left as it is. Its id and city.
 */
export async function createV2From<U, P>(
  plan: Named<P, PlanId>, author: Named<U, ViewerId>, input: { sketch: Sketch; note: string },
  _proof: CanEditPlan<U, P>,
): Promise<{ id: string; cityId: string } | null> {
  const [src] = await db.select().from(schema.plans).where(eq(schema.plans.id, plan.value));
  if (!src) return null;
  const id = await db.transaction(async tx => {
    const [copy] = await tx
      .insert(schema.plans)
      .values({ cityId: src.cityId, name: `${src.name} (V2)`.slice(0, 120), description: src.description, network: emptyNetwork(), settings: src.settings, underlay: src.underlay, sketch: input.sketch, engine: "v2" })
      .returning();
    await tx.execute(sql`insert into plan_images (plan_id, mime, data, bytes) select ${copy.id}, mime, data, bytes from plan_images where plan_id = ${plan.value}`);
    await recordVersion(tx, copy.id, author.value, { revision: copy.revision, network: copy.network, settings: copy.settings, underlay: copy.underlay, sketch: copy.sketch }, "create", input.note);
    await tx.update(schema.cities).set({ updatedAt: new Date() }).where(eq(schema.cities.id, src.cityId));
    return copy.id;
  });
  return { id, cityId: src.cityId };
}

/** Renames the plan; its city, if it's there. */
export async function updatePlanInfo<U, P>(plan: Named<P, PlanId>, input: { name: string; description: string }, _proof: CanEditPlan<U, P>): Promise<string | null> {
  const [row] = await db.update(schema.plans).set({ name: input.name, description: input.description, updatedAt: new Date() }).where(eq(schema.plans.id, plan.value)).returning({ cityId: schema.plans.cityId });
  return row?.cityId ?? null;
}

/** Deletes the plan with its history (so it takes the map's owner); its city, if it was there. */
export async function deletePlan<U, P>(plan: Named<P, PlanId>, _proof: CanOwnPlan<U, P>): Promise<string | null> {
  const [row] = await db.delete(schema.plans).where(eq(schema.plans.id, plan.value)).returning({ cityId: schema.plans.cityId });
  return row?.cityId ?? null;
}

/** The plan's revision now (null: gone), for the live updates of an open plan. */
export async function planRevision<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>): Promise<number | null> {
  const [row] = await db.select({ revision: schema.plans.revision }).from(schema.plans).where(eq(schema.plans.id, plan.value));
  return row ? row.revision : null;
}

/** The plan as it is now, and who saved it last (with that save's note). */
export async function planState<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>) {
  const [p] = await db.select({ revision: schema.plans.revision, updatedAt: schema.plans.updatedAt, network: schema.plans.network, settings: schema.plans.settings, underlay: schema.plans.underlay, sketch: schema.plans.sketch }).from(schema.plans).where(eq(schema.plans.id, plan.value));
  if (!p) return null;
  const [v] = await db.select({ note: schema.planVersions.note, name: schema.users.name, email: schema.users.email })
    .from(schema.planVersions).leftJoin(schema.users, eq(schema.users.id, schema.planVersions.userId))
    .where(eq(schema.planVersions.planId, plan.value)).orderBy(desc(schema.planVersions.updatedAt)).limit(1);
  return {
    revision: p.revision, savedAt: p.updatedAt.toISOString(), network: sanitizeNetwork(p.network), settings: sanitizeSettings(p.settings), underlay: sanitizeUnderlay(p.underlay), sketch: sanitizeSketch(p.sketch),
    by: v ? v.name || v.email || null : null, note: v?.note ?? "",
  };
}

export type SaveResult = { ok: true; revision: number; savedAt: string } | { ok: false; reason: "conflict" | "missing" | "forbidden"; revision?: number };

/**
 * Saves the plan if nobody else saved in between (optimistic concurrency on `revision`, unless `force`), and
 * records it in the history as `author`'s. With `keepBuildings` the client left the (unchanged) buildings out
 * of `network`, and the ones already stored are kept, so large imported plans save quickly. With `restore` it is
 * a restore or an apply from a file (`kind`): its own version in the history, with that note, never grouped
 * with the autosaves.
 */
export async function savePlan<U, P>(
  plan: Named<P, PlanId>, author: Named<U, ViewerId>,
  input: { network: unknown; keepBuildings?: boolean; settings: unknown; underlay?: unknown; sketch?: unknown; revision: number; force?: boolean; restore?: { note: string; kind?: "restore" | "apply" } },
  _proof: CanEditPlan<U, P>,
): Promise<SaveResult> {
  const id = plan.value;
  let raw = input.network;
  if (input.keepBuildings && raw && typeof raw === "object") {
    const [cur] = await db.select({ buildings: sql`${schema.plans.network}->'buildings'`.mapWith(schema.plans.network) }).from(schema.plans).where(eq(schema.plans.id, id));
    // (sanitizeNetwork checks them over with the rest)
    const kept: unknown = cur?.buildings;
    // put them back before sanitising, so zone members that are buildings survive
    if (Array.isArray(kept) && kept.length) raw = { ...raw, buildings: kept };
  }
  const network = sanitizeNetwork(raw), settings = sanitizeSettings(input.settings), underlay = sanitizeUnderlay(input.underlay), sketch = sanitizeSketch(input.sketch);
  const now = new Date();
  const where = input.force ? eq(schema.plans.id, id) : and(eq(schema.plans.id, id), eq(schema.plans.revision, input.revision));
  const row = await db.transaction(async tx => {
    const [r] = await tx
      .update(schema.plans)
      .set({ network, settings, underlay, sketch, revision: sql`${schema.plans.revision} + 1`, updatedAt: now })
      .where(where)
      .returning({ revision: schema.plans.revision, cityId: schema.plans.cityId });
    if (!r) return null;
    if (input.restore) await recordVersion(tx, id, author.value, { revision: r.revision, network, settings, underlay, sketch }, input.restore.kind ?? "restore", input.restore.note);
    else await recordVersion(tx, id, author.value, { revision: r.revision, network, settings, underlay, sketch }, "save");
    await tx.update(schema.cities).set({ updatedAt: now }).where(eq(schema.cities.id, r.cityId));
    return r;
  });
  if (row) return { ok: true, revision: row.revision, savedAt: now.toISOString() };
  const [cur] = await db.select({ revision: schema.plans.revision }).from(schema.plans).where(eq(schema.plans.id, id));
  return cur ? { ok: false, reason: "conflict", revision: cur.revision } : { ok: false, reason: "missing" };
}

export interface VersionRow {
  id: string; revision: number; kind: string; note: string; by: string | null;
  createdAt: string; updatedAt: string; roads: number; nodes: number; stops: number; lines: number;
}

export async function listPlanVersions<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>): Promise<VersionRow[]> {
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
    .where(eq(v.planId, plan.value))
    .orderBy(desc(v.createdAt))
    .limit(KEEP_VERSIONS);
  return rows.map(r => ({
    id: r.id, revision: r.revision, kind: r.kind, note: r.note, by: r.byName || r.byEmail || null,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    roads: r.roads ?? 0, nodes: r.nodes ?? 0, stops: r.stops ?? 0, lines: r.lines ?? 0,
  }));
}

/**
 * Puts a saved version — one of this plan's — back as the plan's current state, itself recorded as `author`'s
 * (so a restore can be undone). The new revision, or null if the plan is gone.
 */
export async function restorePlanVersion<U, P, V>(
  plan: Named<P, PlanId>, version: Named<V, VersionId>, author: Named<U, ViewerId>,
  _proofs: { edit: CanEditPlan<U, P>; version: VersionOfPlan<V, P> },
): Promise<number | null> {
  const [ver] = await db.select().from(schema.planVersions).where(eq(schema.planVersions.id, version.value));
  if (!ver) return null;
  const network = sanitizeNetwork(ver.network), settings = sanitizeSettings(ver.settings), underlay = sanitizeUnderlay(ver.underlay), sketch = sanitizeSketch(ver.sketch);
  const now = new Date(), when = ver.updatedAt.toISOString().slice(0, 16).replace("T", " ");
  return db.transaction(async tx => {
    const [r] = await tx.update(schema.plans)
      .set({ network, settings, underlay, sketch, revision: sql`${schema.plans.revision} + 1`, updatedAt: now })
      .where(eq(schema.plans.id, plan.value)).returning({ revision: schema.plans.revision, cityId: schema.plans.cityId });
    if (!r) return null;
    await recordVersion(tx, plan.value, author.value, { revision: r.revision, network, settings, underlay, sketch }, "restore", `Restored the version from ${when} UTC (revision ${ver.revision})`);
    await tx.update(schema.cities).set({ updatedAt: now }).where(eq(schema.cities.id, r.cityId));
    return r.revision;
  });
}

// ---------------------------------------------------------------- reference images

export async function getPlanImage<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>) {
  const [row] = await db.select({ mime: schema.planImages.mime, data: schema.planImages.data }).from(schema.planImages).where(eq(schema.planImages.planId, plan.value));
  return row ?? null;
}

/** Stores the plan's reference image (false: the plan is gone). */
export async function putPlanImage<U, P>(plan: Named<P, PlanId>, image: { mime: string; data: Buffer; bytes: number; at: Date }, _proof: CanEditPlan<U, P>): Promise<boolean> {
  const [row] = await db.select({ id: schema.plans.id }).from(schema.plans).where(eq(schema.plans.id, plan.value));
  if (!row) return false;
  await db
    .insert(schema.planImages)
    .values({ planId: plan.value, mime: image.mime, data: image.data, bytes: image.bytes, updatedAt: image.at })
    .onConflictDoUpdate({ target: schema.planImages.planId, set: { mime: image.mime, data: image.data, bytes: image.bytes, updatedAt: image.at } });
  return true;
}

export async function deletePlanImage<U, P>(plan: Named<P, PlanId>, _proof: CanEditPlan<U, P>) {
  await db.delete(schema.planImages).where(eq(schema.planImages.planId, plan.value));
}

