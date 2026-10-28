/**
 * Speed bumps (ticket #101). Checks:
 * - the model: a new one takes its kind's length and height; a new kind its own (and its own speed); `speed: null`
 *   goes back to the kind's; sanitizeSketch keeps them, clamps their sizes and speed, an unknown kind a hump;
 * - the sim, on a straight 50 km/h road: cars cross a hump at its speed (and no faster than a little over it), are
 *   back up to speed well away from it, and brake for it before it, not at it;
 * - each kind: crossed at about its own speed (a table slower than a hump, a short bump slower still);
 * - trucks: slower than cars over a hump, faster over cushions (they straddle them);
 * - humps 60 m apart keep the speed between them lower than humps 150 m apart (TRL: spacing sets the speed between);
 * - no collisions.
 * npm run bump:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import { LANE_WIDTH, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import { addBump, BUMP_KINDS, bumpHeavySpeed, bumpSpeed, deleteBump, updateBump, type BumpKind, type SketchBump } from "../src/lib/sketch-bumps";

let bad = 0;
function check(name: string, ok: boolean, info = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? `: ${info}` : ""}`);
  if (!ok) bad++;
}
const LEN = 600;
/** a one-way road along x (0..600 m), 50 km/h, its bumps across it at these x, of this kind */
const road = (xs: number[], kind: BumpKind = "hump", tune: Record<string, number> = {}): Sketch => ({
  lanes: [{ id: "E", width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: 0, y: 1.75 }, { x: LEN, y: 1.75 }] } }],
  connectors: [], roads: [], junctions: [],
  bumps: xs.map((x, i): SketchBump => ({ id: `h${i + 1}`, kind, a: { x, y: -2 }, b: { x, y: 5.5 }, length: BUMP_KINDS[kind].length, height: BUMP_KINDS[kind].height })),
  traffic: { rate: 400, speed: 50, seed: 1, ...(Object.keys(tune).length ? { tune } : {}) },
});
/** run it 15 min; the speeds (km/h) seen with the car's front in each [x0, x1), cars and trucks apart */
function run(sk: Sketch, bands: [number, number][]) {
  const sim = new SketchSim(sk, sk.traffic!, 1);
  const car = bands.map(() => [] as number[]), truck = bands.map(() => [] as number[]);
  for (let i = 0; i < 9000; i++) {
    sim.step(0.1);
    if (i < 600) continue;
    for (const v of sim.vehicles) bands.forEach(([x0, x1], k) => { if (v.pos >= x0 && v.pos < x1) (v.truck ? truck : car)[k].push(v.v * 3.6); });
  }
  return { car, truck, stats: sim.stats() };
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const max = (xs: number[]) => Math.max(...xs);
const f = (x: number) => x.toFixed(1);

// the model
{
  const base: Sketch = { lanes: [], connectors: [], roads: [], junctions: [] };
  const [sk1, b] = addBump(base, { x: 0, y: 0 }, { x: 0, y: 7.004 });
  check("new: a hump, its kind's size, no speed of its own", b.id === "h1" && b.kind === "hump" && b.length === 3.7 && b.height === 7.5 && b.speed === undefined && b.b.y === 7, JSON.stringify(b));
  const sk2 = updateBump(sk1, "h1", { speed: 30 }), t = updateBump(sk2, "h1", { kind: "table" }).bumps![0];
  check("speed set, then a new kind: its size and speed", bumpSpeed(sk2.bumps![0]) === 30 && t.length === BUMP_KINDS.table.length && t.speed === undefined && bumpSpeed(t) === 21, JSON.stringify(t));
  check("speed back to the kind's", updateBump(sk2, "h1", { speed: null }).bumps![0].speed === undefined);
  check("heavy: slower over a hump, faster over cushions", bumpHeavySpeed(b) < bumpSpeed(b) && bumpHeavySpeed({ ...b, kind: "cushion", speed: 27 }) > 27);
  check("deleted: no bumps key left", !("bumps" in deleteBump(sk1, "h1")));
  const s = sanitizeSketch(JSON.parse(JSON.stringify({ ...road([100]), bumps: [{ id: "h1", kind: "nope", a: { x: 0, y: 0 }, b: { x: 0, y: 7 }, length: 99, height: 0, speed: 500 }, { id: "h2", kind: "bump", a: { x: 0, y: 0 }, b: { x: 0, y: 0.1 } }] })));
  const k = s?.bumps ?? [];
  check("sanitize: unknown kind a hump, sizes and speed clamped, too short dropped", k.length === 1 && k[0].kind === "hump" && k[0].length === 20 && k[0].height === 1 && k[0].speed === 80, JSON.stringify(k));
  check("sanitize: a sketch with only bumps is kept", !!sanitizeSketch({ lanes: [], connectors: [], roads: [], junctions: [], bumps: [{ id: "h1", kind: "hump", a: { x: 0, y: 0 }, b: { x: 0, y: 7 } }] }));
}

// one hump at x = 300: crossing speed, back up to speed, braking before it
{
  const { car, stats } = run(road([300]), [[298.2, 301.9], [100, 200], [250, 270], [500, 560]]);
  const [on, before, approach, after] = car;
  check("hump: crossed at its speed (24 km/h, a car's own share of it)", Math.abs(mean(on) - 24) < 3 && max(on) < 24 * 1.25, `mean ${f(mean(on))}, max ${f(max(on))}`);
  check("hump: at the limit well before it and back up to it after", mean(before) > 45 && mean(after) > 45, `before ${f(mean(before))}, after ${f(mean(after))}`);
  check("hump: braking in the metres before it (30-50 m out: under the limit, over its speed)", mean(approach) > mean(on) + 3 && mean(approach) < mean(before) - 5, `approach ${f(mean(approach))}`);
  check("hump: cars come and go, no collision", stats.finished > 50 && stats.collisions === 0, `finished ${stats.finished}, collisions ${stats.collisions}`);
}

// each kind at its own speed
{
  const got: Record<string, number> = {};
  for (const kind of ["bump", "hump", "table", "cushion"] as BumpKind[]) {
    const L = BUMP_KINDS[kind].length;
    got[kind] = mean(run(road([300], kind), [[300 - L / 2, 300 + L / 2]]).car[0]);
  }
  check("kinds: each crossed at about its speed", (["bump", "hump", "table", "cushion"] as BumpKind[]).every(k => Math.abs(got[k] - BUMP_KINDS[k].speed) < 3.5), JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, f(v)]))));
  check("kinds: bump < table < hump < cushions", got.bump < got.table && got.table < got.hump && got.hump < got.cushion);
}

