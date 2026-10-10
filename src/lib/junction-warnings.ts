/**
 * What in a sketch's drawing makes its junctions work badly (T161), for the editor to show: a lane or connector across a
 * roundabout's middle, a way onto a ring with no give-way line, a two-lane way onto a ring whose lanes join it at different
 * places, a connector (or a lane in no road) crossing three paths or more, a lane on a junction with no way in or no way out (cars
 * appear or vanish there). Framework-free.
 */
import { connectorPts, contentsOf, laneLength, samples, type Pt, type Sketch, type SketchLane } from "./lane-sketch";

export type JunctionWarningKind = "across-ring" | "entry-no-give-way" | "entry-two-places" | "crosses-many" | "no-way-in" | "no-way-out";
/** one warning: what kind, on which junction (null: on none), the lanes and connectors it is about (ids), the words */
export interface JunctionWarning { kind: JunctionWarningKind; junction: string | null; items: string[]; text: string }

/** a lane drawn as a whole circle (a roundabout's ring): its middle, and how far out a path is in among it (its outer edge, less 1 m) */
function ringOf(l: SketchLane): { c: Pt; inner: number } | null {
  const s = l.shape as { kind: string; c?: Pt; r?: number; sweep?: number };
  if (s.kind !== "arc" || !s.c || !s.r || Math.abs(Math.abs(s.sweep ?? 0) - 2 * Math.PI) > 0.01) return null;
  return { c: s.c, inner: s.r + l.width / 2 - 1 };
}

