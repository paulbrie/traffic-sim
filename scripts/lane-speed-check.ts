/**
 * A speed limit per lane (ticket #126): a lane's own limit comes before its road's, the road's before the sketch's; set
 * back (null) it takes the road's again; kept by sanitizeSketch and when taken out of its road; in the simulation, a
 * road of two lanes side by side at 70 km/h, one of them 30 km/h of its own: its cars keep to 30, the other's run at 70.
 *   npm run lane-speed:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import { LANE_WIDTH, sanitizeSketch, setLaneSpeed, setRoadSpeed, speedLimitOf, type Sketch } from "../src/lib/lane-sketch";
import { takeOutOfRoad } from "../src/lib/road-lanes";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const lane = (id: string, y: number) => ({ id, width: LANE_WIDTH, shape: { kind: "line" as const, pts: [{ x: 0, y }, { x: 1000, y }] } });
const base: Sketch = {
  lanes: [lane("A", 1.75), lane("B", 5.25), lane("C", 40)], connectors: [], junctions: [],
  roads: [{ id: "r1", name: "Strada", lanes: ["A", "B"] }],
  traffic: { rate: 300, speed: 50, seed: 1 },
};

const sk = setLaneSpeed(setRoadSpeed(base, "r1", 70), "B", 30);
check("the road's limit, a lane without its own", speedLimitOf(sk, "A") === 70);
check("a lane's own limit before its road's", speedLimitOf(sk, "B") === 30);
check("a lane in no road, none set: the sketch's", speedLimitOf(sk, "C") === undefined);
check("set back: the road's again", speedLimitOf(setLaneSpeed(sk, "B", null), "B") === 70 && !("speed" in laneOf(setLaneSpeed(sk, "B", null), "B")));
check("the road's changed: the lane keeps its own", speedLimitOf(setRoadSpeed(sk, "r1", 90), "B") === 30 && speedLimitOf(setRoadSpeed(sk, "r1", 90), "A") === 90);
const clean = sanitizeSketch(JSON.parse(JSON.stringify(sk)));
check("kept by sanitizeSketch", !!clean && speedLimitOf(clean, "B") === 30 && speedLimitOf(clean, "A") === 70);
const out = takeOutOfRoad(sk, ["A", "B"]).sketch;
check("taken out of the road: its own kept, the other the road's as its own", speedLimitOf(out, "B") === 30 && speedLimitOf(out, "A") === 70);

// the simulation: the cars on each lane, well along it
const sim = new SketchSim(sk, { rate: 300, speed: 50 }, 1);
const seen: Record<string, number[]> = { A: [], B: [] };
for (let i = 0; i < 6000; i++) {
  sim.step(0.1);
  if (i < 600) continue;
  for (const v of sim.vehicles) if (v.edge.id in seen && v.pos > 300 && v.pos < 900) seen[v.edge.id].push(v.v * 3.6);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length), top = (xs: number[]) => Math.max(0, ...xs);
check("cars on the lane at 30 of its own keep to it", seen.B.length > 100 && top(seen.B) <= 31 && mean(seen.B) > 25, `mean ${mean(seen.B).toFixed(1)}, top ${top(seen.B).toFixed(1)} km/h`);
check("…those on the road's other lane run at the road's 70", seen.A.length > 100 && mean(seen.A) > 60 && top(seen.A) <= 71, `mean ${mean(seen.A).toFixed(1)}, top ${top(seen.A).toFixed(1)} km/h`);

function laneOf(s: Sketch, id: string) { return s.lanes.find(l => l.id === id)!; }
console.log(ok ? "lane speed check: all ok" : "lane speed check: FAILED");
if (!ok) process.exit(1);
