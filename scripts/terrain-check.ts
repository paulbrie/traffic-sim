/**
 * Terrain (ticket #130). Checks:
 * - a Terrarium tile (scripts/fixtures, z12 2290/1449) decodes to the heights sharp reads from it;
 * - the grid kept in the sketch: heights back within 5 cm through JSON and sanitizeSketch; bilinear on a slope; off it, its edge;
 *   moved elsewhere on Earth (`geo` changed), not used;
 * - heights along lanes: on terrain sloping 5% to the east, an eastbound lane climbs 5 m per 100 m and a westbound one comes
 *   down; set by hand, a lane climbs evenly between its ends (an end not set: the terrain's); reversed, sliced, joined, and a
 *   lane both ways' way back keep them; a connector goes evenly from one lane's height to the other's;
 * - the sim, a straight road 600 m long: up a 6% hill trucks are much slower than on the flat and cars a little slower;
 *   down it nobody goes faster than the limit; fuel more uphill, less down; `grades` 0 as the flat; a sketch without heights
 *   runs exactly as before (cars where they were, step by step).
 * npm run terrain:check
 */
import { readFileSync } from "fs";
import { inflateSync } from "zlib";
import { SketchSim } from "../src/lib/lane-sketch-sim";
import { connectorGround, drivable, groundAt, hasHeights, LANE_WIDTH, reverseLane, sanitizeSketch, setGround, sliceLane, terrainOf, twinId, type Sketch } from "../src/lib/lane-sketch";
import { decodeTerrariumPng, makeTerrain, terrainAt, terrainHeights, type SketchTerrain } from "../src/lib/terrain";
import { mergeLanes } from "../src/lib/sketch-merge";

