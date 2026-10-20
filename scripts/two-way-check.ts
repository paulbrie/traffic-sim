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
 * - its rule changed under way (setSketch): no collision; made one way and back: no crash, cars go on;
 * - connected both ways: a junction's ways in, its lights and its signs take the way back (its connectors leaving the
 *   lane's start), cars on it go on green; linking roads, the roundabout stamp, slicing, reversing, merging, the route
 *   traced and the green wave's distance go both ways.
 * npm run two-way:check
 */
import { SketchSim, DEFAULT_SIM } from "../src/lib/lane-sketch-sim";
import { connectorPts, turnArrows, drivable, entryLanes, exitLanes, laneById, sanitizeSketch, setInRate, setOutWeight, setTwoWay, twinId, LANE_WIDTH, DEFAULT_LIGHTS,
  junctionApproaches, junctionContents, signalPlan, setControl, linkRoads, sliceLane, reverseLane, splitExits, junctionDistance, type Sketch, type SketchLane, type TwoWay } from "../src/lib/lane-sketch";
import { stampRoundabout } from "../src/lib/roundabout";
import { traceRoute } from "../src/lib/route-trace";
import { mergeLanes } from "../src/lib/sketch-merge";
import { junctionWarnings } from "../src/lib/junction-warnings";

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

