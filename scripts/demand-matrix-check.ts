/**
 * Demand matrices (ticket #113) on a small sketch: two ways in (A, B), two ways out (X, Y), B reaching X only. The current
 * demand as a matrix; a matrix in use sending its cells' traffic and nothing else; matrices by the time of day switched as the
 * simulation's clock passes from one period to the next, falling back to the ways' rates where none covers the time; no
 * matrix in use, the run as before; cells set, scaled, copied as text and read back.   npm run matrix:check
 */
import { demandWays, MATRIX_BY_TIME, sanitizeSketch, type Sketch, type SketchConnector, type SketchLane } from "../src/lib/lane-sketch";
import { addMatrix, moveLostCell, sameStreet, currentDemand, inPeriod, matrixAt, matrixGrid, matrixText, overlaps, parseCells, reachable, scaleMatrix, setCells, setStartClock, updateMatrix, setMatrixOn } from "../src/lib/demand-matrix";
import { SketchSim } from "../src/lib/lane-sketch-sim";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const line = (id: string, pts: [number, number][]): SketchLane => ({ id, width: 3.5, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) } });
const conn = (id: string, f: string, fs: number, t: string): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: 0 } });
const base: Sketch = {
  lanes: [line("A", [[0, 0], [60, 0]]), line("B", [[0, 40], [60, 40]]), line("X", [[80, 20], [200, 20]]), line("Y", [[80, -20], [200, -20]])],
  connectors: [conn("cAX", "A", 60, "X"), conn("cAY", "A", 60, "Y"), conn("cBX", "B", 60, "X")],
  roads: [], junctions: [], traffic: { rate: 400, speed: 50, seed: 1 },
};
const ways = demandWays(base), way = (lanes: "entries" | "exits", lane: string) => ways[lanes].find(w => w.lanes.includes(lane))!;
const A = way("entries", "A"), B = way("entries", "B"), X = way("exits", "X"), Y = way("exits", "Y");

// the current demand, as a matrix
{
  const od = currentDemand(base), can = reachable(base);
  check("reachable: A to X and Y, B to X only", can.get(A.key)!.size === 2 && can.get(B.key)!.size === 1 && can.get(B.key)!.has(X.key));
  check("the current demand as a matrix: each way in's rate over the ways out it reaches, by their shares", od.A?.X === 200 && od.A?.Y === 200 && od.B?.X === 400 && od.B?.Y === undefined, JSON.stringify(od));
}

/** a run: each car in, where it came in and where it was going, and when */
function run(sk: Sketch, T: number) {
  const sim = new SketchSim(sk, { rate: 400, speed: 50 }, 1), ins: { t: number; lane: string; dest: string }[] = [];
  const s = sim as unknown as { note: (e: Record<string, unknown>) => void }, was = s.note.bind(sim);
  s.note = e => { was(e); if (e.what === "in") ins.push({ t: sim.t, lane: String(e.lane).replace(/^lane:/, ""), dest: String(e.dest) }); };
  while (sim.t < T) sim.step(0.1);
  return { ins, stats: sim.stats() };
}
const count = (xs: { lane: string; dest: string }[], lane: string | null, dest: string | null) => xs.filter(x => (lane === null || x.lane === lane) && (dest === null || x.dest === dest)).length;

// one matrix in use
{
  const [sk0, m] = addMatrix(base, "empty", "Test")!;
  const sk = setCells(sk0, m.id, [{ from: A, to: X, rate: 300 }, { from: A, to: Y, rate: 100 }]);
  check("a new matrix is put in use", sk.matrixOn === m.id);
  const r = run(sk, 3600), aX = count(r.ins, "A", "X"), aY = count(r.ins, "A", "Y"), b = count(r.ins, "B", null);
  check("in use: its cells' traffic (A to X 300/h, A to Y 100/h), within chance", aX > 240 && aX < 360 && aY > 70 && aY < 135, `A→X ${aX}, A→Y ${aY}`);
  check("…and nothing else (B has no cells: no cars, the ways' own rates aside)", b === 0, `B ${b}`);
  check("…the stats say which", r.stats.demand?.matrix === m.id, JSON.stringify(r.stats.demand));
  const sk2 = sanitizeSketch(JSON.parse(JSON.stringify(sk)))!;
  check("kept through saving", sk2.matrixOn === m.id && sk2.matrices?.[0].od.A?.X === 300);
}

