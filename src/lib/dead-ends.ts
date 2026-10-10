/**
 * Dead ends with a turnaround: a lane whose only ways on are U-turns back along the same street (a lane of its road, or
 * of a road of the same name drawn the other way) starting within 15 m of its end (Bob's test, T134, corrected: a sharp
 * turn onto another street heading back isn't one; real dead-end streets, kept so, the user's choice). The map and the 3D view draw a
 * turning circle there, a disc of road a little wider than the U-turn's loop, under it; nothing in the plan or the
 * cars changes. Framework-free.
 */
import { connectorPts, contentsOf, dist, laneById, laneLength, pointAt, type Pt, type Sketch } from "./lane-sketch";

export interface DeadEnd {
  /** the lane coming in, the U-turn connectors off its end and the lanes they go onto */
  lane: string; uturns: string[]; to: string[];
  /** the junction the U-turn is on, if any */
  junction: string | null;
  /** the turning circle: its middle and radius (m), and its level */
  c: Pt; r: number; level: number;
}

/** a U-turn's way back starts within this of the lane's end (m) */
const NEAR = 15;
/** the circle's edge this far out from the U-turn's middle line (m), past half a lane */
const MARGIN = 0.75;

const kept = new WeakMap<Sketch["connectors"], { lanes: Sketch["lanes"]; found: DeadEnd[] }>();

/** the dead ends with a turnaround, each with its turning circle */
export function deadEndTurnarounds(sk: Sketch): DeadEnd[] {
  const was = kept.get(sk.connectors);
  if (was && was.lanes === sk.lanes) return was.found;
  const outs = new Map<string, Sketch["connectors"]>();
  for (const c of sk.connectors) (outs.get(c.from.lane) ?? outs.set(c.from.lane, []).get(c.from.lane)!).push(c);
  const roadOf = new Map(sk.roads.flatMap(r => r.lanes.map(id => [id, r] as const)));
  /** lanes `a` and `b` on the same street: one road, or roads of the same name */
  const same = (a: string, b: string) => { const x = roadOf.get(a), y = roadOf.get(b); return !!x && !!y && (x === y || (!!x.name && x.name === y.name)); };
  const found: DeadEnd[] = [];
  for (const l of sk.lanes) {
    const os = outs.get(l.id);
    if (!os?.length) continue;
    const L = laneLength(l.shape), end = pointAt(l.shape, L);
    const back = os.every(c => {
      const t = laneById(sk, c.to.lane);
      if (!t || c.from.s <= L - 1 || !same(l.id, t.id)) return false;
      const q = pointAt(t.shape, c.to.s);
      return dist(q.p, end.p) < NEAR && end.d.x * q.d.x + end.d.y * q.d.y < -0.5;
    });
    if (!back) continue;
    // (the circle round the U-turns' loops and the lane ends they join: its middle the middle of them all, out past the widest)
    const pts: Pt[] = [end.p];
    for (const c of os) pts.push(...(connectorPts(sk, c) ?? []));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, w = Math.max(l.width, ...os.map(o => laneById(sk, o.to.lane)?.width ?? l.width));
    const r = Math.max(...pts.map(p => dist(p, c))) + w / 2 + MARGIN;
    found.push({ lane: l.id, uturns: os.map(o => o.id), to: os.map(o => o.to.lane), junction: null, c, r, level: l.level ?? 0 });
  }
  if (found.length) {
    const cs = contentsOf(sk);
    for (const f of found) f.junction = sk.junctions.find(j => cs.get(j.id)?.connectors.includes(f.uturns[0]))?.id ?? null;
  }
  kept.set(sk.connectors, { lanes: sk.lanes, found });
  return found;
}

/** a circle as a polygon of `n` points */
export function circlePts(c: Pt, r: number, n = 32): Pt[] {
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((i / n) * 2 * Math.PI), y: c.y + r * Math.sin((i / n) * 2 * Math.PI) }));
}
