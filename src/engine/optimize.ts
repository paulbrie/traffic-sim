/**
 * Junction optimiser: the simulation is the judge. Candidate changes are run with the plan's demand
 * on several random seeds (the same seeds for every candidate, so differences come from the change,
 * not from luck); a change is kept only when it clearly beats the current best. The winner is
 * re-checked on seeds the search never saw.
 *
 * What it may change, per chosen junction:
 *  - control: priority, all-way stop, traffic lights or roundabout
 *  - lane arrows on approaches with 2+ lanes (a dedicated left and / or right lane, or automatic)
 *  - protected left turns at traffic lights (a short phase of their own)
 *  - green time of every phase at traffic lights
 * The search is coordinate descent: one decision at a time, trying its options and keeping the
 * best, pass after pass (green times in smaller steps each pass) until nothing improves.
 * Running the simulations is left to the caller (`Evaluate`), so the browser can spread them over
 * Web Workers and scripts can run them however they like.
 */
import { compile, type CNode, type Compiled } from "./compile";
import { Sim } from "./sim";
import { withCustomPhases } from "./signals";
import { DEFAULT_SIGNAL, LANE_TURNS, type Control, type LaneTurn, type LaneTurns, type LinkDef, type Network, type PlanSettings } from "./types";

export interface RunSpec {
  /** seconds simulated before measuring (the network fills up) */
  warmup: number;
  /** seconds measured */
  measure: number;
}

/** what one run produced during the measured window */
export interface RunMetrics {
  trips: number;
  towed: number;
  /** mean of the average speed samples (km/h) */
  avgSpeed: number;
  /** mean share of vehicles standing still (0..1) */
  stopped: number;
}

/** higher is better: completed trips, with stuck (towed) vehicles counted heavily against */
export const scoreOf = (m: RunMetrics) => m.trips - 5 * m.towed;

/** Simulates a plan with one seed and measures the window after the warm-up. */
export function measureRun(net: Network, settings: PlanSettings, spec: RunSpec): RunMetrics {
  const sim = new Sim(compile(net), settings);
  sim.run(Math.round(spec.warmup * 10));
  const trips0 = sim.stats.trips, towed0 = sim.stats.towed;
  let speed = 0, stopped = 0, n = 0;
  const steps = Math.round(spec.measure * 10);
  for (let k = 1; k <= steps; k++) {
    sim.step();
    if (k % 50 === 0) { speed += sim.stats.avgSpeed; stopped += sim.stats.stopped; n++; }
  }
  return { trips: sim.stats.trips - trips0, towed: sim.stats.towed - towed0, avgSpeed: n ? speed / n : 0, stopped: n ? stopped / n : 0 };
}

/** runs `nets` × `seeds`; returns metrics as [candidate][seed] */
export type Evaluate = (nets: Network[], seeds: number[]) => Promise<RunMetrics[][]>;

export interface Summary extends RunMetrics { score: number; perSeed: number[] }

const summarise = (runs: RunMetrics[]): Summary => {
  const mean = (f: (m: RunMetrics) => number) => runs.reduce((a, m) => a + f(m), 0) / Math.max(1, runs.length);
  return { trips: mean(m => m.trips), towed: mean(m => m.towed), avgSpeed: mean(m => m.avgSpeed), stopped: mean(m => m.stopped), score: mean(scoreOf), perSeed: runs.map(scoreOf) };
};

/** kinds of change the optimiser may make */
export type OptimizeTarget = "greens" | "control" | "lanes" | "lefts";
export const OPTIMIZE_TARGETS: { id: OptimizeTarget; label: string; hint: string }[] = [
  { id: "greens", label: "Green times", hint: "at traffic lights" },
  { id: "control", label: "Junction control", hint: "priority, stop, lights or roundabout" },
  { id: "lefts", label: "Protected left turns", hint: "a short phase of their own at traffic lights" },
  { id: "lanes", label: "Lane arrows", hint: "dedicated left / right lanes on approaches with 2+ lanes" },
];

export interface OptimizeConfig {
  /** junctions (node ids) that may change */
  nodes: string[];
  /** what may change (default: green times only) */
  targets?: OptimizeTarget[];
  /** seeds the search compares candidates on */
  seeds: number[];
  /**
   * independent seeds a winning candidate must also win on before it is kept (the best of many
   * noisy options tends to look better than it is); default: none
   */
  confirmSeeds?: number[];
  /** fresh seeds for the final before / after check */
  holdoutSeeds: number[];
  spec: RunSpec;
  /** passes over all decisions (later passes try smaller changes to green times) */
  rounds: number;
}

