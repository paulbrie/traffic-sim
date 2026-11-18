/**
 * Traffic lights in the V2 simulation: a crossroads, one lane each way north-south and east-west, every way in at 500 vehicles/h,
 * the junction's lights fixed time and actuated (as they come). No car goes over its line once its red has lasted a second: one
 * that went on at the amber, not able to stop in comfort, may still be at its line as the red comes (a few in 15 minutes, up to
 * 0.8 s in), and the all-red (2 s) is there for it. The ways across one another are never green at once; cars do wait at the red;
 * every way gets through; nobody through anybody. (Breaking the stop at red in the sim, every other check still passed: ticket #269.)
 *   npm run lights:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import { DEFAULT_LIGHTS, type JunctionLights, type Sketch, type SketchConnector, type SketchLane } from "../src/lib/lane-sketch";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const line = (id: string, pts: [number, number][]): SketchLane => ({ id, width: 3.5, inRate: id.endsWith("in") ? 500 : 0, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) } });
const conn = (id: string, f: string, fs: number, t: string): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: 0 } });
const H = 1.75;
// (the junction 14 m across at the origin; each way in 140 m up to it, its way on 140 m away from it)
const crossroads = (lights: Partial<JunctionLights>): Sketch => ({
  lanes: [
    line("Win", [[-147, H], [-7, H]]), line("Eout", [[7, H], [147, H]]), line("Ein", [[147, -H], [7, -H]]), line("Wout", [[-7, -H], [-147, -H]]),
    line("Nin", [[-H, -147], [-H, -7]]), line("Sout", [[-H, 7], [-H, 147]]), line("Sin", [[H, 147], [H, 7]]), line("Nout", [[H, -7], [H, -147]]),
  ],
  connectors: [conn("cWE", "Win", 140, "Eout"), conn("cEW", "Ein", 140, "Wout"), conn("cNS", "Nin", 140, "Sout"), conn("cSN", "Sin", 140, "Nout")],
  roads: [],
  junctions: [{ id: "j1", name: "Crossroads", outline: [{ x: -7, y: -7 }, { x: 7, y: -7 }, { x: 7, y: 7 }, { x: -7, y: 7 }], lights: { ...DEFAULT_LIGHTS, ...lights } }],
  traffic: { rate: 0, speed: 50, seed: 1 },
});

type Car = { id: number; edge: { id: string; kind: string }; why: string | null };
type Sim = { step: (dt: number) => void; t: number; vehicles: Car[]; stats: () => { finished: number; collisions: number; deadlocks: number }; edges: Map<string, { signal: { stateOf: (id: string) => string } | null }> };

function run(name: string, lights: Partial<JunctionLights>) {
  const sim = new SketchSim(crossroads(lights), { rate: 0, speed: 50 }, 1) as unknown as Sim;
  const conns = ["cWE", "cEW", "cNS", "cSN"], lane = { cWE: "Win", cEW: "Ein", cNS: "Nin", cSN: "Sin" } as Record<string, string>;
  const sig = sim.edges.get("lane:Win")?.signal;
  const state = (c: string) => sim.edges.get(`lane:${lane[c]}`)?.signal?.stateOf(c) ?? "none";
  const was = new Map<number, string>(), through: Record<string, number> = { cWE: 0, cEW: 0, cNS: 0, cSN: 0 };
  const redSince = new Map<string, number>(), prev = new Map<string, string>();
  let onRed = 0, late = 0, latest = 0, bothGo = 0, waitedRed = 0, steps = 0;
  while (sim.t < 900) {
    const before = Object.fromEntries(conns.map(c => [c, state(c)]));
    for (const c of conns) { if (before[c] === "red" && prev.get(c) !== "red") redSince.set(c, sim.t); prev.set(c, before[c]); }
    sim.step(0.1);
    steps++;
    // (both ways across one another going at once: green or amber)
    const go = (c: string) => before[c] === "green" || before[c] === "amber";
    if ((go("cWE") || go("cEW")) && (go("cNS") || go("cSN")) && (before.cWE === "green" || before.cEW === "green") && (before.cNS === "green" || before.cSN === "green")) bothGo++;
    for (const v of sim.vehicles) {
      const e = v.edge.kind === "conn" ? v.edge.id : null, prev = was.get(v.id);
      if (e && prev !== e && e in through) { through[e]++; if (before[e] === "red") { const into = sim.t - redSince.get(e)!; onRed++; latest = Math.max(latest, into); if (into > 1) late++; } }
      if (v.why && /signal .* red/.test(v.why)) waitedRed++;
      was.set(v.id, e ?? "");
    }
  }
  const st = sim.stats();
  check(`${name}: the lane in has the junction's lights`, !!sig, sig ? "" : "no signal on lane Win");
  check(`${name}: nobody over the line a second into the red`, late === 0 && onRed <= 15, `${onRed} of ${Object.values(through).reduce((a, b) => a + b, 0)} at its first moments, the latest ${latest.toFixed(1)} s in; ${late} later`);
  check(`${name}: never green both ways across`, bothGo === 0, `${bothGo} steps of ${steps}`);
  check(`${name}: cars wait at the red`, waitedRed > 1000, `${waitedRed} car-steps held by a red`);
  check(`${name}: every way gets through`, Object.values(through).every(n => n > 50), JSON.stringify(through));
  check(`${name}: nobody through anybody, no deadlock`, st.collisions === 0 && st.deadlocks === 0, `${st.collisions} collisions, ${st.deadlocks} deadlocks`);
}

run("fixed time", { actuated: false });
run("actuated", { actuated: true });
console.log(ok ? "lights check: all ok" : "lights check: FAILED");
process.exit(ok ? 0 : 1);
