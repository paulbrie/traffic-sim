/**
 * The deep-learning city experiment, headless (ticket #277): a genetic algorithm on the simulation against a surrogate-
 * assisted search (neural-network ensemble), the same simulation budget each, from the same random designs.
 *
 *   npx tsx scripts/dl-city-run.ts [--workers 10] [--rounds 10] [--batch 10] [--init 40] [--out docs/experiments/dl-city-277/runs.jsonl]
 *
 * Each design the searches try is run on two seeds (SEEDS) and scored on their mean (a run's corridor time alone varies by
 * about ±11% from seed to seed); the best of each search then on three more (VALIDATE_SEEDS), five in all.
 *
 * Every run is appended to the output (JSON lines) as it finishes; run again, those already there are not run again (the
 * searches replay their random numbers, so they propose the same designs), so it can be stopped and picked up.
 * Workers: one Node process each (scripts/dl-city-worker.ts), about 0.6 GB each.
 * The recorded runs are the engine's at commit 870a5ed: a later engine change moves single runs (chaotically, a few per
 * cent), so redo the runs (a new --out) rather than adding to that file.
 */
import { fork, type ChildProcess } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import { generateCity, rng } from "../src/lib/experiments/dl-city/city";
import { baseline, designKey, parseKey, randomDesign, type Design } from "../src/lib/experiments/dl-city/design";
import { RUN, score, meanMetrics, type Metrics } from "../src/lib/experiments/dl-city/evaluate";
import { dlPropose, gaPropose, type Tried } from "../src/lib/experiments/dl-city/search";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WORKERS = Number(arg("workers", "10")), ROUNDS = Number(arg("rounds", "10")), BATCH = Number(arg("batch", "10")), INIT = Number(arg("init", "40"));
const SEEDS = [1, 2], VALIDATE_SEEDS = [3, 4, 5];
const OUT = arg("out", "docs/experiments/dl-city-277/runs.jsonl"), CITY_SEED = Number(arg("city", "1")), VALIDATE = Number(arg("validate", "6"));

export interface RunRecord { key: string; seed: number; method: string; round: number; m: Metrics; pred?: number[]; sd?: number[]; at: string }

mkdirSync(dirname(OUT), { recursive: true });
const done = new Map<string, RunRecord>();
if (existsSync(OUT)) for (const line of readFileSync(OUT, "utf8").split("\n")) if (line.trim()) { const r = JSON.parse(line) as RunRecord; done.set(`${r.key}@${r.seed}`, r); }
console.log(`${done.size} runs already in ${OUT}`);

// the worker pool
const workers: { p: ChildProcess; busy: boolean }[] = [];
const waiting: { key: string; seed: number; resolve: (m: Metrics) => void; reject: (e: Error) => void }[] = [];
const pending = new Map<number, { resolve: (m: Metrics) => void; reject: (e: Error) => void; w: (typeof workers)[number] }>();
let nextId = 1;
for (let k = 0; k < WORKERS; k++) {
  const p = fork(new URL("./dl-city-worker.ts", import.meta.url).pathname, [], { execArgv: ["--import", "tsx"], env: { ...process.env, CITY_SEED: String(CITY_SEED) } });
  const w = { p, busy: false };
  p.on("message", (msg: { id: number; m?: Metrics; error?: string }) => {
    const t = pending.get(msg.id)!;
    pending.delete(msg.id); w.busy = false;
    if (msg.error) t.reject(new Error(msg.error)); else t.resolve(msg.m!);
    pump();
  });
  workers.push(w);
}
function pump() {
  for (const w of workers) {
    if (w.busy || !waiting.length) continue;
    const job = waiting.shift()!, id = nextId++;
    w.busy = true; pending.set(id, { resolve: job.resolve, reject: job.reject, w });
    w.p.send({ id, key: job.key, seed: job.seed, warmupMin: RUN.warmupMin, measureMin: RUN.measureMin });
  }
}
const simulate = (key: string, seed: number) => new Promise<Metrics>((resolve, reject) => { waiting.push({ key, seed, resolve, reject }); pump(); });

