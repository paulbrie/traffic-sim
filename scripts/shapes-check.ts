/** The sketch's shapes (ticket #268): editing, rectangles and circles, sanitizing, copy/paste, moving, patches. `npm run shapes:check` */
import { copyPart, emptySketch, pastePart, piecePoints, sanitizeSketch, transformPiece, translation, type Sketch } from "../src/lib/lane-sketch";
import {
  addShape,
  circleOutline,
  CIRCLE_POINTS,
  deleteShape,
  insertShapePoint,
  moveShapePoint,
  rectOutline,
  removeShapePoint,
  sanitizeShapes,
  SHAPE_COLOR,
  shapeArea,
  shapeAt,
  shapeOpacity,
  updateShape,
} from "../src/lib/sketch-shapes";
import { applyPatch } from "../src/lib/sketch-diff";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

// Rectangles and circles to start from.
const rect = rectOutline({ x: 0, y: 0 }, { x: 20, y: 10 });
check("a rectangle: 4 points, its corners", rect.length === 4 && rect[2].x === 20 && rect[2].y === 10 && near(shapeArea({ outline: rect } as never), 200));
const circle = circleOutline({ x: 0, y: 0 }, { x: 10, y: 0 });
check(`a circle: ${CIRCLE_POINTS} points, all on it, the first where dragged to`, circle.length === CIRCLE_POINTS && circle.every(p => near(Math.hypot(p.x, p.y), 10)) && near(circle[0].x, 10) && near(circle[0].y, 0));

// Adding, naming, colour, ids.
const [sk1, s1] = addShape(emptySketch(), rect);
check("a new shape: s1, 'Shape 1', the default colour, solid, no border", s1.id === "s1" && s1.name === "Shape 1" && s1.color === SHAPE_COLOR && shapeOpacity(s1) === 1 && !("opacity" in s1) && !s1.border);
const [sk2, s2] = addShape(sk1, circle, { color: "#4ade80", opacity: 0.5, border: { color: "#000000", width: 0.5 } });
check("the next: s2, its colours as given", s2.id === "s2" && s2.color === "#4ade80" && s2.opacity === 0.5 && s2.border?.width === 0.5 && sk2.shapes?.length === 2);

// Changes.
let sk = updateShape(sk2, "s2", { opacity: 1, border: null, name: "Park" });
const u = sk.shapes!.find(x => x.id === "s2")!;
check("opacity 1 and no border: not kept as set", !("opacity" in u) && !("border" in u) && u.name === "Park");
sk = updateShape(sk, "s2", { opacity: 0.001, border: { color: "#ff0000", width: 99 } });
const u2 = sk.shapes!.find(x => x.id === "s2")!;
check("opacity and border width kept within bounds", u2.opacity === 0.05 && u2.border?.width === 5);
check("s1 left alone", JSON.stringify(sk.shapes![0]) === JSON.stringify(s1));

// Points.
const moved = moveShapePoint(s1, 1, { x: 30.123, y: -1 });
check("a point moved (to the centimetre)", moved.outline[1].x === 30.12 && moved.outline[1].y === -1 && moved.outline.length === 4);
const ins = insertShapePoint(s1, 2, { x: 25, y: 5 });
check("a point put in before point 2", ins.outline.length === 5 && ins.outline[2].x === 25);
check("a point taken out, three kept at least", removeShapePoint(ins, 2).outline.length === 4 && removeShapePoint({ ...s1, outline: rect.slice(0, 3) }, 0).outline.length === 3);

// Under the pointer: the smallest holding it.
const big = { ...s1, id: "b", outline: rectOutline({ x: -50, y: -50 }, { x: 50, y: 50 }) }, small = { ...s1, id: "s", outline: rectOutline({ x: 0, y: 0 }, { x: 5, y: 5 }) };
check("the smallest shape under the pointer is picked", shapeAt([big, small], { x: 1, y: 1 })?.id === "s" && shapeAt([big, small], { x: 20, y: 20 })?.id === "b" && shapeAt([big, small], { x: 99, y: 0 }) === null);

