/**
 * A design run in the V2 simulation (the app's own `SketchSim`, headless) and what came of it (ticket #277): the corridor
 * (trips from the main road's south-west end to its north-east end and back: their mean time, and those still waiting to get
 * in at the end), the centre's traffic (vehicle-km on the roads inside the ring), and the rest of the town (trips, their mean
 * time, cars stuck, deadlocks). Counted after the warm-up, as the Results panel counts.
 */
import { SketchSim } from "../../lane-sketch-sim";
import type { City } from "./city";
import { designSketch, type Design } from "./design";

export interface RunOpts { seed: number; warmupMin: number; measureMin: number }
export const RUN: RunOpts = { seed: 1, warmupMin: 5, measureMin: 20 };

export interface Metrics {
  /** corridor trips finished (both ways), their mean time (s), journey cars still waiting to get in at the end */
  corridorTrips: number; corridorTime: number; corridorWaiting: number;
  /** vehicle-km an hour on the centre's roads */
  centreVehKm: number;
  /** all trips finished an hour, their mean time (s), vehicle-km an hour in all */
  trips: number; tripTime: number; vehKm: number;
  stuck: number; deadlocks: number; collisions: number;
  /** wall-clock ms */
  ms: number;
}

/** a car never let in counts as this long a trip (s) */
export const WAIT_PENALTY = 600;

export function runDesign(city: City, d: Design, o: RunOpts = RUN, onTick?: (t: number) => void): Metrics {
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const b = designSketch(city, d, { seed: o.seed, warmupMin: o.warmupMin });
  if (b.error) throw new Error(b.error);
  const sim = new SketchSim(b.sketch, { rate: 0, speed: 50, seed: o.seed }, o.seed);
  // (no replay kept: it is only for the page, and grows with the run)
  const nr: unknown[] = []; nr.push = () => 0; (sim as unknown as { replay: unknown[] }).replay = nr;
  const T = (o.warmupMin + o.measureMin) * 60;
  let k = 0;
  while (sim.t < T - 1e-9) { sim.step(0.1); if (onTick && ++k % 600 === 0) onTick(sim.t / T); }
  const res = sim.results(), st = sim.stats(), h = o.measureMin / 60;
  // (south-west in to north-east out, and back)
  const C = b.corridor, swIn = new Set(C.swIn), neOut = new Set(C.neOut), neIn = new Set(C.neIn), swOut = new Set(C.swOut);
  let n = 0, sum = 0;
  for (const r of res.od) if ((swIn.has(r.from) && neOut.has(r.to)) || (neIn.has(r.from) && swOut.has(r.to))) { n += r.n; sum += r.sum; }
  const waiting = (st.journeys ?? []).reduce((a, j) => a + j.waiting, 0);
  const centre = new Set(b.centreRoads);
  const all = res.od.reduce((a, r) => a + r.n, 0), allT = res.od.reduce((a, r) => a + r.sum, 0);
  return {
    corridorTrips: n / h, corridorTime: n ? sum / n : WAIT_PENALTY, corridorWaiting: waiting,
    centreVehKm: res.roads.filter(r => centre.has(r.id)).reduce((a, r) => a + r.vehKm, 0) / h,
    trips: all / h, tripTime: all ? allT / all : WAIT_PENALTY, vehKm: res.totals.vehKm / h,
    stuck: res.totals.stuck, deadlocks: res.totals.deadlocks, collisions: res.totals.collisions,
    ms: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0),
  };
}

/** the corridor's time with those never let in counted as WAIT_PENALTY-long trips (s) */
export const corridorEff = (m: Metrics, h = RUN.measureMin / 60) => {
  const n = m.corridorTrips * h;
  return (n * m.corridorTime + m.corridorWaiting * WAIT_PENALTY) / Math.max(1, n + m.corridorWaiting);
};

/**
 * One number to minimise, the status quo's 1: half the corridor's time, half the centre's traffic (each relative to the
 * status quo's), plus penalties where the rest of the town pays for it (trips lost, trips more than 10% longer).
 * Cars stuck at the end are reported, not scored: a count at one moment, it varied as much from seed to seed (sd 0.40 of
 * score) as from design to design (0.49), and took over the score's first version
 */
export function score(m: Metrics, base: Metrics): number {
  const c = corridorEff(m) / corridorEff(base), z = m.centreVehKm / Math.max(1, base.centreVehKm);
  const lost = Math.max(0, (base.trips - m.trips) / base.trips), slower = Math.max(0, m.tripTime / base.tripTime - 1.1);
  return 0.5 * c + 0.5 * z + 2 * lost + 2 * slower;
}

/** the mean of several runs' metrics (other seeds) */
export function meanMetrics(ms: Metrics[]): Metrics {
  const o = { ...ms[0] };
  for (const k of Object.keys(o) as (keyof Metrics)[]) o[k] = ms.reduce((a, m) => a + m[k], 0) / ms.length;
  return o;
}
