/**
 * Lane sketch (an experiment): lanes and connectors drawn freely, lanes grouped into roads, and
 * junctions drawn as surfaces taking in the lanes and connectors on them. Kept in memory only;
 * plain data and geometry, no framework. Coordinates are metres, y down (like the plan).
 *
 * A lane runs the way it was drawn (its direction of travel). Connectors join a place on one lane
 * to a place on another (`s`, metres from the lane's start), so they can leave or join a lane
 * anywhere, a roundabout's ring for instance, and follow the lanes when they move. In between they
 * go through the bend points they were drawn with, if any.
 */

export interface Pt { x: number; y: number }
/**
 * `line`: its points, some of them (not the ends) maybe curved: the corner there rounded off, from the middle of
 * the stretch before to the middle of the one after (next curved points join into one smooth curve).
 * `closed`: it runs on from its last point back to its first, a ring (every point may then be curved).
 * `arc`: centre, radius, start angle and signed sweep (radians; ±2π is a full circle).
 */
export type LaneShape = { kind: "line"; pts: Pt[]; curved?: boolean[]; closed?: true } | { kind: "arc"; c: Pt; r: number; a0: number; sweep: number };
/** a sign where a lane ends: cars leaving there give way to traffic that has none (at a stop, after stopping) */
export type LaneControl = "stop" | "yield";
export interface SketchLane {
  id: string; shape: LaneShape; /** metres */ width: number; control?: LaneControl;
  /** an entry lane: vehicles per hour coming in on it (default: the sketch's rate for every entry) */
  inRate?: number;
  /** an exit lane: its share of the trips that end there, relative to the others (default 1; 0: closed) */
  outWeight?: number;
}
/** a place on a lane, `s` metres from its start */
export interface LaneAt { lane: string; s: number }
export interface SketchConnector { id: string; from: LaneAt; to: LaneAt; /** bend points it goes through, in order */ via?: Pt[] }
/**
 * `align`: its lanes kept side by side, each `offset` metres beside the lead lane `ref` (to its left
 * as it runs, negative to its right), running the same way or the other (`reverse`).
 */
export interface SketchRoad { id: string; name: string; lanes: string[]; align?: { ref: string; lanes: { id: string; offset: number; reverse: boolean }[] } }
/**
 * a junction: a surface (closed outline); the lanes in no road and the connectors mostly on it are its own.
 * `shape: "auto"`: its surface is drawn as the union of what is on it and the ends of the roads it joins
 * (see `junctionBands`; smoothed if `smooth` is set), the outline only saying what it takes in
 */
export interface SketchJunction { id: string; name: string; outline: Pt[]; /** corners rounded off, as a line lane's curved points */ curved?: boolean[]; shape?: "auto";
  /** automatic: its notches rounded off to this radius, metres (see `smoothSurface`) */
  smooth?: number;
  /** traffic lights on the ways in (instead of signs; see `JunctionLights`) */
  lights?: JunctionLights;
}
export interface Sketch {
  lanes: SketchLane[]; connectors: SketchConnector[]; roads: SketchRoad[]; junctions: SketchJunction[];
  /** road ends joined so the road carries on (see `SketchLink`) */
  links?: SketchLink[];
  /** the cars run on it: vehicles per hour at each entry, and the speed on straight lanes (km/h) */
  traffic?: { rate: number; speed: number };
  /** where it is on Earth: the latitude / longitude of its origin (x east, y south, metres; as a V1 plan's `geo`), for the satellite imagery under it */
  geo?: { lat: number; lon: number };
}
/** what a junction's surface takes in, and the roads its connectors join */
export interface JunctionContents { lanes: string[]; connectors: string[]; roads: string[] }
/** some of a sketch, by ids (what is selected, copied, moved…) */
export interface Piece { lanes: string[]; connectors: string[]; junctions: string[] }

export const emptySketch = (): Sketch => ({ lanes: [], connectors: [], roads: [], junctions: [] });
export const LANE_WIDTH = 3.5;
const TAU = Math.PI * 2;

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
/** a ring: a full circle, or a line lane closed on itself */
export const isFullCircle = (s: LaneShape) => (s.kind === "arc" ? Math.abs(s.sweep) >= TAU - 1e-6 : !!s.closed);

/** a line lane as the polyline it runs along (its curved points rounded off) */
const paths = new WeakMap<LaneShape, Pt[]>();
export function linePath(sh: Extract<LaneShape, { kind: "line" }>): Pt[] {
  if (!sh.closed && !sh.curved?.some(Boolean)) return sh.pts;
  let out = paths.get(sh);
  if (out) return out;
  const pts = sh.pts, n = pts.length, mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  if (sh.closed) {
    // (round the ring: every point, the last one's neighbour the first; the path ends where it starts)
    out = [];
    for (let i = 0; i < n; i++) {
      if (!sh.curved?.[i]) { out.push(pts[i]); continue; }
      const a = mid(pts[(i + n - 1) % n], pts[i]), c = pts[i], b = mid(pts[i], pts[(i + 1) % n]), m = Math.max(8, Math.ceil((dist(a, c) + dist(c, b)) / 0.75));
      for (let k = 0; k <= m; k++) {
        const t = k / m, u = 1 - t;
        out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
      }
    }
    out.push(out[0]);
    paths.set(sh, out);
    return out;
  }
  out = [pts[0]];
  for (let i = 1; i < n - 1; i++) {
    if (!sh.curved?.[i]) { out.push(pts[i]); continue; }
    const a = mid(pts[i - 1], pts[i]), c = pts[i], b = mid(pts[i], pts[i + 1]), m = Math.max(8, Math.ceil((dist(a, c) + dist(c, b)) / 0.75));
    for (let k = 0; k <= m; k++) {
      const t = k / m, u = 1 - t;
      out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    }
  }
  out.push(pts[n - 1]);
  paths.set(sh, out);
  return out;
}

/** a junction's border as the closed polyline it runs along (its curved corners rounded off; not repeating the first point) */
const outlines = new WeakMap<SketchJunction, Pt[]>();
export function outlinePath(j: SketchJunction): Pt[] {
  if (!j.curved?.some(Boolean) || j.outline.length < 3) return j.outline;
  let out = outlines.get(j);
  if (out) return out;
  const pts = j.outline, n = pts.length, mid = (a: Pt, b: Pt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  out = [];
  for (let i = 0; i < n; i++) {
    if (!j.curved[i]) { out.push(pts[i]); continue; }
    const a = mid(pts[(i + n - 1) % n], pts[i]), c = pts[i], b = mid(pts[i], pts[(i + 1) % n]), m = Math.max(8, Math.ceil((dist(a, c) + dist(c, b)) / 0.75));
    for (let k = 0; k <= m; k++) {
      const t = k / m, u = 1 - t;
      out.push({ x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y });
    }
  }
  outlines.set(j, out);
  return out;
}
/** a junction's corner `i` rounded off, or made a corner again */
export function toggleCorner(j: SketchJunction, i: number): SketchJunction {
  const curved = j.outline.map((_, k) => !!j.curved?.[k]);
  curved[i] = !curved[i];
  return { ...j, curved };
}
/** every corner of a junction rounded off, or none */
export function curveAllCorners(j: SketchJunction, on: boolean): SketchJunction {
  const next = { ...j };
  if (on) next.curved = j.outline.map(() => true); else delete next.curved;
  return next;
}
/** a corner put in a junction's border before corner `i` (a sharp one) */
export function insertCorner(j: SketchJunction, i: number, p: Pt): SketchJunction {
  const next: SketchJunction = { ...j, outline: [...j.outline.slice(0, i), p, ...j.outline.slice(i)] };
  if (j.curved) { const c = j.outline.map((_, k) => !!j.curved?.[k]); next.curved = [...c.slice(0, i), false, ...c.slice(i)]; }
  return next;
}
/** a junction's corner `i` taken out (keeping three at least) */
export function removeCorner(j: SketchJunction, i: number): SketchJunction {
  if (j.outline.length <= 3) return j;
  return { ...j, outline: j.outline.filter((_, k) => k !== i), ...(j.curved ? { curved: j.curved.filter((_, k) => k !== i) } : {}) };
}

export function laneLength(s: LaneShape): number {
  if (s.kind === "arc") return Math.abs(s.sweep) * s.r;
  const pts = linePath(s);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** the point `s` metres along the lane and the direction of travel there (unit vector) */
export function pointAt(sh: LaneShape, s: number): { p: Pt; d: Pt } {
  const L = laneLength(sh);
  s = Math.max(0, Math.min(L, s));
  if (sh.kind === "arc") {
    const sg = Math.sign(sh.sweep) || 1, a = sh.a0 + (sg * s) / sh.r;
    return { p: { x: sh.c.x + sh.r * Math.cos(a), y: sh.c.y + sh.r * Math.sin(a) }, d: { x: -sg * Math.sin(a), y: sg * Math.cos(a) } };
  }
  const pts = linePath(sh);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = dist(a, b);
    if (s <= l || i === pts.length - 1) {
      const t = l ? Math.min(1, s / l) : 0, d = l ? { x: (b.x - a.x) / l, y: (b.y - a.y) / l } : { x: 1, y: 0 };
      return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, d };
    }
    s -= l;
  }
  return { p: pts[0] ?? { x: 0, y: 0 }, d: { x: 1, y: 0 } };
}

/** the lane as a polyline, points about `step` metres apart on arcs */
export function samples(sh: LaneShape, step = 1): Pt[] {
  if (sh.kind === "line") return linePath(sh);
  const n = Math.max(8, Math.ceil(laneLength(sh) / step));
  return Array.from({ length: n + 1 }, (_, i) => pointAt(sh, (laneLength(sh) * i) / n).p);
}

/** the place on the lane nearest to `p`, and how far `p` is from it */
export function nearestOn(sh: LaneShape, p: Pt): { s: number; d: number } {
  if (sh.kind === "arc") {
    const sg = Math.sign(sh.sweep) || 1, span = Math.abs(sh.sweep);
    let rel = (sg * (Math.atan2(p.y - sh.c.y, p.x - sh.c.x) - sh.a0)) % TAU;
    if (rel < 0) rel += TAU;
    if (rel > span) rel = rel - span < TAU - rel ? span : 0;
    const s = rel * sh.r;
    return { s, d: dist(p, pointAt(sh, s).p) };
  }
  let best = { s: 0, d: Infinity }, acc = 0;
  const pts = linePath(sh);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], l = dist(a, b);
    const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l))) : 0;
    const d = dist(p, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    if (d < best.d) best = { s: acc + t * l, d };
    acc += l;
  }
  return best;
}

type End = { p: Pt; d: Pt };
/**
 * A smooth path leaving `a` along its direction of travel, through `via`, and joining `b` along
 * its: cubic pieces with Catmull-Rom tangents at the bend points.
 */
export function curveThrough(a: End, via: Pt[], b: End, perPiece = 16): Pt[] {
  const P = [a.p, ...via, b.p], n = P.length;
  const T = P.map((p, i) => {
    if (i > 0 && i < n - 1) return { x: (P[i + 1].x - P[i - 1].x) / 2, y: (P[i + 1].y - P[i - 1].y) / 2 };
    const e = i === 0 ? a : b, k = Math.max(1, Math.min(120, 1.2 * dist(p, P[i === 0 ? 1 : n - 2])));
    return { x: e.d.x * k, y: e.d.y * k };
  });
  const out: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const c1 = { x: P[i].x + T[i].x / 3, y: P[i].y + T[i].y / 3 }, c2 = { x: P[i + 1].x - T[i + 1].x / 3, y: P[i + 1].y - T[i + 1].y / 3 };
    out.push(...bezierPts([P[i], c1, c2, P[i + 1]], perPiece).slice(i ? 1 : 0));
  }
  return out;
}
export function bezierPts([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt], n = 24): Pt[] {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, u = 1 - t;
    return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
  });
}

