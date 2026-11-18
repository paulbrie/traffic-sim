/**
 * The V2 simulation's collision count does count (a dozen checks pass on "collisions 0", and would pass with a count that never
 * moved): two cars held on top of each other where two lanes cross count one collision, once (not again every second they stay
 * so); held 20 m apart, none; held side by side in two lanes 3.5 m apart, none.   npm run collisions:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import type { Sketch, SketchLane } from "../src/lib/lane-sketch";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const line = (id: string, pts: [number, number][]): SketchLane => ({ id, width: 3.5, inRate: 0, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) } });
type Car = { id: number; pos: number; v: number };
type Sim = { sendTest: (from: string, to: string) => number | null; step: (dt: number) => void; vehicles: Car[]; stats: () => { collisions: number } };

/** two test cars, one on each lane, held still at `posA` and `posB` along them for 2.5 s (the count is taken once a second) */
function held(lanes: SketchLane[], [a, b]: [string, string], posA: number, posB: number) {
  const sk: Sketch = { lanes, connectors: [], roads: [], junctions: [], traffic: { rate: 0, speed: 50, seed: 1 } };
  const sim = new SketchSim(sk, { rate: 0, speed: 50 }, 1) as unknown as Sim;
  const ia = sim.sendTest(a, a), ib = sim.sendTest(b, b);
  const hold = () => { for (const c of sim.vehicles) { c.v = 0; c.pos = c.id === ia ? posA : posB; } };
  sim.step(0.1);
  hold();
  for (let i = 0; i < 25; i++) { sim.step(0.1); hold(); }
  return { collisions: sim.stats().collisions, cars: sim.vehicles.length, both: ia !== null && ib !== null };
}

const crossing = [line("H", [[0, 0], [200, 0]]), line("V", [[100, -100], [100, 100]])];
const on = held(crossing, ["H", "V"], 100, 100);
check("two cars on top of each other at a crossing: one collision, counted once", on.both && on.cars === 2 && on.collisions === 1, `${on.collisions} in 2.5 s`);
const apart = held(crossing, ["H", "V"], 80, 100);
check("20 m apart: none", apart.both && apart.cars === 2 && apart.collisions === 0, `${apart.collisions}`);
const side = held([line("A", [[0, 0], [200, 0]]), line("B", [[0, 3.5], [200, 3.5]])], ["A", "B"], 100, 100);
check("side by side, two lanes 3.5 m apart: none", side.both && side.cars === 2 && side.collisions === 0, `${side.collisions}`);

console.log(ok ? "collisions check: all ok" : "collisions check: FAILED");
process.exit(ok ? 0 : 1);
