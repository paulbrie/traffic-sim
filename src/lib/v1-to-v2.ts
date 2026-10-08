/**
 * A V1 plan's network as a V2 lane sketch (framework-free; runs on the server): the network compiled
 * as the V1 simulation sees it, then
 *  - every lane of every road a sketch lane along its centreline, as wide; each road a sketch road;
 *  - every lane-to-lane path through a junction, or past a plain road point, a connector along it;
 *  - each junction an automatic junction round its connectors;
 *  - a roundabout's circulating lane(s) a ring lane, with entry and exit connectors;
 *  - signs on the lanes they stand at (all-way stop: every way in), traffic lights with the junction's
 *    phases (green per connector, from the lanes green in each phase) and timings;
 *  - where the plan is on Earth.
 * Buildings, bus lines, crossings, parking and demand stay behind (see docs/v2-porting.md).
 */
import { compile, exitLanesOf, laneAllowed, type Compiled, type Edge } from "@/engine/compile";
import type { Poly } from "@/engine/geom";
import type { Network } from "@/engine/types";
import {
  emptySketch, nearestOn, surfaceAround,
  type JunctionLights, type LaneControl, type LightsPhase, type Pt, type Sketch, type SketchConnector, type SketchJunction, type SketchLane, type SketchRoad,
} from "./lane-sketch";

const r2 = (x: number) => Math.round(x * 100) / 100;
const polyPts = (p: Poly): Pt[] => { const out: Pt[] = []; for (let i = 0; i < p.pts.length; i += 2) out.push({ x: p.pts[i], y: p.pts[i + 1] }); return out; };

/** a polyline with the points it doesn't need left out (Douglas-Peucker, within `tol` metres) */
function simplify(pts: Pt[], tol = 0.05): Pt[] {
  if (pts.length <= 2) return pts.map(p => ({ x: r2(p.x), y: r2(p.y) }));
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!, A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
    let best = -1, bd = tol;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L; if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]).map(p => ({ x: r2(p.x), y: r2(p.y) }));
}
/** a few points along a path to bend a connector through (none for a short or straight one) */
function bends(pts: Pt[]): Pt[] {
  let L = 0;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) { L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); cum.push(L); }
  const a = pts[0], b = pts[pts.length - 1], chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (L < 6 || L - chord < 0.05) return [];
  const n = Math.min(5, Math.max(1, Math.round(L / 8))), out: Pt[] = [];
  for (let k = 1; k <= n; k++) {
    const s = (L * k) / (n + 1);
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    out.push({ x: r2(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t), y: r2(pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t) });
  }
  return out;
}

export interface ConvertReport { lanes: number; connectors: number; roads: number; junctions: number; roundabouts: number; lights: number; signs: number; skipped: string[] }

