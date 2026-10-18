/**
 * A car always finds somewhere to go, even when its own lane's own way out isn't the nearest one (bug: "animation
 * stops" — TypeError: Cannot read properties of undefined (reading 'lane') at SketchSim.plan).
 *
 * In `plan`, once a car's cheapest way to its destination (`best`) is found, goals within 5 m of it are kept as
 * `near` — except a goal that only dead-ends a *different* lane from the car's own, when the car's own lane also
 * dead-ends there (T194's "no change to another lane of it for nothing"). That exclusion could empty `near`
 * entirely when every goal tied for `best` happened to be one of the excluded ones and the car's own lane's dead
 * end cost more than `best + 5` — then `near[Math.floor(rnd() * 0)]` is `undefined`, and the next line
 * (`v.goal = { lane: g.lane, … }`) throws, stopping the whole simulation (the worker's tick throws, nothing steps
 * again).
 *
 * Repro: three plain parallel lanes in one road, no connectors at all — every lane is simultaneously its own entry
 * and exit, and their dead ends keep tying for `best` in a way that used to hit the empty case. Runs several seeds;
 * `ok` is simply "it didn't throw" (SketchSim.step would have let the exception propagate).
 * npm run plan:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import type { Sketch, SketchLane } from "../src/lib/lane-sketch";

function threeParallelLanes(): Sketch {
  const lanes: SketchLane[] = [0, 1, 2].map(i => ({ id: `l${i}`, width: 3.5, shape: { kind: "line", pts: [{ x: 0, y: i * 3.6 }, { x: 300, y: i * 3.6 }] } }));
  return { lanes, connectors: [], roads: [{ id: "r1", name: "Road", lanes: lanes.map(l => l.id) }], junctions: [], traffic: { rate: 900, speed: 50, seed: 1 } };
}

let bad = 0;
for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
  const sk = threeParallelLanes();
  sk.traffic!.seed = seed;
  let ok = true, vehicles = 0;
  try {
    const sim = new SketchSim(sk, { ...sk.traffic!, seed }, seed);
    for (let i = 0; i < 3000; i++) sim.step(0.1);
    vehicles = sim.vehicles.length;
  } catch (e) {
    ok = false;
    console.error(`seed ${seed} threw:`, (e as Error).message);
  }
  if (!ok) bad++;
  console.log(`seed ${seed}: ${vehicles} vehicles still going | ok ${ok}`);
}
if (bad) { console.error(`${bad} seed(s) crashed the simulation`); process.exit(1); }
