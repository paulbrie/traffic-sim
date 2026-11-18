/**
 * Saves the experiment's city (ticket #277) to the database as a new city with V2 plans: the status quo and the best
 * designs the searches found (each its sketch, with its demand, the corridor's journeys and the centre drawn as a zone), so
 * they can be opened, run and changed in the editor. Through the app's own data layer (`recordVersion` for each plan's first
 * version), hence `--conditions=react-server`:
 *
 *   DATABASE_URL=… npx tsx --conditions=react-server scripts/dl-city-save.ts --owner <email> [--runs docs/experiments/dl-city-277/runs.jsonl]
 *
 * Refuses if that owner already has a city of that name. Prints the city's and plans' ids.
 */
import { readFileSync } from "fs";

const arg = (k: string, d = "") => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const OWNER = arg("owner"), RUNS = arg("runs", "docs/experiments/dl-city-277/runs.jsonl");

async function main() {
  if (!OWNER) throw new Error("--owner <email> is needed");
  const { db, schema } = await import("../src/db");
  const { sql, eq, and } = await import("drizzle-orm");
  const { recordVersion } = await import("../src/server/data/history");
  const { generateCity, STREETS } = await import("../src/lib/experiments/dl-city/city");
  const { baseline, designKey, designSketch, parseKey } = await import("../src/lib/experiments/dl-city/design");
  const { analyse } = await import("../src/lib/experiments/dl-city/analysis");
  const { corridorEff } = await import("../src/lib/experiments/dl-city/evaluate");
  const { sanitizeSketch } = await import("../src/lib/lane-sketch");
  const { emptyNetwork, DEFAULT_SETTINGS } = await import("../src/engine/types");

  const [{ d }] = await db.execute<{ d: string }>(sql`select current_database() as d`);
  console.log(`database: ${d}`);
  const [owner] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, OWNER));
  if (!owner) throw new Error(`no user ${OWNER}`);
  const city = generateCity(1), a = analyse(readFileSync(RUNS, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)));
  const name = `${city.name.replace(/ \(.*\)$/, "")}: a random Bistrița-like city (#277)`;
  const [dup] = await db.select({ id: schema.cities.id }).from(schema.cities).where(and(eq(schema.cities.ownerId, owner.id), eq(schema.cities.name, name)));
  if (dup) throw new Error(`${OWNER} already has “${name}” (${dup.id})`);
  const pct = (r: number) => `${r < 1 ? "−" : "+"}${Math.abs((r - 1) * 100).toFixed(1)}%`;
  const line = (k: string) => { const r = a.designs.find(x => x.key === k)!, m = r.m5 ?? r.m, B = r.m5 ? a.base5 : a.base; return `corridor ${corridorEff(m).toFixed(0)} s (${pct(corridorEff(m) / corridorEff(B))}), centre ${m.centreVehKm.toFixed(0)} veh-km/h (${pct(m.centreVehKm / B.centreVehKm)}), ${m.trips.toFixed(0)} trips/h, score ${(r.score5 ?? r.score).toFixed(3)} (mean of ${r.m5 ? 5 : 2} seeds)`; };
  const plans: { name: string; description: string; key: string }[] = [{ name: "Status quo", description: `The main road four lanes outside the ring (${STREETS[0].name}, ${STREETS[2].name}), every street two-way, lights where it meets the ring and in the centre. ${line(designKey(baseline(city)))}.`, key: designKey(baseline(city)) }];
  for (const m of ["dl", "ga"] as const) {
    const best = a.finalists.find(x => x.method === m);
    if (best) plans.push({ name: `Best by ${m === "dl" ? "the neural-network surrogate" : "the genetic algorithm"}`, description: `Ticket #277's ${m === "dl" ? "surrogate-assisted" : "genetic-algorithm"} search. Four lanes: ${parseKey(best.key).four.map(k => STREETS[k].name).join(", ")}. ${line(best.key)}.`, key: best.key });
  }
  // (the hybrid tried afterwards, if its runs are there: the surrogate's centre with the genetic algorithm's four-lane streets)
  try {
    const probe = readFileSync(RUNS.replace(/runs\.jsonl$/, "runs-probe.jsonl"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter((r: { method: string }) => r.method === "hybrid-four");
    if (probe.length) plans.push({ name: "Hybrid: surrogate's centre, GA's four-lane streets", description: `Tried after the searches (ticket #277): the surrogate's centre and junctions, four lanes on ${parseKey(probe[0].key).four.map(k => STREETS[k].name).join(", ")}. About as good on the score as the surrogate's best, with far fewer cars stuck (see the experiment's page).`, key: probe[0].key });
  } catch { /* no probe runs */ }
  const ids = await db.transaction(async tx => {
    const [c] = await tx.insert(schema.cities).values({ ownerId: owner.id, name, description: `Generated for ticket #277 (seed ${city.seed}) with the traits of Bistrița Auto Search: a dense centre in a ring boulevard, a main road from the south-west to the north-east through it, two bypasses, car parks and courtyards. The experiment's page: docs/experiments/dl-city-277/index.html.` }).returning({ id: schema.cities.id });
    const out: string[] = [];
    for (const p of plans) {
      const sketch = sanitizeSketch(designSketch(city, parseKey(p.key)).sketch)!;
      const [row] = await tx.insert(schema.plans).values({ cityId: c.id, name: p.name, description: p.description.slice(0, 500), network: emptyNetwork(), settings: DEFAULT_SETTINGS, sketch, engine: "v2" }).returning();
      await recordVersion(tx, row.id, owner.id, { revision: row.revision, network: row.network, settings: row.settings, underlay: null, sketch: row.sketch }, "create", `Ticket #277: ${p.name.toLowerCase()} of the random city`);
      out.push(row.id);
    }
    return { city: c.id, plans: out };
  });
  console.log(`city ${ids.city}: ${plans.map((p, i) => `${p.name} ${ids.plans[i]}`).join("; ")}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
