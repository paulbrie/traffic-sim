/**
 * Bus support in V2 (T21, parity with v1's bus lines/stops/vehicles): a bus line's fleet spawns and is kept
 * near its set size, buses (and only buses) use a road's bus lane, a bus stops and dwells at each of its
 * line's stops in order, boards waiting passengers, and completes full loops. Two sketches:
 *  - a loop road (bus lane both legs) with 3 stops: checks sustained looping, no ordinary car ever on the
 *    bus lane, and dwelling happens.
 *  - the same loop with ordinary car demand added too: checks cars and buses coexist without collisions or
 *    deadlocks, and cars still never touch the bus lane.
 * npm run bus-support:check
 */
import { sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import { SketchSim, DEFAULT_SIM } from "../src/lib/lane-sketch-sim";

function loopSketch(rate: number): Sketch {
  const raw = {
    lanes: [
      { id: "out1", shape: { kind: "line", pts: [{ x: 0, y: 0 }, { x: 400, y: 0 }] }, width: 3.5, bus: true },
      { id: "back1", shape: { kind: "line", pts: [{ x: 400, y: 10 }, { x: 0, y: 10 }] }, width: 3.5, bus: true },
      { id: "link1", shape: { kind: "line", pts: [{ x: 400, y: 0 }, { x: 400, y: 10 }] }, width: 3.5 },
      { id: "link2", shape: { kind: "line", pts: [{ x: 0, y: 10 }, { x: 0, y: 0 }] }, width: 3.5 },
    ],
    connectors: [
      { id: "c1", from: { lane: "out1", s: 400 }, to: { lane: "link1", s: 0 } },
      { id: "c2", from: { lane: "link1", s: 10 }, to: { lane: "back1", s: 0 } },
      { id: "c3", from: { lane: "back1", s: 400 }, to: { lane: "link2", s: 0 } },
      { id: "c4", from: { lane: "link2", s: 10 }, to: { lane: "out1", s: 0 } },
    ],
    roads: [],
    junctions: [],
    traffic: { rate, speed: 50, seed: 1 },
    stops: [
      { id: "s1", name: "A", lane: "out1", s: 20 },
      { id: "s2", name: "B", lane: "out1", s: 350 },
      { id: "s3", name: "C", lane: "back1", s: 350 },
    ],
    busLines: [{ id: "line1", name: "Line 1", color: "#d99800", stops: ["s1", "s2", "s3"], buses: 2 }],
  };
  const sk = sanitizeSketch(raw);
  if (!sk) throw new Error("sketch failed to sanitize");
  return sk;
}

function run(sk: Sketch, seconds: number) {
  const sim = new SketchSim(sk, { ...(sk.traffic ?? DEFAULT_SIM), seed: 1 }, 1);
  let onBusLaneCar = 0, onBusLaneBus = 0, dwelled = 0, maxBuses = 0;
  const busLoops = new Map<number, { last: number; loops: number }>();
  for (let i = 0; i < seconds / 0.1; i++) {
    sim.step(0.1);
    const buses = sim.vehicles.filter(v => v.bus);
    maxBuses = Math.max(maxBuses, buses.length);
    for (const v of sim.vehicles) {
      const onBusLane = v.edge.kind === "lane" && v.edge.bus;
      if (onBusLane) { if (v.bus) onBusLaneBus++; else onBusLaneCar++; }
      if (v.bus && v.dwell > 0.5) dwelled++;
      if (v.bus) {
        const r = busLoops.get(v.id) ?? { last: -1, loops: 0 };
        if (r.last === 2 && v.stopIdx === 0) r.loops++;
        r.last = v.stopIdx;
        busLoops.set(v.id, r);
      }
    }
  }
  const stats = sim.stats();
  return { onBusLaneCar, onBusLaneBus, dwelled, maxBuses, loops: [...busLoops.values()].reduce((a, r) => a + r.loops, 0), collisions: stats.collisions, deadlocks: stats.deadlocks };
}

let bad = 0;
{
  const r = run(loopSketch(0), 1200);
  const ok = r.onBusLaneCar === 0 && r.onBusLaneBus > 0 && r.dwelled > 0 && r.maxBuses === 2 && r.loops >= 2 && r.collisions === 0 && r.deadlocks === 0;
  if (!ok) bad++;
  console.log(`bus-only loop: ${r.loops} full loops completed, ${r.maxBuses} buses at once, ${r.dwelled} dwell-ticks, bus-lane ticks car=${r.onBusLaneCar}/bus=${r.onBusLaneBus}, collisions ${r.collisions}, deadlocks ${r.deadlocks} | ok ${ok}`);
}
{
  const r = run(loopSketch(600), 1200);
  const ok = r.onBusLaneCar === 0 && r.onBusLaneBus > 0 && r.collisions === 0 && r.deadlocks === 0;
  if (!ok) bad++;
  console.log(`buses + ordinary car demand sharing the loop: bus-lane ticks car=${r.onBusLaneCar}/bus=${r.onBusLaneBus}, collisions ${r.collisions}, deadlocks ${r.deadlocks} | ok ${ok}`);
}
if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
