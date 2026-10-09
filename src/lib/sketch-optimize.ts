/**
 * The V2 lights optimiser, as V1's (engine/optimize.ts): the simulation is the judge. Candidate timings are
 * run with the sketch's traffic on several random seeds (the same seeds for every candidate, so differences
 * come from the change, not from luck); a change is kept only when it clearly beats the best so far and still
 * does on a second set of seeds; the result is checked on seeds the search never saw.
 *
 * What it may change, per chosen junction with lights (not those in a signal group: the group times them):
 *  - green time of every phase (the phases then set by hand, as they were worked out)
 *  - actuated or fixed
 *  - phases worked out with ways facing each other together, or one way at a time
 * Coordinate descent: one decision at a time, its options tried and the best kept, pass after pass (greens
 * in smaller steps each pass) until nothing improves. Each run is of the sketch round the chosen junctions
 * only (`cropAround`), so a city's plan stays quick. Running the simulations is left to the caller
 * (`Evaluate`), so the browser can spread them over workers. Framework-free.
 */
import { junctionContents, signalPlan, groupOf, type JunctionLights, type LightsPhase, type Pt, type Sketch } from "./lane-sketch";
import { SketchSim, type SimParams } from "./lane-sketch-sim";

export interface RunSpec { /** seconds simulated before measuring (the sketch fills up) */ warmup: number; /** seconds measured */ measure: number }
/** what one run produced in the measured window: trips finished, vehicles stuck a minute or more at its end, their mean speed (km/h) */
export interface RunMetrics { trips: number; stuck: number; meanSpeed: number }
/** higher is better: trips finished, stuck vehicles counted heavily against */
export const scoreOf = (m: RunMetrics) => m.trips - 5 * m.stuck;

/** runs a sketch with one seed and measures the window after the warm-up */
export function measureRun(sk: Sketch, params: SimParams, seed: number, spec: RunSpec): RunMetrics {
  const sim = new SketchSim(sk, { ...params, seed }, seed);
  for (let t = 0; t < spec.warmup; t += 0.1) sim.step(0.1);
  const f0 = sim.stats().finished;
  let speed = 0, n = 0;
  const steps = Math.round(spec.measure / 0.1);
  for (let k = 1; k <= steps; k++) {
    sim.step(0.1);
    if (k % 50 === 0) { speed += sim.stats().meanSpeed; n++; }
  }
  return { trips: sim.stats().finished - f0, stuck: sim.vehicles.filter(v => v.still >= 60).length, meanSpeed: n ? speed / n : 0 };
}

/** runs `sketches` × `seeds`; metrics as [candidate][seed] */
export type Evaluate = (sketches: Sketch[], seeds: number[]) => Promise<RunMetrics[][]>;

export interface Summary extends RunMetrics { score: number; perSeed: number[] }
const summarise = (runs: RunMetrics[]): Summary => {
  const mean = (f: (m: RunMetrics) => number) => runs.reduce((a, m) => a + f(m), 0) / Math.max(1, runs.length);
  return { trips: mean(m => m.trips), stuck: mean(m => m.stuck), meanSpeed: mean(m => m.meanSpeed), score: mean(scoreOf), perSeed: runs.map(scoreOf) };
};

/** kinds of change it may make */
export type OptimizeTarget = "greens" | "actuated" | "mode";
export const OPTIMIZE_TARGETS: { id: OptimizeTarget; label: string; hint: string }[] = [
  { id: "greens", label: "Green times", hint: "each phase's" },
  { id: "actuated", label: "Actuated or fixed", hint: "greens cut short when nobody uses them" },
  { id: "mode", label: "Phases", hint: "opposite ways together, or one at a time (phases worked out only)" },
];
/** how hard to look: more seeds and longer runs tell real gains from luck, at the cost of time */
export const OPTIMIZE_EFFORT = {
  quick: { label: "Quick", seeds: [1, 2, 3], confirmSeeds: [51, 52, 53], holdoutSeeds: [101, 102, 103], spec: { warmup: 60, measure: 180 }, rounds: 2 },
  standard: { label: "Standard", seeds: [1, 2, 3, 4], confirmSeeds: [51, 52, 53, 54], holdoutSeeds: [101, 102, 103, 104, 105], spec: { warmup: 120, measure: 300 }, rounds: 3 },
  thorough: { label: "Thorough", seeds: [1, 2, 3, 4, 5, 6], confirmSeeds: [51, 52, 53, 54, 55, 56], holdoutSeeds: [101, 102, 103, 104, 105, 106, 107, 108], spec: { warmup: 120, measure: 480 }, rounds: 3 },
} as const;
export type OptimizeEffort = keyof typeof OPTIMIZE_EFFORT;

