/**
 * Imports an OpenStreetMap area the way the app does and runs traffic on it:
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

async function main() {
  const [south, west, north, east] = process.argv.slice(2).map(Number);
  const bbox: BBox = { south, west, north, east };
  const problem = bboxProblem(bbox);
  if (problem) { console.error(`usage: osm:check <south> <west> <north> <east>\n${problem}`); process.exit(1); }
  const opts = { bbox, roads: DEFAULT_ROAD_CLASSES, buildings: true };
  const file = join(tmpdir(), `gridlock-osm-${[south, west, north, east].join("_")}.json`);
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
  if (clean.links.length !== network.links.length || clean.nodes.length !== network.nodes.length || (clean.buildings?.length ?? 0) !== (network.buildings?.length ?? 0)) console.log("WARNING: validation dropped parts of the import");
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
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