let ran = 0;
const t0 = Date.now();
async function evaluate(jobs: { d: Design; seed: number; method: string; round: number; pred?: number[]; sd?: number[] }[]): Promise<RunRecord[]> {
  return Promise.all(jobs.map(async j => {
    const key = designKey(j.d), have = done.get(`${key}@${j.seed}`);
    if (have) return have;
    let m: Metrics;
    try { m = await simulate(key, j.seed); }
    catch (e) { console.error(`run failed (${j.method} ${key} @${j.seed}):`, (e as Error).message.split("\n")[0]); m = { corridorTrips: 0, corridorTime: 600, corridorWaiting: 999, centreVehKm: 1e4, trips: 0, tripTime: 600, vehKm: 0, stuck: 999, deadlocks: 999, collisions: 0, ms: 0 }; }
    const r: RunRecord = { key, seed: j.seed, method: j.method, round: j.round, m, ...(j.pred ? { pred: j.pred.map(v => +v.toFixed(4)), sd: j.sd!.map(v => +v.toFixed(4)) } : {}), at: new Date().toISOString() };
    done.set(`${key}@${j.seed}`, r);
    appendFileSync(OUT, JSON.stringify(r) + "\n");
    ran++;
    if (ran % 6 === 0) console.log(`  ${ran} runs, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    return r;
  }));
}

/** each design on every one of `seeds`: their mean */
async function evaluateMean(jobs: { d: Design; method: string; round: number; pred?: number[]; sd?: number[] }[], seeds = SEEDS): Promise<{ key: string; m: Metrics }[]> {
  const runs = await evaluate(jobs.flatMap(j => seeds.map(seed => ({ ...j, seed }))));
  return jobs.map((j, i) => ({ key: designKey(j.d), m: meanMetrics(runs.slice(i * seeds.length, (i + 1) * seeds.length).map(r => r.m)) }));
}

async function main() {
  const city = generateCity(CITY_SEED), R = rng(277);
  console.log(`${city.name}: ${city.nodes.length} nodes, ${city.links.length} links, ${city.gateways.length} gateways; ${WORKERS} workers`);
  // 1. the status quo, on five seeds (how much a run varies)
  const base = baseline(city);
  const bRuns = await evaluate([1, 2, 3, 4, 5].map(seed => ({ d: base, seed, method: "baseline", round: 0 })));
  const B = meanMetrics(bRuns.filter(r => SEEDS.includes(r.seed)).map(r => r.m));
  console.log(`status quo: corridor ${B.corridorTime.toFixed(0)} s (${B.corridorTrips.toFixed(0)}/h, ${B.corridorWaiting} waiting), centre ${B.centreVehKm.toFixed(0)} veh-km/h, trips ${B.trips.toFixed(0)}/h, stuck ${B.stuck}`);
  const tried = (r: { key: string; m: Metrics }): Tried => ({ d: parseKey(r.key), key: r.key, m: r.m, score: score(r.m, B) });
  // 2. the same random designs for both searches to start from (some cautious, some bold)
  const init: Design[] = [];
  while (init.length < INIT) init.push(randomDesign(city, R, R() * 0.3, R() * 0.4));
  const initRuns = await evaluateMean(init.map(d => ({ d, method: "init", round: 0 })));
  const ga: Tried[] = [tried({ key: designKey(base), m: B }), ...initRuns.map(tried)], dl: Tried[] = [...ga];
  const best = (t: Tried[]) => t.reduce((a, b) => (b.score < a.score ? b : a));
  console.log(`random designs: best ${best(ga).score.toFixed(3)}`);
  // 3. the two searches, a batch each a round (run side by side)
  const Rga = rng(1001), Rdl = rng(2002);
  for (let round = 1; round <= ROUNDS; round++) {
    const gaD = gaPropose(city, ga, BATCH, Rga);
    // (exploring at first, then taking what the networks rate best)
    const kappa = Math.max(0.1, 1 - round / ROUNDS);
    const tp = Date.now(), { proposals } = dlPropose(city, dl, B, BATCH, Rdl, { kappa });
    const dlMs = Date.now() - tp;
    const [gr, dr] = await Promise.all([
      evaluateMean(gaD.map(d => ({ d, method: "ga", round }))),
      evaluateMean(proposals.map(p => ({ d: p.d, method: "dl", round, pred: p.pred, sd: p.sd }))),
    ]);
    ga.push(...gr.map(tried)); dl.push(...dr.map(tried));
    const err = dr.map((r, i) => Math.abs(score(r.m, B) - proposals[i].pred[2]));
    console.log(`round ${round}: GA best ${best(ga).score.toFixed(3)} (batch ${Math.min(...gr.map(r => score(r.m, B))).toFixed(3)}), DL best ${best(dl).score.toFixed(3)} (batch ${Math.min(...dr.map(r => score(r.m, B))).toFixed(3)}, predicted ±${(err.reduce((a, b) => a + b, 0) / Math.max(1, err.length)).toFixed(3)}, ${dlMs} ms to propose)`);
  }
  // 4. the best of each, on three more seeds (one seed favours some designs by luck)
  const top = (t: Tried[]) => { const s = [...t].filter(x => x.key !== designKey(base)).sort((a, b) => a.score - b.score), o: Tried[] = []; for (const x of s) if (o.length < VALIDATE && !o.some(y => y.key === x.key)) o.push(x); return o; };
  const finalists = [...top(ga).map(t => ({ t, method: "ga" })), ...top(dl).map(t => ({ t, method: "dl" }))];
  await evaluate(finalists.flatMap(({ t, method }) => VALIDATE_SEEDS.map(seed => ({ d: t.d, seed, method: `validate-${method}`, round: 0 }))));
  const all = [...SEEDS, ...VALIDATE_SEEDS], Bm = meanMetrics(all.map(s => done.get(`${designKey(base)}@${s}`)!.m));
  console.log(`validated on seeds ${all.join(", ")} (score against the status quo's mean over them):`);
  for (const { t, method } of finalists) {
    const mm = meanMetrics(all.map(s => done.get(`${t.key}@${s}`)!.m));
    console.log(`  ${method} ${score(mm, Bm).toFixed(3)} (in the search: ${t.score.toFixed(3)}) ${t.key}`);
  }
  for (const w of workers) w.p.kill();
}
main().catch(e => { console.error(e); for (const w of workers) w.p.kill(); process.exit(1); });