// by the time of day
{
  const [sk1, m1] = addMatrix(setStartClock(base, 7 * 60 + 30), "empty", "Early")!;
  let [sk] = addMatrix(sk1, "empty", "Late")!;
  const m2 = sk.matrices![1];
  sk = updateMatrix(sk, m1.id, { start: 7 * 60, end: 8 * 60 }); sk = updateMatrix(sk, m2.id, { start: 8 * 60, end: 9 * 60 });
  sk = setCells(sk, m1.id, [{ from: A, to: X, rate: 600 }]); sk = setCells(sk, m2.id, [{ from: A, to: Y, rate: 600 }]);
  sk = setMatrixOn(sk, MATRIX_BY_TIME);
  check("by the time of day: the matrix whose period it is", matrixAt(sk, 7 * 60 + 45)?.id === m1.id && matrixAt(sk, 8 * 60 + 10)?.id === m2.id && matrixAt(sk, 10 * 60) === null);
  const r = run(sk, 3600), early = r.ins.filter(x => x.t < 1790), late = r.ins.filter(x => x.t > 1810);
  check("…starting at 07:30, the first half hour on Early (A to X)", count(early, "A", "X") > 240 && count(early, "A", "Y") === 0 && count(early, "B", null) === 0, `A→X ${count(early, "A", "X")}, A→Y ${count(early, "A", "Y")}, B ${count(early, "B", null)}`);
  check("…then on Late, from 08:00 (A to Y)", count(late, "A", "Y") > 240 && count(late, "A", "X") === 0, `A→Y ${count(late, "A", "Y")}, A→X ${count(late, "A", "X")}`);
  check("…the stats on Late at 08:30", r.stats.demand?.matrix === m2.id && Math.abs(r.stats.demand!.clock - 510) < 0.1, JSON.stringify(r.stats.demand));
  const after = run(setStartClock(sk, 8 * 60 + 50), 1200), lateOn = after.ins.filter(x => x.t < 590), none = after.ins.filter(x => x.t > 610);
  check("…and past 09:00, no matrix for the time: the ways' rates and shares again (B comes in)", count(lateOn, "B", null) === 0 && count(none, "B", null) > 40, `B before 09:00 ${count(lateOn, "B", null)}, after ${count(none, "B", null)}`);
  check("periods past midnight", inPeriod({ id: "n", name: "n", od: {}, start: 22 * 60, end: 6 * 60 }, 23 * 60) && inPeriod({ id: "n", name: "n", od: {}, start: 22 * 60, end: 6 * 60 }, 60) && !inPeriod({ id: "n", name: "n", od: {}, start: 22 * 60, end: 6 * 60 }, 12 * 60));
  check("overlapping periods found", overlaps(updateMatrix(sk, m2.id, { start: 7 * 60 + 30, end: 9 * 60 })).length === 1 && overlaps(sk).length === 0);
}

// no matrix in use: the run as before
{
  const [withOne] = addMatrix(base, "current")!, idle = setMatrixOn(withOne, null);
  const a = run(base, 900), b = run(idle, 900);
  check("matrices kept but none in use: the very same run", a.stats.spawned === b.stats.spawned && a.stats.finished === b.stats.finished && JSON.stringify(a.ins) === JSON.stringify(b.ins), `${a.stats.spawned} / ${b.stats.spawned} in`);
}

// cells as a spreadsheet's
{
  const [sk0, m] = addMatrix(base, "current")!;
  let sk = sk0;
  const names = { entries: [A, B], exits: [X, Y] }, text = matrixText(sk, sk.matrices![0], names);
  check("copied as text: a header row, then a row a way in", text.split("\n").length === 3 && text.split("\n")[1].split("\t").slice(1).join() === "200,200", JSON.stringify(text));
  const cells = parseCells("10\t20\n30\t0\n");
  check("text pasted read back as numbers", JSON.stringify(cells) === "[[10,20],[30,0]]");
  check("…a comma decimal with semicolons", JSON.stringify(parseCells("1,5;2\n")) === "[[1.5,2]]");
  sk = scaleMatrix(sk, m.id, 1.5);
  const g = matrixGrid(sk, sk.matrices![0]);
  check("scaled by 1.5", g.cell.get(A.key)?.get(X.key) === 300 && g.total === 1200, `${g.total}`);
  sk = setCells(sk, m.id, [{ from: A, to: Y, rate: 0 }]);
  check("a cell set to 0: gone", sk.matrices![0].od.A?.Y === undefined && matrixGrid(sk, sk.matrices![0]).rows.get(A.key) === 300);
}

