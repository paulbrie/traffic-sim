import { Sim, sampleTown, compile, measureRun, optimizeSignals } from "../src/engine";
import * as mirrorModule from "../src/engine/sim/mirror";
import { customizePhases, addPhase, approachesTo, setLaneGreen, reverseLink, splitLink, linkPoint, nodeById } from "../src/state/ops";
const net = sampleTown();
const c = compile(net);
console.log("edges", c.edges.length, "nodes", c.nodes.length, "warnings", c.warnings);
for (const n of c.nodes) if (n.degree >= 3) console.log(n.def.control, "deg", n.degree, "phases", JSON.stringify(n.phases), "ring", n.ringR.toFixed(1), "moves", [...n.moves.values()].map(l => l.map(m => `${m.turn}[${m.lo}-${m.hi}]`).join(",")).join(" | "));
for (const [cars, trucks] of [[40, 4], [80, 8], [140, 14], [200, 20]]) {
  const sim = new Sim(net, { cars, trucks, seed: 7 });
  const t0 = Date.now();
  const st: Record<string, number> = {};
  sim.run(6000);
  let bad = 0;
  for (const v of sim.vehicles) if (!v.dead) { st[v.state] = (st[v.state] || 0) + 1; const p = sim.pose(v); if (!isFinite(p.fx) || !isFinite(v.s)) bad++; }
  const S = sim.stats;
  console.log(cars, trucks, "n", S.count, "bus", S.buses, "v", S.avgSpeed.toFixed(1), "stop%", (S.stopped * 100).toFixed(0), "tpm", S.tripsPerMin, "towed", S.towed, "lc", S.laneChanges, "boarded", S.boarded, "bad", bad, "ms", Date.now() - t0, JSON.stringify(st));
}

// custom (per-lane) traffic light phases: a protected left turn for the boulevard's leftmost lane
{
  let n2 = sampleTown();
  const c0 = compile(n2);
  const j = c0.nodes.find(n => n.def.control === "lights" && n.degree === 4 && n.arms.some(a => (a.inEdge?.n ?? 0) >= 3))!;
  n2 = addPhase(customizePhases(n2, c0, j.def.id), j.def.id);
  const wide = approachesTo(n2, j.def.id).find(a => a.lanes >= 3)!;
  for (const p of (wide.dir === 1 ? wide.link.greenF : wide.link.greenB)![0]) n2 = setLaneGreen(n2, wide.link.id, wide.dir, 0, p, false);
  n2 = setLaneGreen(n2, wide.link.id, wide.dir, 0, 2, true);
  const lanesOf = (net: typeof n2) => { const c = compile(net), n = c.nodeById.get(j.def.id)!; return JSON.stringify(n.arms.map(a => (a.inEdge ? `${a.inEdge.link.name}:${JSON.stringify(n.lanePhases[n.arms.indexOf(a)])}` : "")).sort()); };
  const before = lanesOf(n2);
  // editing the roads keeps each lane's phases
  const reversed = reverseLink(n2, wide.link.id);
  const A = nodeById(n2, wide.link.from)!, B = nodeById(n2, wide.link.to)!;
  const [split] = splitLink(n2, wide.link.id, 0.5, linkPoint(wide.link, A, B, 0.5));
  console.log("custom phases survive reverse / split:", lanesOf(reversed) === before, lanesOf(split) === before);
  const c = compile(n2), cj = c.nodeById.get(j.def.id)!, arm = cj.arms.findIndex(a => a.inEdge?.link.id === wide.link.id && a.inEdge.dir === wide.dir);
  const sim = new Sim(c, { cars: 140, trucks: 14, seed: 7 });
  let wrong = 0, leftGreen = 0;
  for (let t = 0; t < 4000; t++) {
    sim.step();
    const st = sim.nodeState(cj.idx), s0 = sim.signalFor(cj.idx, arm, 0), s1 = sim.signalFor(cj.idx, arm, 1);
    if (s0 === "green") { leftGreen++; if (st.phase !== 2) wrong++; }
    if (s1 === "green" && st.phase === 2 && st.stage === 0) wrong++;
  }
  const S = sim.stats;
  console.log("protected left: green", leftGreen, "ticks, wrong aspects", wrong, "| n", S.count, "v", S.avgSpeed.toFixed(1), "towed", S.towed, "warnings", c.warnings.length);
  if (wrong) process.exit(1);
}

