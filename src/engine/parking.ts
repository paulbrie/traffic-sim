/**
 * Rows of parking bays (ParkingDef) laid out along the kerb of a road, or standing on their own anywhere
 * (reached from the road nearest them): where each bay is, as the renderers draw it and the simulation
 * parks cars in it. Framework-free.
 */
import type { Edge } from "./compile";
import { Poly, connectorPoints, cubicPoints } from "./geom";
import { BAY_SIZE, PARKING, type Network, type ParkingDef, type Vec } from "./types";

/** one bay: the middle of its opening, the direction along the row, and the direction into the bay */
export interface BayFrame { k: Vec; t: Vec; n: Vec }

export interface CParking {
  idx: number; def: ParkingDef;
  /** the road direction cars reach it from, and the lane they stop in: its kerb lane, or beside a bus lane (cars cross it) */
  edge: Edge; lane: number;
  /** where cars stop for each bay, along the edge (m on its trimmed centreline) */
  bays: number[];
  /** each bay's place */
  frames: BayFrame[];
  /** bay size across and deep (m), angle to the row (rad; 0 = parallel), spacing along it (m) */
  w: number; l: number; alpha: number; pitch: number;
  /** a row standing on its own (not along the kerb): cars turn in and out of it */
  free: boolean;
  /** each bay's way in from its lane and out to it */
  access: BayAccess[];
}

/** a car's length as the bays' paths are laid out for (cars vary a little) */
export const CAR_LEN = 4.6;
/**
 * How a car gets into a bay and out of it (its connector to the lane): it leaves the lane where its front
 * is at `sIn` (m along the edge) and drives `inPath` (its front's path) into the bay; it comes out along
 * `outPath` — reversing (the rear's path; perpendicular and angled bays) or driving forwards (the front's;
 * parallel bays) — ending with its front at `sOut` in the lane, facing the traffic.
 */
export interface BayAccess {
  sIn: number; sOut: number; inPath: Poly; outPath: Poly; reverse: boolean;
  /** the lane it is in once out (backing out of a perpendicular or angled bay, the one its reverse ends in) */
  outLane: number;
}

/** the rows of bays on roads that exist (and have lanes that way) */
export function compileParking(net: Network, edgeByKey: Map<string, Edge>): CParking[] {
  const out: CParking[] = [];
  for (const def of net.parking ?? []) {
    const edge = edgeByKey.get(`${def.link}:${def.dir}`);
    // (not from a bus lane: from the lane beside it; a road that way only for buses has no parking)
    if (!edge || !edge.lanes.length || edge.length < 2 || edge.busOnly || (edge.bus && edge.kerb < 1)) continue;
    const size = BAY_SIZE[def.kind], w = def.bayW ?? size.w, l = def.bayL ?? size.l;
    const alpha = def.kind === "parallel" ? 0 : def.kind === "perpendicular" ? Math.PI / 2 : ((def.angle ?? PARKING.angle) * Math.PI) / 180;
    const pitch = def.kind === "parallel" ? l : w / Math.sin(alpha);
    // (the bays line the kerb; cars reach them from `lane`)
    const lane = edge.bus ? edge.kerb - 1 : edge.kerb, lp = edge.lanes[edge.kerb], toEdge = edge.length / Math.max(1e-6, lp.len);
    let bays: number[], frames: BayFrame[];
    if (def.line) {
      // standing on its own: bays along the line, each reached from the nearest point of the kerb lane
      const { a, b, side } = def.line, L = Math.hypot(b.x - a.x, b.y - a.y), t = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
      const n = { x: -t.y * side, y: t.x * side }, count = Math.floor(L / pitch + 1e-6);
      if (count <= 0) continue;
      const start = (L - count * pitch) / 2;
      frames = Array.from({ length: count }, (_, i) => ({ k: { x: a.x + t.x * (start + pitch * (i + 0.5)), y: a.y + t.y * (start + pitch * (i + 0.5)) }, t, n }));
      bays = frames.map(f => Math.min(edge.length - 0.5, Math.max(0.5, lp.poly.project(f.k.x, f.k.y).s * toEdge)));
    } else {
      // from..to is along the road as drawn (from → to); this direction may run the other way
      const full = edge.center.len, at = (t: number) => (edge.dir === 1 ? t : 1 - t) * full - edge.trimA;
      const s0 = Math.max(0, Math.min(at(def.from), at(def.to))), s1 = Math.min(edge.length, Math.max(at(def.from), at(def.to)));
      const count = Math.floor((s1 - s0) / pitch + 1e-6);
      if (count <= 0) continue;
      const start = s0 + (s1 - s0 - count * pitch) / 2;
      bays = Array.from({ length: count }, (_, i) => start + pitch * (i + 0.5));
      frames = bays.map(s => {
        const sl = s / toEdge, c = lp.poly.at(sl), t = lp.poly.tangent(sl);
        // (the kerb is on the right of the traffic: y runs south, so right of (x, y) is (−y, x))
        const n = { x: -t.y, y: t.x }, off = edge.lw / 2 + (def.gap ?? 0);
        return { k: { x: c.x + n.x * off, y: c.y + n.y * off }, t, n };
      });
    }
    const row: CParking = { idx: out.length, def, edge, lane, bays, frames, w, l, alpha, pitch, free: !!def.line, access: [] };
    row.access = bays.map((_, i) => bayAccess(row, i));
    out.push(row);
  }
  return out;
}