export interface OptimizeConfig {
  /** junctions (ids) whose lights may change */
  junctions: string[];
  targets: OptimizeTarget[];
  seeds: readonly number[]; confirmSeeds: readonly number[]; holdoutSeeds: readonly number[];
  spec: RunSpec; rounds: number;
}
/** a difference between the sketch and the result at a junction */
export type Change =
  | { kind: "green"; junction: string; phase: string; from: number; to: number }
  | { kind: "actuated"; junction: string; from: boolean; to: boolean }
  | { kind: "mode"; junction: string; from: JunctionLights["mode"]; to: JunctionLights["mode"] };
export interface OptimizeProgress { round: number; rounds: number; step: string; evaluations: number; total: number; baseline: Summary | null; best: Summary | null }
export interface OptimizeResult {
  /** the chosen junctions' lights as found best (to put into the sketch) */
  lights: Record<string, JunctionLights>;
  changes: Change[];
  /** on the search seeds */
  baseline: Summary; best: Summary;
  /** on the fresh seeds */
  check: { baseline: Summary; best: Summary; better: number; of: number };
  evaluations: number;
}

// ---------------------------------------------------------------- the area run

const centre = (pts: Pt[]) => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });
/** the lanes within `radius` metres of the junctions (any point of theirs), with what joins them: the sketch the optimiser runs */
export function cropAround(sk: Sketch, ids: string[], radius = 600): Sketch {
  const cs = sk.junctions.filter(j => ids.includes(j.id)).map(j => centre(j.outline));
  if (!cs.length) return sk;
  const near = (p: Pt) => cs.some(c => Math.hypot(p.x - c.x, p.y - c.y) <= radius);
  const ptsOf = (l: Sketch["lanes"][number]): Pt[] => (l.shape.kind === "line" ? l.shape.pts : [l.shape.c]);
  const lanes = sk.lanes.filter(l => ptsOf(l).some(near)), keep = new Set(lanes.map(l => l.id));
  if (keep.size === sk.lanes.length) return sk;
  const connectors = sk.connectors.filter(c => keep.has(c.from.lane) && keep.has(c.to.lane));
  const roads = sk.roads.map(r => ({ ...r, lanes: r.lanes.filter(id => keep.has(id)) })).filter(r => r.lanes.length);
  const junctions = sk.junctions.filter(j => j.outline.some(near));
  const js = new Set(junctions.map(j => j.id));
  const signalGroups = (sk.signalGroups ?? []).map(g => ({ ...g, members: g.members.filter(m => js.has(m.junction)) })).filter(g => g.members.length);
  const journeys = (sk.journeys ?? []).filter(j => keep.has(j.from) && keep.has(j.to));
  const { links: _l, scratch: _s, signalGroups: _g, journeys: _j, crossings, ...rest } = sk;
  return {
    ...rest, lanes, connectors, roads, junctions,
    ...(crossings ? { crossings: crossings.filter(x => near(x.a) || near(x.b)) } : {}),
    ...(signalGroups.length ? { signalGroups } : {}), ...(journeys.length ? { journeys } : {}),
  };
}

// ---------------------------------------------------------------- the decisions it can make

interface Option { label: string; sk: Sketch }
interface Decision { key: string; structural: boolean; options: (sk: Sketch, round: number) => Option[] }
const GREEN_FACTORS = [[0.5, 0.75, 1.35, 1.8], [0.8, 1.2], [0.9, 1.1]];
const MIN_GREEN = 5, MAX_GREEN = 90;

