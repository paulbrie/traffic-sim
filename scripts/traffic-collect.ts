/**
 * The traffic recorder (ticket #261): TomTom's traffic over each plan given, now, kept in `traffic_samples`. It saves the
 * flow lines (gzipped), each lane's match on the plan's sketch, and the incidents. A failed fetch is kept too, with why.
 * Run by cron every 5 minutes in the hours wanted (the times are cron's, UTC on this server), e.g.
 *   0-59/5 4-6,14-16 * * *  and  0 7,17 * * *
 * npm run traffic:collect -- <planId> [<planId>…]
 * It writes to the Railway database only (.env.local's, as the app; cron's environment has no DATABASE_URL).
 */
import "./env";
import { gzipSync } from "node:zlib";
import postgres from "postgres";
import { databaseProblem } from "../src/lib/agent-login";
import type { Sketch } from "../src/lib/lane-sketch";
import { MAX_TILES, sketchArea, tilesFor, trafficMatcher } from "../src/lib/tomtom";
import { fetchFlow, fetchIncidents, TomTomError } from "../src/lib/tomtom-api";
import { laneTuples } from "../src/lib/traffic-history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length || ids.some(x => !UUID.test(x))) { console.error("usage: npm run traffic:collect -- <planId> [<planId>…]"); process.exit(2); }
  const key = process.env.TOMTOM_API;
  if (!key) { console.error("No TomTom key (TOMTOM_API in .env.local)"); process.exit(1); }
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  let failed = 0;
  try {
    const [{ current_database: dbName }] = await sql<{ current_database: string }[]>`select current_database()`;
    const problem = databaseProblem(dbName);
    if (problem) throw new Error(problem);
    for (const id of ids) {
      const at = new Date();
      const [plan] = await sql<{ name: string; revision: number; sketch: Sketch | null }[]>`select name, revision, sketch from plans where id = ${id}`;
      if (!plan) { console.error(`${at.toISOString()} ${id}: no such plan`); failed++; continue; }
      const area = plan.sketch && sketchArea(plan.sketch);
      if (!plan.sketch || !area) { console.error(`${at.toISOString()} ${id}: the plan isn't placed on the map`); failed++; continue; }
      const tiles = tilesFor(area).length;
      let row: { lanes: object; incidents: object; data: Buffer | null; bytes: number; error: string | null };
      try {
        if (tiles > MAX_TILES) throw new TomTomError(`the plan covers too much of the map (${tiles} tiles, at most ${MAX_TILES})`);
        const [flow, incidents] = await Promise.all([fetchFlow(area, key), fetchIncidents(area, key)]);
        const m = trafficMatcher({ at: at.toISOString(), area, speeds: flow.speeds, ratios: flow.ratios })(plan.sketch)!;
        const data = gzipSync(JSON.stringify({ speeds: flow.speeds, ratios: flow.ratios }));
        row = { lanes: laneTuples(m), incidents, data, bytes: data.length, error: null };
        console.log(`${at.toISOString()} ${plan.name}: ${flow.speeds.length} lines, ${m.lanes.size} lanes matched (${Math.round((100 * m.covered) / (m.length || 1))}% of the roads), ${incidents.length} incidents, ${(data.length / 1024).toFixed(0)} KB`);
      } catch (e) {
        const error = e instanceof TomTomError ? e.message : `Couldn't reach TomTom (${e instanceof Error ? e.message.replaceAll(key, "<key>") : String(e)})`;
        console.error(`${at.toISOString()} ${plan.name}: ${error}`);
        row = { lanes: {}, incidents: [], data: null, bytes: 0, error };
        failed++;
      }
      await sql`insert into traffic_samples (plan_id, at, revision, area, tiles, lanes, incidents, data, bytes, error)
        values (${id}, ${at}, ${plan.revision}, ${sql.json({ ...area })}, ${tiles}, ${sql.json(row.lanes as never)}, ${sql.json(row.incidents as never)}, ${row.data}, ${row.bytes}, ${row.error})`;
    }
  } finally { await sql.end(); }
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(new Date().toISOString(), e instanceof Error ? e.message : e); process.exit(1); });
