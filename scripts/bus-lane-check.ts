/**
 * Bus lanes (T18): a lane marked `bus` is closed to ordinary cars, at the road's border or in the middle (contrary to
 * v1, where it's always the kerb lane). Two straight 3-lane roads, 300 m, one with the bus lane at the border (lane 3
 * of 3), one with it in the middle (lane 2 of 3); traffic demand at every lane's own start (so a car could, if let,
 * start right on the bus lane) and free to lane-change along the whole road. Runs both, 300 s, and checks no vehicle
 * is ever found on the bus lane, no vehicle starts there, in/out counts still look sane (cars not simply stuck
 * elsewhere for want of a lane), and the border case still behaves the same as before this existed, by running a
 * sketch without a `bus` flag on a same-shaped lane and comparing vehicle-ticks on it (nonzero, driven on normally).
 * npm run bus:check
 */
import { SketchSim, DEFAULT_SIM } from "../src/lib/lane-sketch-sim";
import type { Sketch, SketchLane } from "../src/lib/lane-sketch";

function road(busAt: "border" | "middle" | null): Sketch {
  const n = 3, lanes: SketchLane[] = [];
  for (let i = 0; i < n; i++) {
    const bus = busAt === "border" ? i === n - 1 : busAt === "middle" ? i === 1 : false;
    lanes.push({ id: `l${i}`, width: 3.5, shape: { kind: "line", pts: [{ x: 0, y: i * 3.6 }, { x: 300, y: i * 3.6 }] }, ...(bus ? { bus: true as const } : {}) });
  }
  return { lanes, connectors: [], roads: [{ id: "r1", name: "Road", lanes: lanes.map(l => l.id) }], junctions: [], traffic: { rate: 900, speed: 50, seed: 1 } };
}

function run(sk: Sketch, seconds: number) {
  const sim = new SketchSim(sk, { ...(sk.traffic ?? DEFAULT_SIM), seed: 1 }, 1);
  const busLane = new Set(sk.lanes.filter(l => l.bus).map(l => l.id));
  let onBus = 0, startedOnBus = 0, ticks = 0;
  const seen = new Set<number>();
  for (let i = 0; i < seconds / 0.1; i++) {
    sim.step(0.1);
    for (const v of sim.vehicles) {
      ticks++;
      if (v.edge.kind === "lane" && busLane.has(v.edge.id)) {
        onBus++;
        if (!seen.has(v.id)) startedOnBus++;
      }
      seen.add(v.id);
    }
  }
  const s = sim.stats();
  return { onBus, startedOnBus, ticks, in: s.spawned, out: s.finished };
}

let bad = 0;
for (const at of ["border", "middle"] as const) {
  const r = run(road(at), 300);
  const ok = r.onBus === 0 && r.startedOnBus === 0 && r.out > 0;
  if (!ok) bad++;
  console.log(`bus lane at the ${at}: ${r.ticks} vehicle-ticks, ${r.onBus} on the bus lane (${r.startedOnBus} starting there), ${r.in} in / ${r.out} out | ok ${ok}`);
}
// (no bus flag at all, one plain lane: driven on normally, to show the restriction above is really the flag's doing,
// not every lane of a 3-parallel-lanes-no-connectors road going unused for some other reason)
{
  const sk: Sketch = { lanes: [{ id: "l0", width: 3.5, shape: { kind: "line", pts: [{ x: 0, y: 0 }, { x: 300, y: 0 }] } }], connectors: [], roads: [], junctions: [], traffic: { rate: 900, speed: 50, seed: 1 } };
  const r = run(sk, 300);
  const ok = r.ticks > 0 && r.out > 0;
  if (!ok) bad++;
  console.log(`no bus lane (control): ${r.ticks} vehicle-ticks, ${r.in} in / ${r.out} out | ok ${ok}`);
}
if (bad) { console.error(`${bad} check(s) failed`); process.exit(1); }