const lightsOf = (sk: Sketch, id: string) => sk.junctions.find(j => j.id === id)?.lights ?? null;
const withLights = (sk: Sketch, id: string, L: JunctionLights): Sketch => ({ ...sk, junctions: sk.junctions.map(j => (j.id === id ? { ...j, lights: L } : j)) });
const nameOf = (sk: Sketch, id: string) => sk.junctions.find(j => j.id === id)?.name ?? id;
/** a junction's lights with its phases set by hand, as they are worked out now (null: no lights, or nothing for them to hold) */
function byHand(sk: Sketch, id: string): JunctionLights | null {
  const j = sk.junctions.find(x => x.id === id), L = j?.lights;
  if (!j || !L) return null;
  if (L.phases?.length) return L;
  const plan = signalPlan(sk, j, junctionContents(sk, j));
  if (!plan || plan.phases.length < 2) return null;
  return { ...L, phases: plan.phases.map((p): LightsPhase => ({ name: p.name, green: p.green, conns: [...p.conns] })) };
}
/** lights it may time: two phases or more, not in a signal group */
const timeable = (sk: Sketch, id: string) => {
  const j = sk.junctions.find(x => x.id === id);
  if (!j?.lights || groupOf(sk, id)) return false;
  const plan = signalPlan(sk, j, junctionContents(sk, j));
  return !!plan && plan.phases.length >= 2;
};

function modeDecision(id: string): Decision {
  return {
    key: `mode:${id}`, structural: true,
    options: sk => {
      const L = lightsOf(sk, id);
      if (!L || L.phases?.length || !timeable(sk, id)) return [];
      const to = L.mode === "pairs" ? "each" : "pairs";
      return [{ label: `${nameOf(sk, id)}: ${to === "each" ? "one way at a time" : "opposite ways together"}`, sk: withLights(sk, id, { ...L, mode: to }) }];
    },
  };
}
function actuatedDecision(id: string): Decision {
  return {
    key: `actuated:${id}`, structural: true,
    options: sk => {
      const L = lightsOf(sk, id);
      if (!L || !timeable(sk, id)) return [];
      return [{ label: `${nameOf(sk, id)}: ${L.actuated ? "fixed" : "actuated"}`, sk: withLights(sk, id, { ...L, actuated: !L.actuated }) }];
    },
  };
}
function greenDecisions(sk0: Sketch, id: string): Decision[] {
  const L0 = timeable(sk0, id) ? byHand(sk0, id) : null;
  if (!L0?.phases) return [];
  return L0.phases.map((_, p) => ({
    key: `green:${id}:${p}`, structural: false,
    options: (sk: Sketch, round: number): Option[] => {
      const L = timeable(sk, id) ? byHand(sk, id) : null, ph = L?.phases?.[p];
      if (!L || !ph || !ph.conns.length) return [];
      const cur = ph.green;
      const values = [...new Set(GREEN_FACTORS[Math.min(round, GREEN_FACTORS.length) - 1].map(f => Math.round(Math.min(MAX_GREEN, Math.max(MIN_GREEN, cur * f)))))].filter(v => v !== cur);
      return values.map(v => ({
        label: `${nameOf(sk, id)}: ${ph.name || `phase ${p + 1}`} green ${cur} → ${v} s`,
        sk: withLights(sk, id, { ...L, phases: L.phases!.map((q, i) => (i === p ? { ...q, green: v } : q)) }),
      }));
    },
  }));
}

/** what differs between the sketch and the result at the chosen junctions */
export function describeChanges(original: Sketch, result: Sketch, ids: string[]): Change[] {
  const out: Change[] = [];
  for (const id of ids) {
    const a = lightsOf(original, id), b = lightsOf(result, id);
    if (!a || !b) continue;
    if (a.mode !== b.mode && !b.phases?.length) out.push({ kind: "mode", junction: id, from: a.mode, to: b.mode });
    if (a.actuated !== b.actuated) out.push({ kind: "actuated", junction: id, from: a.actuated, to: b.actuated });
    const pa = byHand(original, id)?.phases ?? [], pb = b.phases ?? [];
    pb.forEach((q, i) => { if (pa[i] && pa[i].green !== q.green) out.push({ kind: "green", junction: id, phase: q.name || `Phase ${i + 1}`, from: pa[i].green, to: q.green }); });
  }
  return out;
}
/** one change as text, e.g. "Junction 2: Phase 1 green 18 → 24 s" */
export function formatChange(ch: Change, name: (id: string) => string): string {
  const j = name(ch.junction);
  switch (ch.kind) {
    case "green": return `${j}: ${ch.phase} green ${ch.from} → ${ch.to} s`;
    case "actuated": return `${j}: ${ch.to ? "actuated" : "fixed"} (was ${ch.from ? "actuated" : "fixed"})`;
    case "mode": return `${j}: ${ch.to === "each" ? "one way at a time" : "opposite ways together"}`;
  }
}