// (lookups by id, kept per sketch: a sketch is never changed, only replaced; a lane list or road list
// replaced or grown in place since is noticed)
const laneIndex = new WeakMap<Sketch, { lanes: SketchLane[]; n: number; map: Map<string, SketchLane> }>();
const roadIndex = new WeakMap<Sketch, { roads: SketchRoad[]; n: number; map: Map<string, SketchRoad> }>();
export const laneById = (sk: Sketch, id: string) => {
  let x = laneIndex.get(sk);
  if (!x || x.lanes !== sk.lanes || x.n !== sk.lanes.length) laneIndex.set(sk, (x = { lanes: sk.lanes, n: sk.lanes.length, map: new Map(sk.lanes.map(l => [l.id, l])) }));
  return x.map.get(id);
};
export const roadOf = (sk: Sketch, lane: string) => {
  let x = roadIndex.get(sk);
  if (!x || x.roads !== sk.roads || x.n !== sk.roads.reduce((a, r) => a + r.lanes.length, 0)) {
    const map = new Map<string, SketchRoad>();
    for (const r of sk.roads) for (const l of r.lanes) if (!map.has(l)) map.set(l, r);
    roadIndex.set(sk, (x = { roads: sk.roads, n: sk.roads.reduce((a, r) => a + r.lanes.length, 0), map }));
  }
  return x.map.get(lane);
};
/** where a connector end is, and the direction of travel there; null if its lane is gone */
export function at(sk: Sketch, a: LaneAt) {
  const l = laneById(sk, a.lane);
  return l ? pointAt(l.shape, a.s) : null;
}
/** the connector as a polyline; null if one of its lanes is gone */
// (a connector's curve, kept while the connector and the two lanes it joins are the same)
const curves = new WeakMap<SketchConnector, { a: SketchLane; b: SketchLane; pts: Pt[] }>();
export function connectorPts(sk: Sketch, c: SketchConnector): Pt[] | null {
  const la = laneById(sk, c.from.lane), lb = laneById(sk, c.to.lane);
  if (!la || !lb) return null;
  const k = curves.get(c);
  if (k && k.a === la && k.b === lb) return k.pts;
  const pts = curveThrough(pointAt(la.shape, c.from.s), c.via ?? [], pointAt(lb.shape, c.to.s));
  curves.set(c, { a: la, b: lb, pts });
  return pts;
}

// ---------------------------------------------------------------- editing (each returns a new sketch)

export function addLane(sk: Sketch, lane: SketchLane): Sketch {
  return { ...sk, lanes: [...sk.lanes, lane] };
}

/** lanes, connectors, roads and junctions removed (connectors on removed lanes and roads left empty go too) */
export function remove(sk: Sketch, ids: { lanes?: Iterable<string>; connectors?: Iterable<string>; roads?: Iterable<string>; junctions?: Iterable<string> }): Sketch {
  const lanes = new Set(ids.lanes ?? []), conns = new Set(ids.connectors ?? []), roads = new Set(ids.roads ?? []), js = new Set(ids.junctions ?? []);
  return {
    // (what it has besides: its traffic settings, links, place on Earth)
    ...sk,
    lanes: sk.lanes.filter(l => !lanes.has(l.id)),
    connectors: sk.connectors.filter(c => !conns.has(c.id) && !lanes.has(c.from.lane) && !lanes.has(c.to.lane)),
    roads: sk.roads.filter(r => !roads.has(r.id)).map(r => ({ ...r, lanes: r.lanes.filter(l => !lanes.has(l)) })).filter(r => r.lanes.length),
    junctions: sk.junctions.filter(j => !js.has(j.id)),
    // (links kept: `syncLinks` drops those whose roads are gone)
    ...(sk.links ? { links: sk.links } : {}),
  };
}

/** lanes made into one road (taken out of the roads they were in) */
export function groupRoad(sk: Sketch, lanes: string[], id: string, name: string): Sketch {
  const set = new Set(lanes);
  const roads = sk.roads.map(r => ({ ...r, lanes: r.lanes.filter(l => !set.has(l)) })).filter(r => r.lanes.length);
  return { ...sk, roads: [...roads, { id, name, lanes: [...set] }] };
}

export function moveShape(sh: LaneShape, dx: number, dy: number): LaneShape {
  return sh.kind === "arc" ? { ...sh, c: { x: sh.c.x + dx, y: sh.c.y + dy } } : { ...sh, pts: sh.pts.map(p => ({ x: p.x + dx, y: p.y + dy })) };
}

/** a lane's shape turned by `a` radians about `o` (clockwise on screen, y being down) */
export function rotateShape(sh: LaneShape, o: Pt, a: number): LaneShape {
  const cos = Math.cos(a), sin = Math.sin(a);
  const rot = (p: Pt) => ({ x: o.x + (p.x - o.x) * cos - (p.y - o.y) * sin, y: o.y + (p.x - o.x) * sin + (p.y - o.y) * cos });
  return sh.kind === "arc" ? { ...sh, c: rot(sh.c), a0: sh.a0 + a } : { ...sh, pts: sh.pts.map(rot) };
}

const rotatePt = (o: Pt, a: number) => {
  const cos = Math.cos(a), sin = Math.sin(a);
  return (p: Pt) => ({ x: o.x + (p.x - o.x) * cos - (p.y - o.y) * sin, y: o.y + (p.x - o.x) * sin + (p.y - o.y) * cos });
};
/** how a piece is moved: each point, and each lane's shape */
export interface Transform { pt: (p: Pt) => Pt; shape: (sh: LaneShape) => LaneShape }
export const translation = (dx: number, dy: number): Transform => ({ pt: p => ({ x: p.x + dx, y: p.y + dy }), shape: sh => moveShape(sh, dx, dy) });
export const rotation = (o: Pt, a: number): Transform => ({ pt: rotatePt(o, a), shape: sh => rotateShape(sh, o, a) });

/** a piece's lanes, junction surfaces and connector bends moved (the bends of connectors between two of its lanes too) */
export function transformPiece(sk: Sketch, piece: Piece, t: Transform): Sketch {
  const lanes = new Set(piece.lanes), conns = new Set(piece.connectors), js = new Set(piece.junctions);
  return {
    ...sk,
    lanes: sk.lanes.map(l => (lanes.has(l.id) ? { ...l, shape: t.shape(l.shape) } : l)),
    connectors: sk.connectors.map(c => (c.via?.length && (conns.has(c.id) || (lanes.has(c.from.lane) && lanes.has(c.to.lane))) ? { ...c, via: c.via.map(t.pt) } : c)),
    junctions: sk.junctions.map(j => (js.has(j.id) ? { ...j, outline: j.outline.map(t.pt) } : j)),
  };
}

/** every point of a piece: its lanes, connectors and junction surfaces */
export function piecePoints(sk: Sketch, piece: Piece): Pt[] {
  const out: Pt[] = [];
  for (const id of piece.lanes) { const l = laneById(sk, id); if (l) out.push(...samples(l.shape, 2)); }
  for (const id of piece.connectors) { const c = sk.connectors.find(x => x.id === id), p = c && connectorPts(sk, c); if (p) out.push(...p); }
  for (const id of piece.junctions) out.push(...(sk.junctions.find(j => j.id === id)?.outline ?? []));
  return out;
}
export function boundsOfPts(pts: Pt[]) {
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}

/** the next free id with this prefix ("l3", "c12"…), readable in the copied structure */
export function nextId(prefix: string, ids: string[]) {
  let n = 0;
  for (const id of ids) if (id.startsWith(prefix)) n = Math.max(n, Number(id.slice(prefix.length)) || 0);
  return `${prefix}${n + 1}`;
}

/** a piece to paste: its lanes with every connector between them and their roads (only the lanes copied), and its junctions */
export function copyPart(sk: Sketch, piece: Piece): Sketch {
  const set = new Set(piece.lanes), js = new Set(piece.junctions);
  return {
    lanes: sk.lanes.filter(l => set.has(l.id)),
    connectors: sk.connectors.filter(c => set.has(c.from.lane) && set.has(c.to.lane)),
    roads: sk.roads.map(r => ({ ...r, lanes: r.lanes.filter(l => set.has(l)) })).filter(r => r.lanes.length),
    junctions: sk.junctions.filter(j => js.has(j.id)),
  };
}

/** a piece pasted in with fresh ids, moved by (dx, dy); answers the sketch and what was pasted */
export function pastePart(sk: Sketch, part: Sketch, dx: number, dy: number): { sketch: Sketch; piece: Piece } {
  const ids = { l: sk.lanes.map(l => l.id), c: sk.connectors.map(c => c.id), r: sk.roads.map(r => r.id), j: sk.junctions.map(j => j.id) };
  const fresh = (k: keyof typeof ids) => { const id = nextId(k, ids[k]); ids[k].push(id); return id; };
  const t = translation(dx, dy), laneIds = new Map(part.lanes.map(l => [l.id, fresh("l")]));
  const lanes = part.lanes.map(l => ({ ...l, id: laneIds.get(l.id)!, shape: t.shape(l.shape) }));
  const connectors = part.connectors.map(c => ({ id: fresh("c"), from: { ...c.from, lane: laneIds.get(c.from.lane)! }, to: { ...c.to, lane: laneIds.get(c.to.lane)! }, ...(c.via?.length ? { via: c.via.map(t.pt) } : {}) }));
  const roads = part.roads.map(r => ({ id: fresh("r"), name: `${r.name} copy`, lanes: r.lanes.map(l => laneIds.get(l)!) }));
  const junctions = part.junctions.map(j => ({ id: fresh("j"), name: `${j.name} copy`, outline: j.outline.map(t.pt), ...(j.curved ? { curved: [...j.curved] } : {}), ...(j.shape ? { shape: j.shape } : {}), ...(j.smooth ? { smooth: j.smooth } : {}), ...(j.lights ? { lights: { ...j.lights } } : {}) }));
  return {
    sketch: { ...sk, lanes: [...sk.lanes, ...lanes], connectors: [...sk.connectors, ...connectors], roads: [...sk.roads, ...roads], junctions: [...sk.junctions, ...junctions] },
    piece: { lanes: lanes.map(l => l.id), connectors: connectors.map(c => c.id), junctions: junctions.map(j => j.id) },
  };
}

/** a shape run the other way */
export function reversed(sh: LaneShape): LaneShape {
  return sh.kind === "arc" ? { ...sh, a0: sh.a0 + sh.sweep, sweep: -sh.sweep } : { ...sh, pts: [...sh.pts].reverse(), ...(sh.curved ? { curved: [...sh.curved].reverse() } : {}) };
}

// ---------------------------------------------------------------- a line lane's points

/** a point added to a line lane where it gets the least longer */
export function insertPoint(sh: Extract<LaneShape, { kind: "line" }>, p: Pt): Extract<LaneShape, { kind: "line" }> {
  let best = 1, cost = Infinity;
  const n = sh.pts.length;
  // (closed: also between the last point and the first, the new one then last)
  for (let i = 1; i <= (sh.closed ? n : n - 1); i++) {
    const a = sh.pts[i - 1], b = sh.pts[i % n], c = dist(a, p) + dist(p, b) - dist(a, b);
    if (c < cost) { cost = c; best = i; }
  }
  const curved = sh.pts.map((_, i) => !!sh.curved?.[i]);
  return { kind: "line", pts: [...sh.pts.slice(0, best), p, ...sh.pts.slice(best)], curved: [...curved.slice(0, best), false, ...curved.slice(best)], ...(sh.closed ? { closed: true as const } : {}) };
}
/** a line lane without its point `i` (it keeps two at least) */
export function removePoint(sh: Extract<LaneShape, { kind: "line" }>, i: number): Extract<LaneShape, { kind: "line" }> {
  if (sh.pts.length <= (sh.closed ? 3 : 2)) return sh;
  return { ...sh, pts: sh.pts.filter((_, k) => k !== i), ...(sh.curved ? { curved: sh.curved.filter((_, k) => k !== i) } : {}) };
}
/** a line lane's point `i` made curved, or a corner again (the ends of one not closed stay corners) */
export function toggleCurve(sh: Extract<LaneShape, { kind: "line" }>, i: number): Extract<LaneShape, { kind: "line" }> {
  if (!sh.closed && (i <= 0 || i >= sh.pts.length - 1)) return sh;
  const curved = sh.pts.map((_, k) => !!sh.curved?.[k]);
  curved[i] = !curved[i];
  return { ...sh, curved };
}

