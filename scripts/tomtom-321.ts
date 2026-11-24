/**
 * Ticket #321: the morning's and the evening's traffic on Bistrița Auto Search v2 inferred from TomTom's recorded speeds,
 * then the centre's one-way streets tried both ways round on it. Stages (each writes to docs/experiments/tomtom-321):
 *   npx tsx scripts/tomtom-321.ts fetch                      the plan's sketch from Railway (plan.json; the main plan only)
 *   npx tsx scripts/tomtom-321.ts free                       each way's free-flow speed in the simulation (free.json)
 *   npx tsx scripts/tomtom-321.ts calibrate --peak morning --fit half|all [--rounds 14]
 *                                                            the demand fitted to TomTom (calib-<peak>-<fit>.json)
 *   npx tsx scripts/tomtom-321.ts optimize [--rounds 6] [--seeds 2]
 *                                                            the centre's streets turned round, greedily (optimize.json)
 *   npx tsx scripts/tomtom-321.ts final [--seeds 6]          today's layout against the best found, on more seeds (final.json)
 *   npx tsx scripts/tomtom-321.ts patch                      the agent patch: the best design and the two matrices (patch.json)
 *   npx tsx scripts/tomtom-321.ts figures                    each peak's fit run again on fresh seeds, way by way, and the figures (fit-*.svg, check.json)
 * --export <file> the TomTom export (npm run traffic:export), --workers <n> (default 12).
 * The simulation is the app's V2 one, headless (src/lib/experiments/tomtom-321/sim.ts), several runs at once in worker
 * processes. Railway's DATABASE_URL from .env.local (must be `railway`).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import postgres from "postgres";
import { laneLength, pointAt, samples, sanitizeSketch, type Pt, type Sketch } from "../src/lib/lane-sketch";
import { endsOf, gravityMatrix, totalOf, type Gravity } from "../src/lib/experiments/tomtom-321/demand";
import { observed, PEAKS, type Observed } from "../src/lib/experiments/tomtom-321/observed";
import { runAll, type JobOut } from "../src/lib/experiments/tomtom-321/pool";
import { waysOf } from "../src/lib/traffic-history";
import { CENTRE, centreRoads, inCentre } from "../src/lib/experiments/tomtom-321/centre";
import { deadLanes, lanesTurned, movesOf, reach, streetsIn, turnLanes, type Move, type Street } from "../src/lib/experiments/tomtom-321/directions";
import { demandWays, type DemandMatrix } from "../src/lib/lane-sketch";

const PLAN = "b87c01a7-40ea-4aa3-a72a-7c917a58091b";
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "docs/experiments/tomtom-321");
const argv = process.argv.slice(2), stage = argv[0];
const arg = (k: string, d?: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const WORKERS = Number(arg("workers", "12"));
const EXPORT = arg("export", "/tmp/t321/traffic-b87c01a7-2026-11-16-2026-11-24.json")!;
const PLAN_FILE = join(OUT, "plan.json"), SKETCH_FILE = "/tmp/t321/plan.sketch.json";
mkdirSync(OUT, { recursive: true });

const loadPlan = (): Sketch => sanitizeSketch(JSON.parse(readFileSync(PLAN_FILE, "utf8")).sketch)!;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** the plan's sketch as it is now (the main plan only: its saved sketches, buildings and terrain left out) */
async function fetchPlan() {
  const url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(join(ROOT, ".env.local"), "utf8"))?.[1].trim().replace(/^"|"$/g, "");
  if (!url) throw new Error("no DATABASE_URL in .env.local");
  const sql = postgres(url, { max: 1 });
  try {
    const [{ d }] = await sql`select current_database() as d`;
    if (d !== "railway") throw new Error(`database is ${d}, not railway`);
    const [p] = await sql`select id, name, revision, sketch from plans where id = ${PLAN}`;
    const { sketches: _s, scratch: _c, buildings: _b, terrain: _t, sketchOpen: _o, ...sketch } = p.sketch;
    writeFileSync(PLAN_FILE, JSON.stringify({ id: p.id, name: p.name, revision: p.revision, fetched: new Date().toISOString(), sketch }));
    console.log(`${p.name}, revision ${p.revision}: ${sketch.lanes.length} lanes, ${sketch.roads.length} roads`);
  } finally { await sql.end(); }
}