let bad = 0;
function check(name: string, ok: boolean, info = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? `: ${info}` : ""}`);
  if (!ok) bad++;
}
const f = (x: number, d = 2) => x.toFixed(d);
const GEO = { lat: 46.77, lon: 23.59 };
/** terrain over x -100..900, y -200..200, rising `grade` to the east from 300 m at x = 0 */
const slope = (grade: number): SketchTerrain => {
  const g = { x0: -100, y0: -200, cell: 20, cols: 51, rows: 21 }, h = new Float32Array(g.cols * g.rows);
  for (let j = 0; j < g.rows; j++) for (let i = 0; i < g.cols; i++) h[j * g.cols + i] = 300 + grade * (g.x0 + i * g.cell);
  return makeTerrain(g, h, GEO);
};

// the tile
{
  const t = decodeTerrariumPng(new Uint8Array(readFileSync("scripts/fixtures/terrarium-12-2290-1449.png")), d => new Uint8Array(inflateSync(d)));
  let sum = 0;
  for (const h of t) sum += h;
  check("a Terrarium tile decodes as sharp reads it", Math.abs(sum - 6179056.258) < 0.01 && t[0] === 91.73046875 && t[40000] === 94.8046875, `sum ${f(sum, 3)}, first ${t[0]}, 40000th ${t[40000]}`);
}

// the grid
{
  const t = slope(0.05);
  check("bilinear on a slope", Math.abs(terrainAt(t, 133, 7) - (300 + 0.05 * 133)) < 0.06, f(terrainAt(t, 133, 7)));
  check("off the grid: its edge's", Math.abs(terrainAt(t, 5000, 0) - (300 + 0.05 * 900)) < 0.06 && Math.abs(terrainAt(t, -5000, 0) - 295) < 0.06);
  const sk = sanitizeSketch(JSON.parse(JSON.stringify({ lanes: [], connectors: [], roads: [], junctions: [], geo: GEO, terrain: t })))!;
  const a = terrainHeights(t), b = terrainHeights(sk.terrain!);
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, Math.abs(a[i] - b[i]));
  check("kept through JSON and sanitizeSketch, within 5 cm", d <= 0.05 && !!terrainOf(sk), `${f(d, 3)} m`);
  check("sanitize: a grid short of heights is dropped", !sanitizeSketch({ lanes: [], connectors: [], roads: [], junctions: [], geo: GEO, terrain: { ...t, h: t.h.slice(0, 40) } })?.terrain);
  check("moved elsewhere on Earth: not used", !terrainOf({ ...sk, geo: { lat: GEO.lat + 0.01, lon: GEO.lon } }) && !hasHeights({ ...sk, geo: { lat: GEO.lat + 0.01, lon: GEO.lon } }));
}

// heights along lanes
{
  const base: Sketch = {
    lanes: [
      { id: "E", width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: 0, y: 0 }, { x: 400, y: 0 }] } },
      { id: "W", width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: 400, y: 50 }, { x: 0, y: 50 }] } },
      { id: "N", width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: 500, y: 100 }, { x: 500, y: -100 }] } },
    ],
    connectors: [{ id: "c1", from: { lane: "E", s: 400 }, to: { lane: "N", s: 100 } }], roads: [], junctions: [], geo: GEO, terrain: slope(0.05),
  };
  const climb = groundAt(base, "E", 300) - groundAt(base, "E", 100), down = groundAt(base, "W", 300) - groundAt(base, "W", 100);
  check("eastbound climbs 5 m per 100 m, westbound comes down", Math.abs(climb - 10) < 0.1 && Math.abs(down + 10) < 0.1 && Math.abs(groundAt(base, "E", 0) - 300) < 0.1, `E ${f(climb)} m, W ${f(down)} m over 200 m`);
  check("no heights: 0 everywhere", groundAt({ ...base, terrain: undefined }, "E", 250) === 0 && !hasHeights({ ...base, terrain: undefined }));
  const c = base.connectors[0];
  check("a connector: from one lane's height to the other's", Math.abs(connectorGround(base, c, 0) - groundAt(base, "E", 400)) < 1e-6 && Math.abs(connectorGround(base, c, 1) - groundAt(base, "N", 100)) < 1e-6 && Math.abs(connectorGround(base, c, 0.5) - (connectorGround(base, c, 0) + connectorGround(base, c, 1)) / 2) < 1e-6);
  // (set by hand: an embankment, flat at 330 m all along; one end only: from it to the terrain's other end)
  const hand = setGround(base, ["E"], { a: 330, b: 330 }), one = setGround(base, ["E"], { a: 280 });
  check("set by hand: even between its ends", Math.abs(groundAt(hand, "E", 123) - 330) < 1e-6 && Math.abs(groundAt(one, "E", 200) - (280 + 320) / 2) < 0.1, `${f(groundAt(hand, "E", 123))}, ${f(groundAt(one, "E", 200))}`);
  check("cleared: the terrain's again", !setGround(hand, ["E"], { a: null, b: null }).lanes[0].ground);
  const sloped = setGround(base, ["E"], { a: 300, b: 340 });
  const rev = reverseLane(sloped, "E");
  check("reversed: its ends' heights swapped", rev.lanes[0].ground?.a === 340 && rev.lanes[0].ground?.b === 300 && Math.abs(groundAt(rev, "E", 100) - 330) < 1e-6);
  const cut = sliceLane(sloped, "E", 100, "E2")!;
  check("sliced: each stretch to the height at the cut", Math.abs(groundAt(cut, "E", 100) - 310) < 1e-6 && Math.abs(groundAt(cut, "E2", 0) - 310) < 1e-6 && Math.abs(groundAt(cut, "E2", 300) - 340) < 1e-6, JSON.stringify([cut.lanes.find(l => l.id === "E")!.ground, cut.lanes.find(l => l.id === "E2")!.ground]));
  const joined = mergeLanes(cut, "E", "E2");
  const j = joined.ok ? joined.sketch.lanes.find(l => l.id === "E") : undefined;
  check("joined again: the first's start, the second's end", !!j && j.ground?.a === 300 && j.ground?.b === 340, JSON.stringify(j?.ground));
  const both = drivable(setGround({ ...sloped, lanes: sloped.lanes.map(l => (l.id === "E" ? { ...l, twoWay: "turns" as const } : l)) } as Sketch, ["E"], { a: 300, b: 340 }));
  check("a lane both ways: its way back comes down the same hill", Math.abs(groundAt(both, twinId("E"), 0) - 340) < 1e-6 && Math.abs(groundAt(both, twinId("E"), 400) - 300) < 1e-6);
}

// the sim
{
  const LEN = 600;
  const road = (grade: number | null, tune: Record<string, number> = {}): Sketch => ({
    lanes: [{ id: "E", width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: 0, y: 0 }, { x: LEN, y: 0 }] } }],
    connectors: [], roads: [], junctions: [], geo: GEO, ...(grade !== null ? { terrain: slope(grade) } : {}),
    traffic: { rate: 300, speed: 50, seed: 1, tune: { truckShare: 20, ...tune } },
  });
  /** 15 min; the speeds (km/h) with fronts at 300–550 m, cars and trucks apart; fuel per km; collisions */
  const run = (sk: Sketch) => {
    const sim = new SketchSim(sk, sk.traffic!, 1), car: number[] = [], truck: number[] = [];
    let over = 0;
    for (let i = 0; i < 9000; i++) {
      sim.step(0.1);
      for (const v of sim.vehicles) {
        if (v.v * 3.6 > 50 * 1.15 + 0.5) over++;
        if (i >= 600 && v.pos >= 300 && v.pos < 550) (v.truck ? truck : car).push(v.v * 3.6);
      }
    }
    const st = sim.stats();
    return { car: car.reduce((a, b) => a + b, 0) / car.length, truck: truck.reduce((a, b) => a + b, 0) / truck.length, perKm: st.fuel.total / Math.max(1e-9, st.fuel.km), over, collisions: st.collisions };
  };
  const flat = run(road(null)), up = run(road(0.06)), down = run(road(-0.06)), off = run(road(0.06, { grades: 0 }));
  // (cars alone: with trucks, the cars' speed uphill is mostly the trucks' ahead of them)
  const carsFlat = run(road(null, { truckShare: 0 })), carsUp = run(road(0.06, { truckShare: 0 }));
  console.log(`  flat: cars ${f(flat.car, 1)} km/h, trucks ${f(flat.truck, 1)}, ${f(flat.perKm * 1000, 1)} mL/km; up 6%: ${f(up.car, 1)}, ${f(up.truck, 1)}, ${f(up.perKm * 1000, 1)}; down: ${f(down.car, 1)}, ${f(down.truck, 1)}, ${f(down.perKm * 1000, 1)}`);
  check("up 6%: trucks much slower (at least 15%)", up.truck < 0.85 * flat.truck, `${f(up.truck, 1)} against ${f(flat.truck, 1)} km/h`);
  check("up 6%, cars alone: a little slower (at most 10%)", carsUp.car < carsFlat.car && carsUp.car > 0.9 * carsFlat.car, `${f(carsUp.car, 1)} against ${f(carsFlat.car, 1)} km/h`);
  check("down 6%: none faster than the speed it wants, about the flat's on average (up to speed sooner)", down.over === 0 && down.car <= flat.car * 1.03 && down.truck <= flat.truck * 1.03, `${down.over} car-steps over`);
  check("fuel: more per km uphill, less down", up.perKm > 1.5 * flat.perKm && down.perKm < flat.perKm);
  check("hills off (grades 0): as the flat", Math.abs(off.car - flat.car) < 1e-9 && Math.abs(off.truck - flat.truck) < 1e-9 && Math.abs(off.perKm - flat.perKm) < 1e-12);
  check("no collisions", flat.collisions + up.collisions + down.collisions === 0);
  // (no heights: the same as a sketch that never had any, step by step)
  const a = new SketchSim(road(null), road(null).traffic!, 1), b = new SketchSim({ ...road(null), geo: undefined }, road(null).traffic!, 1);
  let same = true;
  for (let i = 0; i < 3000 && same; i++) { a.step(0.1); b.step(0.1); same = a.vehicles.length === b.vehicles.length && a.vehicles.every((v, k) => v.pos === b.vehicles[k].pos && v.v === b.vehicles[k].v); }
  check("no heights: exactly as before, step by step", same);
}

console.log(bad ? `terrain check: ${bad} FAILED` : "terrain check: all ok");
if (bad) process.exit(1);
