/**
 * One lane, both ways (ticket #53): a lane marked `twoWay` carries traffic along it and back, one way at a time, by its
 * rule (`turns`: each way in turn; `forward` / `back`: those coming in at its start / end first). Checks:
 * - a two-lane road narrowing to one lane for 200 m (a bridge) and back to two, traffic both ways, under each rule: never
 *   a car on the lane one way while one is on it the other way, no collision, cars through both ways; with priority, the
 *   way that has it gets more through than the other at the same demand; taking turns, about as many each way;
 * - a lane both ways on its own, traffic coming in at both its ends (a way in and out each way);
 * - `drivable`: the way back a lane (`twinId`), in the lane's road, the connectors joining it past its middle and leaving
 *   it before moved onto it; entry and exit lanes; `setInRate` / `setOutWeight` on the way back kept on its lane;
 *   `connectorPts` joining it at its end coming in the other way; turn arrows both ways; `sanitizeSketch` keeps `twoWay`, not on a ring;
 * - its rule changed under way (setSketch): no collision; made one way and back: no crash, cars go on.
 * npm run two-way:check
 */
import { SketchSim, DEFAULT_SIM } from "../src/lib/lane-sketch-sim";
import { connectorPts, turnArrows, drivable, entryLanes, exitLanes, laneById, sanitizeSketch, setInRate, setOutWeight, setTwoWay, twinId, LANE_WIDTH, type Sketch, type SketchLane, type TwoWay } from "../src/lib/lane-sketch";

const H = LANE_WIDTH / 2;
const line = (id: string, x0: number, y0: number, x1: number, y1: number, extra: Partial<SketchLane> = {}): SketchLane =>
  ({ id, width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }] }, ...extra });

/** east: a → L → c; west: d → L's way back → b. L is 200 m. */
function bridge(rule: TwoWay | null, east: number, west: number): Sketch {
  return {
    lanes: [line("a", 0, -H, 100, -H, { inRate: east }), line("b", 100, H, 0, H), line("L", 110, 0, 310, 0, rule ? { twoWay: rule, backInRate: west } : {}),
      line("c", 320, -H, 420, -H), line("d", 420, H, 320, H, { inRate: west })],
    connectors: [
      { id: "c1", from: { lane: "a", s: 100 }, to: { lane: "L", s: 0 } },
      { id: "c2", from: { lane: "L", s: 200 }, to: { lane: "c", s: 0 } },
      { id: "c3", from: { lane: "d", s: 100 }, to: { lane: "L", s: 200 } },
      { id: "c4", from: { lane: "L", s: 0 }, to: { lane: "b", s: 0 } },
    ],
    roads: [{ id: "r1", name: "West", lanes: ["a", "b"] }, { id: "r2", name: "Bridge", lanes: ["L"] }, { id: "r3", name: "East", lanes: ["c", "d"] }],
    junctions: [], traffic: { rate: 400, speed: 50, seed: 1 },
  };
}

function run(sk: Sketch, seconds: number, sim = new SketchSim(sk, { ...(sk.traffic ?? DEFAULT_SIM), seed: 1 }, 1)) {
  const both = sk.lanes.filter(l => l.twoWay).map(l => l.id);
  let together = 0, maxWait = 0;
  const reached = new Map<string, Set<number>>();
  for (let i = 0; i < seconds / 0.1; i++) {
    sim.step(0.1);
    for (const id of both) {
      const fw = sim.vehicles.some(v => v.edge.id === id), bw = sim.vehicles.some(v => v.edge.id === twinId(id));
      if (fw && bw) together++;
    }
    for (const v of sim.vehicles) {
      if (v.edge.kind === "lane") (reached.get(v.edge.id) ?? reached.set(v.edge.id, new Set()).get(v.edge.id)!).add(v.id);
      maxWait = Math.max(maxWait, v.still);
    }
  }
  const s = sim.stats(), n = (id: string) => reached.get(id)?.size ?? 0;
  return { sim, together, maxWait, n, s };
}

let bad = 0;
const check = (label: string, ok: boolean, detail: string) => { if (!ok) bad++; console.log(`${label}: ${detail} | ok ${ok}`); };

// (1) the bridge, under each rule (by priority at less traffic: at 500/h each way the way with priority hardly leaves a gap
// long enough for the other to cross 200 m, as on a real one)
const res: Record<string, ReturnType<typeof run>> = {};
for (const rule of ["turns", "forward", "back"] as const) {
  const r = run(rule === "turns" ? bridge(rule, 500, 500) : bridge(rule, 300, 300), 900);
  res[rule] = r;
  check(`bridge, ${rule}`, r.together === 0 && r.s.collisions === 0 && r.n("c") > (rule === "turns" ? 20 : 10) && r.n("b") > (rule === "turns" ? 20 : 10) && r.s.deadlocks === 0,
    `${r.together} steps with cars on it both ways, ${r.s.collisions} collisions, ${r.s.deadlocks} deadlocks, east ${r.n("c")} through, west ${r.n("b")} through, ${r.s.spawned} in, longest still ${r.maxWait.toFixed(0)} s`);
}
{
  const t = res.turns, f = res.forward, b = res.back;
  check("priority gets more through", f.n("c") > f.n("b") && b.n("b") > b.n("c"),
    `forward: east ${f.n("c")} / west ${f.n("b")}; back: east ${b.n("c")} / west ${b.n("b")}`);
  check("taking turns, fair", Math.abs(t.n("c") - t.n("b")) <= 0.25 * Math.max(t.n("c"), t.n("b")), `east ${t.n("c")} / west ${t.n("b")}`);
}
// (the control: one way only, no traffic the way back)
{
  const sk = bridge(null, 500, 500), r = run(sk, 300);
  check("one way (control)", r.n("c") > 20 && r.n("b") === 0, `east ${r.n("c")}, west ${r.n("b")}`);
}

