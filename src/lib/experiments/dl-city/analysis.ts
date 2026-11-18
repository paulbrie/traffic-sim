/**
 * What the experiment's runs say (ticket #277), worked out the same way for the page and for the summary script: each
 * design's results (its runs' mean), how each search's best improved run by run, the trade-off between the corridor and
 * the centre (the designs nobody beats on both), the finalists checked on five seeds, and how well the networks predicted
 * designs before they were simulated.
 */
import { corridorEff, meanMetrics, score, type Metrics } from "./evaluate";
import { Ensemble, r2, spearman } from "./mlp";
import { parseKey, features } from "./design";
import { rng, type City } from "./city";
import { actual, surrogate, targets } from "./search";

export interface RunRecord { key: string; seed: number; method: string; round: number; m: Metrics; pred?: number[]; sd?: number[]; at?: string }
export const SEARCH_SEEDS = [1, 2], ALL_SEEDS = [1, 2, 3, 4, 5];

export interface DesignResult {
  key: string; method: "baseline" | "init" | "ga" | "dl"; round: number;
  /** on the search's seeds */
  m: Metrics; score: number; corridor: number; centre: number;
  /** on all five, when it was checked on them */
  m5?: Metrics; score5?: number; corridor5?: number; centre5?: number;
  pred?: number[]; sd?: number[];
  /** the order it was run in (by when its first run finished) */
  order: number;
}

export interface Analysis {
  base: Metrics; base5: Metrics; designs: DesignResult[];
  /** best score so far against simulator runs, per search (the runs both started from counted for each) */
  curves: { ga: { runs: number; best: number }[]; dl: { runs: number; best: number }[] };
  pareto: string[];
  finalists: DesignResult[];
  /** the networks' predictions of the score of the designs they proposed, before they were run */
  prospective: { n: number; mae: number; r2: number; rho: number; byRound: { round: number; mae: number }[] };
  /** baseline seed-to-seed spread (sd of score over the five seeds) */
  noise: number;
}

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

export function analyse(runs: RunRecord[]): Analysis {
  const by = new Map<string, RunRecord[]>();
  runs.forEach(r => (by.get(r.key) ?? by.set(r.key, []).get(r.key)!).push(r));
  const baseRuns = runs.filter(r => r.method === "baseline");
  if (!baseRuns.length) throw new Error("no status quo runs");
  const bkey = baseRuns[0].key;
  const pick = (key: string, seeds: number[]) => { const rs = by.get(key)!.filter(r => seeds.includes(r.seed)); return rs.length === seeds.length ? meanMetrics(rs.map(r => r.m)) : null; };
  const base = pick(bkey, SEARCH_SEEDS)!, base5 = pick(bkey, ALL_SEEDS) ?? base;
  const order = new Map<string, number>();
  runs.forEach((r, i) => { if (!order.has(r.key)) order.set(r.key, i); });
  const designs: DesignResult[] = [];
  for (const [key, rs] of by) {
    const m = pick(key, SEARCH_SEEDS);
    if (!m) continue;
    const first = rs.find(r => !r.method.startsWith("validate")) ?? rs[0];
    const method = (key === bkey ? "baseline" : first.method) as DesignResult["method"];
    const m5 = pick(key, ALL_SEEDS) ?? undefined;
    designs.push({
      key, method, round: first.round, m, score: score(m, base), corridor: corridorEff(m) / corridorEff(base), centre: m.centreVehKm / base.centreVehKm,
      ...(m5 ? { m5, score5: score(m5, base5), corridor5: corridorEff(m5) / corridorEff(base5), centre5: m5.centreVehKm / base5.centreVehKm } : {}),
      ...(first.pred ? { pred: first.pred, sd: first.sd } : {}), order: order.get(key)!,
    });
  }
  designs.sort((a, b) => a.order - b.order);
  // (each search: the status quo and the designs both started from, then its own, in the order they ran)
  const curve = (method: "ga" | "dl") => {
    const out: { runs: number; best: number }[] = [];
    let runsSoFar = 0, best = Infinity;
    for (const d of designs) {
      if (d.method !== "baseline" && d.method !== "init" && d.method !== method) continue;
      runsSoFar += SEARCH_SEEDS.length;
      best = Math.min(best, d.score);
      out.push({ runs: runsSoFar, best });
    }
    return out;
  };
  // (the trade-off: no other design both quicker on the corridor and with less traffic in the centre)
  const ok = designs.filter(d => d.m.trips >= base.trips * 0.95);
  const pareto = ok.filter(d => !ok.some(e => e !== d && e.corridor <= d.corridor && e.centre <= d.centre && (e.corridor < d.corridor || e.centre < d.centre))).map(d => d.key);
  const finalists = designs.filter(d => d.score5 !== undefined && d.method !== "baseline").sort((a, b) => a.score5! - b.score5!);
  const dl = designs.filter(d => d.method === "dl" && d.pred);
  const rounds = [...new Set(dl.map(d => d.round))].sort((a, b) => a - b);
  const sd5 = ALL_SEEDS.map(s => by.get(bkey)!.find(r => r.seed === s)).filter(Boolean).map(r => score(r!.m, base5));
  const mu = mean(sd5);
  return {
    base, base5, designs, curves: { ga: curve("ga"), dl: curve("dl") }, pareto, finalists,
    prospective: {
      n: dl.length, mae: mean(dl.map(d => Math.abs(d.pred![2] - d.score))), r2: dl.length > 2 ? r2(dl.map(d => d.score), dl.map(d => d.pred![2])) : NaN,
      rho: dl.length > 2 ? spearman(dl.map(d => d.score), dl.map(d => d.pred![2])) : NaN,
      byRound: rounds.map(round => ({ round, mae: mean(dl.filter(d => d.round === round).map(d => Math.abs(d.pred![2] - d.score))) })),
    },
    noise: Math.sqrt(mean(sd5.map(s => (s - mu) ** 2))),
  };
}

/**
 * k-fold cross-validation of the networks on every design run (each fold's designs predicted by an ensemble trained on
 * the others): how well design → results can be learnt from this many runs. Per target: R², rank correlation, and each
 * design's held-out prediction.
 */
export function crossValidate(city: City, a: Analysis, folds = 5, o: { size?: number; hidden?: number[]; epochs?: number; onFold?: (k: number) => void } = {}) {
  const ds = a.designs, R = rng(42), idx = ds.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const X = ds.map(d => features(city, parseKey(d.key))), T = ds.map(d => targets(d.m, a.base)), Y = ds.map(d => actual(d.m, a.base));
  const pred: number[][] = ds.map(() => []);
  for (let k = 0; k < folds; k++) {
    const test = new Set(idx.filter((_, i) => i % folds === k)), train = idx.filter(i => !test.has(i));
    const ens = new Ensemble(o.size ?? 5, o.hidden ?? [64, 32], 100 + k).fit(train.map(i => X[i]), train.map(i => T[i]), { epochs: o.epochs });
    for (const i of test) pred[i] = surrogate(ens, X[i]).pred;
    o.onFold?.(k + 1);
  }
  const names = ["corridor", "centre", "score"];
  return { pred, actual: Y, stats: names.map((name, t) => ({ name, r2: r2(Y.map(y => y[t]), pred.map(p => p[t])), rho: spearman(Y.map(y => y[t]), pred.map(p => p[t])) })) };
}