/** do segments a–b and c–d cross (not just touch at an end)? */
function cross(a: Pt, b: Pt, c: Pt, d: Pt) {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return d1 * d2 < -1e-9 && d3 * d4 < -1e-9;
}
const crosses = (P: Pt[], Q: Pt[]) => { for (let i = 1; i < P.length; i++) for (let j = 1; j < Q.length; j++) if (cross(P[i - 1], P[i], Q[j - 1], Q[j])) return true; return false; };
const box = (P: Pt[]) => P.reduce((b, p) => ({ x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

/** the sketch's junction warnings, by junction, worst first */
export function junctionWarnings(sk: Sketch): JunctionWarning[] {
  const out: JunctionWarning[] = [];
  const cs = contentsOf(sk), onJ = new Map<string, string>();
  for (const j of sk.junctions) for (const id of [...(cs.get(j.id)?.connectors ?? []), ...(cs.get(j.id)?.lanes ?? [])]) onJ.set(id, j.id);
  const inRoad = new Set(sk.roads.flatMap(r => r.lanes)), roadOf = new Map(sk.roads.flatMap(r => r.lanes.map(id => [id, r.id] as const)));
  const lanes = new Map(sk.lanes.map(l => [l.id, l]));
  const pathOf = new Map<string, Pt[]>();
  for (const l of sk.lanes) pathOf.set(l.id, samples(l.shape, 1));
  for (const c of sk.connectors) { const p = connectorPts(sk, c); if (p) pathOf.set(c.id, p); }
  const rings = sk.lanes.flatMap(l => { const r = ringOf(l); return r ? [{ id: l.id, ...r }] : []; });
  const ringIds = new Set(rings.map(r => r.id));
  const name = (id: string) => (lanes.has(id) ? `lane ${id}` : `connector ${id}`);

  // across a roundabout's middle: in among a ring (inside its outer edge by a metre), joined by neither end to it or to a ring
  // round the same middle (a two-lane roundabout's other ring); nor a lane leading onto or off it (a way in drawn into the ring)
  const connById = new Map(sk.connectors.map(c => [c.id, c]));
  const sameMiddle = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < 1;
  for (const R of rings) {
    const group = new Set(rings.filter(o => sameMiddle(o.c, R.c)).map(o => o.id)), hits: string[] = [];
    const arm = new Set(sk.connectors.flatMap(c => (group.has(c.to.lane) ? [c.from.lane] : group.has(c.from.lane) ? [c.to.lane] : [])));
    for (const [id, P] of pathOf) {
      if (group.has(id) || arm.has(id)) continue;
      const c = connById.get(id);
      if (c && (group.has(c.from.lane) || group.has(c.to.lane))) continue;
      if (P.some(p => Math.hypot(p.x - R.c.x, p.y - R.c.y) < R.inner)) hits.push(id);
    }
    if (hits.length) out.push({ kind: "across-ring", junction: onJ.get(R.id) ?? onJ.get(hits[0]) ?? null, items: [R.id, ...hits], text: `${hits.map(name).join(", ")} ${hits.length === 1 ? "crosses" : "cross"} the middle of the roundabout (ring ${R.id}): cars there cut across the ring and block its exits` });
  }
  // ways onto a ring: a give-way line, and two lanes of one road joining at one place
  const onto = new Map<string, typeof sk.connectors>();
  for (const c of sk.connectors) if (ringIds.has(c.to.lane)) (onto.get(c.to.lane) ?? onto.set(c.to.lane, []).get(c.to.lane)!).push(c);
  for (const [ring, cs2] of onto) {
    for (const c of cs2) {
      const from = lanes.get(c.from.lane);
      if (from && !ringIds.has(from.id) && !from.control) out.push({ kind: "entry-no-give-way", junction: onJ.get(c.id) ?? null, items: [from.id, c.id], text: `the way onto the roundabout from lane ${from.id} has no give-way line` });
    }
    const byRoad = new Map<string, typeof cs2>();
    for (const c of cs2) { const r = roadOf.get(c.from.lane); if (r) (byRoad.get(r) ?? byRoad.set(r, []).get(r)!).push(c); }
    for (const [road, list] of byRoad) {
      const from = new Set(list.map(c => c.from.lane));
      if (from.size < 2) continue;
      const ss = list.map(c => c.to.s), spread = Math.max(...ss) - Math.min(...ss);
      if (spread > 1) out.push({ kind: "entry-two-places", junction: onJ.get(list[0].id) ?? null, items: list.map(c => c.id), text: `road ${road}'s ${from.size} lanes join the one-lane ring ${ring} at places ${spread.toFixed(1)} m apart, not at one merge point: they cross each other there` });
    }
  }
  // crossing many paths on a junction: a lane in no road drawn through it, crossing three or more; a long connector (30 m or more),
  // five or more (a left turn at a crossroads crosses three or four: that is a junction's ordinary work)
  const byJ = new Map<string, { id: string; P: Pt[]; b: ReturnType<typeof box>; conn: typeof sk.connectors[number] | null }[]>();
  for (const [id, P] of pathOf) { const j = onJ.get(id); if (j) (byJ.get(j) ?? byJ.set(j, []).get(j)!).push({ id, P, b: box(P), conn: connById.get(id) ?? null }); }
  for (const items of byJ.values()) for (const A of items) {
    if (!A.conn && (inRoad.has(A.id) || ringIds.has(A.id))) continue;
    const long = A.conn ? A.P.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - A.P[i].x, p.y - A.P[i].y), 0) >= 30 : true;
    if (!long) continue;
    const ends = A.conn ? new Set([A.conn.from.lane, A.conn.to.lane]) : new Set<string>();
    const hit: string[] = [];
    for (const B of items) {
      if (B.id === A.id || ends.has(B.id) || B.b.x0 > A.b.x1 || B.b.x1 < A.b.x0 || B.b.y0 > A.b.y1 || B.b.y1 < A.b.y0) continue;
      // (connectors sharing a lane at either end fan out from or into it: not a crossing)
      if (A.conn && B.conn && (A.conn.from.lane === B.conn.from.lane || A.conn.to.lane === B.conn.to.lane)) continue;
      if (crosses(A.P, B.P)) hit.push(B.id);
    }
    if (hit.length >= (A.conn ? 5 : 3)) out.push({ kind: "crosses-many", junction: onJ.get(A.id) ?? null, items: [A.id, ...hit], text: `${name(A.id)} crosses ${hit.length} other paths (${hit.slice(0, 6).join(", ")}${hit.length > 6 ? "…" : ""}): one waiting on it blocks them` });
  }
  // a lane on a junction with no way in, or no way out
  const ins = new Set(sk.connectors.map(c => c.to.lane)), outs = new Set(sk.connectors.map(c => c.from.lane));
  for (const l of sk.lanes) {
    const j = onJ.get(l.id);
    if (!j || inRoad.has(l.id) || ringIds.has(l.id) || laneLength(l.shape) < 1) continue;
    if (!ins.has(l.id)) out.push({ kind: "no-way-in", junction: j, items: [l.id], text: `lane ${l.id} on the junction has no way in: cars appear on it out of nowhere` });
    if (!outs.has(l.id)) out.push({ kind: "no-way-out", junction: j, items: [l.id], text: `lane ${l.id} on the junction has no way out: cars on it vanish at its end` });
  }
  const rank: Record<JunctionWarningKind, number> = { "across-ring": 0, "no-way-in": 1, "no-way-out": 1, "crosses-many": 2, "entry-two-places": 3, "entry-no-give-way": 4 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.junction ?? "").localeCompare(b.junction ?? ""));
}
