/**
 * Runs the signal optimiser headlessly on a saved plan (read from the app's database in .env.local):
 *   npx tsx scripts/optimize-check.ts <planId> [J-refs, e.g. J2,J3 | all] [quick|standard|thorough] [greens,control,lefts,lanes | everything]
 * Simulations run in parallel worker threads. Prints the changes and the before / after check.
 */
import { readFileSync } from "fs";
import { cpus } from "os";
import { join } from "path";
import { buildSync } from "esbuild";
import { Worker, isMainThread, parentPort } from "worker_threads";
import postgres from "postgres";
import { compile, formatChange, measureRun, optimizeSignals, OPTIMIZE_EFFORT, type OptimizeEffort, type OptimizeTarget, type Network, type PlanSettings, type RunMetrics, type RunSpec } from "../src/engine";
import { junctionRefs } from "../src/engine/refs";


if (!isMainThread) {
  parentPort!.on("message", (j: { id: number; net: Network; settings: PlanSettings; spec: RunSpec }) => parentPort!.postMessage({ id: j.id, m: measureRun(j.net, j.settings, j.spec) }));
} else main();

async function main() {
  const [planId, which = "all", effort = "quick", what = "greens"] = process.argv.slice(2);
  const targets = (what === "everything" ? ["greens", "control", "lefts", "lanes"] : what.split(",")) as OptimizeTarget[];
  const url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(".env.local", "utf8"))![1].trim();
  const s = postgres(url, { max: 1 });
  const [p] = await s`select name, network, settings from plans where id = ${planId}`;
  await s.end();
  if (!p) throw new Error("plan not found");
  const net = p.network as Network, settings = p.settings as PlanSettings;
  const c = compile(net), refs = junctionRefs(c);
  const byRef = new Map([...refs].map(([id, r]) => [r, id]));
  // every junction (the optimiser skips what doesn't apply, e.g. green times where there are no lights)
  const nodes = which === "all" ? [...refs.keys()] : which.split(",").map(r => byRef.get(r)!).filter(Boolean);
  const e = OPTIMIZE_EFFORT[effort as OptimizeEffort];
  console.log(`plan "${p.name}": ${settings.cars} cars, ${settings.trucks} trucks; tuning ${nodes.map(id => refs.get(id)).join(", ")} (${effort}; ${targets.join(", ")})`);

  // worker threads don't get tsx's TypeScript loader: they run a plain JS bundle of this script
  const bundle = join(process.cwd(), "node_modules", ".cache", "gridlock-optimize-worker.cjs");
  buildSync({ entryPoints: [new URL(import.meta.url).pathname], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "error", external: ["esbuild", "postgres"] });
  const workers = Array.from({ length: Math.max(1, cpus().length - 1) }, () => new Worker(bundle));
  const waiting = new Map<number, (m: RunMetrics) => void>();
  let nextId = 0;
  workers.forEach(w => w.on("message", (r: { id: number; m: RunMetrics }) => { waiting.get(r.id)!(r.m); waiting.delete(r.id); }));
  // pool: each finished worker takes the next queued run
  const pool = async (nets: Network[], seeds: number[]) => {
    const jobs: Promise<RunMetrics>[][] = nets.map(n => seeds.map(seed => runJob(n, { ...settings, seed })));
    return Promise.all(jobs.map(j => Promise.all(j)));
  };
  const free: Worker[] = [...workers];
  const pending: { n: Network; st: PlanSettings; res: (m: RunMetrics) => void }[] = [];
  function dispatch() {
    while (free.length && pending.length) {
      const w = free.pop()!, t = pending.shift()!, id = nextId++;
      waiting.set(id, m => { t.res(m); free.push(w); dispatch(); });
      w.postMessage({ id, net: t.n, settings: t.st, spec: e.spec });
    }
  }
  function runJob(n: Network, st: PlanSettings) { return new Promise<RunMetrics>(res => { pending.push({ n, st, res }); dispatch(); }); }

  const t0 = Date.now();
  const r = await optimizeSignals(net, settings, { nodes, targets, seeds: [...e.seeds], confirmSeeds: [...e.confirmSeeds], holdoutSeeds: [...e.holdoutSeeds], spec: e.spec, rounds: e.rounds }, pool,
    pr => process.stdout.write(`\r[${((Date.now() - t0) / 1000).toFixed(0)} s] round ${pr.round}/${pr.rounds} · ${pr.evaluations}/${pr.total} · ${pr.step.replace(/n_[a-z0-9]+/g, id => refs.get(id) ?? id).slice(0, 70).padEnd(70)}`));
  console.log(`\ndone in ${((Date.now() - t0) / 60000).toFixed(1)} min, ${r.evaluations} candidates`);
  for (const ch of r.changes) console.log(`  ${formatChange(ch, id => refs.get(id) ?? id)}`);
  const f = (x: { trips: number; avgSpeed: number; stopped: number; towed: number }) => `${(x.trips / (e.spec.measure / 60)).toFixed(1)} trips/min, ${x.avgSpeed.toFixed(1)} km/h, ${(x.stopped * 100).toFixed(0)}% stopped, ${x.towed.toFixed(1)} towed`;
  console.log(`search seeds:  before ${f(r.baseline)} | after ${f(r.best)}`);
  console.log(`fresh seeds:   before ${f(r.check.baseline)} | after ${f(r.check.best)} | better on ${r.check.better} of ${r.check.of}`);
  await Promise.all(workers.map(w => w.terminate()));
}
