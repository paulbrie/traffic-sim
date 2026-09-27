import { Sim, sampleTown, compile } from "../src/engine";
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