// Deleting.
const gone = deleteShape(deleteShape(sk, "s1"), "s2");
check("deleting the last shape leaves no shapes list", !("shapes" in gone));

// Sanitizing.
const clean = sanitizeShapes([
  { id: "s1", outline: rect, color: "#ABCDEF", opacity: 0.3333, border: { color: "#112233", width: 0.25 } },
  { id: "s1", outline: rect, color: "#000000" },
  { id: "s3", outline: rect.slice(0, 2), color: "#000000" },
  { id: "s4", outline: [...rect, { x: Number.NaN, y: 0 }], color: "red", opacity: 2, border: { color: "blue", width: 1 } },
  { outline: rect },
]);
check("sanitize: a repeated id, too few points and no id dropped", clean.map(x => x.id).join(",") === "s1,s4");
check("sanitize: colour lower case, opacity to the hundredth, border kept", clean[0].color === "#abcdef" && clean[0].opacity === 0.33 && clean[0].border?.color === "#112233" && clean[0].name === "Shape 1");
check("sanitize: a bad colour the default, opacity over 1 solid, a bad border none, a bad point dropped", clean[1].color === SHAPE_COLOR && !("opacity" in clean[1]) && !clean[1].border && clean[1].outline.length === 4);
const only = sanitizeSketch({ lanes: [], connectors: [], roads: [], junctions: [], shapes: [{ id: "s1", outline: rect, color: "#123456" }] });
check("a sketch with only shapes is a sketch still, its shapes kept", !!only && only.shapes?.length === 1 && only.shapes[0].color === "#123456");
check("a saved sketch keeps its shapes through sanitizing", JSON.stringify(sanitizeSketch(sk)?.shapes) === JSON.stringify(sk.shapes));

// Moving, copying, pasting.
const piece = { lanes: [], connectors: [], junctions: [], shapes: ["s1"] };
const mv = transformPiece(sk, piece, translation(10, -5));
check("moved: its points, the other shape not", mv.shapes![0].outline[0].x === 10 && mv.shapes![0].outline[0].y === -5 && JSON.stringify(mv.shapes![1]) === JSON.stringify(sk.shapes![1]));
check("its points are the piece's", piecePoints(sk, piece).length === 4);
const part = copyPart(sk, piece);
check("copied: the shape alone", part.shapes?.length === 1 && part.shapes[0].id === "s1");
const pasted = pastePart(sk, part, 100, 0), p1 = pasted.sketch.shapes!.find(x => x.id === pasted.piece.shapes![0])!;
check("pasted: a new id, '… copy', moved, the pasted piece names it", pasted.piece.shapes?.length === 1 && p1.id === "s3" && p1.name === "Shape 1 copy" && p1.outline[0].x === 100 && pasted.sketch.shapes!.length === 3);
const again = pastePart(pasted.sketch, copyPart(pasted.sketch, { ...piece, shapes: [p1.id] }), 0, 0);
check("a copy of a copy is '… copy' still", again.sketch.shapes!.find(x => x.id === again.piece.shapes![0])!.name === "Shape 1 copy");

// A patch (History's Apply changes from file, an agent's): a shape changed field by field, one added, one removed.
const base = { ...sk, lanes: [], connectors: [], roads: [], junctions: [] } as Sketch;
const patched = applyPatch(base, { shapes: [{ id: "s1", color: "#00ff00" }, { id: "s9", outline: rect, color: "#0000ff" }], remove: { shapes: ["s2"] } });
const ps = patched?.shapes ?? [];
check("a patch changes a shape's colour, adds one, removes one", ps.length === 2 && ps.find(x => x.id === "s1")?.color === "#00ff00" && ps.find(x => x.id === "s1")?.outline.length === 4 && ps.some(x => x.id === "s9") && !ps.some(x => x.id === "s2"));

console.log(ok ? "shapes check: all ok" : "shapes check: FAILED");
process.exit(ok ? 0 : 1);
