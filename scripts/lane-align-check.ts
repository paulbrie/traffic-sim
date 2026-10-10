/** Aligning selected lanes (T149): units, bounding boxes, offsets, the anchor. `npm run align:check` */
import { boundsOfPts, laneById, samples, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import { alignLanes, alignOffsets, alignUnits, ALIGNS, canAlign } from "../src/lib/lane-align";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};
const line = (id: string, x0: number, y0: number, x1: number, y1: number) => ({ id, width: 3.5, shape: { kind: "line" as const, pts: [{ x: x0, y: y0 }, { x: x1, y: y1 }] } });
const box = (sk: Sketch, id: string) => boundsOfPts(samples(laneById(sk, id)!.shape, 1))!;

// a: 0..20 at y 0 (the anchor), b: 50..60 at y 30, c: -10..30 at y 100
const sk: Sketch = sanitizeSketch({
  lanes: [line("a", 0, 0, 20, 0), line("b", 50, 30, 60, 30), line("c", -10, 100, 30, 100), line("d", 200, 10, 240, 10), line("e", 200, 13.5, 240, 13.5)],
  connectors: [{ id: "k1", from: { lane: "d", s: 40 }, to: { lane: "e", s: 40 }, via: [{ x: 250, y: 12 }] }],
  roads: [{ id: "r1", name: "Side by side", lanes: ["d", "e"], align: { ref: "d", lanes: [{ id: "e", offset: 3.5, reverse: false }] } }],
  junctions: [{ id: "j1", name: "J", outline: [{ x: 45, y: 25 }, { x: 65, y: 25 }, { x: 65, y: 35 }] }],
})!;

check("fewer than two lanes: nothing to align", !canAlign(sk, ["a"]) && alignLanes(sk, ["a"], "left") === sk);
check("unknown lanes left out", alignUnits(sk, ["a", "zz"]).length === 1);
const ab = (how: (typeof ALIGNS)[number]) => alignLanes(sk, ["a", "b"], how);
check("left: b's left edge on a's (x 0), its shape unchanged", box(ab("left"), "b").minX === 0 && box(ab("left"), "b").maxX === 10 && box(ab("left"), "b").minY === 30);
check("right: b's right edge on a's (x 20)", box(ab("right"), "b").maxX === 20);
check("centre: b's middle on a's (x 10)", (box(ab("center"), "b").minX + box(ab("center"), "b").maxX) / 2 === 10);
check("top (north, the smallest y): b's on a's (y 0), x unchanged", box(ab("top"), "b").minY === 0 && box(ab("top"), "b").minX === 50);
check("bottom and middle on a's (one line: y 0 too)", box(ab("bottom"), "b").maxY === 0 && box(ab("middle"), "b").minY === 0);
for (const how of ALIGNS) check(`${how}: the anchor stays put`, JSON.stringify(box(ab(how), "a")) === JSON.stringify(box(sk, "a")));
check("the anchor is the first selected: b first, a moves to it", box(alignLanes(sk, ["b", "a"], "left"), "a").minX === 50);
check("three lanes: each lined up on the anchor", (() => { const s = alignLanes(sk, ["a", "b", "c"], "right"); return box(s, "b").maxX === 20 && box(s, "c").maxX === 20; })());
const offs = alignOffsets(alignUnits(sk, ["a", "c"]), "left");
check("offsets: c moves 10 east, not north or south", offs.length === 1 && offs[0].dx === 10 && offs[0].dy === 0);

// A side-by-side road moves as one: its lanes together, the connector between them with them.
const withRoad = alignLanes(sk, ["a", "e"], "left");
check("a side-by-side road's lane brings its road: d and e both move", box(withRoad, "d").minX === 0 && box(withRoad, "e").minX === 0);
check("…and the connector's bend between them moves too", withRoad.connectors[0].via?.[0].x === 50);
check("two lanes of one road count once (nothing else to align)", alignUnits(sk, ["d", "e"]).length === 1 && !canAlign(sk, ["d", "e"]));
check("junction outlines don't move", JSON.stringify(ab("left").junctions) === JSON.stringify(sk.junctions));

process.exit(ok ? 0 : 1);