// ---------------------------------------------------------------- a road's lanes side by side

/** `sh` moved `off` metres to its left as it runs (negative: to its right), and run the other way if `reverse` */
export function offsetShape(sh: LaneShape, off: number, reverse: boolean): LaneShape {
  let out: LaneShape;
  if (sh.kind === "arc") {
    // (its left is towards the centre when it turns that way)
    const r = Math.max(0.5, sh.r - Math.sign(sh.sweep || 1) * off);
    out = { ...sh, r: Number(r.toFixed(3)) };
  } else {
    const pts = sh.pts, n = pts.length, nrm = (a: Pt, b: Pt) => { const l = dist(a, b) || 1; return { x: (b.y - a.y) / l, y: -(b.x - a.x) / l }; };
    const moved = pts.map((p, i) => {
      const closed = !!sh.closed, n0 = i > 0 || closed ? nrm(pts[(i + n - 1) % n], p) : null, n1 = i < n - 1 || closed ? nrm(p, pts[(i + 1) % n]) : null;
      let m = n0 && n1 ? { x: n0.x + n1.x, y: n0.y + n1.y } : (n0 ?? n1)!;
      const l = Math.hypot(m.x, m.y) || 1;
      m = { x: m.x / l, y: m.y / l };
      // (mitred: the corner further out, up to twice the offset)
      const cos = n0 && n1 ? Math.max(0.5, m.x * n0.x + m.y * n0.y) : 1;
      return { x: Number((p.x + (m.x * off) / cos).toFixed(3)), y: Number((p.y + (m.y * off) / cos).toFixed(3)) };
    });
    out = { ...sh, pts: moved };
  }
  return reverse ? reversed(out) : out;
}

/** a road's lanes put side by side as they lie now: the lead lane first, the others packed by their widths, on the side and running the way they do */
export function alignmentOf(sk: Sketch, road: SketchRoad, ref = road.lanes[0]): SketchRoad["align"] {
  const lead = laneById(sk, ref);
  if (!lead) return undefined;
  const placed = road.lanes.flatMap(id => {
    const l = laneById(sk, id);
    if (!l) return [];
    if (id === ref) return [{ id, side: 0, reverse: false, width: l.width }];
    const m = pointAt(l.shape, laneLength(l.shape) / 2), q = pointAt(lead.shape, nearestOn(lead.shape, m.p).s);
    const left = { x: q.d.y, y: -q.d.x };
    return [{ id, side: (m.p.x - q.p.x) * left.x + (m.p.y - q.p.y) * left.y, reverse: m.d.x * q.d.x + m.d.y * q.d.y < 0, width: l.width }];
  }).sort((a, b) => a.side - b.side);
  const k = placed.findIndex(x => x.id === ref), offsets = new Map([[ref, 0]]);
  for (let i = k + 1; i < placed.length; i++) offsets.set(placed[i].id, offsets.get(placed[i - 1].id)! + (placed[i - 1].width + placed[i].width) / 2);
  for (let i = k - 1; i >= 0; i--) offsets.set(placed[i].id, offsets.get(placed[i + 1].id)! - (placed[i + 1].width + placed[i].width) / 2);
  return { ref, lanes: placed.filter(x => x.id !== ref).map(x => ({ id: x.id, offset: Number(offsets.get(x.id)!.toFixed(3)), reverse: x.reverse })) };
}

/**
 * The sketch with every road kept side by side laid out from its lead lane (its alignment worked out
 * again when the road's lanes changed). Called after every change.
 */
/** the lead lane of the side-by-side road a lane follows, if it follows one */
export function leadOf(sk: Sketch, lane: string): string | null {
  return sk.roads.find(r => r.align?.lanes.some(x => x.id === lane))?.align?.ref ?? null;
}

export function settle(sk: Sketch): Sketch {
  return syncLinks(settleRoads(sk));
}
function settleRoads(sk: Sketch): Sketch {
  if (!sk.roads.some(r => r.align)) return sk;
  let lanes = sk.lanes, roads = sk.roads;
  for (const road of sk.roads) {
    if (!road.align) continue;
    let align = road.align;
    const ids = [align.ref, ...align.lanes.map(l => l.id)];
    if (!road.lanes.includes(align.ref) || ids.length !== road.lanes.length || road.lanes.some(id => !ids.includes(id))) {
      const ref = road.lanes.includes(align.ref) ? align.ref : road.lanes[0];
      align = alignmentOf({ ...sk, lanes }, road, ref)!;
      roads = roads.map(r => (r.id === road.id ? { ...r, align } : r));
      if (!align) continue;
    }
    const lead = lanes.find(l => l.id === align.ref);
    if (!lead) continue;
    const want = new Map(align.lanes.map(a => [a.id, offsetShape(lead.shape, a.offset, a.reverse)]));
    lanes = lanes.map(l => (want.has(l.id) ? { ...l, shape: want.get(l.id)! } : l));
  }
  // (connectors kept within their lanes' new lengths)
  const len = new Map(lanes.map(l => [l.id, laneLength(l.shape)]));
  const clamp = (a: LaneAt) => (len.has(a.lane) && a.s > len.get(a.lane)! ? { ...a, s: len.get(a.lane)! } : a);
  return { ...sk, lanes, roads, connectors: sk.connectors.map(c => ({ ...c, from: clamp(c.from), to: clamp(c.to) })) };
}

/** a lane turned to run the other way (its connectors stay at the same places) */
export function reverseLane(sk: Sketch, id: string): Sketch {
  const lane = laneById(sk, id);
  if (!lane) return sk;
  const L = laneLength(lane.shape), sh = lane.shape;
  const shape = reversed(sh);
  const flip = (a: LaneAt) => (a.lane === id ? { ...a, s: L - a.s } : a);
  // (side by side: a following lane runs the other way; reversing the lead keeps the others where they are)
  const roads = sk.roads.map(r => {
    if (!r.align) return r;
    if (r.align.ref === id) return { ...r, align: { ...r.align, lanes: r.align.lanes.map(x => ({ ...x, offset: -x.offset, reverse: !x.reverse })) } };
    if (r.align.lanes.some(x => x.id === id)) return { ...r, align: { ...r.align, lanes: r.align.lanes.map(x => (x.id === id ? { ...x, reverse: !x.reverse } : x)) } };
    return r;
  });
  return { ...sk, roads, lanes: sk.lanes.map(l => (l.id === id ? { ...l, shape } : l)), connectors: sk.connectors.map(c => ({ ...c, from: flip(c.from), to: flip(c.to) })) };
}

// ---------------------------------------------------------------- slicing

/** a lane's shape cut `s` metres along it: the stretch before and the one after (a ring can't be cut in two) */
export function splitShape(sh: LaneShape, s: number): [LaneShape, LaneShape] | null {
  const L = laneLength(sh);
  if (isFullCircle(sh) || s < 0.5 || s > L - 0.5) return null;
  if (sh.kind === "arc") {
    const da = ((Math.sign(sh.sweep) || 1) * s) / sh.r;
    return [{ ...sh, sweep: da }, { ...sh, a0: sh.a0 + da, sweep: sh.sweep - da }];
  }
  // (cut on the control points' segment nearest the place, the place itself the new end of both)
  const p = pointAt(sh, s).p, pts = sh.pts, curved = pts.map((_, i) => !!sh.curved?.[i]);
  let k = 0, bd = Infinity;
  for (let i = 1; i < pts.length; i++) { const d = nearestOn({ kind: "line", pts: [pts[i - 1], pts[i]] }, p).d; if (d < bd) { bd = d; k = i; } }
  const cut = { x: Number(p.x.toFixed(3)), y: Number(p.y.toFixed(3)) };
  const shape = (ps: Pt[], cs: boolean[]): LaneShape => ({ kind: "line", pts: ps, ...(cs.some(Boolean) ? { curved: cs } : {}) });
  return [shape([...pts.slice(0, k), cut], [...curved.slice(0, k), false]), shape([cut, ...pts.slice(k)], [false, ...curved.slice(k)])];
}

/**
 * A lane cut in two `s` metres along it: the first stretch keeps its id, the second is `newId` (with
 * the lane's stop or yield line, at its end). Connectors leaving or joining it go with the stretch they
 * are on (one leaving right at the cut leaves the first's end, one joining there joins the second's
 * start). The two aren't joined: traffic leaves the first's end and comes in at the second's start.
 */
export function sliceLane(sk: Sketch, id: string, s: number, newId: string): Sketch | null {
  const lane = laneById(sk, id), parts = lane && splitShape(lane.shape, s);
  if (!lane || !parts) return null;
  const cut = laneLength(lane.shape) - laneLength(parts[1]);
  // (the first keeps what is at the lane's start: the traffic coming in; the second what is at its end: its sign, its share of trips out)
  const first: SketchLane = { id, shape: parts[0], width: lane.width, ...(lane.inRate !== undefined ? { inRate: lane.inRate } : {}) };
  const second: SketchLane = { ...lane, id: newId, shape: parts[1] };
  delete second.inRate;
  const move = (a: LaneAt, leaving: boolean) => (a.lane !== id ? a : (leaving ? a.s <= cut + 1e-6 : a.s < cut - 1e-6) ? { ...a, s: Math.min(a.s, cut) } : { lane: newId, s: Math.max(0, a.s - cut) });
  return {
    ...sk,
    lanes: sk.lanes.flatMap(l => (l.id === id ? [first, second] : [l])),
    connectors: sk.connectors.map(c => ({ ...c, from: move(c.from, true), to: move(c.to, false) })),
    // (in a road: the second stretch in it too)
    roads: sk.roads.map(r => (r.lanes.includes(id) ? { ...r, lanes: r.lanes.flatMap(x => (x === id ? [id, newId] : [x])) } : r)),
  };
}

/**
 * A road cut in two across `p` (on lane `at`): each of its lanes cut where it passes nearest `p`, the
 * stretches on the far side (along lane `at`) making a new road `newRoad`, laid out side by side as the
 * road was. Answers null if no lane could be cut there.
 */
export function sliceRoad(sk: Sketch, roadId: string, at: string, p: Pt, newRoad: string, newName: string): Sketch | null {
  const road = sk.roads.find(r => r.id === roadId), lead = laneById(sk, at);
  if (!road || !lead) return null;
  const q = pointAt(lead.shape, nearestOn(lead.shape, p).s), side = (pt: Pt) => (pt.x - q.p.x) * q.d.x + (pt.y - q.p.y) * q.d.y;
  let out = sk;
  const ids = sk.lanes.map(l => l.id), twin = new Map<string, string>();
  for (const id of road.lanes) {
    const l = laneById(out, id)!, near = nearestOn(l.shape, q.p);
    // (a lane that doesn't reach the cut goes whole to its side)
    if (near.d > 2 * (l.width + lead.width)) continue;
    const newId = nextId("l", ids);
    const next = sliceLane(out, id, near.s, newId);
    if (!next) continue;
    ids.push(newId); twin.set(id, newId); out = next;
  }
  if (!twin.size) return null;
  // each stretch to the side of the cut it lies on
  const mid = (id: string) => { const l = laneById(out, id)!; return pointAt(l.shape, laneLength(l.shape) / 2).p; };
  const all = [...road.lanes, ...twin.values()], far = new Set(all.filter(id => side(mid(id)) > 0));
  const near = all.filter(id => !far.has(id));
  if (!near.length || !far.size) return null;
  // (side by side: each side led by the lead's stretch there, the others as they were beside it)
  const alignFor = (keep: Set<string>) => {
    if (!road.align) return undefined;
    const pick = (id: string) => (keep.has(id) ? id : twin.get(id) && keep.has(twin.get(id)!) ? twin.get(id)! : null);
    const ref = pick(road.align.ref);
    if (!ref) return undefined;
    const lanes = road.align.lanes.flatMap(x => { const id = pick(x.id); return id ? [{ ...x, id }] : []; });
    return lanes.length === keep.size - 1 ? { ref, lanes } : undefined;
  };
  const a = alignFor(new Set(near)), b = alignFor(far);
  const roads = out.roads.flatMap(r => {
    if (r.id !== roadId) return [r];
    const first: SketchRoad = { id: r.id, name: r.name, lanes: near, ...(a ? { align: a } : {}) };
    const second: SketchRoad = { id: newRoad, name: newName, lanes: [...far], ...(b ? { align: b } : {}) };
    return [first, second];
  });
  return { ...out, roads };
}

