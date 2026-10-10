/** "Fill holes" on an automatic junction (T147): what gets paved. `npm run fill:check` */
import { insideLoops, type Band, type Pt } from "../src/lib/lane-sketch";
import { FILL_GAP, fillAllJunctions, fillLoops, junctionSurfaceHoles, nestLoops, unfilledJunctions } from "../src/lib/junction-fill";
import { junctionContents, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};
const band = (pts: Pt[], width = 3.5, closed = false): Band => ({ pts, width, closed });
const line = (x0: number, y0: number, x1: number, y1: number, width = 3.5) => band([{ x: x0, y: y0 }, { x: x1, y: y1 }], width);
const paved = (loops: Pt[][], x: number, y: number) => insideLoops({ x, y }, loops);

// Two connectors side by side, a 1 m sliver between them (edges at y = 1.75 and 2.75), and a wedge where two part.
const sliver = fillLoops([line(0, 0, 40, 0), line(0, 4.5, 40, 4.5)], []);
check("a 1 m sliver between two bands: paved", paved(sliver, 20, 2.25));
check("the bands themselves: paved", paved(sliver, 20, 0) && paved(sliver, 20, 4.5));
check("…and nothing beyond the bands' outer edges", !paved(sliver, 20, -3) && !paved(sliver, 20, 7.5));
// (two bands parting from a point: the gap between their edges grows ~0.3 m a metre along)
const wedge = fillLoops([line(0, 0, 40, 0), line(0, 0, 40, 12)], []);
check("a wedge where two bands part, narrower than FILL_GAP: paved", paved(wedge, 15, 2.25), "at x 15");
check("…but where it opens wider than FILL_GAP (8 m at x 38), not", !paved(wedge, 38, 5.7));

// A wide gap stays open; a square of bands shuts in a hole, which is paved.
const wide = fillLoops([line(0, 0, 40, 0), line(0, FILL_GAP + 3.5 + 2, 40, FILL_GAP + 3.5 + 2)], []);
check(`a gap wider than ${FILL_GAP} m between bands: left open`, !paved(wide, 20, (FILL_GAP + 5.5) / 2));
const square = [line(0, 0, 20, 0), line(20, 0, 20, 20), line(20, 20, 0, 20), line(0, 20, 0, 0)];
const box = fillLoops(square, []);
check("ground the bands shut in (an inner square): paved", paved(box, 10, 10));
check("outside the square: not", !paved(box, -5, 10) && !paved(box, 30, 10));

// A ring lane: its island stays unpaved, the ring itself paved; a big enclosed area stays unpaved.
const ring = Array.from({ length: 48 }, (_, k) => ({ x: 12 * Math.cos((k / 48) * 2 * Math.PI), y: 12 * Math.sin((k / 48) * 2 * Math.PI) }));
const round = fillLoops([band(ring, 5, true), line(-30, 0, -12, 0), line(12, 0, 30, 0)], [ring]);
check("a ring lane's island: left unpaved", !paved(round, 0, 0));
check("the ring itself: paved", paved(round, 0, 12) && paved(round, 12, 0));
const nested = nestLoops(round);
check("nested for 3D: the island a hole in the ring's loop", nested.some(n => n.holes.length > 0));
const plaza = fillLoops([line(0, 0, 40, 0), line(40, 0, 40, 40), line(40, 40, 0, 40), line(0, 40, 0, 0)], []);
check("an enclosed area over the limit (a plaza, ~1300 m²): left unpaved", !paved(plaza, 20, 20));
check("…its bands paved", paved(plaza, 20, 0));
check("no bands, nothing", fillLoops([], []).length === 0);

// On a sketch: off changes nothing, on only adds; stored, sanitized, set for all by Tidy's offer.
const lane = (id: string, x0: number, y0: number, x1: number, y1: number) => ({ id, width: 3.5, shape: { kind: "line" as const, pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }] } });
const sk: Sketch = sanitizeSketch({
  lanes: [lane("a", -40, 0, -10, 0), lane("b", 10, 0, 40, 0), lane("c", -40, 4.5, -10, 4.5), lane("d", 10, 4.5, 40, 4.5)],
  connectors: [{ id: "k1", from: { lane: "a", s: 30 }, to: { lane: "b", s: 0 } }, { id: "k2", from: { lane: "c", s: 30 }, to: { lane: "d", s: 0 } }],
  roads: [{ id: "r1", name: "A", lanes: ["a", "c"] }, { id: "r2", name: "B", lanes: ["b", "d"] }],
  junctions: [
    { id: "j1", name: "J", shape: "auto", outline: [{ x: -12, y: -6 }, { x: 12, y: -6 }, { x: 12, y: 10 }, { x: -12, y: 10 }] },
    { id: "j2", name: "J2", shape: "auto", fill: "yes", outline: [{ x: 100, y: 0 }, { x: 110, y: 0 }, { x: 110, y: 10 }] },
  ],
})!;
const j1 = sk.junctions[0], c1 = junctionContents(sk, j1);
check("sanitize: fill kept only as true (a stray value dropped)", !("fill" in sk.junctions[1]) && sanitizeSketch({ ...sk, junctions: [{ ...j1, fill: true }] })!.junctions[0].fill === true);
const off = junctionSurfaceHoles(sk, j1, c1), on = junctionSurfaceHoles(sk, { ...j1, fill: true }, c1);
check("fill off: the holes as today", off.length === 0);
check("fill on: the 1 m sliver between the two connectors paved", on.some(l => insideLoops({ x: 0, y: 2.25 }, [l])));
check("fill on keeps today's holes first (it only adds)", off.every(h => on.includes(h)));
check("Tidy's offer: the automatic junctions not filled", unfilledJunctions(sk).map(j => j.id).join() === "j1,j2");
const all = fillAllJunctions(sk);
check("…all of them ticked, and nothing else changed", all.n === 2 && all.sketch.junctions.every(j => j.fill) && all.sketch.lanes === sk.lanes);
check("…and nothing to do the second time", fillAllJunctions(all.sketch).n === 0);

process.exit(ok ? 0 : 1);
