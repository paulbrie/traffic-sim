// TomTom's traffic recorded for a plan (ticket #261; scripts/traffic-collect.ts records it): how much there is, and the
// export to analyse, for anyone who can see the plan.
import "server-only";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import type { Named } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { PlanId } from "@/lib/ids";
import { historyExport, type HistoryExport } from "@/lib/traffic-history";
import type { CanViewPlan } from "../proofs/policy";

const t = schema.trafficSamples;

export interface TrafficHistoryInfo {
  /** samples kept, of them with data; the first and last (ISO), the last's error */
  samples: number; ok: number;
  first: string | null; last: string | null; lastError: string | null;
}

export async function trafficHistoryInfo<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>): Promise<TrafficHistoryInfo> {
  const [n] = await db.select({ samples: sql<number>`count(*)::int`, ok: sql<number>`count(*) filter (where ${t.error} is null)::int`, first: sql<Date | null>`min(${t.at})`, last: sql<Date | null>`max(${t.at})` })
    .from(t).where(eq(t.planId, plan.value));
  const [last] = n.samples ? await db.select({ error: t.error }).from(t).where(eq(t.planId, plan.value)).orderBy(desc(t.at)).limit(1) : [];
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return { samples: n.samples, ok: n.ok, first: iso(n.first), last: iso(n.last), lastError: last?.error ?? null };
}

/** the samples since `from` as an export (null: no such plan, or no sketch) */
export async function trafficHistoryExport<U, P>(plan: Named<P, PlanId>, from: Date | null, _proof: CanViewPlan<U, P>): Promise<HistoryExport | null> {
  const [p] = await db.select({ id: schema.plans.id, name: schema.plans.name, revision: schema.plans.revision, sketch: schema.plans.sketch }).from(schema.plans).where(eq(schema.plans.id, plan.value));
  if (!p?.sketch) return null;
  const rows = await db.select({ at: t.at, revision: t.revision, area: t.area, tiles: t.tiles, lanes: t.lanes, incidents: t.incidents, error: t.error })
    .from(t).where(and(eq(t.planId, plan.value), from ? gte(t.at, from) : undefined)).orderBy(asc(t.at));
  return historyExport(p, p.sketch, rows);
}

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