/** each way's speed with next to no traffic (km/h): the median of a few light runs where cars drove it */
async function free() {
  const sk = loadPlan(), { ins, outs } = endsOf(sk);
  const g: Gravity = { P: Object.fromEntries(ins.map(i => [i.key, 12])), A: Object.fromEntries(outs.map(o => [o.key, 1])) };
  const m = gravityMatrix(sk, g, "free", "free flow");
  const seeds = [1, 2, 3, 4, 5, 6];
  const res = await runAll(seeds.map(seed => ({ sketch: SKETCH_FILE, matrix: m, opts: { seed, warmupMin: 5, measureMin: 40 } })), WORKERS);
  const out: Record<string, number> = {};
  for (const w of waysOf(sk)) {
    const v = res.map(r => r.ways[w.id]?.kmh).filter((x): x is number => typeof x === "number").sort((a, b) => a - b);
    if (v.length) out[w.id] = r3(v[Math.floor(v.length / 2)]);
  }
  writeFileSync(join(OUT, "free.json"), JSON.stringify(out));
  console.log(`free flow: ${Object.keys(out).length} of ${waysOf(sk).length} ways driven (${(totalOf(g)).toFixed(0)} veh/h in)`);
}

// ---------------------------------------------------------------- calibrating

/** a road's half: the ways fitted to (the other half held out to test on), by the road (both its ways in the same half) */
const half = (wayId: string) => { let h = 0; for (const c of wayId.split("/")[0]) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 2 === 0; };

/** the simulated speed share on each way (the seeds' runs pooled: distance over time), against free flow */
function relSim(rs: JobOut[], freeKmh: Record<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const ids = new Set(rs.flatMap(r => Object.keys(r.ways)));
  for (const id of ids) {
    let km = 0, h = 0;
    for (const r of rs) { const w = r.ways[id]; if (w && w.kmh !== null) { km += w.km; h += w.hours; } }
    const f = freeKmh[id];
    if (!f) continue;
    out.set(id, h > 0 ? Math.min(1.2, km / h / f) : 1);
  }
  return out;
}

interface Fit { loss: number; corr: number; n: number; bias: number }
/**
 * Daytime friction: TomTom's free flow is the night's, and by day parking, people crossing, buses and bikes slow a town's
 * streets whatever the traffic, which the simulation leaves out. So the simulated share is scaled by one factor for the
 * whole network, φ (0.75 to 1), the least-squares one on the ways fitted to; the demand has to explain the rest.
 */
function frictionOf(sim: Map<string, number>, obs: Map<string, Observed>, keep: (id: string) => boolean): number {
  let so = 0, ss = 0;
  for (const [id, o] of obs) { if (!keep(id) || o.lengthM < 20) continue; const s = sim.get(id) ?? 1; so += o.weight * s * o.rel; ss += o.weight * s * s; }
  return Math.max(0.75, Math.min(1, ss ? so / ss : 1));
}
function fitOf(sim0: Map<string, number>, obs: Map<string, Observed>, keep: (id: string) => boolean, phi = 1): Fit {
  const sim = new Map([...sim0].map(([k, v]) => [k, v * phi]));
  let sw = 0, se = 0, sb = 0, n = 0;
  const xs: number[] = [], ys: number[] = [], ws: number[] = [];
  for (const [id, o] of obs) {
    if (!keep(id) || o.lengthM < 20) continue;
    const s = sim.get(id) ?? phi;
    sw += o.weight; se += o.weight * (s - o.rel) ** 2; sb += o.weight * (s - o.rel); n++;
    xs.push(s); ys.push(o.rel); ws.push(o.weight);
  }
  // (weighted Pearson correlation)
  const W = ws.reduce((a, b) => a + b, 0), mx = xs.reduce((a, x, i) => a + x * ws[i], 0) / W, my = ys.reduce((a, y, i) => a + y * ws[i], 0) / W;
  let cxy = 0, cxx = 0, cyy = 0;
  for (let i = 0; i < xs.length; i++) { cxy += ws[i] * (xs[i] - mx) * (ys[i] - my); cxx += ws[i] * (xs[i] - mx) ** 2; cyy += ws[i] * (ys[i] - my) ** 2; }
  return { loss: r3(Math.sqrt(se / sw)), corr: r3(cxy / Math.sqrt(cxx * cyy || 1)), n, bias: r3(sb / sw) };
}

