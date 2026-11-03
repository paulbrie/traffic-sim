/**
 * A run's results, saved to compare variants of a sketch (ticket #124): what the simulation counted over the time measured
 * (from the warm-up's end: the sketch's `traffic.warmup`), per junction (and per lane into and out of it), per road, per trip
 * from a way in to a way out, and in all; with what it was a run of (the sketch, its demand, its settings) and the names to
 * read it by, as they were then. Compared by id, else by name: a variant made by duplicating keeps its ids. Framework-free.
 */
import type { JunctionSeries } from "./lane-sketch-sim";
import { demandWays, type Sketch } from "./lane-sketch";
import { demandMode, periodText, startClock } from "./demand-matrix";

/** what the simulation hands over (SketchSim.results) */
export interface SimResultData {
  v: 1;
  /** seconds simulated in all, and when the counting began (s): the warm-up's end */
  t: number; from: number;
  totals: { in: number; out: number; collisions: number; deadlocks: number; stuck: number; pedsCrossed: number; fuel: number; co2: number; vehKm: number; vehHours: number };
  /** per junction: vehicles through it, their delay in all (s), its queue (mean over the time measured, longest), fuel (l),
   * metres driven and seconds spent inside it, and vehicles in from each lane and out onto each */
  junctions: { id: string; through: number; delay: number; queueMean: number; queueMax: number; fuel: number; dist: number; time: number; ins: Record<string, number>; outs: Record<string, number> }[];
  roads: { id: string; through: number; vehKm: number; vehHours: number; delay: number; queueMax: number; lanes: Record<string, number> }[];
  /** trips ended, by the lane they came in on and the one they went out by: how many, their time in all and the longest (s) */
  od: { from: string; to: string; n: number; sum: number; max: number }[];
  /** (asked for) each junction's flows every 5 s (sketches of 24 junctions at most) */
  series?: JunctionSeries[];
}

/** what a result was a run of, and the names to read it by (as they were) */
export interface SimResultMeta {
  sketch: { id: string; name: string }; revision: number;
  /** the demand: each way's rate and share, a matrix (its name), or matrices by the time of day; journeys on top */
  demand: string;
  /** the time of day the run began (minutes after midnight) */
  clock: number;
  params: { speed: number; seed?: number; tune?: Record<string, number> };
  names: { junctions: Record<string, string>; roads: Record<string, string>; lanes: Record<string, string> };
  /** the trips' ways: each lane's way in or out (its key and name) */
  ways: { in: Record<string, { key: string; name: string }>; out: Record<string, { key: string; name: string }> };
}

/** a saved result as listed (its data apart: fetched to compare) */
export interface SimResultInfo { id: string; name: string; createdAt: string; by: string; sketch: string; seconds: number; series: boolean; bytes: number }
export interface SimResult extends SimResultInfo { meta: SimResultMeta; data: SimResultData }

/** the most results a plan keeps, and the most bytes one may take */
export const MAX_RESULTS = 200, MAX_RESULT_BYTES = 4_000_000;

// ---------------------------------------------------------------- comparing results

/** a measure compared: its label and unit, and which way is better (more through, less delay; null: neither) */
export interface CompareMetric { key: string; label: string; unit: string; better: "higher" | "lower" | null }
/** a row compared: what it is (`parent`: the junction a lane row is of), and each result's values (null: not in that result) */
export interface CompareRow { key: string; name: string; parent?: string; values: (number[] | null)[] }
export interface CompareSection { id: "totals" | "junctions" | "trips" | "roads"; title: string; metrics: CompareMetric[]; rows: CompareRow[] }

