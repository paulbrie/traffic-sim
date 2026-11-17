// (ticket #261) The samples of TomTom's traffic recorded for a plan, for the Live traffic panel's replay: listed, and one
// with its lines. Anyone who can see the plan.
import "server-only";
import { and, asc, eq } from "drizzle-orm";
import type { Named } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { PlanId } from "@/lib/ids";
import type { CanViewPlan } from "../proofs/policy";

const t = schema.trafficSamples;

/** a sample recorded, for the replay: its id, when, why it has no data (if so) */
export interface TrafficSampleInfo { id: string; at: string; error: string | null }

/** the plan's samples, oldest first */
export async function listTrafficSamples<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>): Promise<TrafficSampleInfo[]> {
  const rows = await db.select({ id: t.id, at: t.at, error: t.error }).from(t).where(eq(t.planId, plan.value)).orderBy(asc(t.at));
  return rows.map(r => ({ id: r.id, at: r.at.toISOString(), error: r.error }));
}

/** one sample's lines (gzipped JSON { speeds, ratios }), area and incidents; null: not the plan's, or no data */
export async function trafficSample<U, P>(plan: Named<P, PlanId>, id: string, _proof: CanViewPlan<U, P>) {
  const [r] = await db.select({ at: t.at, area: t.area, incidents: t.incidents, data: t.data }).from(t).where(and(eq(t.planId, plan.value), eq(t.id, id)));
  return r?.data ? { ...r, data: r.data } : null;
}