/** the direction a car in the bay faces: along the row for parallel bays, else into the bay at its angle */
function axis(p: CParking, f: BayFrame): Vec {
  return p.alpha === 0 ? f.t : { x: f.t.x * Math.cos(p.alpha) + f.n.x * Math.sin(p.alpha), y: f.t.y * Math.cos(p.alpha) + f.n.y * Math.sin(p.alpha) };
}

/** a bay's outline: its opening along the row, then back to its far side (a parallelogram for angled bays) */
export function bayOutline(p: CParking, i: number): Vec[] {
  const f = p.frames[i], h = p.pitch / 2, ax = axis(p, f);
  // into the bay: across the row for parallel bays (their width), else along the bay's axis (its depth)
  const d = p.alpha === 0 ? { x: f.n.x * p.w, y: f.n.y * p.w } : { x: ax.x * p.l, y: ax.y * p.l };
  const a = { x: f.k.x - f.t.x * h, y: f.k.y - f.t.y * h }, b = { x: f.k.x + f.t.x * h, y: f.k.y + f.t.y * h };
  return [a, b, { x: b.x + d.x, y: b.y + d.y }, { x: a.x + d.x, y: a.y + d.y }];
}

/** a car parked in a bay: its middle and the way it faces (unit), nose in */
export function bayPose(p: CParking, i: number): { x: number; y: number; hx: number; hy: number } {
  const q = bayOutline(p, i), x = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, y = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
  const h = axis(p, p.frames[i]);
  return { x, y, hx: h.x, hy: h.y };
}

/**
 * A row's two ends (the handles that stretch it): a free-standing row's line ends; along a kerb, the ends
 * of its bays, the first one at `from` and the second at `to` (along the road as drawn).
 */
export function rowEnds(p: CParking): [Vec, Vec] {
  if (p.def.line) return [p.def.line.a, p.def.line.b];
  const f0 = p.frames[0], f1 = p.frames[p.frames.length - 1], h = p.pitch / 2;
  const lo = { x: f0.k.x - f0.t.x * h, y: f0.k.y - f0.t.y * h }, hi = { x: f1.k.x + f1.t.x * h, y: f1.k.y + f1.t.y * h };
  // (bays run along the traffic: from → to the other way when it drives against the road's drawing direction)
  return p.edge.dir === 1 ? [lo, hi] : [hi, lo];
}