// general traffic never drives in a bus lane
{
  const sim = new Sim(net, { cars: 140, trucks: 14, seed: 7 });
  let onBus = 0;
  for (let t = 0; t < 4000; t++) {
    sim.step();
    for (const v of sim.vehicles) if (!v.dead && v.kind !== "bus" && v.piece.kind === "lane" && v.piece.edge.bus && v.piece.lane === v.piece.edge.n - 1) onBus++;
  }
  console.log("cars in bus lanes (vehicle-ticks):", onBus);
  if (onBus) process.exit(1);
}

// signal optimiser: a short search on the sample town runs end to end and reports a fresh-seed check
{
  const base = { cars: 140, trucks: 14, seed: 7 };
  const spec = { warmup: 30, measure: 60 };
  optimizeSignals(net, base, { nodes: compile(net).nodes.filter(n => n.controlled && n.degree >= 3).map(n => n.def.id), targets: ["greens", "control", "lefts", "lanes"], seeds: [1, 2], confirmSeeds: [51, 52], holdoutSeeds: [101, 102], spec, rounds: 1 },
    async (nets, seeds) => nets.map(n => seeds.map(seed => measureRun(n, { ...base, seed }, spec)))).then(r => {
    console.log("optimiser:", r.evaluations, "candidates;", r.changes.length, "changes; fresh-seed check better on", r.check.better, "of", r.check.of);
    if (!r.evaluations || r.check.of !== 2) process.exit(1);
  });
}

// the page's mirror of a simulation running in a worker answers exactly what the simulation would
{
  const { SnapshotWriter, SimMirror } = mirrorModule;
  const town = sampleTown();
  const sim = new Sim(compile(town), { cars: 140, trucks: 14, seed: 7 });
  sim.logAll = true;
  const writer = new SnapshotWriter(), mirror = new SimMirror(compile(JSON.parse(JSON.stringify(town))));
  let diffs = 0, checks = 0;
  for (let round = 0; round < 12; round++) {
    sim.run(250);
    const { snap } = writer.write(sim, { vehicle: sim.vehicles.find(v => !v.dead)?.id ?? null, nodes: sim.net.nodes.map(n => n.idx), reservations: true }, round * 1000);
    mirror.apply(structuredClone(snap));
    const live = sim.vehicles.filter(v => !v.dead);
    live.forEach((v, i) => {
      const a = sim.pose(v), b = mirror.pose(mirror.vehicles[i]);
      checks++; if (mirror.vehicles[i].id !== v.id || Math.hypot(a.fx - b.fx, a.fy - b.fy, a.rx - b.rx, a.ry - b.ry) > 1e-3 || sim.blinker(v) !== mirror.blinker(mirror.vehicles[i])) diffs++;
    });
    for (const n of sim.net.nodes) {
      n.arms.forEach((a, arm) => { for (let lane = -1; lane < (a.inEdge?.n ?? 0); lane++) { checks++; if (sim.signalFor(n.idx, arm, lane < 0 ? undefined : lane) !== mirror.signalFor(n.idx, arm, lane < 0 ? undefined : lane)) diffs++; } });
      const s1 = sim.nodeState(n.idx), s2 = mirror.nodeState(n.idx);
      checks++; if (s1.phase !== s2.phase || s1.stage !== s2.stage || s1.occupied !== s2.occupied || Math.abs(s1.t - s2.t) > 1e-3) diffs++;
    }
    checks++; if (JSON.stringify(sim.events) !== JSON.stringify(mirror.events)) diffs++;
    checks++; if (mirror.vehicles.length !== live.length) diffs++;
  }
  console.log("worker mirror:", checks, "checks,", diffs, "differences");
  if (diffs) process.exit(1);
}
