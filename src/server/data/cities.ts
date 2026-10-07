// Cities (maps) and their sharing. Every function that reads or changes a city takes a proof about that city
// (src/server/proofs), so none can run without the check, or with a check about another city; one that
// records who acted (a copy's owner) takes that user, named, too. Functions about the signed-in user's own
// things take a ViewerId, which only the session makes.
import "server-only";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { Named } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { Network } from "@/engine/types";
import type { CityId, UserId, ViewerId } from "@/lib/ids";
import type { CanOwnCity, CanViewCity } from "../proofs/policy";
import type { UserIsAdmin } from "../proofs/user-is-admin";
import { recordVersion } from "./history";

const planCount = sql<number>`(select count(*)::int from plans p where p.city_id = "cities"."id")`;
const lastPlanAt = sql<string | null>`(select max(p.updated_at) from plans p where p.city_id = "cities"."id")`;
const shareCount = sql<number>`(select count(*)::int from city_shares s where s.city_id = "cities"."id")`;

export interface CityListItem {
  id: string; name: string; description: string; updatedAt: Date; planCount: number; lastPlanAt: string | Date | null;
  access: "owner" | "write" | "read"; ownerName: string | null; shareCount: number;
}

/** The maps the signed-in user owns, and those shared with them. */
export async function listCities(viewer: ViewerId, role: "admin" | "user"): Promise<{ mine: CityListItem[]; shared: CityListItem[] }> {
  const rows = await db
    .select({
      id: schema.cities.id, name: schema.cities.name, description: schema.cities.description, updatedAt: schema.cities.updatedAt,
      ownerId: schema.cities.ownerId, ownerName: schema.users.name, ownerEmail: schema.users.email,
      share: schema.cityShares.access, planCount, lastPlanAt, shareCount,
    })
    .from(schema.cities)
    .leftJoin(schema.cityShares, and(eq(schema.cityShares.cityId, schema.cities.id), eq(schema.cityShares.userId, viewer)))
    .leftJoin(schema.users, eq(schema.users.id, schema.cities.ownerId))
    .where(or(eq(schema.cities.ownerId, viewer), eq(schema.cityShares.userId, viewer)))
    .orderBy(desc(schema.cities.updatedAt));
  const items = rows.map(r => {
    const access: CityListItem["access"] = r.ownerId === viewer || role === "admin" ? "owner" : r.share ?? "read";
    return {
      id: r.id, name: r.name, description: r.description, updatedAt: r.updatedAt, planCount: r.planCount, lastPlanAt: r.lastPlanAt, shareCount: r.shareCount,
      access, ownerName: r.ownerName || r.ownerEmail || null, mine: r.ownerId === viewer,
    };
  });
  return { mine: items.filter(i => i.mine), shared: items.filter(i => !i.mine) };
}

/** A city with its plans (for thumbnails: without buildings, which can run to megabytes on imported plans). */
export async function getCity<U, C>(city: Named<C, CityId>, viewer: Named<U, ViewerId>, _proof: CanViewCity<U, C>) {
  const [row] = await db
    .select({ city: schema.cities, ownerName: schema.users.name, ownerEmail: schema.users.email })
    .from(schema.cities)
    .leftJoin(schema.users, eq(schema.users.id, schema.cities.ownerId))
    .where(eq(schema.cities.id, city.value));
  if (!row) return null;
  const plans = await db
    .select({
      id: schema.plans.id,
      name: schema.plans.name,
      description: schema.plans.description,
      updatedAt: schema.plans.updatedAt,
      revision: schema.plans.revision,
      network: sql<Network>`(${schema.plans.network} - 'buildings')`.mapWith(schema.plans.network),
      nodes: sql<number>`jsonb_array_length(${schema.plans.network}->'nodes')`,
      links: sql<number>`jsonb_array_length(${schema.plans.network}->'links')`,
      stops: sql<number>`jsonb_array_length(${schema.plans.network}->'stops')`,
    })
    .from(schema.plans)
    .where(eq(schema.plans.cityId, city.value))
    .orderBy(desc(schema.plans.updatedAt));
  return { city: row.city, owner: row.ownerName || row.ownerEmail || null, ownerIsMe: row.city.ownerId === viewer.value, plans };
}

/** A new, empty city, owned by the signed-in user. */
export async function createCity(owner: ViewerId, input: { name: string; description: string }): Promise<string> {
  const [city] = await db.insert(schema.cities).values({ ownerId: owner, name: input.name, description: input.description }).returning({ id: schema.cities.id });
  return city.id;
}

export async function updateCity<U, C>(city: Named<C, CityId>, input: { name: string; description: string }, _proof: CanOwnCity<U, C>) {
  await db.update(schema.cities).set({ name: input.name, description: input.description, updatedAt: new Date() }).where(eq(schema.cities.id, city.value));
}

export async function deleteCity<U, C>(city: Named<C, CityId>, _proof: CanOwnCity<U, C>) {
  await db.delete(schema.cities).where(eq(schema.cities.id, city.value));
}

