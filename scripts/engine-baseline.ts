/**
 * Behaviour baseline for the simulation engine. Runs fixed scenarios and fingerprints the whole
 * simulation state at checkpoints; a refactor that should not change behaviour must reproduce the
 * stored fingerprints exactly.
 *   npm run engine:baseline            check against scripts/fixtures/engine-baseline.json
 *   npm run engine:baseline -- --update   store the current behaviour as the baseline
 *   npm run engine:baseline -- <name>     only the scenarios whose name contains <name>
 */
import { readFileSync, writeFileSync } from "fs";
import { compile, Sim, sampleTown, type Network, type PlanSettings } from "../src/engine";
import { addPhase, applyGreenWave, approachesTo, customizePhases, joinGroup, setLaneGreen, updateNode } from "../src/state/ops";

const FILE = "scripts/fixtures/engine-baseline.json";
const STEPS = 3000, EVERY = 500;
const fixture = (name: string) => JSON.parse(readFileSync(`scripts/fixtures/${name}.json`, "utf8"));

interface Scenario { name: string; net: Network; settings: PlanSettings; logAll?: boolean }

function scenarios(): Scenario[] {
  const town = sampleTown();
  const c = compile(town);
  const lights = c.nodes.filter(n => n.def.control === "lights" && n.controlled && n.degree >= 3);
  // per-lane phases with a protected left for the widest approach
  const j = lights.find(n => n.arms.some(a => (a.inEdge?.n ?? 0) >= 3))!;
  let custom = addPhase(customizePhases(town, c, j.def.id), j.def.id);
  const wide = approachesTo(custom, j.def.id).find(a => a.lanes >= 3)!;
  for (const p of (wide.dir === 1 ? wide.link.greenF : wide.link.greenB)![0]) custom = setLaneGreen(custom, wide.link.id, wide.dir, 0, p, false);
  custom = setLaneGreen(custom, wide.link.id, wide.dir, 0, 2, true);
  // a green wave over the boulevard's lights
  let wave = town, gid: string | null = null;
  for (const n of lights) [wave, gid] = joinGroup(wave, n.def.id, gid);
  wave = applyGreenWave(wave, compile(wave), gid!);
  // fixed inflow at one entry point, nothing leaving at another
  const gates = c.nodes.filter(n => n.gateway);
  const metered = updateNode(updateNode(town, gates[0].def.id, { inflow: 12 }), gates[1].def.id, { exitWeight: 0 });
  const user = fixture("claude-tests");
  return [
    { name: "sample-140", net: town, settings: { cars: 140, trucks: 14, seed: 7 } },
    { name: "sample-220", net: town, settings: { cars: 220, trucks: 20, seed: 11 } },
    { name: "sample-custom-phases", net: custom, settings: { cars: 140, trucks: 14, seed: 7 } },
    { name: "sample-green-wave", net: wave, settings: { cars: 160, trucks: 10, seed: 3 } },
    { name: "sample-metered", net: metered, settings: { cars: 120, trucks: 10, seed: 5, through: 0.5 } },
    { name: "sample-event-log", net: town, settings: { cars: 140, trucks: 14, seed: 9 }, logAll: true },
    { name: "claude-tests-640", net: user.network, settings: { ...user.settings, cars: 640, seed: 7 } },
    { name: "osm-cluj", net: fixture("osm-cluj"), settings: { cars: 300, trucks: 18, seed: 7 } },
    { name: "osm-milton-keynes", net: fixture("osm-milton-keynes"), settings: { cars: 400, trucks: 24, seed: 7 } },
  ];
}

/** FNV-1a over a stream of numbers */
class Hash {
  h = 0x811c9dc5;
  n(x: number) {
    const v = Number.isFinite(x) ? Math.round(x * 1e6) : x > 0 ? 1e15 : -1e15;
    // mix both 32-bit halves of the rounded value
    for (const part of [v % 4294967296, Math.floor(v / 4294967296)]) {
      let k = part | 0;
      for (let i = 0; i < 4; i++) { this.h ^= k & 0xff; this.h = Math.imul(this.h, 0x01000193); k >>>= 8; }
    }
  }
  s(x: string) { for (let i = 0; i < x.length; i++) this.n(x.charCodeAt(i)); }
  get hex() { return (this.h >>> 0).toString(16).padStart(8, "0"); }
}

function fingerprint(sim: Sim) {
  const h = new Hash();
  for (const v of sim.vehicles) {
    if (v.dead) continue;
    h.n(v.id); h.s(v.kind); h.n(v.piece.id); h.n(v.s); h.n(v.v); h.n(v.lane); h.n(v.ri); h.n(v.route.length);
    h.n(v.granted ? 1 : 0); h.n(v.conn?.id ?? -1); h.s(v.state); h.n(v.wait);
  }
  sim.net.nodes.forEach((n, i) => { if (n.def.control === "lights" && n.controlled) { const st = sim.nodeState(i); h.n(st.phase); h.n(st.stage); } });
  const S = sim.stats;
  for (const x of [S.count, S.trips, S.towed, S.boarded, S.laneChanges, sim.events.length]) h.n(x);
  return { hash: h.hex, vehicles: S.count, trips: S.trips, towed: S.towed };
}

type Record = { [scenario: string]: { tick: number; hash: string; vehicles: number; trips: number; towed: number }[] };

function run(sc: Scenario) {
  const sim = new Sim(compile(sc.net), sc.settings);
  sim.logAll = !!sc.logAll;
  const out: Record[string] = [];
  for (let t = 1; t <= STEPS; t++) {
    sim.step();
    if (t % EVERY === 0) out.push({ tick: t, ...fingerprint(sim) });
  }
  return out;
}

const args = process.argv.slice(2), update = args.includes("--update"), only = args.find(a => !a.startsWith("--"));
const stored: Record = (() => { try { return JSON.parse(readFileSync(FILE, "utf8")); } catch { return {}; } })();
const result: Record = update ? { ...stored } : {};
let failed = 0;
for (const sc of scenarios()) {
  if (only && !sc.name.includes(only)) continue;
  const t0 = Date.now();
  const got = run(sc);
  const ms = Date.now() - t0;
  result[sc.name] = got;
  const want = stored[sc.name];
  const last = got[got.length - 1];
  if (update || !want) { console.log(`${update ? "stored" : "NEW  "} ${sc.name.padEnd(22)} ${last.vehicles} vehicles, ${last.trips} trips (${ms} ms)`); continue; }
  const bad = got.findIndex((g, i) => g.hash !== want[i]?.hash);
  if (bad < 0) console.log(`ok    ${sc.name.padEnd(22)} ${last.vehicles} vehicles, ${last.trips} trips (${ms} ms)`);
  else {
    failed++;
    const g = got[bad], w = want[bad];
    console.log(`DIFF  ${sc.name.padEnd(22)} first at tick ${g.tick}: vehicles ${w?.vehicles}→${g.vehicles}, trips ${w?.trips}→${g.trips}, towed ${w?.towed}→${g.towed} (${ms} ms)`);
  }
}
if (update) writeFileSync(FILE, JSON.stringify(result, null, 1));
if (failed) { console.log(`${failed} scenario(s) differ from the baseline`); process.exit(1); }
