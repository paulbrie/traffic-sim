/**
 * A run's results, to save and compare (ticket #124): counted from the warm-up's end only; per junction its lanes in and out adding up;
 * trips by where they came in and went out; two results compared, by id and (a junction rebuilt under another id) by name; as CSV.
 *   npm run results:check
 */
import { type Sketch, type SketchConnector, type SketchLane } from "../src/lib/lane-sketch";
import { SketchSim } from "../src/lib/lane-sketch-sim";
import { compareResults, comparisonCsv, resultMeta, type SimResult } from "../src/lib/sim-results";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const line = (id: string, pts: [number, number][]): SketchLane => ({ id, width: 3.5, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) } });
const conn = (id: string, f: string, fs: number, t: string): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: 0 } });
// two ways in (A, B) to two ways out (X, Y) through a junction
const base = (warmup: number, rate: number): Sketch => ({
  lanes: [line("A", [[0, 0], [60, 0]]), line("B", [[0, 40], [60, 40]]), line("X", [[80, 20], [200, 20]]), line("Y", [[80, -20], [200, -20]])],
  connectors: [conn("cAX", "A", 60, "X"), conn("cAY", "A", 60, "Y"), conn("cBX", "B", 60, "X")],
  roads: [{ id: "rA", name: "Strada A", lanes: ["A"] }, { id: "rB", name: "Strada B", lanes: ["B"] }, { id: "rX", name: "Strada X", lanes: ["X"] }, { id: "rY", name: "Strada Y", lanes: ["Y"] }],
  junctions: [{ id: "j1", name: "Fork", outline: [{ x: 55, y: -25 }, { x: 85, y: -25 }, { x: 85, y: 45 }, { x: 55, y: 45 }] }],
  traffic: { rate, speed: 50, seed: 1, ...(warmup ? { warmup } : {}) },
});
function run(sk: Sketch, T: number, at?: number) {
  const sim = new SketchSim(sk, { rate: sk.traffic!.rate, speed: 50 }, 1);
  let early = null;
  while (sim.t < T) { sim.step(0.1); if (at !== undefined && !early && sim.t >= at) early = sim.results(); }
  return { sim, early, data: sim.results({ series: true }) };
}
const result = (sk: Sketch, name: string, data: SimResult["data"]): SimResult => ({ id: name, name, createdAt: "", by: "", sketch: "s", seconds: data.t - data.from, series: false, bytes: 0, meta: resultMeta(sk, { sketch: { id: "s1", name: "Sketch" }, revision: 1, speed: 50 }), data });

const skA = base(2, 400);
const a = run(skA, 900, 100);
check("before the warm-up's end: nothing counted", !!a.early && a.early.totals.in === 0 && a.early.totals.fuel === 0 && a.early.junctions.every(j => !Object.keys(j.ins).length), JSON.stringify(a.early?.totals));
check("counted from the warm-up's end (2 min)", Math.abs(a.data.from - 120) < 0.2 && a.data.totals.in > 50, `from ${a.data.from}, in ${a.data.totals.in}`);
const j = a.data.junctions.find(x => x.id === "j1")!, ins = Object.values(j.ins).reduce((x, y) => x + y, 0), outs = Object.values(j.outs).reduce((x, y) => x + y, 0);
check("a junction's lanes in and out: counted, and adding up (give or take those on it)", ins > 50 && Math.abs(ins - outs) <= 5 && !!j.ins.A && !!j.ins.B, `in ${ins} (${JSON.stringify(j.ins)}), out ${outs}`);
check("trips by where they came in and went out, with their times", a.data.od.some(o => o.from === "A" && o.to === "X" && o.n > 0 && o.sum / o.n > 5) && !a.data.od.some(o => o.from === "B" && o.to === "Y"), JSON.stringify(a.data.od));
check("the flows every 5 s, asked for", !!a.data.series?.length && a.data.series[0].samples.every(s => s.t >= 120));
const noWarm = run(base(0, 400), 300).data;
check("no warm-up: from the start", noWarm.from === 0, `from ${noWarm.from}`);

// a variant: twice the traffic, its junction rebuilt under another id (the same name)
const skB0 = base(2, 800), skB: Sketch = { ...skB0, junctions: skB0.junctions.map(x => ({ ...x, id: "j9" })) };
const b = run(skB, 900).data, ra = result(skA, "A", a.data), rb = result(skB, "B", b);
const cmp = compareResults([ra, rb]), jr = cmp.find(s => s.id === "junctions")!.rows.find(r => !r.parent && r.name === "Fork")!;
check("compared: the junction rebuilt under another id matched by its name", !!jr && jr.values.every(v => v !== null), JSON.stringify(jr?.values));
const tr = cmp.find(s => s.id === "trips")!.rows.find(r => r.name === "Strada A → Strada X");
check("…trips by their ways' names, per hour", !!tr && tr.values.every(v => v !== null && v[0] > 0), JSON.stringify(tr?.values));
const tot = cmp.find(s => s.id === "totals")!.rows[0];
check("…in all, per hour: twice the traffic in, more through", (tot.values[1]![0]) > (tot.values[0]![0]) * 1.3, JSON.stringify(tot.values.map(v => v?.slice(0, 3))));
const csv = comparisonCsv(cmp, ["A", "B"]);
check("as CSV: a header per section, the rows under it", csv.split("\n")[0].startsWith("In all,A: In (veh/h)") && csv.includes("Fork,"), csv.split("\n").slice(0, 2).join(" / "));

console.log(ok ? "results check: all ok" : "results check: FAILED");
if (!ok) process.exit(1);