// (2) a lane both ways on its own: in and out at both ends
{
  const sk: Sketch = { lanes: [line("L", 0, 0, 150, 0, { twoWay: "turns" })], connectors: [], roads: [], junctions: [], traffic: { rate: 300, speed: 50, seed: 1 } };
  const ins = entryLanes(sk).map(l => l.id).sort().join(","), outs = exitLanes(sk).map(l => l.id).sort().join(",");
  const r = run(sk, 600);
  check("on its own", ins === `L,${twinId("L")}` && outs === ins && r.together === 0 && r.s.collisions === 0 && r.n("L") > 10 && r.n(twinId("L")) > 10,
    `entries ${ins}, exits ${outs}, ${r.together} steps both ways, along ${r.n("L")}, back ${r.n(twinId("L"))}, ${r.s.finished} out`);
}

// (3) the model
{
  const sk = bridge("turns", 500, 300), d = drivable(sk), T = twinId("L");
  const back = d.lanes.find(l => l.id === T), c3 = d.connectors.find(c => c.id === "c3")!, c4 = d.connectors.find(c => c.id === "c4")!;
  check("drivable", !!back && back.inRate === 300 && back.shape.kind === "line" && back.shape.pts[0].x === 310 && c3.to.lane === T && c3.to.s === 0 && c4.from.lane === T && c4.from.s === 200
    && d.connectors.find(c => c.id === "c1")!.to.lane === "L" && d.roads.find(r => r.id === "r2")!.lanes.join(",") === `L,${T}` && drivable(d) === d,
    `way back ${back?.id} from x ${back?.shape.kind === "line" ? back.shape.pts[0].x : "?"} at ${back?.inRate}/h; c3 to ${c3.to.lane}@${c3.to.s}, c4 from ${c4.from.lane}@${c4.from.s}; road ${d.roads.find(r => r.id === "r2")!.lanes.join(",")}`);
  const ins = entryLanes(sk).map(l => l.id).sort().join(","), outs = exitLanes(sk).map(l => l.id).sort().join(",");
  check("ways in and out", ins === "a,d" && outs === "b,c", `entries ${ins}, exits ${outs}`);
  const rated = setOutWeight(setInRate(sk, [T], 700), [T], 3), L = rated.lanes.find(l => l.id === "L")!;
  check("rates on the way back", L.backInRate === 700 && L.backOutWeight === 3 && L.inRate === undefined && laneById(rated, T)?.inRate === 700,
    `backInRate ${L.backInRate}, backOutWeight ${L.backOutWeight}, inRate ${L.inRate}, way back looked up at ${laneById(rated, T)?.inRate}/h`);
  // (c3 joins L at its end coming west: its last stretch runs west; c1 joins it at its start going east)
  const p3 = connectorPts(sk, sk.connectors.find(c => c.id === "c3")!)!, p1 = connectorPts(sk, sk.connectors.find(c => c.id === "c1")!)!;
  const dx = (p: { x: number }[]) => p[p.length - 1].x - p[p.length - 2].x;
  check("connector curves", dx(p3) < 0 && dx(p1) > 0, `c3 ends going ${dx(p3) < 0 ? "west" : "east"}, c1 ${dx(p1) > 0 ? "east" : "west"}`);
  // (turn arrows: along it at its end, and back at its start, both for lane L)
  const arrows = turnArrows(sk).filter(a => a.lane === "L").map(a => `${a.turns}@${Math.round(a.p.x)}${a.d.x > 0 ? "E" : "W"}`).sort().join(" ");
  check("turn arrows both ways", arrows === "S@116W S@304E", arrows);
  const raw = JSON.parse(JSON.stringify({ ...sk, lanes: [...sk.lanes, { id: "R", width: 3.5, shape: { kind: "arc", c: { x: 0, y: 50 }, r: 20, a0: 0, sweep: 2 * Math.PI }, twoWay: "turns" }, line("Z", 0, 90, 50, 90, { twoWay: "sideways" as TwoWay })] }));
  const back2 = sanitizeSketch(raw)!;
  check("sanitizeSketch", back2.lanes.find(l => l.id === "L")?.twoWay === "turns" && back2.lanes.find(l => l.id === "L")?.backInRate === 300 && !back2.lanes.find(l => l.id === "R")?.twoWay && !back2.lanes.find(l => l.id === "Z")?.twoWay,
    `L ${back2.lanes.find(l => l.id === "L")?.twoWay}, ring ${back2.lanes.find(l => l.id === "R")?.twoWay}, "sideways" ${back2.lanes.find(l => l.id === "Z")?.twoWay}`);
}

// (4) its rule changed under way (setSketch): no collision, cars go on; and made one way, and back: no crash (one way, the
// connectors of the way back join it at its end and leave at its start, against the traffic: cars there meet as drawn)
{
  const sk = bridge("forward", 600, 600), r = run(sk, 120);
  let err = "", hit = -1;
  try {
    for (const rule of ["turns", "back", "forward"] as const) { const x = setTwoWay(sk, "L", rule); r.sim.setSketch(x); run(x, 60, r.sim); }
    hit = r.sim.stats().collisions;
    const one = setTwoWay(sk, "L", null);
    r.sim.setSketch(one); run(one, 60, r.sim);
    r.sim.setSketch(sk); run(sk, 60, r.sim);
  } catch (e) { err = String(e); }
  const s = r.sim.stats();
  check("switched under way", !err && hit === 0 && s.finished > 40, err || `${s.spawned} in, ${s.finished} out, ${hit} collisions changing its rule`);
}

if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
