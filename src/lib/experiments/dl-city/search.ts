/**
 * The two searches compared (ticket #277), each proposing the next designs to simulate from those simulated so far:
 *
 *  - `gaPropose`: a plain genetic algorithm on the simulation: parents from the best so far (tournaments), uniform
 *    crossover, small mutations;
 *  - `dlPropose`: surrogate-assisted (the deep-learning one): an ensemble of neural networks learns design → results from
 *    every run so far, a genetic algorithm then searches the networks (thousands of designs a second, against a minute and
 *    a half a run) for the designs most likely to be better (lowest predicted score less its uncertainty, so it also tries
 *    where it is unsure), and only those are simulated.
 */
import type { City, Rng } from "./city";
import { crossover, designKey, features, mutate, randomDesign, type Design } from "./design";
import { Ensemble } from "./mlp";
import { corridorEff, score, type Metrics } from "./evaluate";

export interface Tried { d: Design; key: string; score: number; m: Metrics }

/**
 * What the networks learn: the score's parts, not the score. These are the corridor's time and the centre's traffic,
 * trips and their mean time, each relative to the status quo's. The score is then worked out from each network's parts
 * as `score` does, and its spread over the networks is how sure they are.
 *
 * The first attempt (stopped after one round; its runs are in docs/experiments/dl-city-277/runs-v1.jsonl) learnt the
 * score itself, as a third output, with cars stuck in it. That output was the least sure of the three, and picking by its
 * lower bound chased that doubt: its round-1 picks were predicted at 0.5–0.6 and ran at 0.96–1.39, against what its own
 * corridor and centre outputs said (a score of about 1).
 */
export const targets = (m: Metrics, base: Metrics) => [corridorEff(m) / corridorEff(base), m.centreVehKm / base.centreVehKm, m.trips / base.trips, m.tripTime / base.tripTime];
/** the score from `targets` (as `score` works it out from the metrics) */
export function scoreOf(t: number[]): number {
  return 0.5 * t[0] + 0.5 * t[1] + 2 * Math.max(0, 1 - t[2]) + 2 * Math.max(0, t[3] - 1.1);
}
/** the networks' prediction for a design: corridor, centre and score (their mean), and how far apart the networks are on each */
export function surrogate(ens: Ensemble, x: number[]): { pred: number[]; sd: number[] } {
  const each = ens.members(x).map(t => [t[0], t[1], scoreOf(t)]);
  const mean = [0, 1, 2].map(i => each.reduce((a, e) => a + e[i], 0) / each.length);
  return { pred: mean, sd: [0, 1, 2].map(i => Math.sqrt(each.reduce((a, e) => a + (e[i] - mean[i]) ** 2, 0) / each.length)) };
}
/** the actual corridor, centre and score of a run (what `surrogate` predicts) */
export const actual = (m: Metrics, base: Metrics) => [corridorEff(m) / corridorEff(base), m.centreVehKm / base.centreVehKm, score(m, base)];

const tournament = (pool: Tried[], R: Rng, k = 3) => { let b: Tried | null = null; for (let i = 0; i < k; i++) { const c = pool[Math.floor(R() * pool.length)]; if (!b || c.score < b.score) b = c; } return b!; };
const hamming = (a: Design, b: Design) => (a.four[0] !== b.four[0] ? 1 : 0) + (a.four[1] !== b.four[1] ? 1 : 0) + a.centre.reduce((s, v, i) => s + (v !== b.centre[i] ? 1 : 0), 0) + a.control.reduce((s, v, i) => s + (v !== b.control[i] ? 1 : 0), 0);

export function gaPropose(city: City, tried: Tried[], n: number, R: Rng, elite = 16): Design[] {
  const pool = [...tried].sort((a, b) => a.score - b.score).slice(0, elite), seen = new Set(tried.map(t => t.key)), out: Design[] = [];
  for (let guard = 0; out.length < n && guard < n * 50; guard++) {
    const a = tournament(pool, R), b = tournament(pool, R);
    let c = R() < 0.7 ? crossover(city, a.d, b.d, R) : a.d;
    c = mutate(city, c, R);
    const k = designKey(c);
    if (seen.has(k)) continue;
    seen.add(k); out.push(c);
  }
  return out;
}

export interface DlProposal { d: Design; pred: number[]; sd: number[]; acq: number }

/**
 * The networks trained on what was tried; the designs they rate best (by `mean − kappa · sd` of the score), not tried yet,
 * at least `minDist` genes apart from one another
 */
export function dlPropose(city: City, tried: Tried[], base: Metrics, n: number, R: Rng, o: { kappa?: number; gens?: number; pop?: number; minDist?: number; ens?: Ensemble } = {}): { proposals: DlProposal[]; ens: Ensemble } {
  const ens = o.ens ?? new Ensemble(5, [64, 32], Math.floor(R() * 1e9)).fit(tried.map(t => features(city, t.d)), tried.map(t => targets(t.m, base)));
  const kappa = o.kappa ?? 1, seen = new Set(tried.map(t => t.key));
  const rate = (d: Design) => { const p = surrogate(ens, features(city, d)); return { pred: p.pred, sd: p.sd, acq: p.pred[2] - kappa * p.sd[2] }; };
  // (a genetic algorithm on the networks: from the best tried, and random designs)
  let pop: { d: Design; acq: number; pred: number[]; sd: number[] }[] = [...tried].sort((a, b) => a.score - b.score).slice(0, 30).map(t => ({ d: t.d, ...rate(t.d) }));
  while (pop.length < (o.pop ?? 200)) { const d = randomDesign(city, R, R() * 0.3, R() * 0.4); pop.push({ d, ...rate(d) }); }
  const best = new Map<string, DlProposal>();
  for (let g = 0; g < (o.gens ?? 40); g++) {
    pop.sort((a, b) => a.acq - b.acq);
    for (const p of pop) { const k = designKey(p.d); if (!seen.has(k) && !best.has(k)) best.set(k, { d: p.d, pred: p.pred, sd: p.sd, acq: p.acq }); }
    const parents = pop.slice(0, Math.floor(pop.length / 4)), kids: typeof pop = [];
    while (kids.length < pop.length - parents.length) {
      const a = parents[Math.floor(R() * parents.length)], b = parents[Math.floor(R() * parents.length)];
      const c = mutate(city, R() < 0.6 ? crossover(city, a.d, b.d, R) : a.d, R, 0.7);
      kids.push({ d: c, ...rate(c) });
    }
    pop = [...parents, ...kids];
  }
  const ranked = [...best.values()].sort((a, b) => a.acq - b.acq), out: DlProposal[] = [];
  for (const p of ranked) { if (out.length >= n) break; if (out.every(q => hamming(q.d, p.d) >= (o.minDist ?? 2))) out.push(p); }
  return { proposals: out, ens };
}
