/**
 * Speed of the simulation engine: ms per step on loaded networks (after they fill up).
 *   npx tsx scripts/engine-bench.ts
 */
import { readFileSync } from "fs";
import { compile, Sim, type Network, type PlanSettings } from "../src/engine";

const fixture = (name: string) => JSON.parse(readFileSync(`scripts/fixtures/${name}.json`, "utf8"));
const cases: { name: string; net: Network; settings: PlanSettings; warm: number; steps: number }[] = [
  { name: "milton-keynes 2500 cars", net: fixture("osm-milton-keynes"), settings: { cars: 2500, trucks: 100, seed: 7 }, warm: 2500, steps: 1500 },
  { name: "claude-tests 640 cars", net: fixture("claude-tests").network, settings: { cars: 640, trucks: 8, seed: 7 }, warm: 1500, steps: 3000 },
];
for (const c of cases) {
  const sim = new Sim(compile(c.net), c.settings);
  sim.run(c.warm);
  const t0 = performance.now();
  sim.run(c.steps);
  const ms = (performance.now() - t0) / c.steps;
  const n = sim.vehicles.filter(v => !v.dead).length;
  console.log(`${c.name.padEnd(26)} ${ms.toFixed(2)} ms/step with ${n} vehicles (${((ms * 1000) / n).toFixed(2)} µs per vehicle)`);
}
