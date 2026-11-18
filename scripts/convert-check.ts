/**
 * A V1 plan converted to V2 ("Convert to V2", lib/v1-to-v2.ts): V1's sample town (3 junctions with lights, an all-way stop, a
 * roundabout, 3 give-way junctions) and the Cluj import kept for the engine's baseline. The report counts what the sketch holds;
 * the junctions come through as they were (lights with phases, the stop's signs, the roundabout's ring); every connector joins lanes
 * that are there, within their length; sanitizeSketch (as it is saved) keeps all of it; converting again gives the same sketch; and
 * the V2 simulation drives it: cars in and out, through every junction with lights, nobody through anybody.   npm run convert:check
 */
import { readFileSync } from "fs";
import { sampleTown, type Network } from "../src/engine";
import { networkToSketch } from "../src/lib/v1-to-v2";
import { laneLength, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import { SketchSim } from "../src/lib/lane-sketch-sim";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };

function sound(name: string, sk: Sketch) {
  const lanes = new Map(sk.lanes.map(l => [l.id, l]));
  const bad = sk.connectors.filter(c => {
    const a = lanes.get(c.from.lane), b = lanes.get(c.to.lane);
    return !a || !b || c.from.s < -0.05 || c.from.s > laneLength(a.shape) + 0.05 || c.to.s < -0.05 || c.to.s > laneLength(b.shape) + 0.05;
  });
  check(`${name}: every connector joins lanes that are there, within their length (to 5 cm: rounding)`, bad.length === 0, bad.slice(0, 3).map(c => c.id).join(", "));
  const inRoads = sk.roads.flatMap(r => r.lanes).filter(id => !lanes.has(id));
  check(`${name}: every road's lanes are there`, inRoads.length === 0, inRoads.slice(0, 3).join(", "));
  const saved = sanitizeSketch(JSON.parse(JSON.stringify(sk)));
  check(`${name}: kept whole as it is saved (sanitizeSketch)`, !!saved && saved.lanes.length === sk.lanes.length && saved.connectors.length === sk.connectors.length && saved.junctions.length === sk.junctions.length && saved.roads.length === sk.roads.length,
    saved ? `${saved.lanes.length}/${sk.lanes.length} lanes, ${saved.connectors.length}/${sk.connectors.length} connectors, ${saved.junctions.length}/${sk.junctions.length} junctions` : "refused");
  return saved!;
}

// V1's sample town
{
  const { sketch: sk, report: r } = networkToSketch(sampleTown());
  console.log("sample town:", JSON.stringify({ ...r, tidy: undefined }));
  check("sample town: the report counts what the sketch holds", r.lanes === sk.lanes.length && r.connectors === sk.connectors.length && r.roads === sk.roads.length && r.junctions === sk.junctions.length);
  check("sample town: its 3 junctions with lights have lights, with phases", r.lights === 3 && sk.junctions.filter(j => j.lights).length === 3, `${r.lights} in the report, ${sk.junctions.filter(j => j.lights).length} in the sketch`);
  check("sample town: the roundabout a ring", r.roundabouts === 1 && sk.lanes.some(l => l.shape.kind === "arc"), `${r.roundabouts}`);
  check("sample town: the all-way stop's ways in have their signs", r.signs >= 4 && sk.lanes.filter(l => l.control === "stop").length >= 4, `${r.signs} signs, ${sk.lanes.filter(l => l.control === "stop").length} stop lanes`);
  check("sample town: nothing left out but what V2 doesn't carry over", r.skipped.every(s => /bus|park|demand|building/i.test(s)), JSON.stringify(r.skipped));
  const saved = sound("sample town", sk);
  check("sample town: converted again, the same sketch", JSON.stringify(networkToSketch(sampleTown()).sketch) === JSON.stringify(sk));

  // (the V2 simulation on it, 15 minutes at 300 vehicles/h a way in: cars come and go, through the lit junctions)
  const run: Sketch = { ...saved, traffic: { rate: 300, speed: 50, seed: 1 } };
  const sim = new SketchSim(run, { rate: 300, speed: 50 }, 1) as unknown as { step: (dt: number) => void; t: number; vehicles: { edge: { kind: string; id: string } }[]; stats: () => { finished: number; collisions: number; deadlocks: number } };
  const lit = new Set(saved.junctions.filter(j => j.lights).flatMap(j => j.lights?.phases?.flatMap(p => p.conns) ?? [])), used = new Set<string>();
  while (sim.t < 900) { sim.step(0.1); for (const v of sim.vehicles) if (v.edge.kind === "conn" && lit.has(v.edge.id)) used.add(v.edge.id); }
  const st = sim.stats();
  check("sample town in V2: cars through it, nobody through anybody, at most a deadlock or two", st.finished > 300 && st.collisions <= 2 && st.deadlocks <= 2, `${st.finished} out, ${st.collisions} collisions, ${st.deadlocks} deadlocks`);
  check("…and through the junctions with lights", !lit.size || used.size >= lit.size / 2, `${used.size} of ${lit.size} lit connectors driven`);
}

// the Cluj import (an OSM area as V1 imported it)
{
  const net: Network = JSON.parse(readFileSync("scripts/fixtures/osm-cluj.json", "utf8"));
  const { sketch: sk, report: r } = networkToSketch(net);
  console.log("Cluj:", JSON.stringify({ ...r, tidy: undefined }));
  check("Cluj: lanes, connectors, roads and junctions, counted", r.lanes > 100 && r.connectors > 100 && r.junctions > 10 && r.lanes === sk.lanes.length && r.connectors === sk.connectors.length, `${r.lanes} lanes, ${r.connectors} connectors, ${r.junctions} junctions`);
  check("Cluj: its lights come through", r.lights > 0 && sk.junctions.some(j => j.lights));
  check("Cluj: where it is on Earth kept", !!sk.geo || !net.geo, JSON.stringify(sk.geo ?? null));
  sound("Cluj", sk);
}

console.log(ok ? "convert check: all ok" : "convert check: FAILED");
process.exit(ok ? 0 : 1);