// ticket #120: a way out carried on (its lane now leads on to another): its cells follow; carried on past a fork: kept apart, to move
{
  const [s0, m] = addMatrix(base, "empty", "Follow")!;
  const sk0 = setCells(s0, m.id, [{ from: A, to: X, rate: 300 }]);
  const on: Sketch = { ...sk0, lanes: [...sk0.lanes, line("X2", [[210, 20], [300, 20]])], connectors: [...sk0.connectors, conn("cXX2", "X", 120, "X2")] };
  const X2 = demandWays(on).exits.find(w => w.lanes.includes("X2"))!;
  const g = matrixGrid(on, on.matrices![0]);
  check("a way out carried on to a new end: its cells follow there", g.cell.get(A.key)?.get(X2.key) === 300 && !g.lost.length, JSON.stringify([...g.cols]));
  const set = setCells(on, m.id, [{ from: A, to: X2, rate: 50 }]), g2 = matrixGrid(set, set.matrices![0]);
  check("…a cell set there then: the one kept under the old lane goes (not counted twice)", g2.cell.get(A.key)?.get(X2.key) === 50 && g2.total === 50, JSON.stringify(set.matrices![0].od));
  const fork: Sketch = { ...on, lanes: [...on.lanes, line("X3", [[210, 40], [300, 60]])], connectors: [...on.connectors, conn("cXX3", "X", 120, "X3")] };
  const g3 = matrixGrid(fork, fork.matrices![0]);
  check("carried on past a fork: the cell can't be placed, listed (not simulated)", g3.lost.length === 1 && g3.lost[0].rate === 300 && g3.lost[0].toWay === null && g3.total === 0, JSON.stringify(g3.lost));
  const X3 = demandWays(fork).exits.find(w => w.lanes.includes("X3"))!, moved = moveLostCell(fork, m.id, g3.lost[0], { from: A, to: X3 });
  const g4 = matrixGrid(moved, moved.matrices![0]);
  check("…moved to a way out picked: placed there", g4.cell.get(A.key)?.get(X3.key) === 300 && !g4.lost.length, JSON.stringify(moved.matrices![0].od));
}

// ticket #122: in and back out by the same street (a road's way in and its way out, or two roads of one name at one place): no trip
{
  const street: Sketch = { ...base, roads: [{ id: "rAY", name: "Strada A", lanes: ["A", "Y"] }] };
  const w = demandWays(street), a = w.entries.find(x => x.lanes.includes("A"))!, y = w.exits.find(x => x.lanes.includes("Y"))!, xw = w.exits.find(x => x.lanes.includes("X"))!;
  check("a road's way in and its way out: the same street", sameStreet(street, a, y) && !sameStreet(street, a, xw));
  // (Z: Strada A's other direction, ending beside where A starts; Y, a road of that name too, ends 200 m away)
  const named: Sketch = { ...base, lanes: [...base.lanes, line("Z", [[50, 4], [0, 4]])], roads: [{ id: "r1", name: "Strada A", lanes: ["A"] }, { id: "r2", name: "Strada A", lanes: ["Z"] }, { id: "r3", name: "Strada A", lanes: ["Y"] }] }, wn = demandWays(named);
  const na = wn.entries.find(x => x.lanes.includes("A"))!;
  check("…two roads of one name, A's start and Z's end together: the same street", sameStreet(named, na, wn.exits.find(x => x.lanes.includes("Z"))!));
  check("…of that name but its far end (200 m off): not", !sameStreet(named, na, wn.exits.find(x => x.lanes.includes("Y"))!));
  const od = currentDemand(street);
  check("the demand now as a matrix: none back out by the same street, all of A's to X", od.A?.Y === undefined && od.A?.X === 400, JSON.stringify(od));
  const [s0, m] = addMatrix(street, "empty")!, sk = { ...s0, matrices: [{ ...m, od: { A: { Y: 120, X: 30 } } }] };
  const g = matrixGrid(sk, sk.matrices[0]);
  check("…a cell kept there already: listed apart (not simulated), the rest as it was", g.lost.length === 1 && g.lost[0].same === true && g.lost[0].rate === 120 && g.total === 30, JSON.stringify(g.lost));
  const moved = moveLostCell(sk, m.id, g.lost[0], { from: a, to: xw }), g2 = matrixGrid(moved, moved.matrices![0]);
  check("…moved to another way out: added to what is there", g2.cell.get(a.key)?.get(xw.key) === 150 && !g2.lost.length, JSON.stringify(moved.matrices![0].od));
}

console.log(ok ? "demand matrix check: all ok" : "demand matrix check: FAILED");
if (!ok) process.exit(1);
