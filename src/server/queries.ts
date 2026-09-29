import "server-only";
import { connection } from "next/server";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Network } from "@/engine/types";
import type { CurrentUser } from "./auth";
import { cityAccess, planAccess, type Access } from "./access";

const planCount = sql<number>`(select count(*)::int from plans p where p.city_id = "cities"."id")`;
const lastPlanAt = sql<string | null>`(select max(p.updated_at) from plans p where p.city_id = "cities"."id")`;
const shareCount = sql<number>`(select count(*)::int from city_shares s where s.city_id = "cities"."id")`;

export interface CityListItem {
  id: string; name: string; description: string; updatedAt: Date; planCount: number; lastPlanAt: string | Date | null;
  access: Access; ownerName: string | null; shareCount: number;
}

/** Maps the user owns plus maps shared with them (admins see every map in the admin section). */
export async function listCities(user: CurrentUser): Promise<{ mine: CityListItem[]; shared: CityListItem[] }> {
  await connection();
  const rows = await db
    .select({
      id: schema.cities.id, name: schema.cities.name, description: schema.cities.description, updatedAt: schema.cities.updatedAt,
      ownerId: schema.cities.ownerId, ownerName: schema.users.name, ownerEmail: schema.users.email,
      share: schema.cityShares.access, planCount, lastPlanAt, shareCount,
    })
    .from(schema.cities)
    .leftJoin(schema.cityShares, and(eq(schema.cityShares.cityId, schema.cities.id), eq(schema.cityShares.userId, user.id)))
    .leftJoin(schema.users, eq(schema.users.id, schema.cities.ownerId))
    .where(or(eq(schema.cities.ownerId, user.id), eq(schema.cityShares.userId, user.id)))
    .orderBy(desc(schema.cities.updatedAt));
  const items = rows.map(r => ({
    id: r.id, name: r.name, description: r.description, updatedAt: r.updatedAt, planCount: r.planCount, lastPlanAt: r.lastPlanAt, shareCount: r.shareCount,
    access: (r.ownerId === user.id || user.role === "admin" ? "owner" : r.share ?? "read") as Access,
    ownerName: r.ownerName || r.ownerEmail || null,
    mine: r.ownerId === user.id,
  }));
  return { mine: items.filter(i => i.mine), shared: items.filter(i => !i.mine) };
}

/** Every map, for the admin section. */
export async function listAllCities() {
  await connection();
  return db
    .select({
      id: schema.cities.id, name: schema.cities.name, updatedAt: schema.cities.updatedAt,
      ownerId: schema.cities.ownerId, ownerEmail: schema.users.email, planCount, lastPlanAt, shareCount,
    })
    .from(schema.cities)
    .leftJoin(schema.users, eq(schema.users.id, schema.cities.ownerId))
    .orderBy(asc(schema.users.email), asc(schema.cities.name));
}

export async function getCity(id: string, user: CurrentUser) {
  await connection();
  const access = await cityAccess(user, id);
  if (!access) return null;
  const [city] = await db
    .select({ city: schema.cities, ownerName: schema.users.name, ownerEmail: schema.users.email })
    .from(schema.cities)
    .leftJoin(schema.users, eq(schema.users.id, schema.cities.ownerId))
    .where(eq(schema.cities.id, id));
  if (!city) return null;
  const plans = await db
    .select({
      id: schema.plans.id,
      name: schema.plans.name,
      description: schema.plans.description,
      updatedAt: schema.plans.updatedAt,
      revision: schema.plans.revision,
      // for the thumbnails: without buildings, which can run to megabytes on imported plans
      network: sql<Network>`(${schema.plans.network} - 'buildings')`.mapWith(schema.plans.network),
      nodes: sql<number>`jsonb_array_length(${schema.plans.network}->'nodes')`,
      links: sql<number>`jsonb_array_length(${schema.plans.network}->'links')`,
      stops: sql<number>`jsonb_array_length(${schema.plans.network}->'stops')`,
    })
    .from(schema.plans)
    .where(eq(schema.plans.cityId, id))
    .orderBy(desc(schema.plans.updatedAt));
  return { city: city.city, owner: city.ownerName || city.ownerEmail || null, ownerIsMe: city.city.ownerId === user.id, access, plans };
}

export async function getPlan(id: string, user: CurrentUser) {
  await connection();
  const a = await planAccess(user, id);
  if (!a?.access) return null;
  const [row] = await db
    .select({ plan: schema.plans, cityName: schema.cities.name })
    .from(schema.plans)
    .innerJoin(schema.cities, eq(schema.plans.cityId, schema.cities.id))
    .where(eq(schema.plans.id, id));
  return row ? { ...row, access: a.access } : null;
}