/**
 * An arc lane made a line lane of curved points, to reshape freely: a ring closed on itself (12
 * points), an arc open (a point every 30° or so, its ends where the arc's are). The points are put a
 * little out from the circle so the curve through them stays on it. Connectors on it are put at the
 * same places on the new shape.
 */
export function arcToPoints(sk: Sketch, id: string): Sketch {
  const lane = laneById(sk, id);
  if (!lane || lane.shape.kind !== "arc") return sk;
  const arc = lane.shape, ring = isFullCircle(arc), n = ring ? 12 : Math.max(2, Math.ceil(Math.abs(arc.sweep) / (Math.PI / 6)));
  const step = arc.sweep / n, R = arc.r / ((1 + (1 + Math.cos(step)) / 2) / 2);
  const at = (k: number, r: number) => { const a = arc.a0 + step * k; return { x: Number((arc.c.x + r * Math.cos(a)).toFixed(3)), y: Number((arc.c.y + r * Math.sin(a)).toFixed(3)) }; };
  const shape: LaneShape = ring
    ? { kind: "line", pts: Array.from({ length: n }, (_, k) => at(k, R)), curved: Array.from({ length: n }, () => true), closed: true }
    : { kind: "line", pts: Array.from({ length: n + 1 }, (_, k) => at(k, k === 0 || k === n ? arc.r : R)), curved: Array.from({ length: n + 1 }, (_, k) => k > 0 && k < n) };
  const place = (a: LaneAt) => (a.lane === id ? { ...a, s: Number(nearestOn(shape, pointAt(arc, a.s).p).s.toFixed(2)) } : a);
  return { ...sk, lanes: sk.lanes.map(l => (l.id === id ? { ...l, shape } : l)), connectors: sk.connectors.map(c => ({ ...c, from: place(c.from), to: place(c.to) })) };
}

// ---------------------------------------------------------------- links: two road ends joined as one road

/** where a link meets a road: its start or end (the way its lead lane runs) */
export interface RoadEnd { road: string; end: "start" | "end" }
/**
 * A link: two road ends joined so the road just carries on: its connectors made from the lanes at the
 * two ends (`conns`, kept by `syncLinks`), its surface a strip from one end to the other, the road's
 * markings carried across.
 */
export interface SketchLink { id: string; a: RoadEnd; b: RoadEnd; conns: string[] }

/** a road end's lanes across it: where each ends there, which way along, `o` metres left of the lead (looking out of the road) */
interface EndLane { lane: SketchLane; p: Pt; out: boolean; o: number }
export function linkEnd(sk: Sketch, e: RoadEnd) {
  const road = sk.roads.find(r => r.id === e.road), lead = road && laneById(sk, road.align?.ref ?? road.lanes[0]);
  if (!road || !lead) return null;
  const q = pointAt(lead.shape, e.end === "end" ? laneLength(lead.shape) : 0);
  const u = e.end === "end" ? q.d : { x: -q.d.x, y: -q.d.y }, left = { x: u.y, y: -u.x };
  const lanes: EndLane[] = [];
  for (const id of road.lanes) {
    const l = laneById(sk, id);
    if (!l || isFullCircle(l.shape)) continue;
    const L = laneLength(l.shape), a = pointAt(l.shape, 0).p, b = pointAt(l.shape, L).p, atEnd = dist(b, q.p) <= dist(a, q.p), p = atEnd ? b : a;
    lanes.push({ lane: l, p, out: atEnd, o: (p.x - q.p.x) * left.x + (p.y - q.p.y) * left.y });
  }
  lanes.sort((x, y) => x.o - y.o);
  return { p: q.p, u, left, lanes };
}

/** a cubic from `a` heading `ta` to `b` arriving heading `tb` */
function hermite(a: Pt, ta: Pt, b: Pt, tb: Pt, n = 24): Pt[] {
  const k = dist(a, b) / 3;
  return bezierPts([a, { x: a.x + ta.x * k, y: a.y + ta.y * k }, { x: b.x - tb.x * k, y: b.y - tb.y * k }, b], n);
}

/**
 * A link's shape: its surface (left side out of `a`, then the right side back), the two sides (for the
 * kerbs), and the road's lines carried across it where both ends have the same lanes in the same order.
 */
export function linkGeometry(sk: Sketch, k: SketchLink): { outline: Pt[]; sides: Pt[][]; lines: Marking[] } | null {
  const A = linkEnd(sk, k.a), B = linkEnd(sk, k.b);
  if (!A?.lanes.length || !B?.lanes.length) return null;
  // (seen from `a` going to `b`: `b`'s lanes as they lie looking into its road, its left the other way round)
  const inB = { x: -B.u.x, y: -B.u.y }, bl = [...B.lanes].reverse();
  const edge = (e: EndLane, left: Pt, side: number) => ({ x: e.p.x + left.x * side * (e.lane.width / 2), y: e.p.y + left.y * side * (e.lane.width / 2) });
  const aL = edge(A.lanes[A.lanes.length - 1], A.left, 1), aR = edge(A.lanes[0], A.left, -1);
  const bL = edge(bl[bl.length - 1], B.left, -1), bR = edge(bl[0], B.left, 1);
  const left = hermite(aL, A.u, bL, inB), right = hermite(aR, A.u, bR, inB);
  const lines: Marking[] = [];
  const pattern = (ls: EndLane[], out: (e: EndLane) => boolean) => ls.map(e => (out(e) ? "o" : "i")).join("");
  // (the same lanes, the same ways: `a`'s lanes leaving it are `b`'s coming in)
  if (A.lanes.length === bl.length && pattern(A.lanes, e => e.out) === pattern(bl, e => !e.out)) {
    for (let i = 0; i + 1 < A.lanes.length; i++) {
      const x = A.lanes[i], y = A.lanes[i + 1], same = x.out === y.out;
      const pa = edge(x, A.left, 1), pb = edge(bl[i], B.left, -1);
      const line = hermite(pa, A.u, pb, inB);
      if (same) lines.push({ pts: line, kind: "lane", dashed: true });
      else if (A.lanes.length <= 2) lines.push({ pts: line, kind: "center", dashed: true });
      else for (const o of [-0.15, 0.15]) lines.push({ pts: offsetPolyline(line, o), kind: "center", dashed: false });
    }
  }
  return { outline: [...left, ...[...right].reverse()], sides: [left, right], lines };
}

/**
 * Every link's connectors made again from its ends (keeping their ids): each lane leaving one end
 * joined to one coming in at the other, paired from the kerb side (a lane more on one side merges
 * into, or splits from, the last one on the other). Links whose roads are gone are dropped.
 */
export function syncLinks(sk: Sketch): Sketch {
  if (!sk.links?.length) return sk;
  const ids = sk.connectors.map(c => c.id), owned = new Set(sk.links.flatMap(k => k.conns));
  const made: SketchConnector[] = [], links: SketchLink[] = [];
  for (const k of sk.links) {
    const A = linkEnd(sk, k.a), B = linkEnd(sk, k.b);
    if (!A || !B) continue;
    const pairs: [SketchLane, SketchLane][] = [];
    const join = (outs: EndLane[], ins: EndLane[]) => {
      for (let i = 0; i < Math.max(outs.length, ins.length) && outs.length && ins.length; i++) pairs.push([outs[Math.min(i, outs.length - 1)].lane, ins[Math.min(i, ins.length - 1)].lane]);
    };
    // (from the kerb side, the right as each runs: leaving `a` its lanes rightmost first; coming into `b`, `b`'s left looking out)
    join(A.lanes.filter(e => e.out), [...B.lanes].reverse().filter(e => !e.out));
    join(B.lanes.filter(e => e.out), [...A.lanes].reverse().filter(e => !e.out));
    const conns = pairs.map(([f, t], i) => {
      const id = k.conns[i] ?? nextId("c", ids);
      if (!k.conns[i]) ids.push(id);
      made.push({ id, from: { lane: f.id, s: Number(laneLength(f.shape).toFixed(2)) }, to: { lane: t.id, s: 0 } });
      return id;
    });
    links.push({ ...k, conns });
  }
  const keep = new Set(links.flatMap(k => k.conns));
  const connectors = [...sk.connectors.filter(c => !owned.has(c.id) && !keep.has(c.id)), ...made];
  // (nothing changed: the same sketch, so nothing is redrawn or rebuilt for it)
  const same = links.length === sk.links.length && links.every((k, i) => k.conns.join() === sk.links![i].conns.join())
    && made.every(m => { const c = sk.connectors.find(x => x.id === m.id); return c && !c.via && c.from.lane === m.from.lane && c.from.s === m.from.s && c.to.lane === m.to.lane && c.to.s === 0; });
  return same ? sk : { ...sk, connectors, links };
}

/** two roads linked at their nearest ends (answers null if they are the same road or already linked there) */
export function linkRoads(sk: Sketch, r1: string, r2: string, id: string): Sketch | null {
  if (r1 === r2) return null;
  let best: { a: RoadEnd; b: RoadEnd; d: number } | null = null;
  for (const ea of ["start", "end"] as const) for (const eb of ["start", "end"] as const) {
    const a = { road: r1, end: ea }, b = { road: r2, end: eb }, A = linkEnd(sk, a), B = linkEnd(sk, b);
    if (!A || !B) continue;
    const d = dist(A.p, B.p);
    if (!best || d < best.d) best = { a, b, d };
  }
  if (!best) return null;
  const taken = (e: RoadEnd) => sk.links?.some(k => [k.a, k.b].some(x => x.road === e.road && x.end === e.end));
  if (taken(best.a) || taken(best.b)) return null;
  return settle({ ...sk, links: [...(sk.links ?? []), { id, a: best.a, b: best.b, conns: [] }] });
}

/** a link taken away, with its connectors */
export function unlink(sk: Sketch, id: string): Sketch {
  const k = sk.links?.find(x => x.id === id);
  if (!k) return sk;
  const gone = new Set(k.conns);
  return { ...sk, links: sk.links!.filter(x => x.id !== id), connectors: sk.connectors.filter(c => !gone.has(c.id)) };
}

/** a stop or yield line put at a lane's end, or taken away (null) */
export function setControl(sk: Sketch, id: string, control: LaneControl | null): Sketch {
  return { ...sk, lanes: sk.lanes.map(l => { if (l.id !== id) return l; const next = { ...l }; if (control) next.control = control; else delete next.control; return next; }) };
}

/**
 * The ways into a junction, as signs are put up on them (the plan's approaches): for each road, or
 * lane in no road, the lanes ending where its connectors leave them (not lanes on the junction, a
 * roundabout's ring say), and the sign they have: one, none, or "mixed" if not all the same.
 */