const hoursOf = (r: SimResult) => Math.max(1 / 3600, (r.data.t - r.data.from) / 3600);
const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
const round = (x: number, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Rows of several results put side by side: by key (an id), and those found in some results only, under another key in the others,
 * by their name (a junction rebuilt, a road redrawn) when the results they are in don't overlap
 */
function side(n: number, each: (i: number) => { key: string; name: string; parent?: string; values: number[] }[]): CompareRow[] {
  const rows = new Map<string, CompareRow>();
  for (let i = 0; i < n; i++) for (const x of each(i)) {
    const row = rows.get(x.key) ?? rows.set(x.key, { key: x.key, name: x.name, ...(x.parent ? { parent: x.parent } : {}), values: Array(n).fill(null) }).get(x.key)!;
    row.values[i] = x.values;
  }
  const all = [...rows.values()], out: CompareRow[] = [];
  const has = (r: CompareRow) => r.values.map(v => v !== null);
  for (const r of all) {
    if (out.includes(r)) continue;
    // (a row of some results only: one of the same name (and parent) in the others only, taken in)
    const mine = has(r);
    if (mine.some(x => !x)) for (const o of all) {
      if (o === r || out.includes(o) || o.name !== r.name || o.parent !== r.parent) continue;
      const theirs = has(o);
      if (theirs.some((x, i) => x && mine[i])) continue;
      o.values.forEach((v, i) => { if (v) { r.values[i] = v; mine[i] = true; } });
      o.values = o.values.map(() => null);
    }
    out.push(r);
  }
  return out.filter(r => r.values.some(v => v !== null));
}

/** results side by side: in all, per junction (and its lanes in and out), per trip from a way in to a way out, per road */
export function compareResults(rs: SimResult[]): CompareSection[] {
  const n = rs.length, h = rs.map(hoursOf);
  const totals: CompareSection = {
    id: "totals", title: "In all",
    metrics: [
      { key: "in", label: "In", unit: "veh/h", better: "higher" }, { key: "out", label: "Out", unit: "veh/h", better: "higher" },
      { key: "speed", label: "Mean speed", unit: "km/h", better: "higher" }, { key: "fuel", label: "Fuel", unit: "l/h", better: "lower" },
      { key: "co2", label: "CO₂", unit: "kg/h", better: "lower" }, { key: "collisions", label: "Collisions", unit: "", better: "lower" },
      { key: "deadlocks", label: "Deadlocks broken", unit: "", better: "lower" }, { key: "stuck", label: "Stuck at the end", unit: "", better: "lower" },
      { key: "peds", label: "Pedestrians across", unit: "/h", better: "higher" },
    ],
    rows: [{ key: "all", name: "The sketch", values: rs.map((r, i) => {
      const t = r.data.totals;
      return [round(t.in / h[i]), round(t.out / h[i]), round(t.vehHours > 0 ? t.vehKm / t.vehHours : 0), round(t.fuel / h[i], 2), round(t.co2 / h[i], 2), t.collisions, t.deadlocks, t.stuck, round(t.pedsCrossed / h[i])];
    }) }],
  };
  const junctions: CompareSection = {
    id: "junctions", title: "Junctions (and their lanes in and out)",
    metrics: [
      { key: "flow", label: "Through", unit: "veh/h", better: "higher" }, { key: "delay", label: "Delay", unit: "s/veh", better: "lower" },
      { key: "queue", label: "Queue", unit: "veh (mean)", better: "lower" }, { key: "queueMax", label: "Longest queue", unit: "veh", better: "lower" },
    ],
    rows: side(n, i => {
      const r = rs[i], name = (id: string) => r.meta.names.junctions[id] ?? id, lane = (id: string) => r.meta.names.lanes[id] ? `${r.meta.names.lanes[id]} · ${id}` : id;
      return r.data.junctions.flatMap(j => {
        const ins = sum(j.ins);
        return [
          { key: j.id, name: name(j.id), values: [round(ins / h[i]), round(ins > 0 ? j.delay / ins : 0), round(j.queueMean), j.queueMax] },
          ...Object.entries(j.ins).map(([l, k]) => ({ key: `${j.id}|in|${l}`, name: `in from ${lane(l)}`, parent: j.id, values: [round(k / h[i])] })),
          ...Object.entries(j.outs).map(([l, k]) => ({ key: `${j.id}|out|${l}`, name: `out onto ${lane(l)}`, parent: j.id, values: [round(k / h[i])] })),
        ];
      });
    }),
  };
  const trips: CompareSection = {
    id: "trips", title: "Trips from a way in to a way out",
    metrics: [{ key: "trips", label: "Trips", unit: "/h", better: "higher" }, { key: "mean", label: "Mean time", unit: "s", better: "lower" }, { key: "max", label: "Longest", unit: "s", better: "lower" }],
    rows: side(n, i => {
      const r = rs[i], by = new Map<string, { name: string; n: number; sum: number; max: number }>();
      for (const o of r.data.od) {
        const a = r.meta.ways.in[o.from], b = r.meta.ways.out[o.to], key = `${a?.key ?? `lane:${o.from}`}>${b?.key ?? `lane:${o.to}`}`;
        const x = by.get(key) ?? by.set(key, { name: `${a?.name ?? `lane ${o.from}`} → ${b?.name ?? `lane ${o.to}`}`, n: 0, sum: 0, max: 0 }).get(key)!;
        x.n += o.n; x.sum += o.sum; x.max = Math.max(x.max, o.max);
      }
      return [...by].map(([key, x]) => ({ key, name: x.name, values: [round(x.n / h[i]), round(x.n ? x.sum / x.n : 0), round(x.max)] }));
    }).sort((a, b) => a.name.localeCompare(b.name)),
  };
  const roads: CompareSection = {
    id: "roads", title: "Roads",
    metrics: [{ key: "flow", label: "Through", unit: "veh/h", better: "higher" }, { key: "speed", label: "Mean speed", unit: "km/h", better: "higher" }, { key: "delay", label: "Delay", unit: "s/veh", better: "lower" }, { key: "queueMax", label: "Longest queue", unit: "veh", better: "lower" }],
    rows: side(n, i => rs[i].data.roads.filter(x => x.through > 0).map(x => ({ key: x.id, name: rs[i].meta.names.roads[x.id] ?? x.id, values: [round(x.through / h[i]), round(x.vehHours > 0 ? x.vehKm / x.vehHours : 0), round(x.through ? x.delay / x.through : 0), x.queueMax] }))).sort((a, b) => a.name.localeCompare(b.name)),
  };
  return [totals, junctions, trips, roads];
}

/** the change from the first result (%; null where either is missing or the first is 0) */
export const changeFrom = (first: number | null | undefined, x: number | null | undefined) => (first === null || first === undefined || x === null || x === undefined || first === 0 ? null : ((x - first) / Math.abs(first)) * 100);

/** the comparison as comma-separated text: a row per row, the results' values side by side under their names */
export function comparisonCsv(sections: CompareSection[], names: string[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines: string[] = [];
  for (const s of sections) {
    // (a lane's row: its first measure only, the vehicles through it)
    const ms = s.metrics;
    lines.push([q(s.title), ...names.flatMap(n => ms.map(m => q(`${n}: ${m.label}${m.unit ? ` (${m.unit})` : ""}`)))].join(","));
    for (const r of s.rows) lines.push([q(r.parent ? `  ${r.name}` : r.name), ...r.values.flatMap(v => ms.map((_, k) => (v && v[k] !== undefined ? String(v[k]) : "")))].join(","));
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- what a run was a run of

/** a result's context, as the sketch is now: its name and the plan's revision, its demand and start, the names to read the counts by */
export function resultMeta(sk: Sketch, opts: { sketch: { id: string; name: string }; revision: number; speed: number; seed?: number; tune?: Record<string, number> }): SimResultMeta {
  const mode = demandMode(sk), journeys = sk.journeys?.length ?? 0;
  const demand = (mode.kind === "ways" ? "each way's rate and share" : mode.kind === "matrix" ? `matrix "${mode.matrix.name}"` : `matrices by the time of day (${(sk.matrices ?? []).map(m => `${m.name} ${periodText(m)}`).join(", ")})`) + (journeys ? `, ${journeys} journey${journeys === 1 ? "" : "s"} on top` : "");
  const ways = demandWays(sk);
  return {
    sketch: opts.sketch, revision: opts.revision, demand, clock: startClock(sk),
    params: { speed: opts.speed, ...(opts.seed !== undefined ? { seed: opts.seed } : {}), ...(opts.tune ? { tune: opts.tune } : {}) },
    names: {
      junctions: Object.fromEntries(sk.junctions.map(j => [j.id, j.name])),
      roads: Object.fromEntries(sk.roads.map(r => [r.id, r.name])),
      lanes: Object.fromEntries(sk.roads.flatMap(r => r.lanes.map(l => [l, r.name]))),
    },
    ways: {
      in: Object.fromEntries(ways.entries.flatMap(w => w.lanes.map(l => [l, { key: w.key, name: w.name }]))),
      out: Object.fromEntries(ways.exits.flatMap(w => w.lanes.map(l => [l, { key: w.key, name: w.name }]))),
    },
  };
}
