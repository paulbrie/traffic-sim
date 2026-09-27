import "server-only";
import { connection } from "next/server";
import { desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";

export async function listCities() {
  await connection();
  return db
    .select({
      id: schema.cities.id,
      name: schema.cities.name,
      description: schema.cities.description,
      updatedAt: schema.cities.updatedAt,
      planCount: sql<number>`(select count(*)::int from plans p where p.city_id = "cities"."id")`,
      lastPlanAt: sql<string | null>`(select max(p.updated_at) from plans p where p.city_id = "cities"."id")`,
    })
    .from(schema.cities)
    .orderBy(desc(schema.cities.updatedAt));
}

export async function getCity(id: string) {
  await connection();
  const [city] = await db.select().from(schema.cities).where(eq(schema.cities.id, id));
  if (!city) return null;
  const plans = await db
    .select({
      id: schema.plans.id,
      name: schema.plans.name,
      description: schema.plans.description,
      updatedAt: schema.plans.updatedAt,
      revision: schema.plans.revision,
      network: schema.plans.network,
      nodes: sql<number>`jsonb_array_length(${schema.plans.network}->'nodes')`,
      links: sql<number>`jsonb_array_length(${schema.plans.network}->'links')`,
      stops: sql<number>`jsonb_array_length(${schema.plans.network}->'stops')`,
    })
    .from(schema.plans)
    .where(eq(schema.plans.cityId, id))
    .orderBy(desc(schema.plans.updatedAt));
  return { city, plans };
}

export async function getPlan(id: string) {
  await connection();
  const [row] = await db
    .select({ plan: schema.plans, cityName: schema.cities.name })
    .from(schema.plans)
    .innerJoin(schema.cities, eq(schema.plans.cityId, schema.cities.id))
    .where(eq(schema.plans.id, id));
  return row ?? null;
}