export interface Approach { road: string | null; name: string; lanes: string[]; sign: LaneControl | null | "mixed" }
export function junctionApproaches(sk: Sketch, c: JunctionContents): Approach[] {
  const own = new Set(c.lanes), by = new Map<string, Approach>();
  for (const id of c.connectors) {
    const cn = sk.connectors.find(x => x.id === id), l = cn && laneById(sk, cn.from.lane);
    if (!cn || !l || own.has(l.id) || isFullCircle(l.shape) || cn.from.s < laneLength(l.shape) - 1) continue;
    const road = roadOf(sk, l.id), key = road?.id ?? `lane:${l.id}`;
    const a = by.get(key) ?? { road: road?.id ?? null, name: road?.name ?? `Lane ${l.id}`, lanes: [], sign: null };
    if (!a.lanes.includes(l.id)) a.lanes.push(l.id);
    by.set(key, a);
  }
  return [...by.values()].map(a => {
    const signs = new Set(a.lanes.map(id => laneById(sk, id)?.control ?? null));
    return { ...a, sign: signs.size > 1 ? "mixed" : [...signs][0] ?? null };
  });
}
/** a sign put on some lanes' ends, or taken away (null) */
export function setSigns(sk: Sketch, lanes: string[], control: LaneControl | null): Sketch {
  return lanes.reduce((s, id) => setControl(s, id, control), sk);
}

// ---------------------------------------------------------------- traffic lights

/** one phase set by hand: its name, how long its green lasts, and the connectors with green in it */
export interface LightsPhase { name?: string; green: number; /** default: the junction's */ minGreen?: number; conns: string[] }
/**
 * A junction's traffic lights, as on the plan: each phase gets green in turn (`green` seconds at most),
 * then `amber`, then `allRed` with every way red. Worked out (`mode`: ways facing each other together,
 * or one way at a time) or set by hand (`phases`, run in order, green per connector). `actuated`: a
 * green nobody is using ends after `minGreen` when another phase has cars waiting.
 */
export interface JunctionLights {
  green: number; amber: number; allRed: number; mode: "pairs" | "each";
  minGreen: number; actuated: boolean;
  phases?: LightsPhase[];
}
export const DEFAULT_LIGHTS: JunctionLights = { green: 18, amber: 3, allRed: 2, mode: "pairs", minGreen: 6, actuated: true };
export const MAX_PHASES = 8;
export interface SignalPhase { name: string; ways: string[]; lanes: string[]; conns: string[]; start: number; green: number; minGreen: number }
export interface SignalPlan { junction: string; cycle: number; amber: number; allRed: number; actuated: boolean; custom: boolean; phases: SignalPhase[]; /** every connector the lights hold (the ways in), green in a phase or not */ controlled: string[] }
export type SignalState = "green" | "amber" | "red";

/** the connectors leaving a junction's ways in at their ends (what its lights hold), by way */
function wayConns(sk: Sketch, c: JunctionContents, ways: Approach[]) {
  const set = new Set(c.connectors);
  return ways.map(w => sk.connectors.filter(cn => set.has(cn.id) && w.lanes.includes(cn.from.lane)).map(cn => cn.id));
}

/** a junction's lights as a plan: the phases in order, their connectors, when each starts in a fixed cycle */
export function signalPlan(sk: Sketch, j: SketchJunction, c: JunctionContents): SignalPlan | null {
  const L = j.lights;
  if (!L) return null;
  const ways = junctionApproaches(sk, c);
  if (!ways.length) return null;
  const conns = wayConns(sk, c, ways), controlled = conns.flat(), key = (i: number) => ways[i].road ?? `lane:${ways[i].lanes[0]}`;
  const minGreen = Math.min(L.minGreen ?? DEFAULT_LIGHTS.minGreen, L.green);
  let raw: { name: string; ways: string[]; lanes: string[]; conns: string[]; green: number; minGreen: number }[];
  if (L.phases?.length) {
    // (by hand: each phase's connectors, still there and held by the lights; its lanes and ways those they leave)
    raw = L.phases.map((p, i) => {
      const cs = p.conns.filter(id => controlled.includes(id)), lanes = [...new Set(cs.map(id => sk.connectors.find(x => x.id === id)!.from.lane))];
      return { name: p.name || `Phase ${i + 1}`, ways: [...new Set(lanes.map(l => { const k = ways.findIndex(w => w.lanes.includes(l)); return key(k); }))], lanes, conns: cs, green: p.green, minGreen: Math.min(p.minGreen ?? minGreen, p.green) };
    });
  } else {
    // (worked out: the way each faces where its lanes end, and those facing each other paired)
    const facing = ways.map(w => {
      const ds = w.lanes.map(id => { const l = laneById(sk, id)!; return pointAt(l.shape, laneLength(l.shape)).d; });
      const x = ds.reduce((a, d) => a + d.x, 0), y = ds.reduce((a, d) => a + d.y, 0), n = Math.hypot(x, y) || 1;
      return { x: x / n, y: y / n };
    });
    const groups: number[][] = [], used = new Set<number>();
    for (let i = 0; i < ways.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const g = [i];
      // (two ways only: together they would always have green, so each gets its own)
      if (L.mode === "pairs" && ways.length > 2) {
        let best = -1, bd = -0.7;
        for (let k = 0; k < ways.length; k++) { if (used.has(k)) continue; const dot = facing[i].x * facing[k].x + facing[i].y * facing[k].y; if (dot < bd) { bd = dot; best = k; } }
        if (best >= 0) { used.add(best); g.push(best); }
      }
      groups.push(g);
    }
    raw = groups.map((g, i) => ({ name: `Phase ${i + 1}`, ways: g.map(key), lanes: g.flatMap(k => ways[k].lanes), conns: g.flatMap(k => conns[k]), green: L.green, minGreen }));
  }
  let t = 0;
  const phases = raw.map(p => { const out = { ...p, start: t }; t += p.green + L.amber + L.allRed; return out; });
  return { junction: j.id, cycle: t, amber: L.amber, allRed: L.allRed, actuated: L.actuated ?? DEFAULT_LIGHTS.actuated, custom: !!L.phases?.length, phases, controlled };
}

/** the light a lane has at time `t` in the fixed cycle (green if any of its connectors is), or null if the lights don't hold it */
export function signalAt(plan: SignalPlan, lane: string, t: number): SignalState | null {
  if (!plan.phases.some(p => p.lanes.includes(lane))) return null;
  const into = ((t % plan.cycle) + plan.cycle) % plan.cycle;
  const p = plan.phases.find(x => x.lanes.includes(lane) && into >= x.start && into < x.start + x.green + plan.amber);
  return !p ? "red" : into < p.start + p.green ? "green" : "amber";
}

/**
 * A junction's lights as they run: the phase on and how long it has been, stepped with the cars. With
 * `actuated`, a green nobody is using ends after its minimum when another phase has cars waiting, and
 * phases nobody waits for are passed over. Every change is kept, to tell the lights at an earlier time.
 */
export class SignalController {
  phase = 0;
  stage: "green" | "amber" | "allRed" = "green";
  /** seconds into the stage */
  into = 0;
  history: { t: number; phase: number; stage: "green" | "amber" | "allRed" }[] = [{ t: 0, phase: 0, stage: "green" }];
  constructor(public plan: SignalPlan, prev?: SignalController | null) {
    // (the same lights edited: carrying on where they were)
    if (prev && prev.plan.junction === plan.junction && prev.phase < plan.phases.length) {
      this.phase = prev.phase; this.stage = prev.stage; this.into = prev.into; this.history = prev.history;
    }
  }
  reset() { this.phase = 0; this.stage = "green"; this.into = 0; this.history = [{ t: 0, phase: 0, stage: "green" }]; }
  private go(t: number, phase: number, stage: "green" | "amber" | "allRed") {
    this.phase = phase; this.stage = stage; this.into = 0;
    this.history.push({ t, phase, stage });
    if (this.history.length > 5000) this.history.splice(0, this.history.length - 5000);
  }
  /** the lights moved on by `dt` seconds (to time `t`); `demand`: are cars coming up to a line for one of these connectors? */
  step(t: number, dt: number, demand: (conns: string[]) => boolean) {
    const P = this.plan, n = P.phases.length;
    if (!n) return;
    this.into += dt;
    const ph = P.phases[this.phase];
    if (this.stage === "green") {
      const others = P.actuated && n > 1 && P.phases.some((q, i) => i !== this.phase && q.conns.length && demand(q.conns));
      // (fixed: at the end of its green; actuated: then too if others wait, or after its minimum if nobody uses it and others wait. Nobody else waiting, it rests on green)
      if ((this.into >= ph.green && (!P.actuated || others)) || (P.actuated && others && this.into >= ph.minGreen && !demand(ph.conns))) this.go(t, this.phase, "amber");
    } else if (this.stage === "amber") {
      if (this.into >= P.amber) { if (P.allRed > 0) this.go(t, this.phase, "allRed"); else this.next(t, demand); }
    } else if (this.into >= P.allRed) this.next(t, demand);
  }
  /** on to the next phase (actuated: the next one cars wait for, if any does) */
  private next(t: number, demand: (conns: string[]) => boolean) {
    const n = this.plan.phases.length;
    let k = (this.phase + 1) % n;
    if (this.plan.actuated) for (let i = 1; i <= n; i++) { const q = (this.phase + i) % n; if (demand(this.plan.phases[q].conns)) { k = q; break; } }
    this.go(t, k, "green");
  }
  private stateIn(conn: string, phase: number, stage: "green" | "amber" | "allRed"): SignalState | null {
    if (!this.plan.controlled.includes(conn)) return null;
    if (!this.plan.phases[phase]?.conns.includes(conn) || stage === "allRed") return "red";
    return stage === "green" ? "green" : "amber";
  }
  /** a connector's light now (null: the lights don't hold it) */
  stateOf(conn: string): SignalState | null { return this.stateIn(conn, this.phase, this.stage); }
  /** a connector's light at time `t` (as it was then) */
  stateAt(conn: string, t: number): SignalState | null {
    let h = this.history[0];
    for (const x of this.history) { if (x.t > t) break; h = x; }
    return this.stateIn(conn, h.phase, h.stage);
  }
  /** the phase on at time `t`, and its stage */
  at(t: number) { let h = this.history[0]; for (const x of this.history) { if (x.t > t) break; h = x; } return h; }
}

/** every junction's lights, as plans (what the cars and the drawing go by) */
export function signalPlans(sk: Sketch): SignalPlan[] {
  return sk.junctions.flatMap(j => { const p = j.lights ? signalPlan(sk, j, junctionContents(sk, j)) : null; return p ? [p] : []; });
}

/** a lane's shape changed; connectors on it are kept within its new length */
export function reshape(sk: Sketch, id: string, shape: LaneShape, width?: number): Sketch {
  const L = laneLength(shape), clamp = (a: LaneAt) => (a.lane === id ? { ...a, s: Math.min(a.s, L) } : a);
  return {
    ...sk,
    lanes: sk.lanes.map(l => (l.id === id ? { ...l, shape, width: width ?? l.width } : l)),
    connectors: sk.connectors.map(c => ({ ...c, from: clamp(c.from), to: clamp(c.to) })),
  };
}

/**
 * Line lanes with fewer points: only their ends (`tol` undefined: straight), or (`tol` metres) the
 * points that keep them within `tol` of where they ran (Douglas-Peucker; curved points kept curved).
 * Rings and arcs are left as they are, and lanes following a lead (side by side). Connectors on them
 * stay where they were (at the nearest place on the new shape; at a start or an end, there).
 */
