/**
 * Lanes' side lines set by hand (ticket #263): solid, dashed, or mixed (a solid line with a dashed one on the lane's side)
 * on each side of a lane. Checks what `roadMarkings` draws for each (between two lanes the same way, at the road's edge,
 * between ways running opposite), that a sketch with none set draws as before, that what a lane says about its own
 * side wins over the lane beyond, that lanes in no road (a roundabout's rings and the lanes round them) get their lines
 * too, with each other and with a road's lanes beside them, and that the cars keep to it: on a two-lane road whose right
 * lane leads only to a closed way out, its cars change over to the left lane where they may cross, and never where they may not.
 * npm run lines:check
 */
import { SketchSim, DEFAULT_SIM } from "../src/lib/lane-sketch-sim";
import { mayChangeAt, reverseLane, roadMarkings, sanitizeSketch, setLaneLine, type Marking, type SideLine, type Sketch, type SketchLane } from "../src/lib/lane-sketch";

let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

/** two lanes east, 300 m (y down: l1, at y = 3.6, has l0 on its left), and one west beside l0 when `opposite` */
function road(opposite = false): Sketch {
  const line = (id: string, y: number, west = false): SketchLane => ({ id, width: 3.5, shape: { kind: "line", pts: west ? [{ x: 300, y }, { x: 0, y }] : [{ x: 0, y }, { x: 300, y }] } });
  const lanes = [line("l0", 0), line("l1", 3.6), ...(opposite ? [line("w0", -3.6, true)] : [])];
  return { lanes, connectors: [], roads: [{ id: "r1", name: "Road", lanes: lanes.map(l => l.id) }], junctions: [], traffic: { rate: 900, speed: 50, seed: 1 } };
}
const set = (sk: Sketch, lane: string, side: "left" | "right", v: SideLine | null) => setLaneLine(sk, lane, side, v);
/** the markings as `kind dashed/solid @ y` (each line's y half way along), sorted */
const marks = (sk: Sketch) => roadMarkings(sk).map((m: Marking) => {
  const p = m.pts[m.pts.length >> 1];
  return `${m.kind} ${m.dashed ? "dashed" : "solid"} @ ${p.y.toFixed(2)}`;
}).sort();
const eq = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify(b);

// --- what is drawn
{
  const base = road();
  check(eq(marks(base), ["lane dashed @ 1.85"]), `none set: a dashed line between the lanes, as before (${marks(base)})`);
  check(eq(marks(set(base, "l1", "left", "solid")), ["lane solid @ 1.85"]), "l1's left solid: a solid line");
  check(eq(marks(set(base, "l0", "right", "solid")), ["lane solid @ 1.85"]), "l0's right solid (l1's left not set): a solid line");
  // (mixed on l1's left: the dashed half on l1's side, y = 2.00; the solid on l0's, y = 1.70)
  check(eq(marks(set(base, "l1", "left", "mixed")), ["lane dashed @ 2.00", "lane solid @ 1.70"]), `l1's left mixed: dashed on its side (${marks(set(base, "l1", "left", "mixed"))})`);
  check(eq(marks(set(base, "l0", "right", "mixed")), ["lane dashed @ 1.70", "lane solid @ 2.00"]), `l0's right mixed: dashed on l0's side (${marks(set(base, "l0", "right", "mixed"))})`);
  check(eq(marks(set(set(base, "l0", "right", "solid"), "l1", "left", "dashed")), ["lane dashed @ 2.00", "lane solid @ 1.70"]), "l0 solid, l1 dashed: a mixed line, dashed on l1's side");
  check(eq(marks(set(set(base, "l0", "right", "dashed"), "l1", "left", "dashed")), ["lane dashed @ 1.85"]), "both dashed: a dashed line");
  check(eq(marks(set(base, "l0", "left", "solid")), ["lane dashed @ 1.85", "lane solid @ -1.75"]), "l0's left solid at the road's edge: an edge line there");
  check(eq(marks(set(base, "l1", "right", "mixed")), ["lane dashed @ 1.85", "lane dashed @ 5.20", "lane solid @ 5.50"]), `l1's right mixed at the edge: dashed inside (${marks(set(base, "l1", "right", "mixed"))})`);
  const opp = road(true);
  check(eq(marks(opp), ["center solid @ -1.60", "center solid @ -1.90", "lane dashed @ 1.85"]), `none set, a way west beside (3 lanes): the double centre line, as before (${marks(opp)})`);
  check(eq(marks(set(opp, "w0", "left", "solid")), ["center solid @ -1.75", "lane dashed @ 1.85"]), "the way west's left solid: a solid centre line");
  check(eq(marks(set(opp, "l0", "left", "mixed")), ["center dashed @ -1.60", "center solid @ -1.90", "lane dashed @ 1.85"]), `l0's left mixed against the way west: dashed on l0's side (${marks(set(opp, "l0", "left", "mixed"))})`);
  // (a lane turned round: its left its right)
  const rev = reverseLane(set(base, "l0", "left", "solid"), "l0");
  check(rev.lanes.find(l => l.id === "l0")?.lines?.right === "solid" && !rev.lanes.find(l => l.id === "l0")?.lines?.left, "turned round: its left line now its right");
  // (kept and checked when the sketch is read)
  const read = sanitizeSketch(JSON.parse(JSON.stringify({ ...base, lanes: base.lanes.map((l, i) => (i ? { ...l, lines: { left: "mixed", right: "wavy" } } : l)) })));
  check(read?.lanes[1].lines?.left === "mixed" && read?.lanes[1].lines?.right === undefined, "read back: a known line kept, an unknown one left out");
}