/** a bay's way in and out (see BayAccess): smooth curves between the kerb lane and the bay */
function bayAccess(p: CParking, i: number): BayAccess {
  const e = p.edge, lp = e.lanes[p.lane], f = lp.len / Math.max(1e-6, e.length);
  const at = (s: number) => { const sl = Math.min(lp.len, Math.max(0, s * f)); return { pt: lp.poly.at(sl), t: lp.poly.tangent(sl) }; };
  const clampS = (s: number) => Math.min(e.length - 0.5, Math.max(0.5, s));
  const pose = bayPose(p, i), c = { x: pose.x, y: pose.y }, h = { x: pose.hx, y: pose.hy }, half = CAR_LEN / 2;
  const sK = p.bays[i], k = at(sK).pt, fr = p.frames[i];
  // (how far before the bay a car leaves the lane: enough to turn in; a parallel bay is entered along it)
  const side = Math.hypot(fr.k.x - k.x, fr.k.y - k.y), d0 = p.alpha === 0 ? p.l + 2 : Math.min(15, Math.max(3, side + 1));
  const sIn = clampS(sK - d0), a = at(sIn), front = { x: c.x + h.x * half, y: c.y + h.y * half };
  // (into a perpendicular or angled bay straight along it, from just outside its opening: the car is lined up
  // before it is between its neighbours; a parallel bay is entered along the kerb)
  const straight = p.alpha === 0 ? 0 : half + p.l / 2 + 0.3;
  const line = (from: { x: number; y: number }, dir: { x: number; y: number }, len: number) => Array.from({ length: 4 }, (_, k) => [from.x + dir.x * (len * (k + 1)) / 4, from.y + dir.y * (len * (k + 1)) / 4]).flat();
  const inPts = straight > 0
    ? [...connectorPoints(a.pt, a.t, { x: front.x - h.x * straight, y: front.y - h.y * straight }, h, 16), ...line({ x: front.x - h.x * straight, y: front.y - h.y * straight }, h, straight)]
    : connectorPoints(a.pt, a.t, front, h, 16);
  const inPath = new Poly(inPts);
  if (p.alpha === 0) {
    // out forwards, into the lane ahead of the bay, then a car length straight along it (so the whole car
    // is lined up with the lane by the time it is in the lane's traffic)
    const sQ = clampS(sK + d0), q = at(sQ), sOut = clampS(sQ + CAR_LEN), pts = connectorPoints(front, h, q.pt, q.t, 16);
    for (let k = 1; k <= 4; k++) { const r = at(sQ + ((sOut - sQ) * k) / 4).pt; pts.push(r.x, r.y); }
    return { sIn, sOut, inPath, outPath: new Poly(pts), reverse: false, outLane: p.lane };
  }
  // backing out: the rear leaves the bay and swings back along the lane, so the car ends up facing the traffic
  // backing straight out until its front is clear of the bay — no further than the inner lane of its direction
  // (not over the centre line) — then turning to face the traffic in the lane it has backed into: the rear moves
  // back along that lane as the car turns, its front (trailing) staying on the bays' side
  const rear = { x: c.x - h.x * half, y: c.y - h.y * half }, sinA = Math.max(0.3, Math.sin(p.alpha));
  const toInner = e.lanes[0].poly.project(rear.x, rear.y).d / sinA;
  const build = (back: number, turn: number): BayAccess => {
    const clear = { x: rear.x - h.x * back, y: rear.y - h.y * back };
    // (the lane it has backed into: its own or one nearer the centre, never a bus lane)
    let outLane = p.lane, best = Infinity;
    for (let k = 0; k <= p.lane; k++) { const d = e.lanes[k].poly.project(clear.x, clear.y).d; if (d < best) { best = d; outLane = k; } }
    const op = e.lanes[outLane], fo = op.len / Math.max(1e-6, e.length);
    const atO = (s: number) => { const sl = Math.min(op.len, Math.max(0, s * fo)); return { pt: op.poly.at(sl), t: op.poly.tangent(sl) }; };
    const sClear = op.poly.project(clear.x, clear.y).s / fo, sQ = clampS(sClear - turn), q = atO(sQ);
    const span = Math.hypot(q.pt.x - clear.x, q.pt.y - clear.y), k1 = span * 0.5, k2 = span * 0.35;
    const outPath = new Poly([rear.x, rear.y, ...line(rear, { x: -h.x, y: -h.y }, back),
      ...cubicPoints(clear, { x: clear.x - h.x * k1, y: clear.y - h.y * k1 }, { x: q.pt.x + q.t.x * k2, y: q.pt.y + q.t.y * k2 }, q.pt, 16).slice(2)]);
    return { sIn, sOut: clampS(sQ + CAR_LEN), inPath, outPath, reverse: true, outLane };
  };
  // (the body — its front swings wide as it turns — kept off the other direction's lanes: backing out less,
  // or turning more gently, until it fits; the most room-taking one that fits)
  const o0 = e.reverse?.lanes[0];
  const fits = (acc: BayAccess) => {
    if (!o0) return true;
    for (let d = 0; d <= acc.outPath.len; d += 0.4) {
      const b = bodyOnPath(acc, "out", d, CAR_LEN), ux = b.fx - b.rx, uy = b.fy - b.ry, m = Math.hypot(ux, uy) || 1, nx = (-uy / m) * 0.95, ny = (ux / m) * 0.95;
      for (const f of [0, 0.5, 1]) for (const sd of [-1, 1]) if (o0.poly.project(b.rx + ux * f + nx * sd, b.ry + uy * f + ny * sd).d < o0.edge.lw / 2 + 0.15) return false;
    }
    return true;
  };
  const back0 = Math.max(0.5, Math.min(straight, toInner)), turn0 = Math.max(3, CAR_LEN * 0.8);
  for (let back = back0; back >= 0.5; back -= 0.4) for (const turn of [turn0, turn0 * 1.5, turn0 * 2]) {
    const acc = build(back, turn);
    if (fits(acc)) return acc;
  }
  return build(back0, turn0);
}

/**
 * Where a car's body is at distance `d` along a bay's path (its front and rear): going in (and out of a
 * parallel bay) the front leads, the rear following along the path (or still in the lane, behind its start);
 * backing out the rear leads, the car facing the other way.
 */
export function bodyOnPath(acc: BayAccess, way: "in" | "out", d: number, len: number): { fx: number; fy: number; rx: number; ry: number } {
  const path = way === "in" ? acc.inPath : acc.outPath, lead = path.at(d), t = path.tangent(d);
  if (way === "out" && acc.reverse) return { rx: lead.x, ry: lead.y, fx: lead.x - t.x * len, fy: lead.y - t.y * len };
  const t0 = path.tangent(0), p0 = path.at(0), r = d >= len ? path.at(d - len) : { x: p0.x - t0.x * (len - d), y: p0.y - t0.y * (len - d) };
  return { fx: lead.x, fy: lead.y, rx: r.x, ry: r.y };
}
