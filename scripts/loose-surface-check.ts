/**
 * Road surface under the connectors on no junction (ticket #111): what gets paved, and what is grouped. A lane fanning out
 * into two has its connectors paved and the wedge between them filled; two carriageways joined across a gap either side of a
 * narrow median stay apart (the median not paved); a road's pieces joined one to the next aren't one group; a junction's
 * connectors are left to it.   npm run loose:check
 */
import { contentsOf, insideLoops, onBands, type Sketch, type SketchConnector, type SketchJunction, type SketchLane, type SketchRoad } from "../src/lib/lane-sketch";
import { looseSurfaces } from "../src/lib/loose-surface";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  ok &&= pass;
  console.log(`${pass ? "ok  " : "FAIL"} ${name}${pass || !detail ? "" : ` (${detail})`}`);
};
const line = (id: string, pts: [number, number][]): SketchLane => ({ id, width: 3.5, inRate: 0, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) } });
const conn = (id: string, f: string, fs: number, t: string, ts: number): SketchConnector => ({ id, from: { lane: f, s: fs }, to: { lane: t, s: ts } });
const road = (id: string, lanes: string[]): SketchRoad => ({ id, name: id, lanes });
const sketch = (lanes: SketchLane[], connectors: SketchConnector[], roads: SketchRoad[], junctions: SketchJunction[] = []): Sketch =>
  ({ lanes, connectors, roads, junctions, traffic: { rate: 0, speed: 50, seed: 1 } });
const surfaces = (sk: Sketch) => looseSurfaces(sk, contentsOf(sk));
const paved = (sk: Sketch, x: number, y: number) => surfaces(sk).some(g => onBands(g.bands, { x, y }) || insideLoops({ x, y }, g.fill));
const onBandsOnly = (sk: Sketch, x: number, y: number) => surfaces(sk).some(g => onBands(g.bands, { x, y }));

// A lane ending at (30, 0), fanning out into two lanes 5 m apart (their edges 1.5 m apart) that start at x 42.
const fanLanes = [line("A", [[0, 0], [30, 0]]), line("B", [[42, -2.5], [80, -2.5]]), line("C", [[42, 2.5], [80, 2.5]])];
const fan = sketch(fanLanes, [conn("cB", "A", 30, "B", 0), conn("cC", "A", 30, "C", 0)], [road("rA", ["A"]), road("rBC", ["B", "C"])]);
{
  const gs = surfaces(fan);
  check("a lane fanning out: its two connectors, one group", gs.length === 1 && gs[0].connectors.length === 2, JSON.stringify(gs.map(g => g.connectors)));
  check("…their bands paved", paved(fan, 36, 0) && paved(fan, 41, -2.4) && paved(fan, 41, 2.4));
  check("…the wedge between them, off their bands, paved by the fill", !onBandsOnly(fan, 41.5, 0) && paved(fan, 41.5, 0));
  check("…and nothing out beyond them", !paved(fan, 36, 6) && !paved(fan, 36, -6));
}

// Two carriageways, each joined across a 3 m gap, a 2.5 m median between them.
const twin = sketch(
  [line("E1", [[0, 3], [30, 3]]), line("E2", [[33, 3], [60, 3]]), line("W1", [[60, -3], [33, -3]]), line("W2", [[30, -3], [0, -3]])],
  [conn("cE", "E1", 30, "E2", 0), conn("cW", "W1", 27, "W2", 0)],
  [road("east", ["E1"]), road("east2", ["E2"]), road("west", ["W1"]), road("west2", ["W2"])],
);
{
  const gs = surfaces(twin);
  check("two carriageways: each join on its own", gs.length === 2 && gs.every(g => g.connectors.length === 1 && !g.fill.length), JSON.stringify(gs.map(g => g.connectors)));
  check("…each gap paved", paved(twin, 31.5, 3) && paved(twin, 31.5, -3));
  check("…the median between them not", !paved(twin, 31.5, 0));
}

// A road's pieces joined one to the next: each join its own.
const chain = sketch(
  [line("R1", [[0, 0], [20, 0]]), line("R2", [[22, 0], [40, 0]]), line("R3", [[42, 0], [60, 0]])],
  [conn("c12", "R1", 20, "R2", 0), conn("c23", "R2", 18, "R3", 0)],
  [road("r1", ["R1"]), road("r2", ["R2"]), road("r3", ["R3"])],
);
check("a road's pieces joined one to the next: not one group", surfaces(chain).length === 2, JSON.stringify(surfaces(chain).map(g => g.connectors)));

// The fan inside a junction: its connectors are the junction's to pave.
const square = (x0: number, y0: number, x1: number, y1: number) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const inJunction = sketch(fan.lanes, fan.connectors, fan.roads, [{ id: "j1", name: "Junction 1", outline: square(28, -6, 44, 6) }]);
check("connectors on a junction: left to it", surfaces(inJunction).length === 0, JSON.stringify(surfaces(inJunction).map(g => g.connectors)));

console.log(ok ? "loose surface check: all ok" : "loose surface check: FAILED");
if (!ok) process.exit(1);
