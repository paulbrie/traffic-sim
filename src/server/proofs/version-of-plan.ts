// Trusted: the only place that can prove a saved version belongs to a plan. The version's id comes from the
// client; without this, a version of a plan the user can't see could be restored into one they can edit.
import "server-only";
import { and, eq } from "drizzle-orm";
import { defineProof, type Named, type Proof } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { PlanId, VersionId } from "@/lib/ids";

const VersionOfPlan = defineProof("VersionOfPlan");
/** version V is in plan P's history */
export interface VersionOfPlan<V, P> extends Proof<"VersionOfPlan", [V, P]> {}

export async function versionOfPlan<V, P>(version: Named<V, VersionId>, plan: Named<P, PlanId>): Promise<VersionOfPlan<V, P> | null> {
  const [row] = await db
    .select({ id: schema.planVersions.id })
    .from(schema.planVersions)
    .where(and(eq(schema.planVersions.id, version.value), eq(schema.planVersions.planId, plan.value)));
  return row ? VersionOfPlan.prove(version, plan) : null;
}
