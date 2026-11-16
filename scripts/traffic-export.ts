/**
 * The traffic recorded for a plan (ticket #261), as a file to analyse: per road and direction ("way") and per sample, with
 * what each field means (src/lib/traffic-history.ts), matched on the plan's sketch now. JSON, and the same as a CSV table.
 * npm run traffic:export -- <planId> [--from 2026-11-17] [--to 2026-11-30] [--out dir] [--rematch]
 *   --from / --to  the samples from / up to (ISO dates or times, UTC; --to a date: that day included)
 *   --out          where the files go (default: the current folder): traffic-<plan>-<from>-<to>.json / .csv
 *   --rematch      match the lines kept on the plan's sketch now again (when its lanes changed since they were recorded)
 * Reads the Railway database (.env.local's); pass it explicitly where the shell has another DATABASE_URL.
 */
import "./env";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import postgres from "postgres";
import type { GeoArea } from "../src/engine/types";
import type { Sketch } from "../src/lib/lane-sketch";
import { trafficMatcher, type FlowLine } from "../src/lib/tomtom";
import type { Incident } from "../src/lib/tomtom-api";
import { historyCsv, historyExport, laneTuples, type LaneTuple, type StoredSample } from "../src/lib/traffic-history";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function args() {
  const a = process.argv.slice(2), out: { plan?: string; from?: Date; to?: Date; dir: string; rematch: boolean } = { dir: ".", rematch: false };
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (v === "--rematch") out.rematch = true;
    else if (v === "--out") out.dir = a[++i];
    else if (v === "--from" || v === "--to") {
      const s = a[++i], d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s ?? "") ? `${s}T00:00:00Z` : s);
      if (!s || isNaN(+d)) throw new Error(`${v}: not a date (${s})`);
      // (a day: up to its end)
      if (v === "--to" && /^\d{4}-\d{2}-\d{2}$/.test(s)) d.setUTCDate(d.getUTCDate() + 1);
      out[v === "--from" ? "from" : "to"] = d;
    } else if (UUID.test(v)) out.plan = v;
    else throw new Error(`what is ${v}?`);
  }
  if (!out.plan) throw new Error("usage: npm run traffic:export -- <planId> [--from date] [--to date] [--out dir] [--rematch]");
  return out;
}

async function main() {
  const o = args();
  const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
  try {
    const [plan] = await sql<{ id: string; name: string; revision: number; sketch: Sketch | null }[]>`select id, name, revision, sketch from plans where id = ${o.plan!}`;
    if (!plan?.sketch) throw new Error("No such plan, or it has no sketch");
    const rows = await sql<(StoredSample & { data: Buffer | null })[]>`
      select at, revision, area, tiles, lanes, incidents, error ${o.rematch ? sql`, data` : sql`, null as data`}
      from traffic_samples where plan_id = ${plan.id}
      ${o.from ? sql`and at >= ${o.from}` : sql``} ${o.to ? sql`and at < ${o.to}` : sql``}
      order by at`;
    const samples: StoredSample[] = rows.map(r => {
      if (!o.rematch || !r.data) return { ...r, data: undefined };
      const { speeds, ratios } = JSON.parse(gunzipSync(r.data).toString()) as { speeds: FlowLine[]; ratios: FlowLine[] };
      const m = trafficMatcher({ at: new Date(r.at).toISOString(), area: r.area as GeoArea, speeds, ratios })(plan.sketch!);
      return { ...r, data: undefined, lanes: m ? laneTuples(m) : ({} as Record<string, LaneTuple>), incidents: r.incidents as Incident[] };
    });
    const e = historyExport(plan, plan.sketch, samples);
    const day = (s: string | null) => (s ?? "none").slice(0, 10);
    const base = join(o.dir, `traffic-${plan.id.slice(0, 8)}-${day(e.range.from)}-${day(e.range.to)}`);
    mkdirSync(o.dir, { recursive: true });
    writeFileSync(`${base}.json`, JSON.stringify(e));
    writeFileSync(`${base}.csv`, historyCsv(e));
    const failed = e.samples.filter(s => s.error).length;
    console.log(`${e.range.samples} samples (${failed} without data) from ${e.range.from ?? "-"} to ${e.range.to ?? "-"}, ${e.ways.length} ways, ${Object.keys(e.incidents).length} incidents\n${base}.json\n${base}.csv`);
  } finally { await sql.end(); }
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
