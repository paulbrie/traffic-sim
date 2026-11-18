/**
 * Roads drawn over each other (overlap-check.ts, the problem console's "drawn over"): two roads' lanes alongside closer than a
 * lane's width for 20 m or more are flagged once, with the longest stretch's length and its middle; not two lanes of one road,
 * lanes side by side a lane's width apart (or a little less), a crossing, a stretch under 20 m, one inside a junction, one lane
 * going on into the next, nor one road over another at another level. As Bistrița's Calea Moldovei (ticket #259): one direction's
 * lane drawn 0.9 m into the other's.   npm run drawn-over:check
 */
import { roadsDrawnOver } from "../src/lib/overlap-check";
import type { Sketch, SketchLane } from "../src/lib/lane-sketch";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => { ok &&= pass; console.log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`); };
const line = (id: string, pts: [number, number][], more: Partial<SketchLane> = {}): SketchLane => ({ id, width: 3.5, shape: { kind: "line", pts: pts.map(([x, y]) => ({ x, y })) }, ...more });
const sk = (lanes: SketchLane[], more: Partial<Sketch> = {}): Sketch => ({ lanes, connectors: [], roads: [{ id: "rA", name: "A", lanes: ["a"] }, { id: "rB", name: "B", lanes: ["b"] }], junctions: [], ...more });
const show = (s: Sketch) => JSON.stringify(roadsDrawnOver(s).map(d => ({ roads: d.roads, length: Math.round(d.length), at: { x: Math.round(d.at.x), y: Math.round(d.at.y) } })));

// a: 0..200 along y = 0; b the other way, 2.6 m off (3.5 m apart less 0.9: Calea Moldovei's) from x 50 to 150, then away
const over = sk([line("a", [[0, 0], [200, 0]]), line("b", [[200, 30], [150, 2.6], [50, 2.6], [0, 30]])]);
{
  const d = roadsDrawnOver(over);
  check("drawn 0.9 m into the other way: flagged once, the two roads named", d.length === 1 && [...d[0].roads].sort().join() === "rA,rB", show(over));
  check("…the stretch about 100 m, its middle about x 100", d.length === 1 && Math.abs(d[0].length - 100) < 6 && Math.abs(d[0].at.x - 100) < 6 && Math.abs(d[0].at.y) < 3, show(over));
}
const apart = sk([line("a", [[0, 0], [200, 0]]), line("b", [[200, 3.5], [0, 3.5]])]);
check("a lane's width apart: not flagged", roadsDrawnOver(apart).length === 0, show(apart));
const nearly = sk([line("a", [[0, 0], [200, 0]]), line("b", [[200, 3.1], [0, 3.1]])]);
check("drawn a little off (3.1 m apart): not flagged", roadsDrawnOver(nearly).length === 0, show(nearly));
const oneRoad = { ...over, roads: [{ id: "r", name: "R", lanes: ["a", "b"] }] };
// (the same lanes as `over`, asked about just before, now in one road: the answer follows the roads, not only the lanes, as it does
// for the junction below; making a road of lanes or drawing a junction round them leaves the lanes as they were)
check("two lanes of one road: not flagged", roadsDrawnOver(oneRoad).length === 0, show(oneRoad));
const cross = sk([line("a", [[0, 0], [200, 0]]), line("b", [[100, -100], [100, 100]])]);
check("a crossing: not flagged", roadsDrawnOver(cross).length === 0, show(cross));
const short = sk([line("a", [[0, 0], [200, 0]]), line("b", [[112, 40], [110, 2], [95, 2], [93, 40]])]);
check("alongside for 15 m: not flagged", roadsDrawnOver(short).length === 0, show(short));
const inJ = { ...over, junctions: [{ id: "j", name: "J", outline: [{ x: 40, y: -10 }, { x: 160, y: -10 }, { x: 160, y: 15 }, { x: 40, y: 15 }] }] };
check("the stretch inside a junction: not flagged", roadsDrawnOver(inJ).length === 0, show(inJ));
const onInto = sk([line("a", [[0, 0], [100, 0]]), line("b", [[80, 0.5], [200, 0.5]])], { connectors: [{ id: "c", from: { lane: "a", s: 100 }, to: { lane: "b", s: 20 } }] });
check("one lane going on into the next (a connector between): not flagged", roadsDrawnOver(onInto).length === 0, show(onInto));
const bridge = sk([line("a", [[0, 0], [200, 0]]), line("b", [[200, 0], [0, 0]], { level: 1 })]);
check("one over the other at another level (a bridge): not flagged", roadsDrawnOver(bridge).length === 0, show(bridge));
const flat = sk([line("a", [[0, 0], [200, 0]]), line("b", [[200, 0], [0, 0]])]);
check("…the same at one level: flagged, 200 m", roadsDrawnOver(flat).length === 1 && Math.abs(roadsDrawnOver(flat)[0].length - 200) < 6, show(flat));
const loose = sk([line("a", [[0, 0], [200, 0]]), line("x", [[200, 1], [0, 1]])]);
check("a lane in no road: named by its own id", roadsDrawnOver(loose)[0]?.roads.includes("x") ?? false, show(loose));

console.log(ok ? "drawn over check: all ok" : "drawn over check: FAILED");
process.exit(ok ? 0 : 1);