/** how hard to look: more seeds and longer runs separate real gains from luck, at the cost of time */
export const OPTIMIZE_EFFORT = {
  quick: { label: "Quick", seeds: [1, 2, 3], confirmSeeds: [51, 52, 53], holdoutSeeds: [101, 102, 103], spec: { warmup: 60, measure: 180 }, rounds: 2 },
  standard: { label: "Standard", seeds: [1, 2, 3, 4], confirmSeeds: [51, 52, 53, 54], holdoutSeeds: [101, 102, 103, 104, 105], spec: { warmup: 120, measure: 300 }, rounds: 3 },
  thorough: { label: "Thorough", seeds: [1, 2, 3, 4, 5, 6], confirmSeeds: [51, 52, 53, 54, 55, 56], holdoutSeeds: [101, 102, 103, 104, 105, 106, 107, 108], spec: { warmup: 120, measure: 480 }, rounds: 3 },
} as const;
export type OptimizeEffort = keyof typeof OPTIMIZE_EFFORT;

/** a difference between the original plan and the result, per junction */
export type Change =
  | { kind: "control"; node: string; from: Control; to: Control }
  | { kind: "lanes"; node: string; road: string; from: LaneTurns | null; to: LaneTurns | null }
  | { kind: "green"; node: string; phase: number; from: number; to: number }
  | { kind: "phases"; node: string; from: number[]; to: number[] };

export interface OptimizeProgress {
  round: number; rounds: number;
  /** what is being tried */
  step: string;
  evaluations: number;
  /** estimate of all evaluations for the search (for a progress bar; may shrink when it ends early) */
  total: number;
  baseline: Summary | null;
  best: Summary | null;
}

export interface OptimizeResult {
  network: Network;
  changes: Change[];
  /** on the search seeds */
  baseline: Summary; best: Summary;
  /** on the holdout seeds */
  check: { baseline: Summary; best: Summary; better: number; of: number };
  evaluations: number;
}

// ---------------------------------------------------------------- the decisions it can make

interface Option { label: string; net: Network }
interface Decision { key: string; structural: boolean; options: (net: Network, c: Compiled, round: number) => Option[] }

const GREEN_FACTORS = [[0.5, 0.75, 1.35, 1.8], [0.8, 1.2], [0.9, 1.1]];
const MIN_GREEN = 5, MAX_GREEN = 90, LEFT_GREEN = 8;
const CONTROLS: Control[] = ["priority", "stop", "lights", "roundabout"];

const updNode = (net: Network, id: string, patch: Partial<Network["nodes"][number]>): Network => ({ ...net, nodes: net.nodes.map(n => (n.id === id ? { ...n, ...patch } : n)) });
const isLit = (n: CNode | undefined) => !!n && n.controlled && n.def.control === "lights" && n.phases.length >= 2;

/** control of a junction (3+ roads) */
function controlDecision(id: string): Decision {
  return {
    key: `control:${id}`, structural: true,
    options: (net, c) => {
      const n = c.nodeById.get(id);
      if (!n || !n.controlled || n.degree < 3) return [];
      return CONTROLS.filter(k => k !== n.def.control).map(k => ({
        label: `${id}: ${n.def.control} → ${k}`,
        net: updNode(net, id, { control: k, ...(k === "lights" && !n.def.signal ? { signal: { ...DEFAULT_SIGNAL } } : {}) }),
      }));
    },
  };
}

/** a lane-turn string in the canonical L-S-R order, if it is a valid one */
const turnOf = (set: Set<string>): LaneTurn | null => {
  const s = ["L", "S", "R"].filter(t => set.has(t)).join("");
  return (LANE_TURNS as string[]).includes(s) ? (s as LaneTurn) : null;
};