export function straightenLanes(sk: Sketch, ids: Iterable<string>, tol?: number): Sketch {
  const want = new Set(ids), changed = new Map<string, { old: LaneShape; shape: LaneShape }>();
  for (const l of sk.lanes) {
    const sh = l.shape;
    if (!want.has(l.id) || sh.kind !== "line" || sh.closed || sh.pts.length <= 2 || leadOf(sk, l.id)) continue;
    let keep: number[];
    if (tol === undefined) keep = [0, sh.pts.length - 1];
    else {
      // (kept: the points the run strays from by more than `tol` without them)
      const pts = sh.pts, k = new Uint8Array(pts.length), stack: [number, number][] = [[0, pts.length - 1]];
      k[0] = k[pts.length - 1] = 1;
      while (stack.length) {
        const [i0, i1] = stack.pop()!, A = pts[i0], B = pts[i1], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 1;
        let best = -1, bd = tol;
        for (let i = i0 + 1; i < i1; i++) { const d = Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L; if (d > bd) { bd = d; best = i; } }
        if (best >= 0) { k[best] = 1; stack.push([i0, best], [best, i1]); }
      }
      keep = [...k.keys()].filter(i => k[i]);
    }
    if (keep.length === sh.pts.length) continue;
    const curved = keep.map(i => !!sh.curved?.[i]);
    const shape: LaneShape = { kind: "line", pts: keep.map(i => sh.pts[i]), ...(curved.some(Boolean) ? { curved } : {}) };
    changed.set(l.id, { old: sh, shape });
  }
  if (!changed.size) return sk;
  const place = (a: LaneAt) => {
    const c = changed.get(a.lane);
    if (!c) return a;
    const L0 = laneLength(c.old), L1 = laneLength(c.shape);
    const s = a.s <= 0.01 ? 0 : a.s >= L0 - 0.01 ? L1 : nearestOn(c.shape, pointAt(c.old, a.s).p).s;
    return { ...a, s: Number(s.toFixed(2)) };
  };
  return {
    ...sk,
    lanes: sk.lanes.map(l => { const c = changed.get(l.id); return c ? { ...l, shape: c.shape } : l; }),
    connectors: sk.connectors.map(c => (changed.has(c.from.lane) || changed.has(c.to.lane) ? { ...c, from: place(c.from), to: place(c.to) } : c)),
  };
}

// ---------------------------------------------------------------- junctions

export function insidePolygon(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const mostlyInside = (pts: Pt[], poly: Pt[]) => pts.length > 0 && pts.filter(p => insidePolygon(p, poly)).length * 2 >= pts.length;

export function polygonArea(poly: Pt[]) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j].x + poly[i].x) * (poly[j].y - poly[i].y);
  return Math.abs(a / 2);
}

/**
 * What a junction's surface takes in: the lanes in no road and the connectors that are mostly on
 * it, and the roads those connectors join.
 */
const inRoads = new WeakMap<Sketch, Set<string>>();
/** every lane in a road (kept per sketch) */
function lanesInRoads(sk: Sketch) {
  let x = inRoads.get(sk);
  if (!x) inRoads.set(sk, (x = new Set(sk.roads.flatMap(r => r.lanes))));
  return x;
}

export function junctionContents(sk: Sketch, j: SketchJunction): JunctionContents {
  if (j.outline.length < 3) return { lanes: [], connectors: [], roads: [] };
  const inRoad = lanesInRoads(sk);
  const border = outlinePath(j);
  // (only what has a point in the border's box can be mostly on it)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of border) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const inBox = (p: Pt) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  const near = (pts: Pt[]) => inBox(pts[0]) || inBox(pts[pts.length - 1]) || inBox(pts[pts.length >> 1]);
  const lanes = sk.lanes.filter(l => { if (inRoad.has(l.id)) return false; const p = samples(l.shape, 1); return near(p) && mostlyInside(p, border); }).map(l => l.id);
  const connectors = sk.connectors.filter(c => { const p = connectorPts(sk, c); return p && near(p) && mostlyInside(p, border); });
  const roads = new Set<string>();
  for (const c of connectors) for (const e of [c.from, c.to]) { const r = roadOf(sk, e.lane); if (r) roads.add(r.id); }
  return { lanes, connectors: connectors.map(c => c.id), roads: [...roads] };
}

/** a band of surface: a path and how wide it is (`w1`: as wide at its end, the width easing from one to the other) */
export interface Band { pts: Pt[]; width: number; w1?: number; closed: boolean }
/** half a band's width a share `t` (0 to 1) of the way along it */
export function bandHalfWidth(b: Band, t: number) {
  if (b.w1 === undefined) return b.width / 2;
  const u = Math.max(0, Math.min(1, t)), e = u * u * (3 - 2 * u);
  return (b.width + (b.w1 - b.width) * e) / 2;
}
/** a band whose width changes as a polygon to fill, `extra` metres wider (its sides offset from its path) */
export function bandPolygon(b: Band, extra = 0): Pt[] {
  const pts = b.pts, n = pts.length, cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const L = cum[n - 1] || 1, left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(n - 1, i + 1)], l = dist(a, c) || 1, nx = -(c.y - a.y) / l, ny = (c.x - a.x) / l;
    const hw = bandHalfWidth(b, cum[i] / L) + extra / 2;
    left.push({ x: pts[i].x + nx * hw, y: pts[i].y + ny * hw }); right.push({ x: pts[i].x - nx * hw, y: pts[i].y - ny * hw });
  }
  return [...left, ...right.reverse()];
}
/** metres of a road's lane taken into a junction's automatic surface, either side of where a connector leaves or joins it */
const STUB = 2;
/**
 * A junction's automatic surface, as bands whose union it is: its connectors (as wide as the lanes
 * they join), the lanes on it, and the ends of the road lanes its connectors leave and join.
 */
const bandsKept = new WeakMap<JunctionContents, { sk: Sketch; bands: Band[] }>();
export function junctionBands(sk: Sketch, c: JunctionContents): Band[] {
  const k = bandsKept.get(c);
  if (k && k.sk === sk) return k.bands;
  const bands = junctionBandsOf(sk, c);
  bandsKept.set(c, { sk, bands });
  return bands;
}
function junctionBandsOf(sk: Sketch, c: JunctionContents): Band[] {
  const out: Band[] = [], inRoad = new Set(sk.roads.flatMap(r => r.lanes));
  const stretch = (sh: LaneShape, a: number, b: number) => { const n = Math.max(2, Math.ceil((b - a) / 0.5)); return Array.from({ length: n + 1 }, (_, i) => pointAt(sh, a + ((b - a) * i) / n).p); };
  for (const id of c.lanes) { const l = laneById(sk, id); if (l) out.push({ pts: samples(l.shape, 0.5), width: l.width, closed: isFullCircle(l.shape) }); }
  for (const id of c.connectors) {
    const cn = sk.connectors.find(x => x.id === id), pts = cn && connectorPts(sk, cn);
    if (!cn || !pts) continue;
    const from = laneById(sk, cn.from.lane)!, to = laneById(sk, cn.to.lane)!;
    out.push({ pts, width: from.width, ...(to.width !== from.width ? { w1: to.width } : {}), closed: false });
    if (inRoad.has(from.id) && cn.from.s > 0.01) out.push({ pts: stretch(from.shape, Math.max(0, cn.from.s - STUB), cn.from.s), width: from.width, closed: false });
    const L = laneLength(to.shape);
    if (inRoad.has(to.id) && cn.to.s < L - 0.01) out.push({ pts: stretch(to.shape, cn.to.s, Math.min(L, cn.to.s + STUB)), width: to.width, closed: false });
  }
  return out;
}
/** is `p` on one of the bands? */
export const onBands = (bands: Band[], p: Pt) => bands.some(b => {
  const sh: LaneShape = { kind: "line", pts: b.closed ? [...b.pts, b.pts[0]] : b.pts }, q = nearestOn(sh, p);
  return q.d <= bandHalfWidth(b, q.s / (laneLength(sh) || 1));
});

/**
 * The union of some bands with its notches rounded off to radius `r` (a closing: grown by `r`, then
 * shrunk back by `r`, so the convex corners, a road's end say, stay as they were), as closed loops
 * (the outside and any holes, a roundabout's island say: fill them even-odd). Worked out on a grid
 * about a quarter metre fine.
 */
export function smoothSurface(bands: Band[], r: number): Pt[][] {
  const all = bands.flatMap(b => b.pts), bb = boundsOfPts(all);
  if (!bb) return [];
  const reach = Math.max(...bands.map(b => Math.max(b.width, b.w1 ?? 0) / 2)) + r;
  const x0 = bb.minX - reach - 1, y0 = bb.minY - reach - 1, w = bb.maxX - x0 + reach + 1, h = bb.maxY - y0 + reach + 1;
  const cell = Math.max(0.2, Math.sqrt((w * h) / 250_000)), nx = Math.ceil(w / cell) + 1, ny = Math.ceil(h / cell) + 1;
  // grown: within `r` of a band
  const grown = new Uint8Array(nx * ny);
  for (const b of bands) {
    const pts = b.closed ? [...b.pts, b.pts[0]] : b.pts;
    let total = 0, acc = 0;
    for (let k = 1; k < pts.length; k++) total += dist(pts[k - 1], pts[k]);
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], c = pts[k], dx = c.x - a.x, dy = c.y - a.y, l2 = dx * dx + dy * dy, sl = Math.sqrt(l2);
      // (as wide as the band is along this piece, at its widest)
      const hw0 = bandHalfWidth(b, acc / (total || 1)), hw1 = bandHalfWidth(b, (acc + sl) / (total || 1)), lim = Math.max(hw0, hw1) + r;
      acc += sl;
      const i0 = Math.max(0, Math.floor((Math.min(a.x, c.x) - lim - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, c.x) + lim - x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(a.y, c.y) - lim - y0) / cell)), j1 = Math.min(ny - 1, Math.ceil((Math.max(a.y, c.y) + lim - y0) / cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        if (grown[j * nx + i]) continue;
        const px = x0 + i * cell, py = y0 + j * cell, t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
        if (Math.hypot(px - a.x - dx * t, py - a.y - dy * t) <= hw0 + (hw1 - hw0) * t + r) grown[j * nx + i] = 1;
      }
    }
  }
  // shrunk back: how far each point of it is from outside it (an exact distance transform), less `r`
  const INF = 1e20, d2 = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) d2[k] = grown[k] ? INF : 0;
  const f = new Float64Array(Math.max(nx, ny)), out = new Float64Array(Math.max(nx, ny)), v = new Int32Array(Math.max(nx, ny)), z = new Float64Array(Math.max(nx, ny) + 1);
  const pass = (n: number, get: (q: number) => number, set: (q: number, x: number) => void) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) { k--; s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) { while (z[k + 1] < q) k++; out[q] = (q - v[k]) ** 2 + f[v[k]]; }
    for (let q = 0; q < n; q++) set(q, out[q]);
  };
  for (let i = 0; i < nx; i++) pass(ny, q => d2[q * nx + i], (q, x) => { d2[q * nx + i] = x; });
  for (let j = 0; j < ny; j++) pass(nx, q => d2[j * nx + q], (q, x) => { d2[j * nx + q] = x; });
  const g = (i: number, j: number) => Math.sqrt(d2[j * nx + i]) * cell - r;
  // its edge, where that is 0 (marching squares), the pieces chained into loops
  const at = (i: number, j: number, i2: number, j2: number) => {
    const a = g(i, j), b = g(i2, j2), t = a === b ? 0.5 : a / (a - b);
    return { x: x0 + (i + (i2 - i) * t) * cell, y: y0 + (j + (j2 - j) * t) * cell };
  };
  const next = new Map<string, { to: string; p: Pt }>();
  const seg = (ka: string, kb: string, pa: Pt) => next.set(ka, { to: kb, p: pa });
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = g(i, j) >= 0, b = g(i + 1, j) >= 0, c = g(i + 1, j + 1) >= 0, d = g(i, j + 1) >= 0;
    const code = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (d ? 1 : 0);
    if (code === 0 || code === 15) continue;
    // the cell's edges: top, right, bottom, left (each keyed so neighbours share it)
    const T = { k: `h${i},${j}`, p: () => at(i, j, i + 1, j) }, R = { k: `v${i + 1},${j}`, p: () => at(i + 1, j, i + 1, j + 1) };
    const B = { k: `h${i},${j + 1}`, p: () => at(i, j + 1, i + 1, j + 1) }, L = { k: `v${i},${j}`, p: () => at(i, j, i, j + 1) };
    const link = (e1: typeof T, e2: typeof T) => seg(e1.k, e2.k, e1.p());
    const mid = (g(i, j) + g(i + 1, j) + g(i + 1, j + 1) + g(i, j + 1)) / 4 >= 0;
    switch (code) {
      case 1: link(L, B); break; case 2: link(B, R); break; case 3: link(L, R); break; case 4: link(R, T); break;
      case 5: if (mid) { link(L, T); link(R, B); } else { link(L, B); link(R, T); } break;
      case 6: link(B, T); break; case 7: link(L, T); break; case 8: link(T, L); break; case 9: link(T, B); break;
      case 10: if (mid) { link(T, R); link(B, L); } else { link(T, L); link(B, R); } break;
      case 11: link(T, R); break; case 12: link(R, L); break; case 13: link(R, B); break; case 14: link(B, L); break;
    }
  }
  const loops: Pt[][] = [];
  for (const start of [...next.keys()]) {
    if (!next.has(start)) continue;
    const loop: Pt[] = [];
    let k: string | undefined = start;
    while (k !== undefined && next.has(k)) { const s: { to: string; p: Pt } = next.get(k)!; next.delete(k); loop.push(s.p); k = s.to; }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}
