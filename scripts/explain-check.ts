/**
 * The per-car explanation (T157, lane-sketch-sim's `explain`) in a few known situations, on small sketches with test cars only:
 * a car giving way where its lane joins another (merge, with the gap seen and needed), a car waiting at a crossing (the zone on
 * both paths), two lanes zipping into one, a way in held back behind a broken-down car, and a two-car cycle (chain and deadlock).
 * Then a moment past, from the recording.   npx tsx scripts/explain-check.ts
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import { headline } from "../src/lib/car-explain";
import type { Sketch, SketchConnector, SketchLane } from "../src/lib/lane-sketch";

const line = (id: string, pts: [number, number][], more: Partial<SketchLane> = {}): SketchLane => ({ id, width: 3.5, inRate: 0, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) }, ...more });
const conn = (id: string, f: string, fs: number, t: string, ts: number): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: ts } });
const sketch = (lanes: SketchLane[], connectors: SketchConnector[] = [], extra: Partial<Sketch> = {}): Sketch => ({ lanes, connectors, roads: [], junctions: [], traffic: { rate: 0, speed: 50, seed: 1 }, ...extra });
type Sim = SketchSim & { vehicles: { id: number; why: string | null; still: number }[] };
const make = (sk: Sketch) => new SketchSim(sk, { ...sk.traffic!, seed: 1 }, 1) as unknown as Sim;
const results: string[] = [];
let allOk = true;
const report = (name: string, ok: boolean, text: string) => { results.push(`${name}: ${text} | ok ${ok}`); allOk &&= ok; };

// giving way where its lane joins the main one: the main road's car comes, the other waits at its line for the gap
{
  let found: string | null = null;
  for (const delay of [4, 5, 6, 7, 8, 9]) {
    const sim = make(sketch([line("M", [[0, 0], [300, 0]]), line("X", [[310, 0], [400, 0]]), line("A", [[150, -80], [150, -6]], { control: "yield" })],
      [conn("cMX", "M", 300, "X", 0), conn("cA", "A", 74, "M", 158)]));
    const m = sim.sendTest("M", "X")!;
    let a: number | null = null;
    for (let t = 0; t < 30 && !found; t += 0.1) {
      if (a === null && sim.t >= delay) { a = sim.sendTest("A", "X"); sim.watch(a); }
      sim.step(0.1);
      const x = a !== null ? sim.explain(a) : null;
      if (x?.traced && x.rule?.kind === "merge" && x.blocker?.car === m && x.blocker.gap !== undefined && x.blocker.needGap !== undefined && x.blocker.gap < x.blocker.needGap && x.stopAt)
        found = `sent after ${delay} s: ${headline(x).text}; stops ${x.stopAt.dist.toFixed(1)} m ahead`;
    }
    if (found) break;
  }
  report("give way merging", !!found, found ?? "never seen waiting for the main road's car");
}

// waiting at a crossing: the later car waits for the one in the zone; the zone on both paths
{
  const sim = make(sketch([line("H", [[0, 0], [200, 0]]), line("V", [[100, -100], [100, 100]])]));
  const h = sim.sendTest("H", "H")!;
  for (let i = 0; i < 6; i++) sim.step(0.1);
  const v = sim.sendTest("V", "V")!;
  sim.watch(v);
  let found: string | null = null;
  for (let t = 0; t < 25 && !found; t += 0.1) {
    sim.step(0.1);
    const x = sim.explain(v);
    if (x?.traced && (x.rule?.kind === "zone" || x.rule?.kind === "priority" || x.rule?.kind === "give-way") && x.blocker?.car === h && (x.blocker.zone?.mine.length ?? 0) > 0 && (x.blocker.zone?.theirs.length ?? 0) > 0 && x.blocker.theirSec !== undefined)
      found = `${headline(x).text}; zone ${x.blocker.zone!.mine.length} + ${x.blocker.zone!.theirs.length} points, theirs ${x.blocker.theirSec} s, mine ${x.blocker.mySec} s`;
  }
  report("zone at a crossing", !!found, found ?? "never seen waiting for the other car");
}

// two lanes of one road zipping into one: one follows the other in
{
  let found: string | null = null;
  for (const watch of [0, 1]) {
    const sim = make(sketch([line("P", [[0, -1.75], [100, -1.75]]), line("Q", [[0, 1.75], [100, 1.75]]), line("R", [[115, 0], [300, 0]])],
      [conn("cP", "P", 100, "R", 0), conn("cQ", "Q", 100, "R", 0)], { roads: [{ id: "r1", name: "Two lanes", lanes: ["P", "Q"] }] }));
    const ids = [sim.sendTest("P", "R")!, sim.sendTest("Q", "R")!];
    sim.watch(ids[watch]);
    for (let t = 0; t < 25 && !found; t += 0.1) {
      sim.step(0.1);
      const x = sim.explain(ids[watch]);
      if (x?.traced && x.rule?.kind === "merge" && x.rule.detail === "zip" && x.blocker === null && x.leader?.car === ids[1 - watch]) found = `car ${ids[watch]}: ${headline(x).text} (zip)`;
      if (x?.traced && x.rule?.kind === "merge" && x.rule.detail === "zip") found ??= `car ${ids[watch]}: zip behind car ${x.chain[0]}`;
    }
    if (found) break;
  }
  report("zip", !!found, found ?? "no zip seen");
}

// held back: a way in with a broken-down car at its start; arrivals there can't come in
{
  const sim = make(sketch([line("E", [[0, 0], [120, 0]], { inRate: 3000 })]));
  for (let i = 0; i < 40; i++) sim.step(0.1);
  // (one at the start, broken down there)
  const first = sim.vehicles.reduce((a, b) => (Math.abs((b as unknown as { pos: number }).pos) < Math.abs((a as unknown as { pos: number }).pos) ? b : a));
  sim.breakDown(first.id);
  sim.watch(first.id);
  for (let i = 0; i < 300; i++) sim.step(0.1);
  const st = sim.stats() as unknown as { heldBack: number; heldBackBy?: Record<string, number> }, x = sim.explain(first.id);
  const ok = st.heldBack > 0 && x?.rule?.kind === "broken";
  report("held back", ok, `${st.heldBack} arrivals held back${st.heldBackBy ? ` (${JSON.stringify(st.heldBackBy)})` : ""}; the car at the start: ${x ? headline(x).text : "gone"}`);
}

// a two-car cycle: each waits for the other (as the deadlock breaker finds them); a third waits on the ring
{
  const sim = make(sketch([line("H", [[0, 0], [200, 0]]), line("V", [[100, -100], [100, 100]]), line("W", [[0, 50], [200, 50]])]));
  const a = sim.sendTest("H", "H")!, b = sim.sendTest("V", "V")!, c = sim.sendTest("W", "W")!;
  sim.step(0.1);
  const car = (id: number) => sim.vehicles.find(v => v.id === id)!;
  car(a).why = `zone lane:V for car ${b}`; car(b).why = `zone lane:H for car ${a}`; car(c).why = `car ${a}`;
  // (standing, as cars in a deadlock are: on the move it wouldn't be one)
  for (const id of [a, b]) (car(id) as unknown as { v: number }).v = 0;
  const xa = sim.explain(a)!, xc = sim.explain(c)!;
  const ok = JSON.stringify(xa.chain) === JSON.stringify([b, a]) && JSON.stringify(xa.deadlock) === JSON.stringify([a, b])
    && JSON.stringify(xc.chain) === JSON.stringify([a, b, a]) && JSON.stringify(xc.deadlock) === JSON.stringify([a, b]) && /Deadlock/.test(headline(xa).text);
  report("two-car cycle", ok, `car ${a}: chain ${JSON.stringify(xa.chain)} deadlock ${JSON.stringify(xa.deadlock)}; car ${c} behind it: chain ${JSON.stringify(xc.chain)} deadlock ${JSON.stringify(xc.deadlock)}`);
}

// a moment past: the car watched then, as traced; another, from the recording (its whys, gap, time standing)
{
  const sim = make(sketch([line("H", [[0, 0], [200, 0]]), line("V", [[100, -100], [100, 100]])]));
  const h = sim.sendTest("H", "H")!;
  for (let i = 0; i < 6; i++) sim.step(0.1);
  const v = sim.sendTest("V", "V")!;
  sim.watch(v);
  let waited = -1;
  for (let i = 0; i < 250; i++) { sim.step(0.1); if (waited < 0 && sim.explain(v)?.blocker?.car === h) waited = sim.t; }
  const past = waited >= 0 ? sim.explain(v, waited) : null, other = waited >= 0 ? sim.explain(h, waited) : null, frame = waited >= 0 ? sim.replayAt(waited) : null;
  const ok = !!past?.traced && past.blocker?.car === h && !!other && !other.traced && other.speed === null && !!frame?.explain && frame.cars.every(c => c.still !== undefined);
  report("a moment past", ok, `car ${v} at ${waited.toFixed(1)} s: ${past ? headline(past).text : "none"} (traced ${past?.traced}); car ${h} then: ${other ? headline(other).text : "none"} (traced ${other?.traced}); the frame keeps gap and time standing for every car`);
}

// T161, who goes first by the junction's rules (the setting junctionRules 1): the right-hand rule at a plain crossing, whoever gets there first
const RULES: Partial<Sketch> = { traffic: { rate: 0, speed: 50, seed: 1, tune: { junctionRules: 1 } } };
{
  // (V runs north to south, H west to east: H comes from V's right, so V gives way, even arriving first)
  const sim = make(sketch([line("H", [[0, 0], [200, 0]]), line("V", [[100, -100], [100, 100]])], [], RULES));
  const v = sim.sendTest("V", "V")!;
  for (let i = 0; i < 4; i++) sim.step(0.1);
  const h = sim.sendTest("H", "H")!;
  const k = (sim as unknown as { edges: Map<string, { conflicts: { other: { key: string }; prio: number; prioWhy: string }[] }> }).edges.get("lane:V")!.conflicts.find(x => x.other.key === "lane:H")!;
  let hWaited = false, vWaited = false;
  for (let i = 0; i < 300; i++) { sim.step(0.1); const car = (id: number) => sim.vehicles.find(x => x.id === id); if (car(h)?.why?.includes(`car ${v}`)) hWaited = true; if (car(v)?.why?.includes(`car ${h}`)) vWaited = true; }
  const ok = k.prio === -1 && k.prioWhy === "from the right" && vWaited && !hWaited;
  report("right-hand rule", ok, `V against H: ${k.prio} (${k.prioWhy}); the car from the left waited ${vWaited}, the one from the right waited ${hWaited}`);
}

// a roundabout's roles: a lane across its middle gives way to the ring; the ring's ways off go before its ways on
{
  const ring: SketchLane = { id: "R", width: 4, inRate: 0, shape: { kind: "arc", c: { x: 0, y: 0 }, r: 10, a0: 0, sweep: -2 * Math.PI } as SketchLane["shape"] };
  const sim = make(sketch([ring, line("X", [[-40, 1], [40, 1]]), line("IN", [[-40, 30], [-12, 6]], { control: "yield" }), line("OUT", [[6, 12], [30, 40]])],
    [conn("cIn", "IN", 36.9, "R", 20), conn("cOut", "R", 52, "OUT", 0)], RULES));
  const E = (sim as unknown as { edges: Map<string, { conflicts: { other: { key: string }; prio: number; prioWhy: string }[] }> }).edges;
  const across = E.get("lane:X")!.conflicts.filter(x => x.other.key === "lane:R"), xr = across.every(x => x.prio === -1 && x.prioWhy === "roundabout");
  const ok = across.length > 0 && xr;
  report("roundabout roles", ok, `the lane across the middle against the ring: ${across.map(x => `${x.prio} (${x.prioWhy})`).join(", ") || "no conflict"}`);
}

// patience and no flip-flop: a car at a give-way line facing a steady main road gets through, and once it sets off it doesn't stop again
{
  const sim = make(sketch([line("M", [[0, 0], [300, 0]], { inRate: 1500 }), line("A", [[150, -80], [150, -8]], { control: "yield" }), line("B", [[150, 8], [150, 80]])],
    [conn("cAB", "A", 72, "B", 0)], { traffic: { rate: 0, speed: 50, seed: 1, tune: { junctionRules: 1 } } }));
  for (let i = 0; i < 300; i++) sim.step(0.1);
  const a = sim.sendTest("A", "B")!;
  sim.watch(a);
  let maxStill = 0, flips = 0, last: string | null = null, freeAt = -1, through = false;
  for (let i = 0; i < 900 && !through; i++) {
    sim.step(0.1);
    const car = sim.vehicles.find(x => x.id === a);
    if (!car) { through = true; break; }
    maxStill = Math.max(maxStill, car.still);
    const z = car.why?.startsWith("zone ") ? car.why.replace(/ for car .*/, "") : null;
    if (z) { if (last === z && freeAt >= 0 && sim.t - freeAt <= 1) flips++; last = z; freeAt = -1; } else if (last && freeAt < 0) freeAt = sim.t;
    if ((car as unknown as { edge: { key: string } }).edge.key === "lane:B") through = true;
  }
  const ok = through && maxStill < 30 && flips === 0;
  report("patience, no flip-flop", ok, `through ${through}, longest standing ${maxStill.toFixed(1)} s, flip-flops ${flips}`);
}