/** lane arrows of each approach to a junction with 2+ lanes and a choice of turns */
function laneDecisions(id: string, c: Compiled): Decision[] {
  const n = c.nodeById.get(id);
  if (!n || !n.controlled || n.degree < 3 || n.ringR > 0) return [];
  return n.arms.flatMap(a => {
    const e = a.inEdge;
    if (!e || e.n < 2 || e.bus || e.busOnly) return [];
    const linkId = e.link.id, dir = e.dir;
    return [{
      key: `lanes:${linkId}:${dir}`, structural: true,
      options: (net, cc) => {
        const nn = cc.nodeById.get(id), ee = cc.edgeByKey.get(`${linkId}:${dir}`);
        if (!nn || !ee || ee.n < 2 || ee.to !== nn || nn.ringR > 0) return [];
        const link = net.links.find(l => l.id === linkId)!;
        const cur = (dir === 1 ? link.turnsF : link.turnsB) ?? null;
        const turns = new Set((nn.moves.get(ee.idx) ?? []).map(m => (m.turn === "U" ? "L" : m.turn)));
        const k = ee.n, patterns: { label: string; t: LaneTurns | null }[] = [];
        const rest = (drop: string) => turnOf(new Set([...turns].filter(t => t !== drop)));
        if (cur) patterns.push({ label: "automatic", t: null });
        const noR = rest("R"), noL = rest("L");
        if (turns.has("R") && turns.size >= 2 && noR) patterns.push({ label: "right lane for right turns only", t: [...Array(k - 1).fill(noR), "R"] });
        if (turns.has("L") && turns.size >= 2 && noL) patterns.push({ label: "left lane for left turns only", t: ["L", ...Array(k - 1).fill(noL)] });
        if (k >= 3 && turns.has("L") && turns.has("R") && turns.has("S")) patterns.push({ label: "left lane left only, right lane right only", t: ["L", ...Array(k - 2).fill("S"), "R"] });
        const same = (x: LaneTurns | null) => JSON.stringify(x) === JSON.stringify(cur);
        return patterns.filter(p => !same(p.t)).map(p => ({
          label: `${id}: ${link.name || "road"}: ${p.label}`,
          net: { ...net, links: net.links.map(l => (l.id === linkId ? { ...l, ...(dir === 1 ? { turnsF: p.t } : { turnsB: p.t }) } : l)) },
        }));
      },
    }];
  });
}

/** junction at lights, on custom phases (so phases can be added and timed one by one) */
function asCustom(net: Network, c: Compiled, id: string): Network {
  const n = c.nodeById.get(id);
  return isLit(n) && !n!.customPhases ? withCustomPhases(net, c, id) : net;
}

/** protected left turns: a phase of their own for the left lanes of one shared green */
function leftDecision(id: string): Decision {
  return {
    key: `lefts:${id}`, structural: true,
    options: (net0, c0) => {
      if (!isLit(c0.nodeById.get(id))) return [];
      const net1 = asCustom(net0, c0, id), c = net1 === net0 ? c0 : compile(net1), n = c.nodeById.get(id)!;
      const out: Option[] = [];
      n.phases.forEach((arms, p) => {
        // approaches green in this phase whose leftmost lane turns left (and has a lane beside it)
        const lefts = arms.filter(i => {
          const e = n.arms[i].inEdge;
          return e && e.n >= 2 && n.lanePhases[i][0]?.includes(p) && (n.moves.get(e.idx) ?? []).some(m => (m.turn === "L" || m.turn === "U") && m.lo === 0);
        });
        if (!lefts.length || n.phases.length >= 8) return;
        // already protected: those left lanes are green in no other phase with oncoming traffic
        if (lefts.every(i => n.lanePhases[i][0].length === 1 && n.phases[n.lanePhases[i][0][0]].length === lefts.length)) return;
        const q = p + 1; // the new phase comes right after the shared green
        const bump = (ps: number[]) => ps.map(x => (x >= q ? x + 1 : x));
        const leftEdges = new Set(lefts.map(i => n.arms[i].inEdge!.key));
        const links: LinkDef[] = net1.links.map(l => {
          const patch: Partial<LinkDef> = {};
          for (const dir of [1, -1] as const) {
            if ((dir === 1 ? l.to : l.from) !== id) continue;
            const g = dir === 1 ? l.greenF : l.greenB;
            if (!g) continue;
            const ng = g.map((ps, lane) => (lane === 0 && leftEdges.has(`${l.id}:${dir}`) ? [q] : bump(ps)));
            if (dir === 1) patch.greenF = ng; else patch.greenB = ng;
          }
          return Object.keys(patch).length ? { ...l, ...patch } : l;
        });
        const phases = [...(n.def.phases ?? [])];
        phases.splice(q, 0, { green: LEFT_GREEN });
        out.push({
          label: `${id}: protected left turns from ${lefts.map(i => n.arms[i].link.name || "road").join(" + ")}`,
          net: { ...updNode({ ...net1, links }, id, { phases }), signalGroups: net1.signalGroups?.map(g => ({ ...g, members: g.members.map(m => (m.node === id && m.phase >= q ? { ...m, phase: m.phase + 1 } : m)) })) },
        });
      });
      return out;
    },
  };
}

