/**
 * The plan run headless in the V2 simulation (the app's own SketchSim) on a demand matrix, and each way's mean speed
 * (a road one way, as traffic-history.ts's `waysOf` splits them, the ways TomTom's recordings are kept by): distance
 * driven over time spent on its lanes, by every car, after the warm-up (ticket #321). Framework-free.
 */
import { demandWays, type DemandMatrix, type Sketch } from "../../lane-sketch";
import { SketchSim } from "../../lane-sketch-sim";
import { waysOf, type Way } from "../../traffic-history";

export interface RunOpts { seed: number; warmupMin: number; measureMin: number; dt?: number }
export interface WayStat { id: string; km: number; hours: number; kmh: number | null; cars: number }
export interface RunOut {
  ways: Map<string, WayStat>;
  /** trips finished an hour, their mean time (s), cars still on the map at the end, collisions, deadlocks broken */
  trips: number; tripTime: number; onMap: number; collisions: number; deadlocks: number;
  /** cars waiting to get in at the end (the ways in blocked back) */
  waiting: number;
  /** cars counted on each way, by the way in they came from and by the way out they were going to (matrix keys): who uses what */
  byIn: Record<string, Record<string, number>>; byOut: Record<string, Record<string, number>>;
  /** vehicle-km and vehicle-hours an hour on the roads in `area` (if given) */
  areaKm: number; areaHours: number; areaDelay: number;
  ms: number;
}

/** the sketch with `m` the demand in use (all the traffic coming in), journeys off, results counted after `warmupMin` */
export function withMatrix(sk: Sketch, m: DemandMatrix, warmupMin: number): Sketch {
  return { ...sk, matrices: [m], matrixOn: m.id, journeys: [], traffic: { ...(sk.traffic ?? { rate: 0, speed: 50 }), warmup: warmupMin } };
}

export function run(sk: Sketch, o: RunOpts, area?: Set<string>): RunOut {
  const t0 = Date.now(), dt = o.dt ?? 0.1;
  const sim = new SketchSim(sk, { rate: 0, speed: sk.traffic?.speed ?? 50, seed: o.seed, ...(sk.traffic?.tune ? { tune: sk.traffic.tune } : {}) }, o.seed);
  const nr: unknown[] = []; nr.push = () => 0; (sim as unknown as { replay: unknown[] }).replay = nr;
  const ways = waysOf(sk), wayOfLane = new Map<string, Way>();
  for (const w of ways) for (const l of w.lanes) wayOfLane.set(l, w);
  const acc = new Map<string, { m: number; s: number; cars: Set<number> }>(ways.map(w => [w.id, { m: 0, s: 0, cars: new Set<number>() }]));
  const W = o.warmupMin * 60, T = W + o.measureMin * 60;
  // (each car's lane and place a step before: the distance it drove on that lane since)
  const last = new Map<number, { lane: string; pos: number }>();
  // (each car's way in, from the lane it was first seen on, and the ways it has been counted on)
  const inKey = new Map<string, string>(), outKey = new Map<string, string>();
  { const w = demandWays(sk); for (const e of w.entries) for (const l of e.lanes) inKey.set(l, e.lanes[0]); for (const e of w.exits) for (const l of e.lanes) outKey.set(l, e.lanes[0]); }
  const carIn = new Map<number, string>(), carWays = new Map<number, Set<string>>();
  const byIn: Record<string, Record<string, number>> = {}, byOut: Record<string, Record<string, number>> = {};
  let k = 0;
  while (sim.t < T - 1e-9) {
    sim.step(dt);
    if (++k % 5) continue; // (every 0.5 s)
    const counting = sim.t > W;
    const seen = new Set<number>();
    for (const v of sim.vehicles) {
      seen.add(v.id);
      if (!carIn.has(v.id)) carIn.set(v.id, v.edge.kind === "lane" ? inKey.get(v.edge.id) ?? "" : "");
      if (v.edge.kind !== "lane") { last.delete(v.id); continue; }
      const w = wayOfLane.get(v.edge.id);
      if (counting && w) {
        const ws = carWays.get(v.id) ?? carWays.set(v.id, new Set()).get(v.id)!;
        if (!ws.has(w.id)) {
          ws.add(w.id);
          const i = carIn.get(v.id), o = v.dest ? outKey.get(v.dest) : undefined;
          if (i) (byIn[i] ??= {})[w.id] = ((byIn[i] ??= {})[w.id] ?? 0) + 1;
          if (o) (byOut[o] ??= {})[w.id] = ((byOut[o] ??= {})[w.id] ?? 0) + 1;
        }
      }
      const was = last.get(v.id);
      if (counting && w) {
        const a = acc.get(w.id)!;
        a.s += 5 * dt;
        if (was && was.lane === v.edge.id && v.pos >= was.pos) a.m += v.pos - was.pos;
        a.cars.add(v.id);
      }
      last.set(v.id, { lane: v.edge.id, pos: v.pos });
    }
    for (const id of last.keys()) if (!seen.has(id)) last.delete(id);
    for (const id of carIn.keys()) if (!seen.has(id)) { carIn.delete(id); carWays.delete(id); }
  }
  const res = sim.results(), st = sim.stats(), h = o.measureMin / 60;
  const out = new Map<string, WayStat>();
  for (const w of ways) {
    const a = acc.get(w.id)!;
    out.set(w.id, { id: w.id, km: a.m / 1000 / h, hours: a.s / 3600 / h, kmh: a.s > 30 ? (a.m / a.s) * 3.6 : null, cars: a.cars.size / h });
  }
  const all = res.od.reduce((x, r) => x + r.n, 0), allT = res.od.reduce((x, r) => x + r.sum, 0);
  const inArea = area ? res.roads.filter(r => area.has(r.id)) : [];
  return {
    ways: out, byIn, byOut, trips: all / h, tripTime: all ? allT / all : 0, onMap: sim.vehicles.length, collisions: res.totals.collisions, deadlocks: res.totals.deadlocks,
    waiting: st.waiting,
    areaKm: inArea.reduce((x, r) => x + r.vehKm, 0) / h, areaHours: inArea.reduce((x, r) => x + r.vehHours, 0) / h, areaDelay: inArea.reduce((x, r) => x + r.delay, 0) / 3600 / h,
    ms: Date.now() - t0,
  };
}

/** the ways in and out (by a lane of each, as matrices name them) */
export function demandEnds(sk: Sketch) {
  const w = demandWays(sk);
  return { ins: w.entries.map(e => ({ key: e.lanes[0], name: e.name, lanes: e.lanes, at: e.at })), outs: w.exits.map(e => ({ key: e.lanes[0], name: e.name, lanes: e.lanes, at: e.at })) };
}
