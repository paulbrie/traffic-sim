/**
 * Bike lanes (ticket #20): a lane marked `bike` is drawn and kept with the plan, but no vehicle runs on it for now:
 * the simulation, the routes and the Demand panel's entry and exit lanes all leave bike lanes and their connectors
 * out (see `drivable`). Checks:
 * - a 300 m road, two car lanes and a bike lane at its border, traffic at every lane's start: no vehicle is ever on
 *   the bike lane, cars still come and go, and the bike lane is no entry or exit lane;
 * - car lane → connector → bike lane → connector → car lane: no vehicle on the bike lane or its connectors, the first
 *   car lane is an exit, the last an entry (both see cars), as the UI's Demand panel shows them;
 * - a sketch of bike lanes only: runs, no vehicle, no crash;
 * - a lane switched to bike while cars are on it (setSketch, as the worker does on an edit): none on it afterwards;
 * - setLaneUse: bus and bike exclusive, a 3.5 m lane narrowed to 2 m as a bike lane and back; sanitizeSketch keeps
 *   `bike` and drops `bus` beside it;
 * - the markings: a solid line between the bike lane and the car lane beside it, the dashed one between the car lanes.
 * npm run bike:check
 */
import { SketchSim, DEFAULT_SIM } from "../src/lib/lane-sketch-sim";
import { entryLanes, exitLanes, laneUse, roadMarkings, sanitizeSketch, setLaneUse, BIKE_LANE_WIDTH, LANE_WIDTH, type Sketch, type SketchLane } from "../src/lib/lane-sketch";

const traffic = { rate: 900, speed: 50, seed: 1 };
const line = (id: string, y: number, x0: number, x1: number, bike = false): SketchLane =>
  ({ id, width: bike ? BIKE_LANE_WIDTH : LANE_WIDTH, shape: { kind: "line", pts: [{ x: x0, y }, { x: x1, y }] }, ...(bike ? { bike: true as const } : {}) });

function run(sk: Sketch, seconds: number, banned: Set<string>, sim = new SketchSim(sk, { ...(sk.traffic ?? DEFAULT_SIM), seed: 1 }, 1)) {
  let onBanned = 0, ticks = 0;
  const lanesSeen = new Set<string>();
  for (let i = 0; i < seconds / 0.1; i++) {
    sim.step(0.1);
    for (const v of sim.vehicles) {
      ticks++;
      if (banned.has(v.edge.id)) onBanned++;
      if (v.edge.kind === "lane") lanesSeen.add(v.edge.id);
    }
  }
  const s = sim.stats();
  return { sim, onBanned, ticks, lanesSeen, in: s.spawned, out: s.finished };
}

let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { if (!ok) bad++; console.log(`${label}: ${detail} | ok ${ok}`); };
const ids = (ls: SketchLane[]) => ls.map(l => l.id).sort().join(",");

// (1) a road with a bike lane at its border
{
  const lanes = [line("l0", 0, 0, 300), line("l1", 3.5, 0, 300), line("b", 3.5 + (LANE_WIDTH + BIKE_LANE_WIDTH) / 2, 0, 300, true)];
  const sk: Sketch = { lanes, connectors: [], roads: [{ id: "r1", name: "Road", lanes: lanes.map(l => l.id) }], junctions: [], traffic };
  const r = run(sk, 300, new Set(["b"]));
  const ins = ids(entryLanes(sk)), outs = ids(exitLanes(sk));
  check("bike lane on the road's border", r.onBanned === 0 && r.out > 0 && ins === "l0,l1" && outs === "l0,l1",
    `${r.ticks} vehicle-ticks, ${r.onBanned} on the bike lane, ${r.in} in / ${r.out} out, entries ${ins}, exits ${outs}`);
  // the markings: solid between l1 and the bike lane, dashed between l0 and l1
  const ms = roadMarkings(sk).filter(m => m.kind === "lane"), solid = ms.filter(m => !m.dashed), dashed = ms.filter(m => m.dashed);
  const yOf = (m: (typeof ms)[number]) => m.pts.reduce((a, p) => a + p.y, 0) / m.pts.length;
  const solidAt = solid.map(yOf), want = 3.5 + LANE_WIDTH / 2;
  check("markings beside the bike lane", solid.length === 1 && Math.abs(solidAt[0] - want) < 0.05 && dashed.length === 1,
    `${solid.length} solid line(s) at y ${solidAt.map(y => y.toFixed(2)).join(", ") || "-"} (want 1 at ${want}), ${dashed.length} dashed (want 1)`);
}

