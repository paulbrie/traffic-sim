"use server";

import { and, eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db, schema } from "@/db";
import { sampleTown } from "@/engine/sample";
import { DEFAULT_SETTINGS, emptyNetwork } from "@/engine/types";
import { sanitizeNetwork, sanitizeSettings } from "@/engine/validate";
import { sanitizeUnderlay } from "@/lib/underlay";
import { assertUser } from "./auth";

// Every action checks for a signed-in user (see src/server/auth.ts).

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (s: unknown, max = 120) => (typeof s === "string" ? s.trim().slice(0, max) : "");
function assertId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("Invalid id");
}

export async function createCity(input: { name: string; description?: string }) {
  await assertUser();
  const name = clean(input.name);
  if (!name) throw new Error("Give the city a name.");
  const [city] = await db.insert(schema.cities).values({ name, description: clean(input.description, 500) }).returning({ id: schema.cities.id });
  revalidatePath("/");
  return city.id;
}

export async function updateCity(id: string, input: { name: string; description?: string }) {
  await assertUser();
  assertId(id);
  const name = clean(input.name);
  if (!name) throw new Error("Give the city a name.");
  await db.update(schema.cities).set({ name, description: clean(input.description, 500), updatedAt: new Date() }).where(eq(schema.cities.id, id));
  revalidatePath("/");
  revalidatePath(`/cities/${id}`);
}

export async function deleteCity(id: string) {
  await assertUser();
  assertId(id);
  await db.delete(schema.cities).where(eq(schema.cities.id, id));
  revalidatePath("/");
}

export async function createPlan(input: { cityId: string; name: string; description?: string; template: "blank" | "sample" }) {
  await assertUser();
  assertId(input.cityId);
  const name = clean(input.name) || "Untitled plan";
  const network = input.template === "sample" ? sampleTown() : emptyNetwork();
  const [plan] = await db
    .insert(schema.plans)
    .values({ cityId: input.cityId, name, description: clean(input.description, 500), network, settings: DEFAULT_SETTINGS })
    .returning({ id: schema.plans.id });
  await db.update(schema.cities).set({ updatedAt: new Date() }).where(eq(schema.cities.id, input.cityId));
  revalidatePath(`/cities/${input.cityId}`);
  revalidatePath("/");
  return plan.id;
}

export async function duplicatePlan(id: string) {
  await assertUser();
  assertId(id);
  const [src] = await db.select().from(schema.plans).where(eq(schema.plans.id, id));
  if (!src) throw new Error("Plan not found");
  const [plan] = await db
    .insert(schema.plans)
    .values({ cityId: src.cityId, name: `${src.name} (copy)`.slice(0, 120), description: src.description, network: src.network, settings: src.settings, underlay: src.underlay })
    .returning({ id: schema.plans.id });
  // copy the reference image with the plan
  await db.execute(sql`insert into plan_images (plan_id, mime, data, bytes) select ${plan.id}, mime, data, bytes from plan_images where plan_id = ${id}`);
  revalidatePath(`/cities/${src.cityId}`);
  return plan.id;
}

export async function updatePlanInfo(id: string, input: { name: string; description?: string }) {
  await assertUser();
  assertId(id);
  const name = clean(input.name);
  if (!name) throw new Error("Give the plan a name.");
  const [row] = await db.update(schema.plans).set({ name, description: clean(input.description, 500), updatedAt: new Date() }).where(eq(schema.plans.id, id)).returning({ cityId: schema.plans.cityId });
  if (row) revalidatePath(`/cities/${row.cityId}`);
  revalidatePath(`/plans/${id}`);
}

export async function deletePlan(id: string) {
  await assertUser();
  assertId(id);
  const [row] = await db.delete(schema.plans).where(eq(schema.plans.id, id)).returning({ cityId: schema.plans.cityId });
  if (row) revalidatePath(`/cities/${row.cityId}`);
}

export type SaveResult = { ok: true; revision: number; savedAt: string } | { ok: false; reason: "conflict" | "missing"; revision?: number };

/** Saves the plan if nobody else saved in between (optimistic concurrency on `revision`). */
export async function savePlan(id: string, input: { network: unknown; settings: unknown; underlay?: unknown; revision: number; force?: boolean }): Promise<SaveResult> {
  await assertUser();
  assertId(id);
  const network = sanitizeNetwork(input.network);
  const settings = sanitizeSettings(input.settings);
  const underlay = sanitizeUnderlay(input.underlay);
  const now = new Date();
  const where = input.force ? eq(schema.plans.id, id) : and(eq(schema.plans.id, id), eq(schema.plans.revision, input.revision));
  const [row] = await db
    .update(schema.plans)
    .set({ network, settings, underlay, revision: sql`${schema.plans.revision} + 1`, updatedAt: now })
    .where(where)
    .returning({ revision: schema.plans.revision, cityId: schema.plans.cityId });
  if (row) {
    await db.update(schema.cities).set({ updatedAt: now }).where(eq(schema.cities.id, row.cityId));
    return { ok: true, revision: row.revision, savedAt: now.toISOString() };
  }
  const [cur] = await db.select({ revision: schema.plans.revision }).from(schema.plans).where(eq(schema.plans.id, id));
  return cur ? { ok: false, reason: "conflict", revision: cur.revision } : { ok: false, reason: "missing" };
}
