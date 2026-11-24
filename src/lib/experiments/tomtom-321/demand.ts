/**
 * The demand inferred (ticket #321): a gravity model on the plan's ways in and out. Each way in i sends P_i vehicles an
 * hour, each way out j draws a share A_j of them; a trip from i to j is P_i · A_j / ΣA (over the ways out it may go to:
 * not back out by the road it came in on). Calibrated in scripts/tomtom-321.ts: P and A moved until the simulation slows
 * the roads TomTom shows slowed. Framework-free.
 */
import { demandWays, roadOf, type DemandMatrix, type Sketch } from "../../lane-sketch";

export interface End { key: string; name: string; lanes: string[]; road: string | null; x: number; y: number }
export interface Gravity { P: Record<string, number>; A: Record<string, number> }

export function endsOf(sk: Sketch): { ins: End[]; outs: End[] } {
  const w = demandWays(sk);
  const end = (e: { lanes: string[]; name: string; at: { x: number; y: number } }): End => ({ key: e.lanes[0], name: e.name, lanes: e.lanes, road: roadOf(sk, e.lanes[0])?.id ?? null, x: Math.round(e.at.x), y: Math.round(e.at.y) });
  return { ins: w.entries.map(end), outs: w.exits.map(end) };
}

/** the matrix: vehicles an hour from each way in to each way out (cells under 0.05 left out) */
export function gravityMatrix(sk: Sketch, g: Gravity, id: string, name: string, period?: { start: number; end: number }): DemandMatrix {
  const { ins, outs } = endsOf(sk);
  const od: Record<string, Record<string, number>> = {};
  for (const i of ins) {
    const P = g.P[i.key] ?? 0;
    if (P <= 0) continue;
    const to = outs.filter(o => !(o.road && o.road === i.road));
    const sum = to.reduce((a, o) => a + (g.A[o.key] ?? 0), 0);
    if (sum <= 0) continue;
    const row: Record<string, number> = {};
    for (const o of to) { const v = Math.round(((P * (g.A[o.key] ?? 0)) / sum) * 10) / 10; if (v >= 0.1) row[o.key] = v; }
    od[i.key] = row;
  }
  return { id, name, od, ...(period ? period : {}) };
}

export const totalOf = (g: Gravity) => Object.values(g.P).reduce((a, b) => a + b, 0);