// (2) car lane → bike lane → car lane: the bike lane and its connectors left out
{
  const sk: Sketch = {
    lanes: [line("a", 0, 0, 100), line("b", 0, 110, 200, true), line("c", 0, 210, 300)],
    connectors: [{ id: "c1", from: { lane: "a", s: 100 }, to: { lane: "b", s: 0 } }, { id: "c2", from: { lane: "b", s: 90 }, to: { lane: "c", s: 0 } }],
    roads: [], junctions: [], traffic,
  };
  const r = run(sk, 300, new Set(["b", "c1", "c2"]));
  const ins = ids(entryLanes(sk)), outs = ids(exitLanes(sk));
  check("car → bike → car", r.onBanned === 0 && ins === "a,c" && outs === "a,c" && r.lanesSeen.has("a") && r.lanesSeen.has("c") && r.out > 0,
    `${r.ticks} vehicle-ticks, ${r.onBanned} on the bike lane or its connectors, lanes driven ${[...r.lanesSeen].sort().join(",")}, entries ${ins}, exits ${outs}, ${r.in} in / ${r.out} out`);
  // (the control: the same with b a car lane, driven through)
  const plain: Sketch = { ...sk, lanes: sk.lanes.map(l => (l.id === "b" ? line("b", 0, 110, 200) : l)) };
  const p = run(plain, 300, new Set());
  check("car → car → car (control)", p.lanesSeen.has("b") && ids(entryLanes(plain)) === "a" && ids(exitLanes(plain)) === "c",
    `lanes driven ${[...p.lanesSeen].sort().join(",")}, entries ${ids(entryLanes(plain))}, exits ${ids(exitLanes(plain))}`);
}

// (3) bike lanes only
{
  const sk: Sketch = { lanes: [line("b1", 0, 0, 200, true), line("b2", 10, 0, 200, true)], connectors: [], roads: [], junctions: [], traffic };
  let r: ReturnType<typeof run> | null = null, err = "";
  try { r = run(sk, 120, new Set(["b1", "b2"])); } catch (e) { err = String(e); }
  check("bike lanes only", !err && !!r && r.ticks === 0 && entryLanes(sk).length === 0, err || `${r!.ticks} vehicle-ticks, ${r!.in} in`);
}

// (4) a lane switched to bike while cars run on it
{
  const sk: Sketch = { lanes: [line("l0", 0, 0, 600), line("l1", 3.6, 0, 600)], connectors: [], roads: [{ id: "r1", name: "Road", lanes: ["l0", "l1"] }], junctions: [], traffic };
  const before = run(sk, 60, new Set());
  const was = before.sim.vehicles.filter(v => v.edge.id === "l1").length;
  const next = setLaneUse(sk, "l1", "bike");
  before.sim.setSketch(next);
  const after = run(next, 120, new Set(["l1"]), before.sim);
  check("switched to bike under way", was > 0 && after.onBanned === 0 && after.out > 0,
    `${was} on l1 before, ${after.onBanned} vehicle-ticks on it after, ${after.out} out`);
}

// (5) setLaneUse and sanitizeSketch
{
  const sk: Sketch = { lanes: [line("l0", 0, 0, 100)], connectors: [], roads: [], junctions: [] };
  const bike = setLaneUse(sk, "l0", "bike"), bus = setLaneUse(bike, "l0", "bus"), car = setLaneUse(bus, "l0", "car");
  const lb = bike.lanes[0], lu = bus.lanes[0], lc = car.lanes[0];
  const wide = setLaneUse({ ...sk, lanes: [{ ...sk.lanes[0], width: 4.5 }] }, "l0", "bike").lanes[0];
  const okUse = laneUse(lb) === "bike" && lb.width === BIKE_LANE_WIDTH && !lb.bus && laneUse(lu) === "bus" && !lu.bike && lu.width === LANE_WIDTH && laneUse(lc) === "car" && !lc.bus && !lc.bike && wide.width === 4.5;
  check("setLaneUse", okUse, `bike ${lb.width} m, then bus ${lu.width} m (bike ${!!lu.bike}), then car (bus ${!!lc.bus}, bike ${!!lc.bike}); a 4.5 m lane kept ${wide.width} m`);
  const raw = JSON.parse(JSON.stringify({ ...sk, lanes: [{ ...sk.lanes[0], bike: true, bus: true }, { ...line("l1", 5, 0, 100), bike: "yes" }] }));
  const back = sanitizeSketch(raw);
  const s0 = back?.lanes.find(l => l.id === "l0"), s1 = back?.lanes.find(l => l.id === "l1");
  check("sanitizeSketch", !!s0 && s0.bike === true && !s0.bus && !!s1 && !s1.bike, `l0 bike ${s0?.bike} bus ${s0?.bus}; l1 (bike: "yes") bike ${s1?.bike}`);
}

if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