// (5) connected both ways (the user's word on ticket #53): what makes and reads connectors takes the way back
{
  // (a junction at the bridge's west end, lights on: its ways in lane a and the way back, held at their ends)
  const sk0 = bridge("turns", 300, 300), T = twinId("L");
  const J = { id: "j1", name: "West end", outline: [{ x: 95, y: -8 }, { x: 118, y: -8 }, { x: 118, y: 8 }, { x: 95, y: 8 }], lights: { ...DEFAULT_LIGHTS } };
  const sk: Sketch = { ...sk0, junctions: [J] };
  const ways = junctionApproaches(sk, junctionContents(sk, J)).map(w => w.lanes.join("+")).sort().join(" "), plan = signalPlan(sk, J, junctionContents(sk, J));
  const dPlan = signalPlan(drivable(sk), J, junctionContents(drivable(sk), J));
  check("junction ways in", ways === `${T} a` && !!plan && plan.controlled.includes("c4") && JSON.stringify(plan.phases.map(p => p.conns)) === JSON.stringify(dPlan?.phases.map(p => p.conns)),
    `ways in ${ways}; lights hold ${plan?.controlled.join(",")}; phases ${JSON.stringify(plan?.phases.map(p => p.conns))} (the cars' ${JSON.stringify(dPlan?.phases.map(p => p.conns))})`);
  // (by hand: a phase each; the cars the way back go on green, not held for ever)
  const hand: Sketch = { ...sk, junctions: [{ ...J, lights: { ...DEFAULT_LIGHTS, phases: [{ name: "East", green: 15, conns: ["c1"] }, { name: "West", green: 15, conns: ["c4"] }] } }] };
  const r = run(hand, 600);
  check("lights by hand", r.n("b") > 15 && r.n("c") > 15 && r.s.collisions === 0, `west ${r.n("b")} through, east ${r.n("c")}, longest still ${r.maxWait.toFixed(0)} s`);
  // (a sign for the way back: on the lane, as backControl; the cars' way back has it)
  const signed = setControl(sk0, T, "stop");
  check("sign on the way back", signed.lanes.find(l => l.id === "L")!.backControl === "stop" && !signed.lanes.find(l => l.id === "L")!.control && drivable(signed).lanes.find(l => l.id === T)?.control === "stop",
    `L control ${signed.lanes.find(l => l.id === "L")!.control}, backControl ${signed.lanes.find(l => l.id === "L")!.backControl}`);
  const shares = splitExits(sk, junctionContents(sk, J), junctionApproaches(sk, junctionContents(sk, J)).find(w => w.lanes.includes(T))!).map(x => `${x.name}:${x.turn}`).join(" ");
  check("turning shares from the way back", shares === "West:S", shares);
  const tr = traceRoute(sk0, "d", "b");
  check("route traced through the way back", tr.ok && tr.route.steps.some(x => x.kind === "lane" && x.id === T), tr.ok ? tr.route.steps.map(x => (x.kind === "change" ? "~" : x.id)).join(" ") : tr.reason);
}
{
  // (two roads of one lane both ways, end to start 20 m apart, linked: a connector each way)
  const sk: Sketch = { lanes: [line("P", 0, 0, 100, 0, { twoWay: "turns" }), line("Q", 120, 0, 220, 0, { twoWay: "turns" })], connectors: [],
    roads: [{ id: "rp", name: "P", lanes: ["P"] }, { id: "rq", name: "Q", lanes: ["Q"] }], junctions: [], traffic: { rate: 300, speed: 50, seed: 1 } };
  const k = linkRoads(sk, "rp", "rq", "k1"), cs = (k?.connectors ?? []).map(c => `${c.from.lane}@${c.from.s}>${c.to.lane}@${c.to.s}`).sort().join(" ");
  check("link both ways", cs === "P@100>Q@0 Q@0>P@100", cs);
  // (and to a road of two lanes, one each way)
  const two: Sketch = { ...sk, lanes: [sk.lanes[0], line("q1", 120, -H, 220, -H), line("q2", 220, H, 120, H)], roads: [sk.roads[0], { id: "rq", name: "Q", lanes: ["q1", "q2"] }] };
  const k2 = linkRoads(two, "rp", "rq", "k1"), cs2 = (k2?.connectors ?? []).map(c => `${c.from.lane}@${c.from.s}>${c.to.lane}@${c.to.s}`).sort().join(" ");
  check("link both ways to a two-lane road", cs2 === "P@100>q1@0 q2@100>P@100", cs2);
}
{
  // (a roundabout stamped where a lane both ways ends, and one starts: on and off by each, a give-way line for each way on)
  const sk: Sketch = { lanes: [line("W", -100, 0, -25, 0, { twoWay: "turns" }), line("E", 25, 0, 100, 0, { twoWay: "turns" })], connectors: [], roads: [], junctions: [], traffic: { rate: 300, speed: 50, seed: 1 } };
  const st = stampRoundabout(sk, { x: 0, y: 0 }, 12), ring = st.ring, cs = st.sketch.connectors;
  const on = (id: string, s: number) => cs.some(c => c.from.lane === id && Math.abs(c.from.s - s) < 0.1 && c.to.lane === ring);
  const off = (id: string, s: number) => cs.some(c => c.to.lane === id && Math.abs(c.to.s - s) < 0.1 && c.from.lane === ring);
  const W = st.sketch.lanes.find(l => l.id === "W")!, E = st.sketch.lanes.find(l => l.id === "E")!;
  const warn = junctionWarnings(st.sketch).filter(w => w.kind === "entry-no-give-way").length;
  check("roundabout both ways", on("W", 75) && off("W", 75) && on("E", 0) && off("E", 0) && W.control === "yield" && E.backControl === "yield" && warn === 0,
    `${st.report.ins} on, ${st.report.outs} off; W control ${W.control}, E backControl ${E.backControl}; ${warn} give-way warnings`);
  // (the cars on it: in at both outer ends, out at both, none stuck for good; and with a way in and out more, by priority to
  // those leaving the ring, or each way in turn: those waiting on the ring to go off onto one wait a while, then go round)
  const r = run(st.sketch, 600);
  check("roundabout both ways, driven", r.s.collisions === 0 && r.s.finished > 30 && r.together === 0 && r.maxWait < 60, `${r.s.spawned} in, ${r.s.finished} out, ${r.s.collisions} collisions, longest still ${r.maxWait.toFixed(0)} s`);
  for (const [w, e] of [["back", "forward"], ["turns", "turns"]] as const) {
    const four: Sketch = { ...sk, lanes: [line("W", -100, 0, -25, 0, { twoWay: w }), line("E", 25, 0, 100, 0, { twoWay: e }), line("N", 0, 100, 0, 25), line("S", 0, -25, 0, -100)] };
    const r4 = run(stampRoundabout(four, { x: 0, y: 0 }, 12).sketch, 900);
    check(`roundabout, four ways, ${w}/${e}`, r4.s.collisions === 0 && r4.s.finished > 120 && r4.together === 0 && r4.maxWait < 120, `${r4.s.spawned} in, ${r4.s.finished} out, ${r4.s.collisions} collisions, longest still ${r4.maxWait.toFixed(0)} s`);
  }
}
{
  // (sliced: both stretches both ways, the way back's connectors at the ends where they were)
  const sk = bridge("forward", 300, 300), cut = sliceLane(sk, "L", 80, "L2")!;
  const L1 = cut.lanes.find(l => l.id === "L")!, L2 = cut.lanes.find(l => l.id === "L2")!, c3 = cut.connectors.find(c => c.id === "c3")!, c4 = cut.connectors.find(c => c.id === "c4")!;
  check("slice", L1.twoWay === "forward" && L2.twoWay === "forward" && L2.backInRate === 300 && L1.backInRate === undefined && c3.to.lane === "L2" && c3.to.s === 120 && c4.from.lane === "L" && c4.from.s === 0,
    `L ${L1.twoWay}, L2 ${L2.twoWay} (way back in ${L2.backInRate}/h); c3 to ${c3.to.lane}@${c3.to.s}, c4 from ${c4.from.lane}@${c4.from.s}`);
  // (reversed: the same way has priority, its traffic in with it)
  const rev = reverseLane(sk, "L").lanes.find(l => l.id === "L")!;
  check("reverse", rev.twoWay === "back" && rev.inRate === 300 && rev.backInRate === undefined, `rule ${rev.twoWay}, inRate ${rev.inRate}, backInRate ${rev.backInRate}`);
  // (merged with the stretch it was sliced from, joined both ways: one lane both ways again; with a lane one way: not)
  const joined: Sketch = { ...cut, connectors: [...cut.connectors, { id: "x1", from: { lane: "L", s: 80 }, to: { lane: "L2", s: 0 } }, { id: "x2", from: { lane: "L2", s: 0 }, to: { lane: "L", s: 80 } }] };
  const m = mergeLanes(joined, "L", "L2"), ml = m.ok ? m.sketch.lanes.find(l => l.id === "L") : null;
  const one = mergeLanes(setTwoWay(joined, "L2", null), "L", "L2");
  check("merge", m.ok && ml?.twoWay === "forward" && ml.backInRate === 300 && !m.sketch.connectors.some(c => c.id === "x1" || c.id === "x2") && !one.ok,
    m.ok ? `merged ${ml?.twoWay}, way back in ${ml?.backInRate}/h; with a lane one way: ${one.ok ? "merged" : one.reason}` : m.reason);
}
{
  // (the green wave's distance from a junction at the east end to one at the west, by the way back)
  const sk0 = bridge("turns", 300, 300);
  const JW = { id: "jw", name: "West", outline: [{ x: 95, y: -8 }, { x: 118, y: -8 }, { x: 118, y: 8 }, { x: 95, y: 8 }] };
  const JE = { id: "je", name: "East", outline: [{ x: 302, y: -8 }, { x: 325, y: -8 }, { x: 325, y: 8 }, { x: 302, y: 8 }] };
  const sk: Sketch = { ...sk0, junctions: [JW, JE] }, d = junctionDistance(sk, JE, JW), d2 = junctionDistance(sk, JW, JE);
  check("green wave distance both ways", d !== null && d2 !== null && Math.abs(d - d2) < 5, `east to west ${d?.toFixed(0)} m, west to east ${d2?.toFixed(0)} m`);
}

if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