// ---------------------------------------------------------------- search

/** times the chosen junctions' lights; `original` is the whole sketch, the runs are of the area round them */
export async function optimizeLights(
  original: Sketch, cfg: OptimizeConfig, evaluate: Evaluate,
  onProgress: (p: OptimizeProgress) => void = () => {}, signal?: AbortSignal,
): Promise<OptimizeResult> {
  const targets = new Set(cfg.targets.length ? cfg.targets : ["greens"]);
  const rounds = Math.max(1, Math.min(GREEN_FACTORS.length, cfg.rounds));
  const area = cropAround(original, cfg.junctions);
  let sk = area, evaluations = 0, total = 1;
  let baseline: Summary | null = null, best: Summary | null = null;
  const report = (round: number, step: string) => onProgress({ round, rounds, step, evaluations, total, baseline, best });
  const run = async (sks: Sketch[], seeds: readonly number[]) => {
    if (signal?.aborted) throw new DOMException("Optimisation cancelled", "AbortError");
    const r = await evaluate(sks, [...seeds]);
    evaluations += sks.length;
    return r.map(summarise);
  };
  const list = (s: Sketch): Decision[] => [
    ...(targets.has("mode") ? cfg.junctions.map(modeDecision) : []),
    ...(targets.has("actuated") ? cfg.junctions.map(actuatedDecision) : []),
    ...(targets.has("greens") ? cfg.junctions.flatMap(id => greenDecisions(s, id)) : []),
  ];

  report(0, "Measuring the lights as they are");
  [baseline] = await run([sk], cfg.seeds);
  best = baseline;
  let bestConfirm: Summary | null = cfg.confirmSeeds.length ? (await run([sk], cfg.confirmSeeds))[0] : null;

  for (let round = 1; round <= rounds; round++) {
    const ds = list(sk);
    total = evaluations + ds.reduce((a, d) => a + d.options(sk, round).length, 0) * (rounds - round + 1) + 2;
    let improved = false;
    for (const d of ds) {
      const opts = d.options(sk, round);
      if (!opts.length) continue;
      report(round, opts.length === 1 ? `trying ${opts[0].label}` : `trying ${opts.length} options: ${opts[0].label.replace(/ green .*/, "")}…`);
      const results = await run(opts.map(o => o.sk), cfg.seeds);
      let bi = -1;
      results.forEach((r, i) => { if (r.score > (bi < 0 ? best!.score : results[bi].score)) bi = i; });
      // (kept only when it clearly beats the best so far, a change of kind by more…)
      const margin = (x: Summary) => Math.max(1, Math.abs(x.score) * (d.structural ? 0.02 : 0.01));
      if (bi < 0 || results[bi].score <= best!.score + margin(best!)) continue;
      // (…and still does on the other seeds)
      let conf: Summary | null = null;
      if (bestConfirm) {
        report(round, `confirming ${opts[bi].label}`);
        [conf] = await run([opts[bi].sk], cfg.confirmSeeds);
        if (conf.score <= bestConfirm.score + margin(bestConfirm) / 2) { report(round, `not confirmed: ${opts[bi].label}`); continue; }
      }
      sk = opts[bi].sk; best = results[bi]; bestConfirm = conf ?? bestConfirm; improved = true;
      report(round, `kept ${opts[bi].label}`);
    }
    if (!improved) break;
  }

  total = evaluations + 2;
  report(rounds, "Checking the result on fresh seeds");
  const [cb, cn] = await run([area, sk], cfg.holdoutSeeds);
  const better = cn.perSeed.filter((x, i) => x > cb.perSeed[i]).length;
  const changes = describeChanges(area, sk, cfg.junctions);
  const lights: Record<string, JunctionLights> = {};
  if (changes.length) for (const id of cfg.junctions) { const L = lightsOf(sk, id); if (L && L !== lightsOf(area, id)) lights[id] = L; }
  return { lights, changes, baseline: baseline!, best: best!, check: { baseline: cb, best: cn, better, of: cfg.holdoutSeeds.length }, evaluations };
}
