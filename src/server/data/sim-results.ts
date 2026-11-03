// A plan's saved run results (ticket #124): listed and read by anyone who can see the plan, saved and deleted by one who
// may edit it. Kept apart from the plan, so its saves and versions stay small.
import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Named } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { PlanId, ViewerId } from "@/lib/ids";
import { MAX_RESULTS, type SimResult, type SimResultData, type SimResultInfo, type SimResultMeta } from "@/lib/sim-results";

import type { CanEditPlan, CanViewPlan } from "../proofs/policy";

const r = schema.simResults;
const info = (x: Omit<typeof r.$inferSelect, "meta" | "data"> & { byName: string | null; byEmail: string | null }): SimResultInfo => ({
  id: x.id, name: x.name, createdAt: x.createdAt.toISOString(), by: x.byName || x.byEmail || "", sketch: x.sketchName, seconds: x.seconds, series: x.series, bytes: x.bytes,
});
const cols = { id: r.id, planId: r.planId, userId: r.userId, name: r.name, sketchId: r.sketchId, sketchName: r.sketchName, seconds: r.seconds, series: r.series, bytes: r.bytes, createdAt: r.createdAt };

/** the plan's results, newest first (what each is, not its data) */
export async function listSimResults<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>): Promise<SimResultInfo[]> {
  const rows = await db.select({ ...cols, byName: schema.users.name, byEmail: schema.users.email }).from(r)
    .leftJoin(schema.users, eq(schema.users.id, r.userId)).where(eq(r.planId, plan.value)).orderBy(desc(r.createdAt));
  return rows.map(x => info(x));
}

/** some of the plan's results, with their data (those not the plan's left out) */
export async function getSimResults<U, P>(plan: Named<P, PlanId>, ids: string[], _proof: CanViewPlan<U, P>): Promise<SimResult[]> {
  if (!ids.length) return [];
  const rows = await db.select({ x: r, byName: schema.users.name, byEmail: schema.users.email }).from(r)
    .leftJoin(schema.users, eq(schema.users.id, r.userId)).where(and(eq(r.planId, plan.value), inArray(r.id, ids)));
  const byId = new Map(rows.map(y => [y.x.id, { ...info({ ...y.x, byName: y.byName, byEmail: y.byEmail }), meta: y.x.meta, data: y.x.data }]));
  return ids.flatMap(id => byId.get(id) ?? []);
}

/** a result saved by `user`; null: the plan keeps MAX_RESULTS already */
export async function saveSimResult<U, P>(
  plan: Named<P, PlanId>, user: Named<U, ViewerId>,
  x: { name: string; sketchId: string; sketchName: string; seconds: number; series: boolean; bytes: number; meta: SimResultMeta; data: SimResultData },
  _proof: CanEditPlan<U, P>,
): Promise<string | null> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(r).where(eq(r.planId, plan.value));
  if (n >= MAX_RESULTS) return null;
  const [row] = await db.insert(r).values({ planId: plan.value, userId: user.value, ...x }).returning({ id: r.id });
  return row.id;
}

/** a result of the plan deleted; false if there was none */
export async function deleteSimResult<U, P>(plan: Named<P, PlanId>, id: string, _proof: CanEditPlan<U, P>): Promise<boolean> {
  const done = await db.delete(r).where(and(eq(r.id, id), eq(r.planId, plan.value))).returning({ id: r.id });
  return done.length > 0;
}

/** a result of the plan renamed (ticket #125); false if there was none */
export async function renameSimResult<U, P>(plan: Named<P, PlanId>, id: string, name: string, _proof: CanEditPlan<U, P>): Promise<boolean> {
  const done = await db.update(r).set({ name }).where(and(eq(r.id, id), eq(r.planId, plan.value))).returning({ id: r.id });
  return done.length > 0;
}