/**
 * Copies a city with all its plans (and their reference images) into a new city owned by `owner`, who must be
 * able to see the city; sharing and history are not copied. The new city's id, or null if it's gone.
 */
export async function duplicateCity<U, C>(city: Named<C, CityId>, owner: Named<U, ViewerId>, name: string | null, _proof: CanViewCity<U, C>): Promise<string | null> {
  const [src] = await db.select().from(schema.cities).where(eq(schema.cities.id, city.value));
  if (!src) return null;
  const title = name || `${src.name} (copy)`.slice(0, 120);
  return db.transaction(async tx => {
    const [copy] = await tx.insert(schema.cities).values({ ownerId: owner.value, name: title, description: src.description }).returning({ id: schema.cities.id });
    const plans = await tx.select().from(schema.plans).where(eq(schema.plans.cityId, city.value)).orderBy(asc(schema.plans.createdAt));
    for (const p of plans) {
      const [plan] = await tx.insert(schema.plans)
        .values({ cityId: copy.id, name: p.name, description: p.description, network: p.network, settings: p.settings, underlay: p.underlay })
        .returning();
      await tx.execute(sql`insert into plan_images (plan_id, mime, data, bytes) select ${plan.id}, mime, data, bytes from plan_images where plan_id = ${p.id}`);
      await recordVersion(tx, plan.id, owner.value, { revision: plan.revision, network: plan.network, settings: plan.settings, underlay: plan.underlay }, "create", `Copied from “${src.name} / ${p.name}”`);
    }
    return copy.id;
  });
}

export type ShareResult = { ok: true } | { ok: false; error: string };

/** Shares a city with an existing account, or changes the access it already has. */
export async function shareCity<U, C>(city: Named<C, CityId>, email: string, access: "read" | "write", _proof: CanOwnCity<U, C>): Promise<ShareResult> {
  const [target] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (!target) return { ok: false, error: `No account for ${email}. They can create a free one on the sign-in page, then you can share with them.` };
  const [row] = await db.select({ ownerId: schema.cities.ownerId }).from(schema.cities).where(eq(schema.cities.id, city.value));
  if (row?.ownerId === target.id) return { ok: false, error: "That's the owner of this map." };
  await db.insert(schema.cityShares).values({ cityId: city.value, userId: target.id, access })
    .onConflictDoUpdate({ target: [schema.cityShares.cityId, schema.cityShares.userId], set: { access } });
  return { ok: true };
}

/** Takes a city away from someone it was shared with. */
export async function unshareCity<U, C>(city: Named<C, CityId>, member: UserId, _proof: CanOwnCity<U, C>) {
  await db.delete(schema.cityShares).where(and(eq(schema.cityShares.cityId, city.value), eq(schema.cityShares.userId, member)));
}

/** Takes a city shared with the signed-in user off their list (their own share: no proof needed). */
export async function leaveCity(city: CityId, viewer: ViewerId) {
  await db.delete(schema.cityShares).where(and(eq(schema.cityShares.cityId, city), eq(schema.cityShares.userId, viewer)));
}

export async function listShares<U, C>(city: Named<C, CityId>, _proof: CanViewCity<U, C>) {
  return db
    .select({ userId: schema.users.id, email: schema.users.email, name: schema.users.name, access: schema.cityShares.access })
    .from(schema.cityShares)
    .innerJoin(schema.users, eq(schema.users.id, schema.cityShares.userId))
    .where(eq(schema.cityShares.cityId, city.value))
    .orderBy(asc(schema.users.email));
}

// ---------------------------------------------------------------- admins

/** Every map, for the admin section. */
export async function listAllCities<U>(_proof: UserIsAdmin<U>) {
  return db
    .select({
      id: schema.cities.id, name: schema.cities.name, updatedAt: schema.cities.updatedAt,
      ownerId: schema.cities.ownerId, ownerEmail: schema.users.email, planCount, lastPlanAt, shareCount,
    })
    .from(schema.cities)
    .leftJoin(schema.users, eq(schema.users.id, schema.cities.ownerId))
    .orderBy(asc(schema.users.email), asc(schema.cities.name));
}

/** Hands a city to another account; the previous owner keeps edit access. */
export async function transferCity<U>(city: CityId, newOwner: UserId, _proof: UserIsAdmin<U>): Promise<ShareResult> {
  const [row] = await db.select({ ownerId: schema.cities.ownerId }).from(schema.cities).where(eq(schema.cities.id, city));
  if (!row) return { ok: false, error: "Map not found." };
  const [target] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, newOwner));
  if (!target) return { ok: false, error: "User not found." };
  await db.transaction(async tx => {
    await tx.update(schema.cities).set({ ownerId: newOwner }).where(eq(schema.cities.id, city));
    await tx.delete(schema.cityShares).where(and(eq(schema.cityShares.cityId, city), eq(schema.cityShares.userId, newOwner)));
    if (row.ownerId && row.ownerId !== newOwner) {
      await tx.insert(schema.cityShares).values({ cityId: city, userId: row.ownerId, access: "write" }).onConflictDoNothing();
    }
  });
  return { ok: true };
}
