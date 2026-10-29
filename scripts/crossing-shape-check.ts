/**
 * Zebra crossings of a free shape (ticket #57): each of a crossing's four corners moved on its own, and its stripes
 * turned. Checks:
 * - a plain crossing: its corners and bars as before (a bar every metre, half a metre wide, along the traffic);
 * - a corner moved: the crossing keeps its corners, its kerbs (`a`, `b`) and width taken from them; moving a kerb
 *   end moves that side's two corners; a width stretches both kerb sides about their middles; `corners: null`
 *   makes it a rectangle again;
 * - its bars stay inside its outline, turned by `stripes` (and none kept at 0°);
 * - `onCrossing` follows the free outline (and its pad);
 * - sanitizeSketch keeps corners and stripes, kerbs re-derived from the corners, the angle within ±90°;
 * - the sim: a road under a skewed crossing, its pedestrians cross, cars stop for them, no collision.
 * npm run crossing:check
 */
import { SketchSim } from "../src/lib/lane-sketch-sim";
import {
  crossingFrame, crossingStripes, insidePolygon, onCrossing, sanitizeSketch, stripeDir, updateCrossing, LANE_WIDTH,
  type Pt, type Sketch, type SketchCrossing,
} from "../src/lib/lane-sketch";

let bad = 0;
function check(name: string, ok: boolean, info = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${info ? `: ${info}` : ""}`);
  if (!ok) bad++;
}
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;
const same = (p: Pt, q: Pt) => near(p.x, q.x) && near(p.y, q.y);
const one = (sk: Sketch) => sk.crossings![0];

// a road along x, two lanes (y = ±1.75), and a crossing over it from y = -6 to y = 6 at x = 100
const road: Sketch = {
  lanes: [
    { id: "E", width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: 0, y: 1.75 }, { x: 200, y: 1.75 }] } },
    { id: "W", width: LANE_WIDTH, shape: { kind: "line", pts: [{ x: 200, y: -1.75 }, { x: 0, y: -1.75 }] } },
  ],
  connectors: [], roads: [], junctions: [],
  crossings: [{ id: "x1", a: { x: 100, y: -6 }, b: { x: 100, y: 6 }, width: 4, peds: 600 }],
  traffic: { rate: 900, speed: 50, seed: 1 },
};

{
  const x = one(road), f = crossingFrame(x), bars = crossingStripes(x);
  check("plain: four corners round a and b", f.corners.length === 4 && same(f.corners[0], { x: 98, y: -6 }) && same(f.corners[2], { x: 102, y: 6 }), JSON.stringify(f.corners));
  const ys = bars.map(b => Math.min(...b.map(p => p.y)));
  check("plain: 12 bars, a metre apart, along the traffic", bars.length === 12 && near(Math.abs(ys[1] - ys[0]), 1) && bars.every(b => near(Math.max(...b.map(p => p.x)) - Math.min(...b.map(p => p.x)), 4)), `${bars.length} bars`);
}
{
  // (b's left corner pulled 3 m along the road: a skewed crossing)
  const c = [...crossingFrame(one(road)).corners] as [Pt, Pt, Pt, Pt];
  c[1] = { x: 98 + 3, y: 6 }; c[2] = { x: 102 + 3, y: 6 };
  const sk = updateCrossing(road, "x1", { corners: c }), x = one(sk);
  check("corners kept, kerbs from them", !!x.corners && same(x.a, { x: 100, y: -6 }) && same(x.b, { x: 103, y: 6 }) && near(x.width, 4), JSON.stringify({ a: x.a, b: x.b, w: x.width }));
  const moved = one(updateCrossing(sk, "x1", { a: { x: 100, y: -8 } }));
  check("kerb a moved: its two corners with it", same(moved.corners![0], { x: 98, y: -8 }) && same(moved.corners![3], { x: 102, y: -8 }) && same(moved.corners![1], c[1]), JSON.stringify(moved.corners));
  const wide = one(updateCrossing(sk, "x1", { width: 6 }));
  check("width: both kerb sides stretched", near(wide.width, 6) && same(wide.corners![0], { x: 97, y: -6 }) && same(wide.corners![2], { x: 106, y: 6 }), JSON.stringify(wide.corners));
  const square = one(updateCrossing(sk, "x1", { corners: null }));
  check("corners: null, a rectangle again", !square.corners && same(square.b, x.b), JSON.stringify(square));

  const bars = crossingStripes(x), inside = bars.every(b => b.every(p => insidePolygon(p, x.corners!) || x.corners!.some(q => Math.hypot(p.x - q.x, p.y - q.y) < 0.02) || onCrossing(x, p, 0.01)));
  check("skewed: bars cut to its outline", bars.length >= 11 && inside, `${bars.length} bars`);
  check("onCrossing follows the outline", onCrossing(x, { x: 104, y: 5 }) && !onCrossing({ ...x, corners: undefined, width: 4 }, { x: 104.5, y: 0 }) && !onCrossing(x, { x: 99, y: 5 }) && onCrossing(x, { x: 99, y: 5 }, 2), "");

  const turned = one(updateCrossing(sk, "x1", { stripes: 30 })), d = stripeDir(turned);
  const tb = crossingStripes(turned), e = tb[Math.floor(tb.length / 2)];
  // (a bar's long side runs the stripe's way)
  const long = e.map((p, i) => ({ p, q: e[(i + 1) % e.length] })).sort((m, n) => Math.hypot(n.q.x - n.p.x, n.q.y - n.p.y) - Math.hypot(m.q.x - m.p.x, m.q.y - m.p.y))[0];
  const lx = long.q.x - long.p.x, ly = long.q.y - long.p.y, cos = Math.abs(lx * d.x + ly * d.y) / Math.hypot(lx, ly);
  check("stripes turned 30°", turned.stripes === 30 && near(cos, 1, 0.01) && near(Math.abs(d.x), Math.cos(Math.PI / 6) * 1, 0.2), `cos ${cos.toFixed(3)}, dir ${d.x.toFixed(2)},${d.y.toFixed(2)}`);
  check("stripes 0: no angle kept", !("stripes" in one(updateCrossing({ ...sk, crossings: [turned] }, "x1", { stripes: 0 }))));

  const raw = JSON.parse(JSON.stringify({ ...sk, crossings: [{ ...x, a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, stripes: 200 }] }));
  const s = sanitizeSketch(raw), y = s && one(s);
  check("sanitize keeps corners, kerbs from them, the angle within ±90°", !!y?.corners && same(y.b, { x: 103, y: 6 }) && y.stripes === 90, JSON.stringify(y));
  const plain = sanitizeSketch(JSON.parse(JSON.stringify(road))), p = plain && one(plain);
  check("sanitize: a plain one stays plain", !!p && !p.corners && !("stripes" in p), JSON.stringify(p));

  // (the sim over the skewed one, its bars turned: pedestrians cross, cars stop for them)
  const sim = new SketchSim({ ...sk, crossings: [{ ...x, stripes: 30 } as SketchCrossing] }, { rate: 900, speed: 50, seed: 1 }, 1);
  for (let i = 0; i < 3000; i++) sim.step(0.1);
  const st = sim.stats(), xs = sim.crossingStats("x1");
  check("sim: pedestrians cross, cars come and go, no collision", (xs?.crossed ?? 0) > 20 && st.finished > 20 && st.collisions === 0 && (xs?.over.length ?? 0) === 2,
    `crossed ${xs?.crossed}, over ${xs?.over.join(" ")}, finished ${st.finished}, collisions ${st.collisions}`);
}

if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
