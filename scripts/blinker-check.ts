/**
 * Turn signals through a roundabout (ticket #58): left while going round, right from just past the last way off
 * before the car's own. Per car, the runs of (where it is, its signal) from the way up to the roundabout to the way
 * off, counted by pattern: in V1's sample town (a roundabout junction), and in the sketch sim (a one-lane, 4-arm
 * ring as ring-check's "S"). Fails if any car signals right on the ring and then left again, or leaves without
 * signalling right.   npx tsx scripts/blinker-check.ts
 */
import { Sim, sampleTown } from "../src/engine";
import type { Vehicle } from "../src/engine/sim";
import { createRoundabout } from "../src/state/roundabouts";
import { SketchSim } from "../src/lib/lane-sketch-sim";
import type { Sketch, SketchConnector, SketchLane } from "../src/lib/lane-sketch";

const sig = (b: number) => (b === -1 ? "L" : b === 1 ? "R" : b === 0 ? "-" : "H");
// (by car and time through: a car driving through again starts a new run)
const pass = new Map<number, number>();
const push = (m: Map<number, string[]>, id: number, s: string) => {
  let k = id * 100 + (pass.get(id) ?? 0), a = m.get(k);
  if (a && /^(exit|off):/.test(a[a.length - 1]) && !/^(exit|off):/.test(s)) { pass.set(id, (pass.get(id) ?? 0) + 1); k++; a = undefined; }
  if (!a) m.set(k, (a = []));
  if (a[a.length - 1] !== s) a.push(s);
};
let bad = 0;
const report = (title: string, seq: Map<number, string[]>, left: Set<number>) => {
  const pats = new Map<string, number>();
  let through = 0;
  for (const [k, s] of seq) {
    if (!left.has(Math.floor(k / 100)) || !/^(exit|off):/.test(s[s.length - 1])) continue;
    through++;
    const pat = s.join(" "), sigs = s.filter(x => !x.startsWith("approach")).map(x => x.slice(-1)).join("");
    // (left, then right: never back to left, and right at the end)
    if (!/^L*R+$/.test(sigs)) bad++;
    pats.set(pat, (pats.get(pat) ?? 0) + 1);
  }
  console.log(`\n${title}: ${through} times through`);
  for (const [k, n] of [...pats].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(String(n).padStart(5), k);
};

// ---- V1: the sample town's roundabout
{
  const sim = new Sim(sampleTown(), { cars: 120, trucks: 0, seed: 3 });
  const seq = new Map<number, string[]>(), left = new Set<number>();
  for (let t = 0; t < 6000; t++) {
    sim.run(1);
    for (const v of sim.vehicles as Vehicle[]) {
      if (v.dead) continue;
      const p = v.piece, e = v.route[v.ri], next = v.route[v.ri + 1];
      const near = p.kind === "lane" && e === p.edge && next && p.len - v.s < 45 && !!sim.moveOf(e, next)?.node.ring;
      if (!(p.kind === "ring" || (p.kind === "conn" && p.ring) || near)) continue;
      const where = p.kind === "ring" ? `ring.${p.part}` : p.kind === "conn" ? p.role : "approach";
      if (where === "exit") left.add(v.id);
      push(seq, v.id, `${where}:${sig(sim.blinker(v))}`);
    }
  }
  report("V1 engine, sample town roundabout", seq, left);
}

// ---- V1: the same roundabout built of ring roads (the Roundabout tool's)
{
  const town = sampleTown(), j = town.nodes.find(n => n.control === "roundabout")!;
  const made = createRoundabout({ ...town, nodes: town.nodes.map(n => (n === j ? { ...n, control: "priority" as const } : n)) }, { x: j.x, y: j.y }, 18, 1);
  if ("error" in made) throw new Error(made.error);
  const sim = new Sim(made.net, { cars: 120, trucks: 0, seed: 3 });
  const seq = new Map<number, string[]>(), left = new Set<number>();
  for (let t = 0; t < 6000; t++) {
    sim.run(1);
    for (const v of sim.vehicles as Vehicle[]) {
      if (v.dead) continue;
      const p = v.piece, e = v.route[v.ri], next = v.route[v.ri + 1];
      const where = p.kind === "lane" ? (p.edge.link.ring ? "ring" : e === p.edge && next?.link.ring && p.len - v.s < 45 ? "approach" : null)
        : p.kind === "conn" ? (p.inEdge.link.ring ? (p.outEdge.link.ring ? "join" : "off") : p.outEdge.link.ring ? "on" : null) : null;
      if (!where) continue;
      if (where === "off") left.add(v.id);
      push(seq, v.id, `${where}:${sig(sim.blinker(v))}`);
    }
  }
  report("V1 engine, the roundabout as ring roads", seq, left);
}

// ---- sketch sim: a one-lane, 4-arm roundabout
{
  const TAU = 2 * Math.PI, r2 = (v: number) => Math.round(v * 100) / 100, C = { x: 0, y: 0 }, R = 14, NEAR = 40, FAR = 90, D = 0.55;
  const ringS = (a: number) => r2(((((0 - a) % TAU) + TAU) % TAU) * R);
  const lanes: SketchLane[] = [{ id: "O", width: 5, inRate: 0, shape: { kind: "arc", c: C, r: R, a0: 0, sweep: -TAU } as SketchLane["shape"] }];
  const connectors: SketchConnector[] = [];
  for (let k = 0; k < 4; k++) {
    const th = (k * TAU) / 4 + 0.4, u = { x: Math.cos(th), y: Math.sin(th) }, t = { x: Math.sin(th), y: -Math.cos(th) };
    const at = (r: number, off: number) => ({ x: r2(u.x * r + t.x * off), y: r2(u.y * r + t.y * off) });
    const line = (id: string, a: { x: number; y: number }, b: { x: number; y: number }, inRate: number): SketchLane => ({ id, width: 3.5, inRate, ...(inRate ? { control: "yield" as const } : {}), shape: { kind: "line", pts: [a, b] } });
    const inL = line(`in-${k}`, at(FAR, 5.5), at(NEAR, 5.5), 300), outL = line(`out-${k}`, at(NEAR, -5.5), at(FAR, -5.5), 0);
    lanes.push(inL, outL);
    connectors.push({ id: `c-in-${k}`, from: { lane: inL.id, s: FAR - NEAR }, to: { lane: "O", s: ringS(th - D) } });
    connectors.push({ id: `c-out-${k}`, from: { lane: "O", s: ringS(th + D) }, to: { lane: outL.id, s: 0 } });
  }
  const sk: Sketch = { lanes, connectors, roads: [], junctions: [], traffic: { rate: 0, speed: 50, seed: 1 } };
  const sim = new SketchSim(sk, { ...sk.traffic!, seed: 1 } as ConstructorParameters<typeof SketchSim>[1]);
  type V = Parameters<SketchSim["blinker"]>[0];
  const seq = new Map<number, string[]>(), left = new Set<number>();
  for (let i = 0; i < 6000; i++) {
    sim.step(0.1);
    for (const v of (sim as unknown as { vehicles: V[] }).vehicles) {
      const e = v.edge;
      const where = e.ring ? "ring" : e.kind === "conn" ? (e.to!.lane.ring ? "on" : e.from!.lane.ring ? "off" : null) : e.id.startsWith("in-") && v.exit && v.exit.from!.s - v.pos < 45 ? "approach" : null;
      if (!where) continue;
      if (where === "off") left.add(v.id);
      push(seq, v.id, `${where}:${sig(sim.blinker(v))}`);
    }
  }
  report("sketch sim, 4-arm one-lane roundabout", seq, left);
}

console.log(bad ? `\n${bad} cars signalled out of order` : "\nall cars: left round the ring, right to leave it");
process.exit(bad ? 1 : 0);