// trucks: slower over a hump, faster over cushions
{
  const hump = run(road([300], "hump", { truckShare: 40 }), [[298.2, 301.9]]), cush = run(road([300], "cushion", { truckShare: 40 }), [[298.5, 301.5]]);
  check("trucks: slower than cars over a hump", hump.truck[0].length > 0 && mean(hump.truck[0]) < mean(hump.car[0]) - 4, `trucks ${f(mean(hump.truck[0]))}, cars ${f(mean(hump.car[0]))}`);
  check("trucks: faster than cars over cushions", cush.truck[0].length > 0 && mean(cush.truck[0]) > mean(cush.car[0]) + 4, `trucks ${f(mean(cush.truck[0]))}, cars ${f(mean(cush.car[0]))}`);
}

// spacing: the speed half way between humps
{
  const close = run(road([150, 210, 270, 330, 390]), [[235, 245], [295, 305]]), far = run(road([150, 300, 450]), [[220, 230], [370, 380]]);
  const c = mean(close.car.flat()), d = mean(far.car.flat());
  check("spacing: 60 m apart, slower between them than 150 m apart", c < d - 5 && c < 45, `60 m: ${f(c)} km/h, 150 m: ${f(d)} km/h`);
  check("spacing: no collisions", close.stats.collisions === 0 && far.stats.collisions === 0);
}

if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