/** is `p` inside the loops (even-odd)? */
export const insideLoops = (p: Pt, loops: Pt[][]) => loops.filter(l => insidePolygon(p, l)).length % 2 === 1;
/** the radius a smoothed junction's notches are rounded off to, by default (metres) */
export const SMOOTH_R = 6;
const smoothed = new WeakMap<Sketch, Map<string, Pt[][]>>();
/** a smoothed automatic junction's surface (kept while the sketch is the same) */
export function smoothJunction(sk: Sketch, j: SketchJunction, c: JunctionContents): Pt[][] {
  let m = smoothed.get(sk);
  if (!m) smoothed.set(sk, (m = new Map()));
  const key = `${j.id}:${j.smooth}`;
  let loops = m.get(key);
  if (!loops) m.set(key, (loops = smoothSurface(junctionBands(sk, c), j.smooth ?? SMOOTH_R)));
  return loops;
}

/**
 * A road's markings, as on the plan's map: between lanes of a road running side by side the same
 * way, a dashed lane line; between ones running opposite ways, the centre line (dashed where the road
 * has a lane each way, a double solid line where it has more). Found where a lane has another of its
 * road beside it on its left, edge to edge (within half a metre).
 */
export interface Marking { pts: Pt[]; kind: "lane" | "center"; dashed: boolean }
const markings = new WeakMap<Sketch, Marking[]>();
/** a polyline moved `o` metres to its left (each point along the normal there) */
function offsetPolyline(pts: Pt[], o: number): Pt[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], c = pts[Math.min(pts.length - 1, i + 1)], l = dist(a, c) || 1;
    return { x: p.x + ((c.y - a.y) / l) * o, y: p.y - ((c.x - a.x) / l) * o };
  });
}
export function roadMarkings(sk: Sketch): Marking[] {
  const cached = markings.get(sk);
  if (cached) return cached;
  const out: Marking[] = [];
  for (const road of sk.roads) {
    const lanes = road.lanes.map(id => laneById(sk, id)).filter((l): l is SketchLane => !!l);
    for (const a of lanes) {
      const L = laneLength(a.shape), n = Math.max(2, Math.ceil(L / 0.5));
      let run: Pt[] = [], runWith: { b: SketchLane; same: boolean } | null = null;
      const flush = () => {
        if (runWith && run.length >= 2) {
          if (runWith.same) out.push({ pts: run, kind: "lane", dashed: true });
          else if (lanes.length <= 2) out.push({ pts: run, kind: "center", dashed: true });
          else for (const o of [-0.15, 0.15]) out.push({ pts: offsetPolyline(run, o), kind: "center", dashed: false });
        }
        run = []; runWith = null;
      };
      for (let i = 0; i <= n; i++) {
        const { p, d } = pointAt(a.shape, (L * i) / n), left = { x: d.y, y: -d.x };
        let hit: { b: SketchLane; same: boolean } | null = null;
        for (const b of lanes) {
          if (b === a) continue;
          const off = (a.width + b.width) / 2, q = { x: p.x + left.x * off, y: p.y + left.y * off }, near = nearestOn(b.shape, q);
          if (near.d > 0.5) continue;
          const db = pointAt(b.shape, near.s).d, same = db.x * d.x + db.y * d.y > 0;
          // (a line between lanes running opposite ways is found from both: kept from one)
          if (!same && a.id > b.id) continue;
          hit = { b, same };
          break;
        }
        if (!hit || (runWith && (runWith.b !== hit.b || runWith.same !== hit.same))) flush();
        if (hit) { runWith = hit; run.push({ x: p.x + left.x * (a.width / 2), y: p.y + left.y * (a.width / 2) }); }
      }
      flush();
    }
  }
  for (const k of sk.links ?? []) out.push(...(linkGeometry(sk, k)?.lines ?? []));
  markings.set(sk, out);
  return out;
}

export function convexHull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lo: Pt[] = [], hi: Pt[] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.reverse()) { while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}

/** a surface around some points: their convex hull, `pad` metres out from its middle */
export function surfaceAround(pts: Pt[], pad = 2): Pt[] {
  const h = convexHull(pts);
  if (h.length < 3) return [];
  const c = { x: h.reduce((a, p) => a + p.x, 0) / h.length, y: h.reduce((a, p) => a + p.y, 0) / h.length };
  return h.map(p => { const l = dist(p, c) || 1; return { x: Number((p.x + ((p.x - c.x) / l) * pad).toFixed(2)), y: Number((p.y + ((p.y - c.y) / l) * pad).toFixed(2)) }; });
}

/**
 * The lanes cars come in on: those (not rings) that nothing joins near their start (within `ENTRY_CLEAR`
 * metres; one joined further along, a road a side street joins, is an entry still).
 */
export const ENTRY_CLEAR = 10;
/** a lane leads nowhere (cars leave the sketch at its end) only if nothing leaves it within its last `EXIT_CLEAR` metres */
export const EXIT_CLEAR = 10;
const entries = new WeakMap<Sketch, SketchLane[]>(), exits = new WeakMap<Sketch, SketchLane[]>();
export function entryLanes(sk: Sketch): SketchLane[] {
  let x = entries.get(sk);
  if (x) return x;
  const fed = new Set(sk.connectors.filter(c => c.to.s < ENTRY_CLEAR).map(c => c.to.lane));
  entries.set(sk, (x = sk.lanes.filter(l => !isFullCircle(l.shape) && !fed.has(l.id))));
  return x;
}

/** the lanes cars leave the sketch by: those (not rings) that nothing leaves within their last `EXIT_CLEAR` metres */
export function exitLanes(sk: Sketch): SketchLane[] {
  let x = exits.get(sk);
  if (x) return x;
  // (the furthest any connector leaves each lane)
  const last = new Map<string, number>();
  for (const c of sk.connectors) last.set(c.from.lane, Math.max(last.get(c.from.lane) ?? -Infinity, c.from.s));
  exits.set(sk, (x = sk.lanes.filter(l => !isFullCircle(l.shape) && !((last.get(l.id) ?? -Infinity) > laneLength(l.shape) - EXIT_CLEAR))));
  return x;
}

/** metres a lane change counts for in a route (it is slower and harder than driving on) */
export const CHANGE_COST = 25;

/**
 * How far it is to each exit (metres, by the shortest way): from the start of every connector, and
 * from anywhere on a lane (`from`), going on along it, taking the connectors that leave it further
 * on, or changing to a lane beside it of the same road running the same way. Worked out per exit when
 * first asked for (a shortest-path search back from the exit over the connectors).
 */
export class RouteTable {
  readonly exits: string[];
  private lanes = new Map<string, { lane: SketchLane; len: number; ring: boolean; outs: { id: string; s: number }[]; ins: { id: string; s: number }[]; beside: { id: string; map: (s: number) => number }[] }>();
  private connLen = new Map<string, number>();
  private conns = new Map<string, SketchConnector>();
  /** per exit: metres from the start of each connector (missing: can't get there) */
  private tables = new Map<string, Map<string, number>>();
  /** per lane: the lanes it is beside of, and how a place on those maps onto it */
  private besideOf = new Map<string, { from: string; map: (s: number) => number }[]>();

  constructor(sk: Sketch) {
    for (const l of sk.lanes) this.lanes.set(l.id, { lane: l, len: laneLength(l.shape), ring: isFullCircle(l.shape), outs: [], ins: [], beside: [] });
    for (const c of sk.connectors) {
      const p = connectorPts(sk, c), from = this.lanes.get(c.from.lane), to = this.lanes.get(c.to.lane);
      if (!p || !from || !to) continue;
      let L = 0;
      for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]);
      this.connLen.set(c.id, L); this.conns.set(c.id, c);
      from.outs.push({ id: c.id, s: c.from.s });
      to.ins.push({ id: c.id, s: c.to.s });
    }
    // (lanes side by side in a road, the same way: where on the other a place on one is beside)
    for (const r of sk.roads) for (const a of r.lanes) for (const b of r.lanes) {
      const A = this.lanes.get(a), Bl = this.lanes.get(b);
      if (!A || !Bl || a === b || A.ring || Bl.ring) continue;
      const m = pointAt(A.lane.shape, A.len / 2), q = nearestOn(Bl.lane.shape, m.p), d = pointAt(Bl.lane.shape, q.s).d;
      if (q.d > (A.lane.width + Bl.lane.width) / 2 + 0.75 || m.d.x * d.x + m.d.y * d.y < 0.5) continue;
      const map = (s: number) => nearestOn(Bl.lane.shape, pointAt(A.lane.shape, s).p).s;
      A.beside.push({ id: b, map });
      (this.besideOf.get(b) ?? this.besideOf.set(b, []).get(b)!).push({ from: a, map });
    }
    this.exits = exitLanes(sk).map(l => l.id);
  }

  /** may a car at `s` on lane `L` take something leaving it at `to` (as the cars do: half a metre on at least, or the lane's very end) */
  private reach(L: { len: number; ring: boolean }, s: number, to: number) {
    const a = L.ring ? (((to - s) % L.len) + L.len) % L.len : to - s;
    return a > 0.5 || (!L.ring && to >= L.len - 0.01 && s < L.len - 0.01) ? Math.max(0, a) : null;
  }

  /** the exit's table: a shortest-path search back from it, over the connectors that lead (on along lanes, or changing once beside) to it */
  private table(exit: string): Map<string, number> {
    let cost = this.tables.get(exit);
    if (cost) return cost;
    cost = new Map();
    this.tables.set(exit, cost);
    const X = this.lanes.get(exit);
    if (!X) return cost;
    // a small binary heap of [cost, connector]
    const heap: [number, string][] = [];
    const push = (c: number, id: string) => {
      if (c >= (cost!.get(id) ?? Infinity) - 1e-9) return;
      cost!.set(id, c); heap.push([c, id]);
      for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
    };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) { heap[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
      return top;
    };
    /** the connectors that come onto lane `lane` (or, with a change, onto a lane beside it) before `s`, with what they would cost from there */
    const back = (laneId: string, s: number, onward: number) => {
      const L = this.lanes.get(laneId)!;
      for (const i of L.ins) { const a = this.reach(L, i.s, s); if (a !== null) push(this.connLen.get(i.id)! + a + onward, i.id); }
      // (from a lane beside it: coming onto that one, then changing over)
      for (const b of this.besideOf.get(laneId) ?? []) {
        for (const i of this.lanes.get(b.from)!.ins) { const a = this.reach(L, b.map(i.s), s); if (a !== null) push(this.connLen.get(i.id)! + CHANGE_COST + a + onward, i.id); }
      }
    };
    // (driving off the exit's end)
    back(exit, X.len, 0);
    const done = new Set<string>();
    while (heap.length) {
      const [c, id] = pop();
      if (done.has(id) || c > (cost.get(id) ?? Infinity) + 1e-9) continue;
      done.add(id);
      // taking connector `id` from where it leaves its lane: those coming onto that lane before it
      const cx = this.conns.get(id)!;
      back(cx.from.lane, cx.from.s, c);
    }
    return cost;
  }

  /** metres from `s` on a lane to an exit, taking a connector further on or driving off its end (`change`: may change lane once more) */
  private fromLane(lane: string, s: number, exit: string, cost: Map<string, number>, change: boolean): number {
    const L = this.lanes.get(lane);
    if (!L) return Infinity;
    let best = lane === exit ? (this.reach(L, s, L.len) ?? Infinity) : Infinity;
    for (const o of L.outs) {
      const a = this.reach(L, s, o.s), c = cost.get(o.id);
      if (a !== null && c !== undefined) best = Math.min(best, a + c);
    }
    if (change) for (const b of L.beside) best = Math.min(best, CHANGE_COST + this.fromLane(b.id, b.map(s), exit, cost, false));
    return best;
  }

  /** metres from `s` on a lane to an exit (Infinity: it can't be reached from there) */
  from(lane: string, s: number, exit: string): number { return this.lanes.has(exit) ? this.fromLane(lane, s, exit, this.table(exit), true) : Infinity; }
  /** metres from the start of a connector to an exit */
  viaConnector(conn: string, exit: string): number { return this.table(exit).get(conn) ?? Infinity; }
  /** the exits that can be reached from `s` on a lane */
  reachable(lane: string, s = 0): string[] { return this.exits.filter(ex => this.from(lane, s, ex) < Infinity); }
}

