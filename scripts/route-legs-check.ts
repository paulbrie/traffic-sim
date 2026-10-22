/** A vehicle's route as legs (Sim.routeLegs): the legs add up to its route, it is on one of them, and the lines drawn for it reach the end. */
import { Sim, sampleTown } from "../src/engine";

const sim = new Sim(sampleTown(), { cars: 120, trucks: 10, seed: 7 });
sim.run(1500);
let shown = 0, bad = 0, n = 0;
for (const v of sim.vehicles) {
  if (v.dead) continue;
  n++;
  const { legs, at } = sim.routeLegs(v);
  const total = v.route.reduce((a, e) => a + e.length, 0), sum = legs.reduce((a, l) => a + l.m, 0);
  const ahead = sim.routeAhead(v, Infinity);
  if (Math.abs(total - sum) > 1e-6 || at < 0 || at >= legs.length || ahead.length < 4) { bad++; console.log("bad", v.id, { total, sum, at, legs: legs.length, ahead: ahead.length }); }
  if (shown < 3 && legs.length > 3) {
    shown++;
    console.log(`#${v.id} ri=${v.ri}/${v.route.length} edges -> ${legs.length} legs, on ${at}, dest ${v.dest.kind}, ahead ${ahead.length / 2} pts, behind ${sim.routeBehind(v).length / 2} pts`);
    for (const l of legs) console.log(`   ${l.name.padEnd(22)} ${l.m.toFixed(0).padStart(5)} m ${l.t.toFixed(0).padStart(4)} s  ${l.turn ?? "-"} @ ${l.node ?? "-"}`);
  }
}
console.log("vehicles", n, "bad", bad);
if (bad) process.exit(1);