/** green time of each phase (with lanes) of a junction at lights */
function greenDecisions(id: string, c: Compiled): Decision[] {
  const n = c.nodeById.get(id);
  if (!isLit(n)) return [];
  return n!.phases.map((_, p) => ({
    key: `green:${id}:${p}`, structural: false,
    options: (net0: Network, c0: Compiled, round: number): Option[] => {
      const cn = c0.nodeById.get(id);
      if (!isLit(cn) || !cn!.phases[p]?.length) return [];
      const net1 = asCustom(net0, c0, id);
      const cur = net1.nodes.find(x => x.id === id)!.phases![p].green;
      const values = [...new Set(GREEN_FACTORS[Math.min(round, GREEN_FACTORS.length) - 1].map(f => Math.round(Math.min(MAX_GREEN, Math.max(MIN_GREEN, cur * f)))))].filter(v => v !== cur);
      return values.map(v => ({
        label: `${id}: phase ${p + 1} green ${cur} → ${v} s`,
        net: updNode(net1, id, { phases: net1.nodes.find(x => x.id === id)!.phases!.map((ph, i) => (i === p ? { ...ph, green: v } : ph)) }),
      }));
    },
  }));
}

/** all decisions for the chosen junctions, in the order a pass works through them */
function decisions(c: Compiled, nodes: string[], targets: Set<OptimizeTarget>): Decision[] {
  const out: Decision[] = [];
  if (targets.has("control")) for (const id of nodes) out.push(controlDecision(id));
  if (targets.has("lefts")) for (const id of nodes) out.push(leftDecision(id));
  if (targets.has("lanes")) for (const id of nodes) out.push(...laneDecisions(id, c));
  if (targets.has("greens")) for (const id of nodes) out.push(...greenDecisions(id, c));
  return out;
}

// ---------------------------------------------------------------- report

/** what differs between the original plan and the result at the chosen junctions */
export function describeChanges(original: Network, result: Network, nodes: string[]): Change[] {
  const c0 = compile(original), c1 = compile(result);
  const out: Change[] = [];
  for (const id of nodes) {
    const a = c0.nodeById.get(id), b = c1.nodeById.get(id);
    if (!a || !b) continue;
    if (a.def.control !== b.def.control) out.push({ kind: "control", node: id, from: a.def.control, to: b.def.control });
    for (const arm of b.arms) {
      const e = arm.inEdge;
      if (!e) continue;
      const l0 = original.links.find(l => l.id === e.link.id), l1 = result.links.find(l => l.id === e.link.id);
      const t0 = (e.dir === 1 ? l0?.turnsF : l0?.turnsB) ?? null, t1 = (e.dir === 1 ? l1?.turnsF : l1?.turnsB) ?? null;
      if (JSON.stringify(t0) !== JSON.stringify(t1)) out.push({ kind: "lanes", node: id, road: e.link.name || "unnamed road", from: t0, to: t1 });
    }
    if (isLit(b)) {
      const g0 = isLit(a) ? a.phaseGreen : [], g1 = b.phaseGreen;
      if (g0.length === g1.length) g1.forEach((g, p) => { if (g !== g0[p]) out.push({ kind: "green", node: id, phase: p, from: g0[p], to: g }); });
      else out.push({ kind: "phases", node: id, from: g0, to: g1 });
    }
  }
  return out;
}

const CONTROL_NAME: Record<Control, string> = { priority: "priority", free: "free", stop: "all-way stop", lights: "traffic lights", roundabout: "roundabout" };
const lanesText = (t: LaneTurns | null) => (t ? t.join(" | ") : "automatic");

