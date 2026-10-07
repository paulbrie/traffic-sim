// Trusted: the only place that can prove what the signed-in user may do with a plan. A plan's access is its
// city's (see city-access.ts), decided by one query; the strongest proof that holds comes back (null: none,
// or no such plan: the two look the same).
import "server-only";
import { and, eq } from "drizzle-orm";
import { defineProof, type Named, type Proof } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { PlanId, ViewerId } from "@/lib/ids";

const UserOwnsPlan = defineProof("UserOwnsPlan");
const UserCanEditPlan = defineProof("UserCanEditPlan");
const UserCanViewPlan = defineProof("UserCanViewPlan");

/** U owns plan P's city, or is an admin: everything, deleting the plan (and its history) included */
export interface UserOwnsPlan<U, P> extends Proof<"UserOwnsPlan", [U, P]> {}
/** P's city is shared with U for editing: open, simulate, edit, save and restore P */
export interface UserCanEditPlan<U, P> extends Proof<"UserCanEditPlan", [U, P]> {}
/** P's city is shared with U to look at: open and simulate P, nothing saved */
export interface UserCanViewPlan<U, P> extends Proof<"UserCanViewPlan", [U, P]> {}

export type PlanAccess<U, P> = UserOwnsPlan<U, P> | UserCanEditPlan<U, P> | UserCanViewPlan<U, P>;

export async function planAccess<U, P>(user: Named<U, ViewerId>, plan: Named<P, PlanId>): Promise<PlanAccess<U, P> | null> {
  const [row] = await db
    .select({ ownerId: schema.cities.ownerId, share: schema.cityShares.access, role: schema.users.role })
    .from(schema.plans)
    .innerJoin(schema.cities, eq(schema.cities.id, schema.plans.cityId))
    .leftJoin(schema.cityShares, and(eq(schema.cityShares.cityId, schema.cities.id), eq(schema.cityShares.userId, user.value)))
    .leftJoin(schema.users, eq(schema.users.id, user.value))
    .where(eq(schema.plans.id, plan.value));
  if (!row) return null;
  if (row.role === "admin" || row.ownerId === user.value) return UserOwnsPlan.prove(user, plan);
  if (row.share === "write") return UserCanEditPlan.prove(user, plan);
  if (row.share === "read") return UserCanViewPlan.prove(user, plan);
  return null;
}