export function networkToSketch(net: Network): { sketch: Sketch; report: ConvertReport } {
  const c: Compiled = compile(net, { outlines: false });
  const sk = emptySketch(), skipped: string[] = [];
  let ln = 0, cn = 0, rn = 0, jn = 0;
  const laneId = new Map<string, string>(), laneLen = new Map<string, number>();
  const key = (e: Edge, k: number) => `${e.idx}:${k}`;

  // lanes and roads
  const byLink = new Map<string, SketchRoad>();
  for (const e of c.edges) for (const lp of e.lanes) {
    const id = `l${++ln}`, pts = simplify(polyPts(lp.poly));
    if (pts.length < 2 || lp.len < 0.5) continue;
    const lane: SketchLane = { id, shape: { kind: "line", pts }, width: r2(e.lw) };
    sk.lanes.push(lane);
    laneId.set(key(e, lp.lane), id); laneLen.set(id, lp.len);
    const road = byLink.get(e.link.id) ?? { id: `r${++rn}`, name: e.link.name || `Road ${rn}`, lanes: [] };
    road.lanes.push(id);
    byLink.set(e.link.id, road);
  }
  sk.roads = [...byLink.values()];
  const laneShape = (id: string) => sk.lanes.find(l => l.id === id)!.shape;

  const conn = (from: string, fs: number, to: string, ts: number, path: Pt[]): SketchConnector => {
    const via = bends(path), cnx: SketchConnector = { id: `c${++cn}`, from: { lane: from, s: r2(fs) }, to: { lane: to, s: r2(ts) }, ...(via.length ? { via } : {}) };
    sk.connectors.push(cnx);
    return cnx;
  };
  let roundabouts = 0, lights = 0, signs = 0;

  for (const n of c.nodes) {
    const made: SketchConnector[] = [], extra: Pt[] = [];
    // (the lanes green in each phase of its lights, as connectors)
    const phaseOf = new Map<SketchConnector, number[]>();
    if (n.ringR > 0 && n.ring) {
      // a roundabout: its circulating lane(s) a ring lane each, joined and left by connectors
      roundabouts++;
      const rings = [n.ring, n.ring2].filter((r): r is NonNullable<typeof r> => !!r);
      const ringIds: string[] = [];
      for (const ring of rings) {
        const m = ring.length, seq = [ring[m - 1].between];
        for (let k = m - 2; k >= 0; k--) seq.push(ring[k].pass, ring[k].between);
        seq.push(ring[m - 1].pass);
        const pts: Pt[] = [];
        for (const p of seq) for (const q of polyPts(p.poly)) if (!pts.length || Math.hypot(q.x - pts[pts.length - 1].x, q.y - pts[pts.length - 1].y) > 0.05) pts.push(q);
        if (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.5) pts.pop();
        const id = `l${++ln}`, s = simplify(pts, 0.1);
        sk.lanes.push({ id, shape: { kind: "line", pts: s, closed: true }, width: 4.5 });
        ringIds.push(id); extra.push(...s);
      }
      const at = (ring: string, p: Pt) => nearestOn(laneShape(ring), p).s;
      const seen = new Set<string>();
      for (const list of n.moves.values()) for (const mv of list) for (let a = mv.lo; a <= mv.hi; a++) {
        if (!laneAllowed(mv, a)) continue;
        for (const b of exitLanesOf(mv, a)) {
          const pieces = c.crossing(mv, a, b), entry = pieces[0], exit = pieces[pieces.length - 1];
          if (entry.kind !== "conn" || exit.kind !== "conn") continue;
          const ring = ringIds[entry.ringLane ?? 0] ?? ringIds[0], from = laneId.get(key(mv.in, a)), to = laneId.get(key(mv.out, b));
          if (!from || !to) continue;
          const ep = polyPts(entry.poly), xp = polyPts(exit.poly);
          const k1 = `${from}>${ring}`, k2 = `${ring}>${to}`;
          if (!seen.has(k1)) { seen.add(k1); made.push(conn(from, laneLen.get(from)!, ring, at(ring, ep[ep.length - 1]), ep)); }
          if (!seen.has(k2)) { seen.add(k2); made.push(conn(ring, at(ring, xp[0]), to, 0, xp)); }
        }
      }
    } else {
      // every lane-to-lane path: through a junction, or on past a plain road point
      for (const list of n.moves.values()) for (const mv of list) for (let a = mv.lo; a <= mv.hi; a++) {
        if (!laneAllowed(mv, a)) continue;
        for (const b of exitLanesOf(mv, a)) {
          const from = laneId.get(key(mv.in, a)), to = laneId.get(key(mv.out, b));
          if (!from || !to) continue;
          const x = conn(from, laneLen.get(from)!, to, 0, polyPts(c.getConn(mv, a, b).poly));
          made.push(x);
          if (n.def.control === "lights" && n.controlled) phaseOf.set(x, n.lanePhases[mv.in.inArm]?.[a] ?? []);
        }
      }
    }
    // (a plain road point: its connectors, no junction)
    if ((!n.controlled && !(n.ringR > 0)) || !made.length) continue;
    // the junction: automatic, round what is on it
    const pts = [...extra];
    for (const x of made) {
      const a = laneShape(x.from.lane), b = laneShape(x.to.lane);
      if (a.kind === "line") pts.push(a.pts[a.pts.length - 1]);
      if (b.kind === "line") pts.push(b.pts[0]);
      pts.push(...(x.via ?? []));
    }
    const outline = surfaceAround(pts, 3);
    if (outline.length < 3) continue;
    const j: SketchJunction = { id: `j${++jn}`, name: `Junction ${jn}`, outline, shape: "auto" };
    // its control: lights, an all-way stop, or signs on the ways in
    const ctl = n.def.control;
    if (ctl === "lights" && n.phases.length) {
      lights++;
      const t = n.def.signal;
      const phases: LightsPhase[] = n.phases.map((_, p) => ({
        name: `Phase ${p + 1}`, green: Math.max(3, Math.round(n.phaseGreen[p] ?? t.green)), minGreen: Math.max(1, Math.round(n.phaseMinGreen[p] ?? t.minGreen)),
        conns: made.filter(x => phaseOf.get(x)?.includes(p)).map(x => x.id),
      }));
      const L: JunctionLights = { green: t.green, amber: t.yellow, allRed: t.allRed, mode: t.separate ? "each" : "pairs", minGreen: t.minGreen, actuated: t.actuated, phases };
      j.lights = L;
    } else {
      const sign = (e: Edge): LaneControl | null => (ctl === "stop" ? "stop" : ctl === "priority" ? e.sign ?? null : null);
      for (const x of made) {
        const e = c.edges.find(ed => ed.lanes.some(lp => laneId.get(key(ed, lp.lane)) === x.from.lane));
        const s = e && sign(e), lane = sk.lanes.find(l => l.id === x.from.lane);
        if (s && lane && !lane.control) { lane.control = s; signs++; }
      }
    }
    if (n.def.control === "free") skipped.push(`${j.name}: free-flowing (no control) kept as a plain junction`);
    sk.junctions.push(j);
  }
  if (net.geo) sk.geo = { lat: net.geo.lat, lon: net.geo.lon };
  if (net.stops.length) skipped.push(`${net.stops.length} bus stops (and ${net.lines.length} lines): not in V2 yet`);
  if (net.buildings?.length) skipped.push(`${net.buildings.length} buildings: not in V2 yet`);
  return { sketch: sk, report: { lanes: sk.lanes.length, connectors: sk.connectors.length, roads: sk.roads.length, junctions: sk.junctions.length, roundabouts, lights, signs, skipped } };
}