/** one change as text, e.g. "J2: phase 1 green 18 → 24 s" (`ref` names junctions) */
export function formatChange(ch: Change, ref: (nodeId: string) => string): string {
  const j = ref(ch.node);
  switch (ch.kind) {
    case "control": return `${j}: ${CONTROL_NAME[ch.from]} → ${CONTROL_NAME[ch.to]}`;
    case "lanes": return `${j}: lane arrows on ${ch.road}: ${lanesText(ch.from)} → ${lanesText(ch.to)} (left to right)`;
    case "green": return `${j}: phase ${ch.phase + 1} green ${ch.from} → ${ch.to} s`;
    case "phases": return `${j}: phases ${ch.from.length ? ch.from.map(g => `${g} s`).join(" / ") : "none"} → ${ch.to.map(g => `${g} s`).join(" / ")}`;
  }
}

// ---------------------------------------------------------------- search

/** Tunes the chosen junctions: control, lane arrows, protected left turns, green times. */
export async function optimizeSignals(
  original: Network, settings: PlanSettings, cfg: OptimizeConfig, evaluate: Evaluate,
  onProgress: (p: OptimizeProgress) => void = () => {}, signal?: AbortSignal,
): Promise<OptimizeResult> {
  const targets = new Set<OptimizeTarget>(cfg.targets?.length ? cfg.targets : ["greens"]);
  const rounds = Math.max(1, Math.min(GREEN_FACTORS.length, cfg.rounds));
  let net = original;
  let evaluations = 0, total = 1;
  let baseline: Summary | null = null, best: Summary | null = null;
  const report = (round: number, step: string) => onProgress({ round, rounds, step, evaluations, total, baseline, best });
  const run = async (nets: Network[], seeds: number[]) => {
    if (signal?.aborted) throw new DOMException("Optimisation cancelled", "AbortError");
    const r = await evaluate(nets, seeds);
    evaluations += nets.length;
    return r.map(summarise);
  };

  report(0, "Measuring the current plan");
  [baseline] = await run([net], cfg.seeds);
  best = baseline;
  const confirm = cfg.confirmSeeds ?? [];
  let bestConfirm: Summary | null = confirm.length ? (await run([net], confirm))[0] : null;

  for (let round = 1; round <= rounds; round++) {
    let compiled = compile(net);
    const list = decisions(compiled, cfg.nodes, targets);
    // rough size of what is left, for the progress bar
    const perPass = list.reduce((a, d) => a + d.options(net, compiled, round).length, 0);
    total = evaluations + perPass * (rounds - round + 1) + 2;
    let improved = false;
    for (const d of list) {
      const opts = d.options(net, compiled, round);
      if (!opts.length) continue;
      report(round, opts.length === 1 ? `trying ${opts[0].label}` : `trying ${opts.length} options: ${opts[0].label.replace(/ → .*| green .*/, "")}…`);
      const results = await run(opts.map(o => o.net), cfg.seeds);
      let bi = -1;
      results.forEach((r, i) => { if (r.score > (bi < 0 ? best!.score : results[bi].score)) bi = i; });
      // keep a change only when it clearly beats the current best (structural changes need more)…
      const margin = (x: Summary) => Math.max(1, Math.abs(x.score) * (d.structural ? 0.02 : 0.01));
      if (bi < 0 || results[bi].score <= best!.score + margin(best!)) continue;
      // …and still does on the confirmation seeds
      let conf: Summary | null = null;
      if (bestConfirm) {
        report(round, `confirming ${opts[bi].label}`);
        [conf] = await run([opts[bi].net], confirm);
        if (conf.score <= bestConfirm.score + margin(bestConfirm) / 2) { report(round, `not confirmed: ${opts[bi].label}`); continue; }
      }
      net = opts[bi].net; best = results[bi]; bestConfirm = conf ?? bestConfirm; improved = true;
      compiled = compile(net);
      report(round, `kept ${opts[bi].label}`);
    }
    if (!improved) break;
  }

  total = evaluations + 2;
  report(rounds, "Checking the result on fresh seeds");
  const [cb, cn] = await run([original, net], cfg.holdoutSeeds);
  const better = cn.perSeed.filter((s, i) => s > cb.perSeed[i]).length;
  const changes = describeChanges(original, net, cfg.nodes);
  // nothing changed: hand back the plan as it was (no needless switch to custom phases)
  return { network: changes.length ? net : original, changes, baseline: baseline!, best: best!, check: { baseline: cb, best: cn, better, of: cfg.holdoutSeeds.length }, evaluations };
}