// T166: giving up a lane change never drives into a loop no way leaves; cars following one another on the move aren't a deadlock
{
  // (A leads only onto a ring with no way off; B, beside it in one road, leads to X: a car for X on A, kept waiting to change, gives up)
  const ring: SketchLane = { id: "R", width: 4, inRate: 0, shape: { kind: "arc", c: { x: 115, y: -20 }, r: 10, a0: 0, sweep: -2 * Math.PI } as SketchLane["shape"] };
  const sim = make(sketch([line("A", [[0, 0], [100, 0]]), line("B", [[0, 3.5], [100, 3.5]]), line("X", [[110, 3.5], [200, 3.5]]), ring],
    [conn("cAR", "A", 100, "R", 0), conn("cBX", "B", 100, "X", 0)], { roads: [{ id: "r1", name: "Two lanes", lanes: ["A", "B"] }] }));
  const a = sim.sendTest("A", "X")!;
  sim.step(0.1);
  const car = sim.vehicles.find(v => v.id === a) as unknown as { goal: { conn: { key: string } | null } | null; exit: unknown };
  const before = car.goal?.conn?.key ?? null;
  (sim as unknown as { plan: (v: unknown, own: boolean) => void }).plan(car, true);
  const gaveUpTo = car.goal?.conn?.key ?? null;
  const ok = before === "conn:cBX" && gaveUpTo === null;
  report("no give-up into a dead loop", ok, `its way there ${before}; giving up, from its own lane it would take ${gaveUpTo ?? "nothing (it keeps waiting to change)"}`);
}
{
  const sim = make(sketch([line("H", [[0, 0], [200, 0]]), line("V", [[100, -100], [100, 100]])]));
  const a = sim.sendTest("H", "H")!, b = sim.sendTest("V", "V")!;
  sim.step(0.1);
  const car = (id: number) => sim.vehicles.find(v => v.id === id)! as unknown as { why: string | null; v: number };
  car(a).why = `car ${b}`; car(b).why = `car ${a}`; car(a).v = 8; car(b).v = 8;
  const moving = sim.explain(a)!;
  car(a).v = 0; car(b).v = 0;
  const standing = sim.explain(a)!;
  const ok = JSON.stringify(moving.chain) === JSON.stringify([b, a]) && moving.deadlock === null && JSON.stringify(standing.deadlock) === JSON.stringify([a, b]);
  report("moving followers", ok, `on the move: chain ${JSON.stringify(moving.chain)}, deadlock ${JSON.stringify(moving.deadlock)}; standing: deadlock ${JSON.stringify(standing.deadlock)}`);
}

for (const r of results) console.log(r);
console.log(allOk ? "explain check: all ok" : "explain check: FAILED");
if (!allOk) process.exit(1);
