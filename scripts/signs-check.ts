/**
 * Give-way and stop signs in the V2 simulation, with nobody on the main road to wait for: a car at a give-way line slows to the
 * give-way speed (14 km/h as it comes) up to it and goes on; at a stop line it stops dead, then goes; with no sign it carries on at speed.
 * The side road joins at a slant (an on-ramp), so the turn itself slows nobody much. (Breaking the slowing at a give-way line, only a
 * roundabout's throughput in ring:check noticed: ticket #269.)
 * Then the main road busy (900 veh/h) and a side road (300 veh/h) coming up to it square, its connector turning onto it and running
 * along it for 8 m before it joins: no sign, give way and stop alike, the joining car keeps clear of the cars coming along that stretch
 * (it pulled out in front of them: 3 to 8 collisions in 15 min, ticket #270), and the side road still gets cars on. Again with the main
 * road a new lane 5 m before, joined 15 m along it: the cars still on their way onto it count too (1 to 9 collisions unseen).
 *   npm run signs:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import type { Sketch, SketchConnector, SketchLane } from "../src/lib/lane-sketch";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const line = (id: string, pts: [number, number][], more: Partial<SketchLane> = {}): SketchLane => ({ id, width: 3.5, inRate: 0, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) }, ...more });
const conn = (id: string, f: string, fs: number, t: string, ts: number): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: ts } });
// (the main road M west to east; the side road A, 150 m, coming up to it at a slant from the south-west, joining it at x 215)
const sketch = (control: "yield" | "stop" | null): Sketch => ({
  lanes: [line("M", [[0, 0], [400, 0]]), line("A", [[46, 46], [190, 6]], control ? { control } : {})],
  connectors: [conn("cA", "A", Math.hypot(144, 40), "M", 215)],
  roads: [], junctions: [], traffic: { rate: 0, speed: 50, seed: 1 },
});
type Car = { id: number; v: number; pos: number; edge: { id: string } };
type Sim = { sendTest: (from: string, to: string) => number | null; step: (dt: number) => void; t: number; vehicles: Car[] };

/** one car from A onto M, the main road empty: its slowest in the last 3 m up to the line, and whether it got on */
function alone(control: "yield" | "stop" | null) {
  const sim = new SketchSim(sketch(control), { rate: 0, speed: 50 }, 1) as unknown as Sim;
  const id = sim.sendTest("A", "M");
  let slowest = Infinity, on = false;
  while (sim.t < 60 && !on) {
    sim.step(0.1);
    const v = sim.vehicles.find(x => x.id === id);
    if (!v) break;
    if (v.edge.id === "A" && v.pos > Math.hypot(144, 40) - 3) slowest = Math.min(slowest, v.v * 3.6);
    if (v.edge.id === "M") on = true;
  }
  return { slowest, on };
}
const kmh = (x: number) => `${x.toFixed(1)} km/h`;
const g = alone("yield"), s = alone("stop"), n = alone(null);
// (from 14 km/h at the line, braking in comfort before it: about 20 in the last 3 m, the last step's sample up to half a metre short)
check("give way, nobody coming: slows to about the give-way speed at the line, and goes on", g.on && g.slowest <= 22 && g.slowest >= 8, `slowest ${kmh(g.slowest)} in the last 3 m`);
check("stop: stops dead at the line (under 0.2 m/s, as the sim counts it), and goes on", s.on && s.slowest < 0.75, `slowest ${kmh(s.slowest)}`);
check("no sign: carries on at speed", n.on && n.slowest > 25, `slowest ${kmh(n.slowest)}`);

/** the main road busy, 15 min: collisions, and the side road's cars onto it an hour */
function busy(control: "yield" | "stop" | null, nearStart = false) {
  const A = line("A", [[195, 156], [195, 6]], { inRate: 300, ...(control ? { control } : {}) });
  // (nearStart: the main road's lane starts at x 190, the one before it ending at 188)
  const sk: Sketch = nearStart
    ? { lanes: [line("P", [[0, 0], [188, 0]], { inRate: 900 }), line("M", [[190, 0], [400, 0]]), A], connectors: [conn("cP", "P", 188, "M", 0), conn("cA", "A", 150, "M", 15)], roads: [], junctions: [], traffic: { rate: 0, speed: 50, seed: 1 } }
    : { lanes: [line("M", [[0, 0], [400, 0]], { inRate: 900 }), A], connectors: [conn("cA", "A", 150, "M", 205)], roads: [], junctions: [], traffic: { rate: 0, speed: 50, seed: 1 } };
  const sim = new SketchSim(sk, { rate: 0, speed: 50 }, 1) as unknown as Sim & { stats: () => { collisions: number } };
  const fromA = new Set<number>(), on = new Set<number>();
  while (sim.t < 900) {
    sim.step(0.1);
    for (const v of sim.vehicles) if (v.edge.id === "cA") fromA.add(v.id); else if (v.edge.id === "M" && fromA.has(v.id)) on.add(v.id);
  }
  return { collisions: sim.stats().collisions, perHour: on.size * 4 };
}
for (const near of [false, true]) for (const c of [null, "yield", "stop"] as const) {
  const b = busy(c, near);
  check(`main road busy${near ? ", joined 15 m into its lane" : ""}, ${c ? (c === "yield" ? "give way" : "stop") : "no sign"}: no collisions where the side road joins, and it gets on`, b.collisions === 0 && b.perHour >= 100, `${b.collisions} collisions, ${b.perHour} /h on`);
}

console.log(ok ? "signs check: all ok" : "signs check: FAILED");
process.exit(ok ? 0 : 1);