async function calibrate() {
  const peak = PEAKS.find(p => p.id === arg("peak"));
  if (!peak) throw new Error("--peak morning|evening");
  const fitMode = arg("fit", "half")!, rounds = Number(arg("rounds", "14")), seedsPer = Number(arg("seeds", "3"));
  const sk = loadPlan(), { ins, outs } = endsOf(sk);
  const freeKmh = JSON.parse(readFileSync(join(OUT, "free.json"), "utf8")) as Record<string, number>;
  const obs = observed(JSON.parse(readFileSync(EXPORT, "utf8")), peak);
  for (const id of [...obs.keys()]) if (!freeKmh[id]) obs.delete(id);
  const inFit = (id: string) => fitMode === "all" || half(id), held = (id: string) => fitMode !== "all" && !half(id);
  const laneN = (lanes: string[]) => Math.max(1, lanes.length);
  // (the start: every way in sending 60 vehicles an hour a lane, every way out drawing by its lanes)
  let g: Gravity = { P: Object.fromEntries(ins.map(i => [i.key, 60 * laneN(i.lanes)])), A: Object.fromEntries(outs.map(o => [o.key, laneN(o.lanes)])) };
  const startFrom = arg("from");
  if (startFrom && existsSync(startFrom)) g = JSON.parse(readFileSync(startFrom, "utf8")).best.gravity;
  const capOf = new Map(ins.map(i => [i.key, 900 * laneN(i.lanes)]));
  const history: unknown[] = [];
  let best: { round: number; phi: number; fit: Fit; heldOut: Fit | null; gravity: Gravity; total: number; stats: unknown } | null = null;
  const eta = Number(arg("eta", "1.2"));
  for (let round = 1; round <= rounds; round++) {
    const m = gravityMatrix(sk, g, peak.id, peak.name);
    const t0 = Date.now();
    const rs = await runAll(Array.from({ length: seedsPer }, (_, k) => ({ sketch: SKETCH_FILE, matrix: m, opts: { seed: round * 10 + k, warmupMin: 10, measureMin: 20 } })), WORKERS);
    const sim = relSim(rs, freeKmh);
    const phi = r3(frictionOf(sim, obs, inFit));
    const fit = fitOf(sim, obs, inFit, phi), heldOut = fitMode === "all" ? null : fitOf(sim, obs, held, phi);
    const stats = { trips: Math.round(rs.reduce((a, r) => a + r.trips, 0) / rs.length), tripTime: Math.round(rs.reduce((a, r) => a + r.tripTime, 0) / rs.length), waiting: Math.round(rs.reduce((a, r) => a + r.waiting, 0) / rs.length), deadlocks: rs.reduce((a, r) => a + r.deadlocks, 0) / rs.length, collisions: rs.reduce((a, r) => a + r.collisions, 0) / rs.length };
    const total = Math.round(totalOf(g));
    // (gridlock: the simulation can't carry it, and Bistrița doesn't gridlock every morning)
    const jammed = stats.deadlocks > 3 || stats.waiting > 40;
    history.push({ round, total, phi, fit, heldOut, stats, jammed, s: Math.round((Date.now() - t0) / 1000) });
    console.log(`${peak.id} ${fitMode} round ${round}: ${total} veh/h in, φ ${phi}, fit rmse ${fit.loss} r ${fit.corr} bias ${fit.bias}${heldOut ? ` · held out rmse ${heldOut.loss} r ${heldOut.corr} bias ${heldOut.bias}` : ""} · trips ${stats.trips}/h, ${stats.tripTime} s, waiting ${stats.waiting}, deadlocks ${stats.deadlocks.toFixed(1)}${jammed ? " JAMMED" : ""} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (!jammed && (!best || fit.loss < best.fit.loss)) best = { round, phi, fit, heldOut, gravity: JSON.parse(JSON.stringify(g)), total, stats };
    // (the update: each way in and out by the error on the ways its cars drove, weighted by how many and the way's weight)
    const err = new Map<string, number>();
    for (const [id, o] of obs) if (inFit(id) && o.lengthM >= 20) err.set(id, phi * (sim.get(id) ?? 1) - o.rel);
    let ew = 0, ewSum = 0;
    for (const [id, e] of err) { ew += obs.get(id)!.weight * e; ewSum += obs.get(id)!.weight; }
    const mean = ew / ewSum;
    const step = (counts: Record<string, Record<string, number>>, key: string) => {
      const c = counts[key];
      let s = 0, w = 0;
      if (c) for (const [id, n] of Object.entries(c)) { const e = err.get(id); if (e === undefined) continue; const k = n * obs.get(id)!.weight; s += k * e; w += k; }
      const gr = w > 0 ? s / w : mean;
      return Math.max(-0.25, Math.min(0.25, eta * gr)) - (jammed ? 0.15 : 0);
    };
    const pool = (sel: (r: JobOut) => Record<string, Record<string, number>>) => {
      const out: Record<string, Record<string, number>> = {};
      for (const r of rs) for (const [k, row] of Object.entries(sel(r))) for (const [id, n] of Object.entries(row)) (out[k] ??= {})[id] = (out[k][id] ?? 0) + n;
      return out;
    };
    const byIn = pool(r => r.byIn), byOut = pool(r => r.byOut);
    const P: Record<string, number> = {}, A: Record<string, number> = {};
    for (const i of ins) P[i.key] = Math.max(2, Math.min(capOf.get(i.key)!, g.P[i.key] * Math.exp(step(byIn, i.key))));
    for (const o of outs) A[o.key] = Math.max(0.02, Math.min(50, g.A[o.key] * Math.exp(step(byOut, o.key))));
    g = { P, A };
    writeFileSync(join(OUT, `calib-${peak.id}-${fitMode}.json`), JSON.stringify({ peak, fitMode, rounds: history, best, last: g }, null, 1));
  }
  console.log(`best: round ${best!.round}, rmse ${best!.fit.loss}${best!.heldOut ? `, held out ${best!.heldOut.loss}` : ""}`);
}

// ---------------------------------------------------------------- turning the centre's streets round

/** the two peaks' demand: each one's calibration on all the ways, its best round */
function peakMatrices(sk: Sketch): DemandMatrix[] {
  return PEAKS.map(p => {
    const c = JSON.parse(readFileSync(join(OUT, `calib-${p.id}-all.json`), "utf8"));
    return gravityMatrix(sk, c.best.gravity, `tomtom-${p.id}`, p.name, { start: p.start, end: p.end });
  });
}

/** the streets that may be turned: named ones in the centre (the boulevards round it and unnamed bits of junctions left out) */
function candidates(sk: Sketch): Street[] {
  return streetsIn(sk, inCentre).filter(s => !/^Road \d+/.test(s.name) && !/^Bulevardul/.test(s.name));
}

interface Design { moves: Move[] }
const designKey = (d: Design) => d.moves.map(m => `${m.street}:${m.to}`).sort().join(" ") || "today";

/** the plan with a design's streets turned; null if a trip would lose its way (a way in no longer reaching a way out it did) or a turned lane couldn't be driven */
function designSketch(base: Sketch, streets: Street[], d: Design, idPrefix = "c"): Sketch | null {
  if (!d.moves.length) return base;
  const turn = d.moves.flatMap(m => lanesTurned(base, streets.find(s => s.id === m.street)!, m));
  const sk = turnLanes(base, turn, idPrefix);
  if (deadLanes(sk, turn).length) return null;
  const w = demandWays(base), ins = w.entries.flatMap(e => e.lanes), outs = w.exits.flatMap(e => e.lanes);
  const a = reach(base, ins, outs), b = reach(sk, ins, outs);
  for (const [e, set] of a) for (const x of set) if (!b.get(e)!.has(x)) return null;
  return sk;
}

interface Eval { key: string; peaks: Record<string, { trips: number; tripTime: number; netTime: number; centreDelay: number; centreHours: number; centreKm: number; waiting: number; deadlocks: number; collisions: number; onMap: number }[]> }

/** a design run on both peaks, the given seeds each */
async function evaluate(designs: { key: string; file: string }[], mats: DemandMatrix[], seeds: number[], area: string[]): Promise<Eval[]> {
  const jobs = designs.flatMap(d => mats.flatMap(m => seeds.map(seed => ({ sketch: d.file, matrix: m, opts: { seed, warmupMin: 10, measureMin: 20 }, area }))));
  const rs = await runAll(jobs, WORKERS);
  let k = 0;
  return designs.map(d => {
    const peaks: Eval["peaks"] = {};
    for (const m of mats) {
      const demand = Object.values(m.od).reduce((a, row) => a + Object.values(row).reduce((x, y) => x + y, 0), 0);
      peaks[m.id] = seeds.map(() => {
        const r = rs[k++];
        // (time per trip asked for: the trips made, and those that couldn't be as 10 minutes each)
        const netTime = (r.trips * r.tripTime + Math.max(0, demand - r.trips) * 600) / demand;
        return { trips: Math.round(r.trips), tripTime: Math.round(r.tripTime), netTime: Math.round(netTime), centreDelay: r3(r.areaDelay), centreHours: r3(r.areaHours), centreKm: Math.round(r.areaKm), waiting: r.waiting, deadlocks: r.deadlocks, collisions: r.collisions, onMap: r.onMap };
      });
    }
    return { key: d.key, peaks };
  });
}

/** the score against today's (1: as today; lower is better): half the centre's delay, half the time per trip asked for */
function score(e: Eval, base: Eval): number {
  let s = 0, n = 0;
  for (const [p, runs] of Object.entries(e.peaks)) runs.forEach((r, i) => {
    const b = base.peaks[p][i];
    s += 0.5 * (r.centreDelay / Math.max(0.01, b.centreDelay)) + 0.5 * (r.netTime / b.netTime); n++;
  });
  return r3(s / n);
}

async function optimize() {
  const base = loadPlan(), streets = candidates(base), mats = peakMatrices(base), area = centreRoads(base);
  const rounds = Number(arg("rounds", "6")), seeds = Array.from({ length: Number(arg("seeds", "2")) }, (_, i) => 101 + i);
  const dir = "/tmp/t321/designs";
  mkdirSync(dir, { recursive: true });
  const fileOf = (d: Design) => { const f = join(dir, `${designKey(d).replace(/[^\w]+/g, "_").slice(0, 180)}.json`); return f; };
  console.log(`${streets.length} streets may be turned: ${streets.map(s => `${s.name} (${s.kind}, ${s.lengthM} m)`).join("; ")}`);
  let cur: Design = { moves: [] };
  const log: unknown[] = [];
  for (let round = 1; round <= rounds; round++) {
    const tries: { d: Design; file: string }[] = [{ d: cur, file: "" }];
    const used = new Set(cur.moves.map(m => m.street));
    for (const s of streets) if (!used.has(s.id)) for (const m of movesOf(s)) {
      const d = { moves: [...cur.moves, m] }, sk = designSketch(base, streets, d);
      if (sk) tries.push({ d, file: "" });
      else if (round === 1) console.log(`  ${s.name} ${m.to}: refused (a trip would lose its way, or a lane nobody could drive)`);
    }
    for (const t of tries) { t.file = fileOf(t.d); writeFileSync(t.file, JSON.stringify(designSketch(base, streets, t.d))); }
    // (today's layout too, every round, on the same seeds: what each is scored against)
    const todayFile = fileOf({ moves: [] });
    writeFileSync(todayFile, JSON.stringify(base));
    const t0 = Date.now();
    const evals = await evaluate([{ key: "today", file: todayFile }, ...tries.map(t => ({ key: designKey(t.d), file: t.file }))], mats, seeds, area);
    const today = evals[0], scored = evals.slice(1).map((e, i) => ({ d: tries[i].d, e, s: score(e, today) }));
    const curS = scored[0].s;
    scored.sort((a, b) => a.s - b.s);
    console.log(`round ${round} (${Math.round((Date.now() - t0) / 1000)} s): now ${curS}; best ${scored.slice(0, 5).map(x => `${designKey(x.d).split(" ").filter(k => !cur.moves.some(m => `${m.street}:${m.to}` === k)).join(" ") || "(as now)"} ${x.s}`).join(", ")}`);
    log.push({ round, current: designKey(cur), currentScore: curS, tried: scored.map(x => ({ key: designKey(x.d), score: x.s, eval: x.e })), today });
    writeFileSync(join(OUT, "optimize.json"), JSON.stringify({ streets, seeds, log }, null, 1));
    const best = scored[0];
    // (kept only if better than now by more than the runs' noise)
    if (best.s >= curS - 0.01 || designKey(best.d) === designKey(cur)) { console.log("no move better by more than 0.01: done"); break; }
    cur = best.d;
  }
  writeFileSync(join(OUT, "optimize.json"), JSON.stringify({ streets, seeds, log, best: cur }, null, 1));
  console.log(`best: ${designKey(cur)}`);
}

/** today's layout against the search's design after each of its steps, on more seeds (and seeds it never ran) */
async function final() {
  const base = loadPlan(), streets = candidates(base), mats = peakMatrices(base), area = centreRoads(base);
  const opt = JSON.parse(readFileSync(join(OUT, "optimize.json"), "utf8"));
  const seeds = Array.from({ length: Number(arg("seeds", "6")) }, (_, i) => 201 + i);
  // (today, and the design after each of the search's steps: does each change it kept still pay on seeds it never saw?)
  const steps: Design[] = [];
  const best: Design = opt.best;
  for (let k = 1; k <= best.moves.length; k++) steps.push({ moves: best.moves.slice(0, k) });
  const designs: Design[] = [{ moves: [] }, ...steps];
  const files = designs.map((d, i) => { const f = `/tmp/t321/designs/final-${i}.json`; writeFileSync(f, JSON.stringify(designSketch(base, streets, d))); return { key: designKey(d), file: f }; });
  const evals = await evaluate(files, mats, seeds, area);
  const out = evals.map(e => ({ ...e, score: score(e, evals[0]) }));
  writeFileSync(join(OUT, "final.json"), JSON.stringify({ seeds, designs, evals: out }, null, 1));
  for (const e of out) console.log(e.key.slice(0, 80), e.score, Object.entries(e.peaks).map(([p, rs]) => `${p}: centre delay ${r3(rs.reduce((a, r) => a + r.centreDelay, 0) / rs.length)} veh-h/h, trip ${Math.round(rs.reduce((a, r) => a + r.netTime, 0) / rs.length)} s, trips ${Math.round(rs.reduce((a, r) => a + r.trips, 0) / rs.length)}/h`).join(" · "));
}

/**
 * The agent patch (patch.json, for npm run patch:submit): the chosen design's lanes turned round (their shapes, and signs
 * moved or gone), roads whose lanes were laid out beside a turned one, the connectors of the turned lanes' junctions taken
 * out and made again (new ones "c321-1", …, so none can clash with the editor's), and the two peaks' demand matrices.
 */
async function makePatch() {
  const base = loadPlan(), streets = candidates(base), mats = peakMatrices(base);
  const opt = JSON.parse(readFileSync(join(OUT, "optimize.json"), "utf8"));
  const d: Design = arg("design") === "none" ? { moves: [] } : opt.best;
  const sk = designSketch(base, streets, d, "c321-");
  if (!sk) throw new Error("the design can't be made");
  const changed = <T extends { id: string }>(was: T[], now: T[]) => {
    const old = new Map(was.map(x => [x.id, x]));
    return now.filter(x => JSON.stringify(old.get(x.id)) !== JSON.stringify(x)).map(x => {
      const o = old.get(x.id) as Record<string, unknown> | undefined, out: Record<string, unknown> = { ...x };
      // (a field it no longer has: cleared)
      if (o) for (const k of Object.keys(o)) if (!(k in out)) out[k] = null;
      return out;
    });
  };
  const nowIds = new Set(sk.connectors.map(c => c.id));
  const patch = {
    lanes: changed(base.lanes, sk.lanes), roads: changed(base.roads, sk.roads), connectors: changed(base.connectors, sk.connectors),
    matrices: mats,
    remove: { connectors: base.connectors.filter(c => !nowIds.has(c.id)).map(c => c.id) },
  };
  writeFileSync(join(OUT, "patch.json"), JSON.stringify(patch, null, 1));
  const { checkPatch } = await import("../src/lib/agent-patch");
  const r = checkPatch(JSON.stringify(patch), base, "check");
  console.log(r.ok ? `patch.json: ${patch.lanes.length} lanes, ${patch.roads.length} roads, ${patch.connectors.length} connectors made, ${patch.remove.connectors.length} taken out, ${patch.matrices.length} matrices; applies to revision ${JSON.parse(readFileSync(PLAN_FILE, "utf8")).revision}` : `refused: ${r.errors.join("; ")}`);
  if (!r.ok) process.exitCode = 1;
}

/** each peak's demand (fitted on all the ways) run again on seeds it never saw: simulated against TomTom, way by way */
async function figures() {
  const sk = loadPlan(), freeKmh = JSON.parse(readFileSync(join(OUT, "free.json"), "utf8")) as Record<string, number>;
  const exp = JSON.parse(readFileSync(EXPORT, "utf8")), out: Record<string, unknown> = {};
  for (const p of PEAKS) {
    const c = JSON.parse(readFileSync(join(OUT, `calib-${p.id}-all.json`), "utf8")), half = JSON.parse(readFileSync(join(OUT, `calib-${p.id}-half.json`), "utf8"));
    const m = gravityMatrix(sk, c.best.gravity, p.id, p.name);
    const rs = await runAll([301, 302, 303, 304].map(seed => ({ sketch: SKETCH_FILE, matrix: m, opts: { seed, warmupMin: 10, measureMin: 20 } })), WORKERS);
    const sim = relSim(rs, freeKmh), obs = observed(exp, p);
    for (const id of [...obs.keys()]) if (!freeKmh[id]) obs.delete(id);
    const phi = c.best.phi as number, fit = fitOf(sim, obs, () => true, phi);
    const pts = [...obs].filter(([, o]) => o.lengthM >= 20).map(([id, o]) => ({ id, name: o.name, tomtom: o.rel, sim: r3(phi * (sim.get(id) ?? 1)), w: Math.round(o.weight) }));
    const first = half.rounds[0], hb = half.best;
    out[p.id] = { phi, total: c.best.total, fit, heldOut: { start: first.heldOut, best: hb.heldOut, round: hb.round }, stats: { trips: Math.round(rs.reduce((a, r) => a + r.trips, 0) / rs.length), deadlocks: rs.reduce((a, r) => a + r.deadlocks, 0) / rs.length }, pts };
    writeFileSync(join(OUT, `fit-${p.id}.svg`), scatter(p.name, pts, fit));
    console.log(`${p.id}: ${c.best.total} veh/h in, φ ${phi}, fresh seeds rmse ${fit.loss} r ${fit.corr}; held out (half fit) rmse ${first.heldOut.loss} → ${hb.heldOut.loss}, r ${first.heldOut.corr} → ${hb.heldOut.corr}`);
  }
  writeFileSync(join(OUT, "check.json"), JSON.stringify(out, null, 1));
  if (existsSync(join(OUT, "optimize.json"))) changesMap();
}
async function mapOnly() { changesMap(); }

/** the centre with the best design's turned streets: their lanes as they run now (red), the rest of the centre in grey */
function changesMap(): void {
  const base = loadPlan(), streets = candidates(base), opt = JSON.parse(readFileSync(join(OUT, "optimize.json"), "utf8"));
  const d: Design = opt.best, sk = designSketch(base, streets, d);
  if (!sk || !d.moves.length) return;
  const turned = new Set(d.moves.flatMap(m => lanesTurned(base, streets.find(s => s.id === m.street)!, m)));
  const moved = new Set(d.moves.flatMap(m => streets.find(s => s.id === m.street)!.roads.flatMap(r => base.roads.find(x => x.id === r)!.lanes)));
  const xs = CENTRE.map(p => p.x), ys = CENTRE.map(p => p.y), x0 = Math.min(...xs) - 60, x1 = Math.max(...xs) + 60, y0 = Math.min(...ys) - 60, y1 = Math.max(...ys) + 60;
  const W = 900, sc = W / (x1 - x0), H = Math.round((y1 - y0) * sc), P = (p: Pt) => `${((p.x - x0) * sc).toFixed(1)},${((p.y - y0) * sc).toFixed(1)}`;
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">`,
    `<defs><marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0L10,5L0,10z" fill="#c0392b"/></marker><marker id="g" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0L10,5L0,10z" fill="#b5b3ab"/></marker></defs>`,
    `<rect width="${W}" height="${H}" fill="#fcfcfb"/>`, `<polygon points="${CENTRE.map(P).join(" ")}" fill="#f3efe4" stroke="#d8d2c2" stroke-dasharray="5 4"/>`];
  for (const l of sk.lanes) {
    const pts = samples(l.shape, 4);
    if (!pts.some(p => p.x > x0 && p.x < x1 && p.y > y0 && p.y < y1)) continue;
    const hot = moved.has(l.id);
    o.push(`<polyline points="${pts.map(P).join(" ")}" fill="none" stroke="${hot ? "#c0392b" : "#b5b3ab"}" stroke-width="${hot ? 3 : 1.5}" marker-end="url(#${hot ? "a" : "g"})"/>`);
  }
  const named = new Set<string>();
  for (const m of d.moves) {
    const s = streets.find(x => x.id === m.street)!, l = base.lanes.find(x => x.id === Object.keys(s.cls)[0])!, p = pointAt(l.shape, laneLength(l.shape) / 2).p;
    if (named.has(s.name)) continue; named.add(s.name);
    const what = m.to === "reverse" ? "turned round" : m.to === "twoway" ? "made one lane each way" : "made one-way";
    const px = (p.x - x0) * sc, right = px > W * 0.6;
    o.push(`<text x="${(right ? px - 10 : px + 10).toFixed(0)}" y="${((p.y - y0) * sc - 8).toFixed(0)}" text-anchor="${right ? "end" : "start"}" fill="#0b0b0b" stroke="#fcfcfb" stroke-width="3" paint-order="stroke">${s.name.replace(/^Strada /, "Str. ")}: ${what}</text>`);
  }
  o.push(`<text x="12" y="20" font-size="14" font-weight="600" fill="#0b0b0b">The centre's streets changed (red: their lanes as they would run; ${turned.size} lanes turned)</text></svg>`);
  writeFileSync(join(OUT, "changes.svg"), o.join("\n"));
}

/** TomTom's share of free flow against the simulation's (× φ), a dot per way sized by its weight */
function scatter(title: string, pts: { tomtom: number; sim: number; w: number; name: string }[], fit: Fit): string {
  const W = 520, H = 520, L = 56, B = 56, T = 40, R = 16, x = (v: number) => L + (v / 1.1) * (W - L - R), y = (v: number) => H - B - (v / 1.1) * (H - B - T);
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  const o = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif" font-size="12">`,
    `<rect width="${W}" height="${H}" fill="#fcfcfb"/>`, `<text x="${L}" y="22" font-size="14" font-weight="600" fill="#0b0b0b">${title}: each road one way</text>`];
  for (const t of ticks) o.push(`<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke="#e1e0d9"/><line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#e1e0d9"/><text x="${x(t)}" y="${H - B + 16}" text-anchor="middle" fill="#52514d">${t}</text><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end" fill="#52514d">${t}</text>`);
  o.push(`<line x1="${x(0)}" y1="${y(0)}" x2="${x(1.1)}" y2="${y(1.1)}" stroke="#898781" stroke-dasharray="4 4"/>`);
  for (const p of pts) o.push(`<circle cx="${x(p.tomtom).toFixed(1)}" cy="${y(p.sim).toFixed(1)}" r="${Math.max(2.5, Math.min(9, Math.sqrt(p.w) / 3)).toFixed(1)}" fill="#2a78d6" fill-opacity="0.45" stroke="#fcfcfb" stroke-width="1"><title>${p.name}: TomTom ${p.tomtom}, simulated ${p.sim}</title></circle>`);
  o.push(`<text x="${(L + W - R) / 2}" y="${H - 14}" text-anchor="middle" fill="#0b0b0b">TomTom: speed as a share of free flow (weekday median)</text>`);
  o.push(`<text transform="translate(16 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" fill="#0b0b0b">Simulated (× daytime friction)</text>`);
  o.push(`<text x="${W - R}" y="${T + 14}" text-anchor="end" fill="#52514d">${fit.n} roads · r ${fit.corr} · RMSE ${fit.loss}</text></svg>`);
  return o.join("\n");
}

async function main() {
  if (stage === "fetch") return fetchPlan();
  // (the workers read the sketch alone)
  if (existsSync(PLAN_FILE)) writeFileSync(SKETCH_FILE, JSON.stringify(JSON.parse(readFileSync(PLAN_FILE, "utf8")).sketch));
  if (stage === "free") return free();
  if (stage === "calibrate") return calibrate();
  if (stage === "optimize") return optimize();
  if (stage === "final") return final();
  if (stage === "patch") return makePatch();
  if (stage === "figures") return figures();
  if (stage === "map") return mapOnly();
  throw new Error("stage: fetch | free | calibrate | optimize | final | patch | figures");
}
main().catch(e => { console.error(e); process.exit(1); });