// --- lanes in no road (a roundabout's): their lines too
{
  /** a ring round (0, 0), `r` metres out, 3.5 m wide, running the same way as the others */
  const ring = (id: string, r: number): SketchLane => ({ id, width: 3.5, shape: { kind: "arc", c: { x: 0, y: 0 }, r, a0: 0, sweep: -2 * Math.PI } });
  /** a lane round a quarter of it, outside the ring of radius 10 (in no road) */
  const quarter: SketchLane = { id: "q", width: 3.5, shape: { kind: "arc", c: { x: 0, y: 0 }, r: 13.5, a0: 0, sweep: -Math.PI / 2 } };
  const sk = (lanes: SketchLane[], roads: Sketch["roads"] = []): Sketch => ({ lanes, connectors: [], roads, junctions: [] });
  /** each line as `kind dashed/solid @ r` (its distance from the middle, half way along) and how long it is */
  const rmarks = (x: Sketch) => roadMarkings(x).map(m => {
    const p = m.pts[m.pts.length >> 1];
    let len = 0;
    for (let i = 1; i < m.pts.length; i++) len += Math.hypot(m.pts[i].x - m.pts[i - 1].x, m.pts[i].y - m.pts[i - 1].y);
    return `${m.kind} ${m.dashed ? "dashed" : "solid"} @ ${Math.hypot(p.x, p.y).toFixed(2)} ${len > 60 ? "round" : len > 15 ? "quarter" : "short"}`;
  }).sort();
  const two = sk([ring("in", 10), ring("out", 13.5)]);
  check(eq(rmarks(two), ["lane dashed @ 11.75 round"]), `two rings in no road: a dashed line between them all round (${rmarks(two)})`);
  const roadRing = sk([ring("in", 10), ring("out", 13.5)], [{ id: "r", name: "Ring", lanes: ["out"] }]);
  check(eq(rmarks(roadRing), ["lane dashed @ 11.75 round"]), `a ring in no road, one in a road outside it: the line between them once (${rmarks(roadRing)})`);
  check(eq(rmarks(sk([ring("in", 10), quarter])), ["lane dashed @ 11.75 quarter"]), `a lane round a quarter of a ring: a dashed line where it is beside it (${rmarks(sk([ring("in", 10), quarter]))})`);
  const qSolid = setLaneLine(sk([ring("in", 10), quarter]), "q", "left", "solid");
  check(eq(rmarks(qSolid), ["lane solid @ 11.75 quarter"]), `…its left, towards the ring (it runs the same way round), set solid: a solid line (${rmarks(qSolid)})`);
  check(eq(rmarks(sk([ring("in", 10)])), []), "a ring alone: no line");
}

