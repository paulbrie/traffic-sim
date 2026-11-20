/** Marks on a V2 plan (ticket #289): coordinates read from what is pasted, marks added, changed, kept, patched. `npm run marks:check` */
import { emptySketch, sanitizeSketch, type Sketch } from "../src/lib/lane-sketch";
import { addMark, deleteMark, markAt, MARK_COLOR, parseCoordinates, PIN, sanitizeMarks, updateMark } from "../src/lib/sketch-marks";
import { project, unproject } from "../src/lib/osm/area";
import { applyPatch } from "../src/lib/sketch-diff";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};
const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps;
const is = (text: string, lat: number, lon: number, eps = 1e-5) => {
  const g = parseCoordinates(text);
  check(`reads ${JSON.stringify(text)}`, !!g && near(g.lat, lat, eps) && near(g.lon, lon, eps), JSON.stringify(g));
};
const not = (text: string) => { const g = parseCoordinates(text); check(`leaves alone ${JSON.stringify(text)}`, g === null, JSON.stringify(g)); };

// What people paste.
is("46.1347, 24.5012", 46.1347, 24.5012);
is("46.1347,24.5012", 46.1347, 24.5012);
is("  46.1347 24.5012\n", 46.1347, 24.5012);
is("46.1347; 24.5012", 46.1347, 24.5012);
is("-33.8568, 151.2153", -33.8568, 151.2153);
is("40.7128, -74.0060", 40.7128, -74.006);
is("46.1347° N, 24.5012° E", 46.1347, 24.5012);
is("N 46.1347 E 24.5012", 46.1347, 24.5012);
is("24.5012 E 46.1347 N", 46.1347, 24.5012);
is("33.8568 S 151.2153 E", -33.8568, 151.2153);
is(`46°08'05.0"N 24°30'04.3"E`, 46 + 8 / 60 + 5 / 3600, 24 + 30 / 60 + 4.3 / 3600);
is("46°08′05″N 24°30′04″E", 46 + 8 / 60 + 5 / 3600, 24 + 30 / 60 + 4 / 3600);
is("46°08.083'N 24°30.072'E", 46 + 8.083 / 60, 24 + 30.072 / 60);
is("https://www.google.com/maps/place/Bistri%C8%9Ba/@47.1357,24.4889,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d47.1361!4d24.4931", 47.1361, 24.4931);
is("https://www.google.com/maps/@46.1347,24.5012,17z", 46.1347, 24.5012);
is("https://www.google.com/maps/search/?api=1&query=46.134700,24.501200", 46.1347, 24.5012);
is("https://maps.google.com/?q=46.1347,24.5012", 46.1347, 24.5012);
is("https://www.openstreetmap.org/?mlat=46.1347&mlon=24.5012#map=17/46.1/24.5", 46.1347, 24.5012);
is("https://www.openstreetmap.org/#map=17/46.1347/24.5012", 46.1347, 24.5012);
is("geo:46.1347,24.5012", 46.1347, 24.5012);
not("hello world");
not("46.1347");
not("Junction 5");
not("12 cars, 3 buses");
not("95.0, 24.5");
not("46.1, 190.2");
not("46.1 N 24.5 N");
not(`{"lanes":[],"connectors":[]}`);
not("https://example.com/page");

// Adding, changing, deleting.
const geo = { lat: 46.1347, lon: 24.5012 };
const base: Sketch = { ...emptySketch(), geo };
const at = project(geo, 46.1357, 24.5032);
const [sk1, m1] = addMark(base, at);
check("a new mark: m1, 'Mark 1', the default colour, to the centimetre", m1.id === "m1" && m1.name === "Mark 1" && m1.color === MARK_COLOR && m1.at.x === Math.round(at.x * 100) / 100);
const back = unproject(geo, m1.at);
check("its coordinates read back within 1 cm", Math.hypot(project(geo, back.lat, back.lon).x - at.x, project(geo, back.lat, back.lon).y - at.y) < 0.01);
const [sk2, m2] = addMark(sk1, { x: 10, y: 10 }, { name: "  Depot ", color: "#2563eb" });
check("the next: m2, named and coloured as given", m2.id === "m2" && m2.name === "Depot" && m2.color === "#2563eb" && sk2.marks?.length === 2);
const sk3 = updateMark(sk2, "m2", { color: "not a colour", name: "Garage", at: { x: 1.234, y: 5.678 } });
const u = sk3.marks!.find(x => x.id === "m2")!;
check("changed: a bad colour ignored, the name, the place (to the cm)", u.color === "#2563eb" && u.name === "Garage" && u.at.x === 1.23 && u.at.y === 5.68);
check("deleting the last mark leaves no marks list", !("marks" in deleteMark(deleteMark(sk3, "m1"), "m2")));

// Under the pointer: the head above the place, or the tip.
const px = 0.1, mk = sk3.marks!.find(x => x.id === "m1")!;
check("its head picks it", markAt(sk3.marks, { x: mk.at.x, y: mk.at.y - PIN.rise * px }, px)?.id === "m1");
check("its tip picks it", markAt(sk3.marks, mk.at, px)?.id === "m1");
check("beside it picks nothing", markAt(sk3.marks, { x: mk.at.x + 30 * px, y: mk.at.y }, px) === null);

// Kept: sanitized, saved, patched.
const clean = sanitizeMarks([{ id: "m1", at: { x: 1, y: 2 }, color: "#ABCDEF", name: "A" }, { id: "m1", at: { x: 3, y: 4 } }, { id: "m3", at: { x: Number.NaN, y: 0 } }, { at: { x: 0, y: 0 } }, { id: "m4", at: { x: 5, y: 6 }, color: "red" }]);
check("sanitize: a repeated id, a bad place, no id dropped; colour lower case, a bad one the default, a name given", clean.map(x => x.id).join() === "m1,m4" && clean[0].color === "#abcdef" && clean[1].color === MARK_COLOR && clean[1].name === "Mark 4");
const only = sanitizeSketch({ lanes: [], connectors: [], roads: [], junctions: [], marks: [{ id: "m1", name: "X", at: { x: 1, y: 1 }, color: "#123456" }] });
check("a sketch with only marks is a sketch still, its marks kept", !!only && only.marks?.length === 1 && only.marks[0].name === "X");
check("a saved sketch keeps its marks through sanitizing", JSON.stringify(sanitizeSketch(sk3)?.marks) === JSON.stringify(sk3.marks));
const patched = applyPatch(sk3, { marks: [{ id: "m1", name: "Renamed" }, { id: "m9", name: "New", at: { x: 0, y: 0 }, color: "#16a34a" }], remove: { marks: ["m2"] } });
const pm = patched?.marks ?? [];
check("a patch renames one (keeping its place), adds one, removes one", pm.length === 2 && pm.find(x => x.id === "m1")?.name === "Renamed" && pm.find(x => x.id === "m1")?.at.x === mk.at.x && pm.some(x => x.id === "m9") && !pm.some(x => x.id === "m2"));

console.log(ok ? "marks check: all ok" : "marks check: FAILED");
process.exit(ok ? 0 : 1);
