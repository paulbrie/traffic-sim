import "server-only";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { CurrentUser } from "./auth";

/**
 * What a user may do with a city (map) and its plans:
 *   owner - everything, including sharing, renaming and deleting the map (admins get this on every map)
 *   write - open, simulate, edit and restore plans, add / rename / duplicate plans
 *   read  - open and simulate; nothing is saved
 */
export type Access = "owner" | "write" | "read";

const RANK: Record<Access, number> = { read: 1, write: 2, owner: 3 };
export const allows = (have: Access | null | undefined, need: Access) => !!have && RANK[have] >= RANK[need];

export async function cityAccess(user: CurrentUser, cityId: string): Promise<Access | null> {
  const [row] = await db
    .select({ ownerId: schema.cities.ownerId, share: schema.cityShares.access })
    .from(schema.cities)
    .leftJoin(schema.cityShares, and(eq(schema.cityShares.cityId, schema.cities.id), eq(schema.cityShares.userId, user.id)))
    .where(eq(schema.cities.id, cityId));
  if (!row) return null;
  if (user.role === "admin" || row.ownerId === user.id) return "owner";
  return row.share ?? null;
}

export async function planAccess(user: CurrentUser, planId: string): Promise<{ access: Access | null; cityId: string } | null> {
  const [row] = await db
    .select({ cityId: schema.plans.cityId, ownerId: schema.cities.ownerId, share: schema.cityShares.access })
    .from(schema.plans)
    .innerJoin(schema.cities, eq(schema.cities.id, schema.plans.cityId))
    .leftJoin(schema.cityShares, and(eq(schema.cityShares.cityId, schema.cities.id), eq(schema.cityShares.userId, user.id)))
    .where(eq(schema.plans.id, planId));
  if (!row) return null;
  const access: Access | null = user.role === "admin" || row.ownerId === user.id ? "owner" : (row.share ?? null);
  return { access, cityId: row.cityId };
}

/** Throws unless the user has at least `need` on the city. Unknown and forbidden look the same. */
export async function assertCity(user: CurrentUser, cityId: string, need: Access): Promise<Access> {
  const a = await cityAccess(user, cityId);
  if (!allows(a, need)) throw new Error(a ? messageFor(need) : "Map not found");
  return a!;
}

export async function assertPlan(user: CurrentUser, planId: string, need: Access): Promise<{ access: Access; cityId: string }> {
  const r = await planAccess(user, planId);
  if (!r || !allows(r.access, need)) throw new Error(r?.access ? messageFor(need) : "Plan not found");
  return { access: r.access!, cityId: r.cityId };
}

const messageFor = (need: Access) =>
  need === "owner" ? "Only the owner of this map can do that." : "You can view this map but not change it. Ask its owner for edit access.";