// --- the cars
/**
 * cars come in on one lane only (the other fed from a lane with no traffic) and leave by the other only (the first's way
 * out closed, its share 0): every car must change over, `from` → `to` (l1 → l0, or l0 → l1)
 */
function forced(from: "l0" | "l1", lines: (sk: Sketch) => Sketch): Sketch {
  const sk = road(), to = from === "l1" ? "l0" : "l1", y = (id: string) => (id === "l0" ? 0 : 3.6);
  const ex = (id: string, lane: string, w: number): SketchLane => ({ id, width: 3.5, shape: { kind: "line", pts: [{ x: 310, y: y(lane) }, { x: 400, y: y(lane) }] }, outWeight: w });
  const feed: SketchLane = { id: "f", width: 3.5, inRate: 0, shape: { kind: "line", pts: [{ x: -100, y: y(to) }, { x: -10, y: y(to) }] } };
  const lanes = [...sk.lanes.map(l => ({ ...l, inRate: l.id === from ? 600 : 0 })), ex("x0", "l0", to === "l0" ? 1 : 0), ex("x1", "l1", to === "l1" ? 1 : 0), feed];
  return lines({ ...sk, lanes, connectors: [
    { id: "c0", from: { lane: "l0", s: 300 }, to: { lane: "x0", s: 0 } }, { id: "c1", from: { lane: "l1", s: 300 }, to: { lane: "x1", s: 0 } },
    { id: "cf", from: { lane: "f", s: 90 }, to: { lane: to, s: 0 } },
  ] });
}
/** the lane changes the cars made, by way (`l1>l0`: from l1 straight onto l0), in `seconds` */
function changes(sk: Sketch, seconds = 180) {
  const sim = new SketchSim(sk, { ...(sk.traffic ?? DEFAULT_SIM), seed: 1 }, 1);
  const was = new Map<number, string>(), n = { "l1>l0": 0, "l0>l1": 0 };
  for (let i = 0; i < seconds / 0.1; i++) {
    sim.step(0.1);
    for (const v of sim.vehicles) {
      const k = v.edge.kind === "lane" ? v.edge.id : "", w = was.get(v.id);
      if (w && w !== k && `${w}>${k}` in n) n[`${w}>${k}` as keyof typeof n]++;
      was.set(v.id, k);
    }
  }
  return n;
}
const L = (sk: Sketch, id: string) => sk.lanes.find(l => l.id === id)!;
// (what each says: may cars change l1 → l0, and l0 → l1)
for (const [what, f, may10, may01] of [
  ["none set", (sk: Sketch) => sk, true, true],
  ["l1's left solid", (sk: Sketch) => set(sk, "l1", "left", "solid"), false, false],
  ["l1's left dashed", (sk: Sketch) => set(sk, "l1", "left", "dashed"), true, true],
  ["l1's left mixed (dashed its side)", (sk: Sketch) => set(sk, "l1", "left", "mixed"), true, false],
  ["l0's right mixed (dashed its side)", (sk: Sketch) => set(sk, "l0", "right", "mixed"), false, true],
  ["l0's right solid", (sk: Sketch) => set(sk, "l0", "right", "solid"), false, false],
  ["l0's right solid, l1's left dashed (each its own say)", (sk: Sketch) => set(set(sk, "l0", "right", "solid"), "l1", "left", "dashed"), true, false],
] as const) {
  for (const [from, may] of [["l1", may10], ["l0", may01]] as const) {
    const sk = forced(from, f), to = from === "l1" ? "l0" : "l1";
    check(mayChangeAt(L(sk, from), L(sk, to), 150) === may, `${what}: ${from} → ${to} ${may ? "allowed" : "not allowed"}`);
    const n = changes(sk), k = from === "l1" ? "l1>l0" : "l0>l1";
    check(may ? n[k] > 0 : n[k] === 0, `${what}: ${n[k]} cars changed ${from} → ${to} (all changes: ${JSON.stringify(n)})`);
  }
}

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("all ok");