/**
 * The ways in and out of a sketch, as traffic is set on them: its entry and exit lanes, those of a
 * road whose starts (entries) or ends (exits) are close together taken as one (a road's end), each
 * lane in no road on its own.
 */
export interface DemandWay { key: string; name: string; lanes: string[]; at: Pt }
const ways = new WeakMap<Sketch, { entries: DemandWay[]; exits: DemandWay[] }>();
export function demandWays(sk: Sketch): { entries: DemandWay[]; exits: DemandWay[] } {
  let x = ways.get(sk);
  if (!x) ways.set(sk, (x = demandWaysOf(sk)));
  return x;
}
function demandWaysOf(sk: Sketch): { entries: DemandWay[]; exits: DemandWay[] } {
  const group = (lanes: SketchLane[], atEnd: boolean) => {
    const out: DemandWay[] = [];
    for (const l of lanes) {
      const p = pointAt(l.shape, atEnd ? laneLength(l.shape) : 0).p, road = roadOf(sk, l.id);
      const g = road && out.find(w => w.key.startsWith(`${road.id}@`) && dist(w.at, p) < 4 * LANE_WIDTH);
      if (g) { g.lanes.push(l.id); continue; }
      const n = road ? out.filter(w => w.key.startsWith(`${road.id}@`)).length : 0;
      out.push({ key: road ? `${road.id}@${n}` : `lane:${l.id}`, name: road ? road.name + (n ? ` (${n + 1})` : "") : `Lane ${l.id}`, lanes: [l.id], at: p });
    }
    return out;
  };
  return { entries: group(entryLanes(sk), false), exits: group(exitLanes(sk), true) };
}
/** traffic set on lanes: vehicles per hour coming in spread evenly over them (null: back to the sketch's rate), or a share of trips out on each */
export function setInRate(sk: Sketch, lanes: string[], total: number | null): Sketch {
  return { ...sk, lanes: sk.lanes.map(l => { if (!lanes.includes(l.id)) return l; const n = { ...l }; if (total === null) delete n.inRate; else n.inRate = Number((total / lanes.length).toFixed(1)); return n; }) };
}
export function setOutWeight(sk: Sketch, lanes: string[], weight: number | null): Sketch {
  return { ...sk, lanes: sk.lanes.map(l => { if (!lanes.includes(l.id)) return l; const n = { ...l }; if (weight === null || weight === 1) delete n.outWeight; else n.outWeight = weight; return n; }) };
}

/** the traffic coming in on an entry lane (veh/h): its own, or the sketch's for every entry */
export const laneInRate = (l: SketchLane, sk: Sketch) => l.inRate ?? sk.traffic?.rate ?? 400;
/** an exit lane's share of the trips (relative; 0: closed) */
export const laneOutWeight = (l: SketchLane) => l.outWeight ?? 1;

// ---------------------------------------------------------------- stored

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0 && x.length <= 64;
const pt = (x: unknown): Pt | null => { const o = x as Pt; return o && num(o.x) && num(o.y) ? { x: o.x, y: o.y } : null; };
const pts = (x: unknown, min: number): Pt[] | null => { if (!Array.isArray(x)) return null; const out = x.map(pt).filter((p): p is Pt => !!p); return out.length >= min ? out : null; };

/**
 * A sketch as stored with a plan (or sent to be saved), checked over: anything malformed dropped, and what
 * refers to it with it. Null when there is nothing in it.
 */
/** a junction's lights as stored, kept within sensible times */
function lightsOf(x: unknown): { lights?: JunctionLights } {
  const L = x as Partial<JunctionLights> | null;
  if (!L || typeof L !== "object") return {};
  const t = (v: unknown, lo: number, hi: number, d: number) => (num(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const D = DEFAULT_LIGHTS;
  const phases = Array.isArray(L.phases) ? L.phases.slice(0, MAX_PHASES).flatMap(p => (p && typeof p === "object" ? [{
    ...(typeof p.name === "string" && p.name ? { name: p.name.slice(0, 40) } : {}), green: t(p.green, 3, 180, D.green),
    ...(num(p.minGreen) ? { minGreen: t(p.minGreen, 1, 60, D.minGreen) } : {}), conns: Array.isArray(p.conns) ? p.conns.filter((c): c is string => typeof c === "string") : [],
  }] : [])) : [];
  return { lights: {
    green: t(L.green, 3, 180, D.green), amber: t(L.amber, 0, 10, D.amber), allRed: t(L.allRed, 0, 15, D.allRed), mode: L.mode === "each" ? "each" : "pairs",
    minGreen: t(L.minGreen, 1, 60, D.minGreen), actuated: typeof L.actuated === "boolean" ? L.actuated : D.actuated, ...(phases.length ? { phases } : {}),
  } };
}

export function sanitizeSketch(raw: unknown): Sketch | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const lanes: SketchLane[] = [];
  for (const l of Array.isArray(o.lanes) ? o.lanes : []) {
    const sh = l?.shape;
    let shape: LaneShape | null = null;
    if (sh?.kind === "line") {
      const p = pts(sh.pts, 2);
      if (p) shape = { kind: "line", pts: p, ...(Array.isArray(sh.curved) && sh.curved.length === p.length ? { curved: sh.curved.map(Boolean) } : {}), ...(sh.closed === true && p.length >= 3 ? { closed: true as const } : {}) };
    } else if (sh?.kind === "arc" && pt(sh.c) && num(sh.r) && sh.r > 0 && num(sh.a0) && num(sh.sweep) && Math.abs(sh.sweep) <= 2 * Math.PI + 1e-6) {
      shape = { kind: "arc", c: pt(sh.c)!, r: sh.r, a0: sh.a0, sweep: sh.sweep };
    }
    if (!str(l?.id) || !shape || lanes.some(x => x.id === l.id)) continue;
    lanes.push({ id: l.id, shape, width: num(l.width) ? Math.min(8, Math.max(2, l.width)) : LANE_WIDTH, ...(l.control === "stop" || l.control === "yield" ? { control: l.control } : {}),
      ...(num(l.inRate) && l.inRate >= 0 ? { inRate: Math.min(5000, l.inRate) } : {}), ...(num(l.outWeight) && l.outWeight >= 0 ? { outWeight: Math.min(100, l.outWeight) } : {}) });
  }
  const ids = new Set(lanes.map(l => l.id));
  // (a place a hair before a lane's start, from rounding, is its start)
  const at = (a: unknown): LaneAt | null => { const x = a as LaneAt; return x && ids.has(x.lane) && num(x.s) && x.s > -1 ? { lane: x.lane, s: Math.max(0, x.s) } : null; };
  const connectors: SketchConnector[] = [];
  for (const c of Array.isArray(o.connectors) ? o.connectors : []) {
    const from = at(c?.from), to = at(c?.to), via = pts(c?.via, 1);
    if (!str(c?.id) || !from || !to || connectors.some(x => x.id === c.id)) continue;
    connectors.push({ id: c.id, from, to, ...(via ? { via } : {}) });
  }
  const roads: SketchRoad[] = [];
  for (const r of Array.isArray(o.roads) ? o.roads : []) {
    const rl = Array.isArray(r?.lanes) ? [...new Set((r.lanes as unknown[]).filter((x): x is string => typeof x === "string" && ids.has(x)))] : [];
    if (!str(r?.id) || !rl.length || roads.some(x => x.id === r.id)) continue;
    const al = r.align;
    const align = al && typeof al.ref === "string" && rl.includes(al.ref) && Array.isArray(al.lanes)
      ? { ref: al.ref as string, lanes: (al.lanes as { id: unknown; offset: unknown; reverse: unknown }[]).filter(x => typeof x?.id === "string" && rl.includes(x.id) && num(x.offset)).map(x => ({ id: x.id as string, offset: x.offset as number, reverse: !!x.reverse })) }
      : undefined;
    roads.push({ id: r.id, name: typeof r.name === "string" ? r.name.slice(0, 80) : r.id, lanes: rl, ...(align ? { align } : {}) });
  }
  const junctions: SketchJunction[] = [];
  for (const j of Array.isArray(o.junctions) ? o.junctions : []) {
    const outline = pts(j?.outline, 3);
    if (!str(j?.id) || !outline || junctions.some(x => x.id === j.id)) continue;
    const curved = Array.isArray(j.curved) && j.curved.length === outline.length ? { curved: (j.curved as unknown[]).map(Boolean) } : {};
    junctions.push({ id: j.id, name: typeof j.name === "string" ? j.name.slice(0, 80) : j.id, outline, ...curved, ...(j.shape === "auto" ? { shape: "auto" as const } : {}), ...(num(j.smooth) && j.smooth > 0 ? { smooth: Math.min(50, j.smooth) } : {}), ...lightsOf(j.lights) });
  }
  const g = o.geo as Sketch["geo"];
  const geo = g && num(g.lat) && num(g.lon) && Math.abs(g.lat) <= 85 && Math.abs(g.lon) <= 180 ? { lat: g.lat, lon: g.lon } : undefined;
  const t = o.traffic as Sketch["traffic"];
  const traffic = t && num(t.rate) && num(t.speed) ? { rate: Math.min(3000, Math.max(0, t.rate)), speed: Math.min(130, Math.max(10, t.speed)) } : undefined;
  const end = (e: unknown): RoadEnd | null => { const x = e as RoadEnd; return x && roads.some(r => r.id === x.road) && (x.end === "start" || x.end === "end") ? { road: x.road, end: x.end } : null; };
  const links: SketchLink[] = [];
  for (const k of Array.isArray(o.links) ? o.links : []) {
    const a = end(k?.a), b = end(k?.b);
    if (!str(k?.id) || !a || !b || links.some(x => x.id === k.id)) continue;
    links.push({ id: k.id, a, b, conns: Array.isArray(k.conns) ? (k.conns as unknown[]).filter((c): c is string => typeof c === "string" && connectors.some(x => x.id === c)) : [] });
  }
  // (nothing drawn and nowhere placed: no sketch)
  if (!lanes.length && !junctions.length && !geo) return null;
  return { lanes, connectors, roads, junctions, ...(links.length ? { links } : {}), ...(traffic ? { traffic } : {}), ...(geo ? { geo } : {}) };
}
