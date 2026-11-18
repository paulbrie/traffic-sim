/**
 * Imports an OpenStreetMap area the way the app does and runs traffic on it:
 *   npm run osm:check      (offline: a corner of central Cluj kept in scripts/fixtures/overpass-cluj-centre.json, as
 *                           Overpass answered it on 18 Nov 2026; its roads, lights and buildings must all come through)
 *   npm run osm:check -- <south> <west> <north> <east>
 *   npm run osm:check -- 46.7660 23.5830 46.7740 23.5960     (central Cluj)
 * The Overpass answer is cached in the system temp directory, so re-runs work offline.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Sim, compile } from "../src/engine";
import { sanitizeNetwork } from "../src/engine/validate";
import { bboxCenter, bboxProblem, DEFAULT_ROAD_CLASSES, overpassQuery, type BBox } from "../src/lib/osm/area";
import { convertOsm, suggestSettings, type OsmData } from "../src/lib/osm/convert";

const FIXTURE = { bbox: [46.769, 23.586, 46.772, 23.591], file: join(import.meta.dirname, "fixtures/overpass-cluj-centre.json") };

async function main() {
  const fixed = process.argv.length <= 2;
  const [south, west, north, east] = fixed ? FIXTURE.bbox : process.argv.slice(2).map(Number);
  const bbox: BBox = { south, west, north, east };
  const problem = bboxProblem(bbox);
  if (problem) { console.error(`usage: osm:check <south> <west> <north> <east>\n${problem}`); process.exit(1); }
  const opts = { bbox, roads: DEFAULT_ROAD_CLASSES, buildings: true };
  const file = fixed ? FIXTURE.file : join(tmpdir(), `gridlock-osm-${[south, west, north, east].join("_")}.json`);
  if (!existsSync(file)) {
    const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: overpassQuery(opts) }), headers: { "User-Agent": "Gridlock traffic simulator (osm-check)" } });
    if (!res.ok) throw new Error(`Overpass answered ${res.status}`);
    writeFileSync(file, await res.text());
  }
  const data = JSON.parse(readFileSync(file, "utf8")) as OsmData;
  let t0 = Date.now();
  const { network, stats } = convertOsm(data, { ...opts, origin: bboxCenter(bbox) });
  console.log("convert", Date.now() - t0, "ms", JSON.stringify(stats), "json", (JSON.stringify(network).length / 1024).toFixed(0), "kB");
  const L = network.links;
  console.log(`roads with turn bays ${L.filter(l => l.baysF || l.baysB).length}, lane arrows ${L.filter(l => l.turnsF || l.turnsB).length}, medians ${L.filter(l => l.median).length}, slip lanes ${L.filter(l => l.slip).length}, 5+ lanes ${L.filter(l => l.lanesF > 4 || l.lanesB > 4).length}`);
  const clean = sanitizeNetwork(network);
  const dropped = clean.links.length !== network.links.length || clean.nodes.length !== network.nodes.length || (clean.buildings?.length ?? 0) !== (network.buildings?.length ?? 0);
  if (dropped) console.log("WARNING: validation dropped parts of the import");
  t0 = Date.now();
  const c = compile(clean);
  console.log("compile", Date.now() - t0, "ms; edges", c.edges.length, "building access points", c.places.length, "warnings", c.warnings.length);
  for (const w of c.warnings.slice(0, 8)) console.log("  ", w);
  const settings = suggestSettings(clean);
  const sim = new Sim(c, settings);
  t0 = Date.now();
  sim.run(3000);
  let bad = 0;
  const st: Record<string, number> = {};
  for (const v of sim.vehicles) if (!v.dead) { st[v.state] = (st[v.state] || 0) + 1; const p = sim.pose(v); if (!isFinite(p.fx) || !isFinite(v.s)) bad++; }
  const S = sim.stats;
  console.log("settings", JSON.stringify(settings), "after 300 s:", "n", S.count, "v", S.avgSpeed.toFixed(1), "stop%", (S.stopped * 100).toFixed(0), "trips", S.trips, "towed", S.towed, "bad", bad, "ms", Date.now() - t0, JSON.stringify(st));
  if (bad) process.exit(1);
  if (fixed) {
    // (what this corner of Cluj holds: 21 roads, 5 junctions, 4 with lights, 168 buildings; its import must keep them and drive)
    const ok = stats.roads >= 15 && stats.junctions >= 4 && stats.signals >= 3 && stats.buildings >= 150 && stats.entries >= 8 && !dropped && c.warnings.length === 0 && S.trips >= 100 && S.towed === 0 && c.places.length >= 150;
    console.log(ok ? "osm check: all ok" : "osm check: FAILED");
    if (!ok) process.exit(1);
  }
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
