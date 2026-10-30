/**
 * Lights and a zebra on them, run together (ticket #112). A crossing between junctions (two ways in facing each other, a zebra across
 * both) gets its ways green together and a pedestrian phase of its own; with it off, two phases as before. A zebra across one way
 * only needs none (its people cross in the other way's green). Run: nobody is on the zebra while a car has green, people get across,
 * and so do the cars; the pedestrian phase comes only when someone waits (actuated). By hand, a phase with the zebra ticked runs its
 * whole green.   npm run peds:check
 */
import { DEFAULT_LIGHTS, pedWalkTime, signalPlans, type JunctionLights, type Sketch, type SketchConnector, type SketchCrossing, type SketchLane } from "../src/lib/lane-sketch";
import { SketchSim } from "../src/lib/lane-sketch-sim";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const line = (id: string, pts: [number, number][]): SketchLane => ({ id, width: 3.5, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) } });
const conn = (id: string, f: string, fs: number, t: string): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: 0 } });
// a road east-west, one lane each way, cut by a junction 12 m across at x = 0; the zebra across it there
const zebra = (half: "both" | "east"): SketchCrossing => ({ id: "x1", a: { x: 0, y: half === "both" ? -4 : -4 }, b: { x: 0, y: half === "both" ? 4 : 0 }, width: 4, peds: 600 });
const road = (lights: Partial<JunctionLights>, half: "both" | "east" = "both", peds = 600): Sketch => ({
  lanes: [line("A", [[-150, -1.75], [-6, -1.75]]), line("A2", [[6, -1.75], [150, -1.75]]), line("B", [[150, 1.75], [6, 1.75]]), line("B2", [[-6, 1.75], [-150, 1.75]])],
  connectors: [conn("cA", "A", 144, "A2"), conn("cB", "B", 144, "B2")],
  roads: [{ id: "rW", name: "West", lanes: ["A", "B2"] }, { id: "rE", name: "East", lanes: ["A2", "B"] }],
  junctions: [{ id: "j1", name: "Crossing", outline: [{ x: -6, y: -5 }, { x: 6, y: -5 }, { x: 6, y: 5 }, { x: -6, y: 5 }], lights: { ...DEFAULT_LIGHTS, ...lights } }],
  crossings: [{ ...zebra(half), peds }],
  traffic: { rate: 500, speed: 50, seed: 1 },
});
const plan = (sk: Sketch) => signalPlans(sk).find(p => p.junction === "j1")!;
const show = (sk: Sketch) => plan(sk).phases.map(p => `${p.name}: ${[...p.ways, ...(p.peds ?? []).map(x => `people at ${x}`)].join(" + ")} ${p.green} s`).join(" | ");

// the plans
{
  const sk = road({}), p = plan(sk), ped = p.phases.find(x => x.peds?.length);
  check("between junctions, a zebra across both ways: one phase for both ways, and a pedestrian phase", p.phases.length === 2 && p.phases[0].ways.length === 2 && !!ped && !ped.conns.length, show(sk));
  check("…its walk from the zebra's length", ped?.green === pedWalkTime(8) && ped?.minGreen === ped?.green, `${ped?.green} s`);
  check("…its seconds set by hand", plan(road({ walk: 25 })).phases.find(x => x.peds?.length)?.green === 25);
  const off = road({ pedPhase: false });
  check("pedestrian phase off: each way its own phase, as before", plan(off).phases.length === 2 && plan(off).phases.every(x => x.ways.length === 1 && !x.peds), show(off));
  const half = road({}, "east");
  check("a zebra across one way only: no phase of its own (they cross in the other way's green)", plan(half).phases.every(x => !x.peds), show(half));
  check("…still known as the lights' zebra", plan(half).crossings.length === 1 && plan(half).crossings[0].conns.join() === "cA");
}

// a run: who is on the zebra when
function run(sk: Sketch, T: number) {
  const sim = new SketchSim(sk, { rate: 500, speed: 50 }, 1), c = sim.signals.find(x => x.plan.junction === "j1")!;
  let onInGreen = 0, pedPhases = 0, wasPed = false;
  while (sim.t < T) {
    sim.step(0.1);
    const ph = c.plan.phases[c.phase], v = sim.peds().find(x => x.id === "x1")!;
    if (v.crossing && c.stage === "green" && ph.conns.length) onInGreen += 0.1;
    const isPed = !!ph.peds?.length && c.stage === "green";
    if (isPed && !wasPed) pedPhases++;
    wasPed = isPed;
  }
  const v = sim.peds().find(x => x.id === "x1")!, st = sim.stats();
  return { onInGreen, pedPhases, crossed: v.crossed ?? 0, wait: v.avgWait ?? 0, finished: st.finished, collisions: st.collisions, stuck: st.stuck };
}
{
  const r = run(road({}), 900);
  check("run: nobody on the zebra while a car has green", r.onInGreen < 0.05, `${r.onInGreen.toFixed(1)} s`);
  check("…people get across, without long waits", r.crossed > 100 && r.wait < 40, `${r.crossed} crossed, mean wait ${r.wait.toFixed(1)} s, ${r.pedPhases} pedestrian phases`);
  check("…and so do the cars", r.finished > 150 && r.collisions === 0 && r.stuck === 0, `${r.finished} out, ${r.collisions} collisions, ${r.stuck} stuck`);
  const quiet = run(road({}, "both", 0), 300);
  check("nobody at the zebra: no pedestrian phase (actuated: on demand)", quiet.pedPhases === 0, `${quiet.pedPhases}`);
  const old = run(road({ pedPhase: false }), 900);
  check("(pedestrian phase off: people on the zebra in a car's green, as before)", old.onInGreen > 10, `${old.onInGreen.toFixed(0)} s`);
}

// by hand: a phase with the zebra ticked
{
  const sk = road({ phases: [{ name: "Cars", green: 20, conns: ["cA", "cB"] }, { name: "Walk", green: 16, minGreen: 4, conns: [], peds: ["x1"] }] }), p = plan(sk);
  check("by hand: the ticked phase is the zebra's, run whole", p.phases[1].peds?.join() === "x1" && p.phases[1].minGreen === 16, show(sk));
  const r = run(sk, 600);
  check("…people cross in it only", r.onInGreen < 0.05 && r.crossed > 50, `${r.crossed} crossed, ${r.onInGreen.toFixed(1)} s in a car's green`);
}

console.log(ok ? "pedestrian phase check: all ok" : "pedestrian phase check: FAILED");
if (!ok) process.exit(1);
