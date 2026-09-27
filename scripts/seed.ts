/** Creates a demo city with the sample plan (run: npm run db:seed) */
import "./env";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cities, plans, planVersions, users } from "../src/db/schema";
import { sampleTown } from "../src/engine/sample";
import { DEFAULT_SETTINGS, emptyNetwork } from "../src/engine/types";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://traffic:traffic@localhost:5544/traffic", { max: 1 });
const db = drizzle(sql);

async function main() {
  // the demo city belongs to the first admin (run npm run db:admin first)
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.createdAt)).limit(1);
  const [city] = await db.insert(cities).values({ ownerId: admin?.id ?? null, name: "Demo City", description: "Sample district to explore the editor and the simulator." }).returning();
  const made = await db.insert(plans).values([
    { cityId: city.id, name: "Centre — current layout", description: "Diagonal boulevard with bus lanes, a roundabout and a one-way street.", network: sampleTown(), settings: DEFAULT_SETTINGS },
    { cityId: city.id, name: "Blank plan", description: "", network: emptyNetwork(), settings: DEFAULT_SETTINGS },
  ]).returning();
  await db.insert(planVersions).values(made.map(p => ({ planId: p.id, revision: p.revision, kind: "create", note: "Created", network: p.network, settings: p.settings, userId: admin?.id ?? null })));
  console.log(`Seeded city ${city.name} (${city.id})`);
  await sql.end();
}
main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
