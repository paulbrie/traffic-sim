/** The sketch's zones (T129): editing, area, label point, sanitizing, copy/paste. `npm run zones:check` */
import { emptySketch, type Pt } from "../src/lib/lane-sketch";
import {
  addZone,
  deleteZone,
  formatArea,
  insertZoneCorner,
  insideZone,
  moveZoneCorner,
  moveZones,
  pasteZones,
  copyZones,
  removeZoneCorner,
  sanitizeZones,
  updateZone,
  ZONE_COLORS,
  zoneArea,
  zoneLabelPoint,
} from "../src/lib/sketch-zones";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const square: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
// A C (the square with a bite out of its right side): its centroid falls outside it.
const cShape: Pt[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 80 }, { x: 100, y: 80 }, { x: 100, y: 100 }, { x: 0, y: 100 }];

// Adding, naming, colours, ids.
const [sk1, z1] = addZone(emptySketch(), square);
check("a new zone: z1, 'Zone 1', the first colour", z1.id === "z1" && z1.name === "Zone 1" && z1.color === ZONE_COLORS[0]);
const [sk2, z2] = addZone(sk1, cShape, { name: "Centru" });
check("the next: z2, its own name, the next colour", z2.id === "z2" && z2.name === "Centru" && z2.color === ZONE_COLORS[1] && sk2.zones?.length === 2);
const [sk3, z3] = addZone(deleteZone(sk2, "z1"), square);
let sk = sk3;
check("ids aren't reused after a delete", z3.id === "z3", z3.id);

// Updating, moving, deleting.
sk = updateZone(sk, "z2", { name: "Old town", note: "the walls", color: "#ef4444" });
const upd = sk.zones!.find(z => z.id === "z2")!;
check("update: name, note, colour", upd.name === "Old town" && upd.note === "the walls" && upd.color === "#ef4444");
sk = updateZone(sk, "z2", { note: "" });
check("an emptied note goes", !("note" in sk.zones!.find(z => z.id === "z2")!));
sk = moveZones(sk, ["z3"], 10, -5);
check("move: every corner by (dx, dy)", sk.zones!.find(z => z.id === "z3")!.outline[0].x === 10 && sk.zones!.find(z => z.id === "z3")!.outline[0].y === -5);
const gone = deleteZone(deleteZone(sk, "z2"), "z3");
check("deleting the last zone leaves no zones list", !("zones" in gone));

// Corners.
const zq = { id: "z9", name: "Q", outline: square, color: "#3b82f6" };
const ins = insertZoneCorner(zq, 1, { x: 50, y: -10 });
check("a corner put in before corner 1", ins.outline.length === 5 && ins.outline[1].x === 50 && ins.outline[2].x === 100);
check("a corner taken out", removeZoneCorner(ins, 1).outline.length === 4);
check("never fewer than three corners", removeZoneCorner({ ...zq, outline: square.slice(0, 3) }, 0).outline.length === 3);
check("a corner moved (rounded to cm)", moveZoneCorner(zq, 2, { x: 120.123, y: 99.999 }).outline[2].x === 120.12);

// Area.
check("area of a 100 m square: 10 000 m²", near(zoneArea(square), 10_000));
check("area of the C: 10 000 − 60×80", near(zoneArea(cShape), 10_000 - 80 * 60));
check("area either way round", near(zoneArea([...square].reverse()), 10_000));
check("formatArea: m² below a hectare", formatArea(850.4) === "850 m²", formatArea(850.4));
check("formatArea: ha from one up", formatArea(12_400) === "1.24 ha", formatArea(12_400));
check("formatArea: big areas in whole ha", formatArea(2_500_000) === "250 ha", formatArea(2_500_000));

// Label point.
const lp = zoneLabelPoint(square);
check("label: a square's centre", near(lp.x, 50) && near(lp.y, 50));
const lc = zoneLabelPoint(cShape);
check("label: inside a C (whose centroid isn't)", insideZone(lc, cShape), JSON.stringify(lc));

// Sanitizing.
const clean = sanitizeZones([
  { id: "z1", name: "A", outline: square, color: "#ABCDEF", note: "n" },
  { id: "z1", name: "dup", outline: square, color: "#000000" },
  { id: "z2", outline: [{ x: 0, y: 0 }, { x: 1, y: Number.NaN }, { x: 1, y: 1 }] },
  { id: "z3", name: " ", outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }], color: "red" },
  { name: "no id", outline: square },
  "junk",
]);
check("sanitize: repeated ids, bad corners, no ids and junk dropped", clean.map(z => z.id).join() === "z1,z3", clean.map(z => z.id).join());
check("sanitize: colour lower-cased, a bad one replaced, a blank name filled", clean[0].color === "#abcdef" && clean[1].color === ZONE_COLORS[0] && clean[1].name === "Zone 3");
check("sanitize: not a list → none", sanitizeZones(undefined).length === 0 && sanitizeZones({}).length === 0);

// Copy/paste.
const [base] = addZone(emptySketch(), square, { name: "Park" });
const part = copyZones(base, ["z1"]);
const pasted = pasteZones(base, part, 20, 30);
const pz = pasted.sketch.zones!.find(z => z.id === pasted.ids[0])!;
check("paste: a fresh id, '… copy', moved", pasted.ids[0] === "z2" && pz.name === "Park copy" && pz.outline[0].x === 20 && pz.outline[0].y === 30);
const again = pasteZones(pasted.sketch, [pz], 5, 5);
check("a copy of a copy is '… copy' still", again.sketch.zones!.find(z => z.id === again.ids[0])!.name === "Park copy");
check("the original untouched", base.zones![0].outline[0].x === 0);

process.exit(ok ? 0 : 1);
