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
 * parallel bays) — ending with its front at `sOut` in the lane, facing the traffic. A car backing out of a
 * perpendicular bay can't turn within one lane: it backs out in an arc, stops across the lanes, and drives
 * forwards along `fwd` (its front's path) into the lane.
 */
export interface BayAccess {
  sIn: number; sOut: number; inPath: Poly; outPath: Poly; reverse: boolean;
  /** the lane it is in once out: the bay's lane (the nearest to the bays) */
  outLane: number;
  /** after backing out along `outPath` (to a stop), forwards along this into the lane; null: one move */
  fwd: Poly | null;
}

/** how long a bay's way in or out is (backing out then driving forwards: both) */
export const accessLen = (acc: BayAccess, way: "in" | "out") => (way === "in" ? acc.inPath.len : acc.outPath.len + (acc.fwd?.len ?? 0));

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
    out.push({ idx: out.length, def, edge, lane, bays, frames, w, l, alpha, pitch, free: !!def.line, access: [] });
  }
  // (the cars that may be parked around each bay, of every row: by 20 m cell)
  const CELL = 20, grid = new Map<string, { x: number; y: number; hx: number; hy: number; row: number; bay: number }[]>();
  for (const row of out) row.bays.forEach((_, i) => {
    const q = { ...bayPose(row, i), row: row.idx, bay: i }, k = `${Math.floor(q.x / CELL)},${Math.floor(q.y / CELL)}`;
    const l = grid.get(k); if (l) l.push(q); else grid.set(k, [q]);
  });
  for (const row of out) {
    const hint: AccessHint = {}, nears = row.bays.map((_, i) => {
      const q = bayPose(row, i), cx = Math.floor(q.x / CELL), cy = Math.floor(q.y / CELL), near: Vec4[] = [];
      for (let a = cx - 1; a <= cx + 1; a++) for (let b = cy - 1; b <= cy + 1; b++) for (const o of grid.get(`${a},${b}`) ?? []) if (o.row !== row.idx || o.bay !== i) near.push(o);
      return near;
    });
    // (worked out again only when the row, its road's lanes or the bays around it changed: editing elsewhere, or
    // recompiling as the plan runs, finds them here)
    const r3 = (x: number) => Math.round(x * 1000);
    const key = JSON.stringify([row.def, row.lane, [row.edge, row.edge.reverse].map(e => e?.lanes.map(l => Array.from(l.poly.pts, r3))), nears.map(n => n.map(o => [r3(o.x), r3(o.y), r3(o.hx), r3(o.hy)]))]);
    const known = accessCache.get(key);
    if (known) { accessCache.delete(key); accessCache.set(key, known); row.access = known; continue; }
    row.access = row.bays.map((_, i) => bayAccess(row, i, nears[i], hint));
    accessCache.set(key, row.access);
    if (accessCache.size > 500) accessCache.delete(accessCache.keys().next().value!);
  }
  return out;
}
/** rows' ways in and out by everything they depend on (the most recently used 500) */
const accessCache = new Map<string, BayAccess[]>();
type Vec4 = { x: number; y: number; hx: number; hy: number };
/** the way out found for a row's bay before: the next one, much alike, tries it first */
interface AccessHint { one?: { back: number; turn: number; reach: number }; two?: { back: number; r: number; th: number; ahead: number; reach: number; near: number } }

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
function bayAccess(p: CParking, i: number, parked: Vec4[], hint: AccessHint): BayAccess {
  const e = p.edge, lp = e.lanes[p.lane], f = lp.len / Math.max(1e-6, e.length);
  const at = (s: number) => { const sl = Math.min(lp.len, Math.max(0, s * f)); return { pt: lp.poly.at(sl), t: lp.poly.tangent(sl) }; };
  const clampS = (s: number) => Math.min(e.length - 0.5, Math.max(0.5, s));
  const pose = bayPose(p, i), c = { x: pose.x, y: pose.y }, h = { x: pose.hx, y: pose.hy }, half = CAR_LEN / 2;
  const sK = p.bays[i], k = at(sK).pt, fr = p.frames[i];
  // (a car parked in a bay near it, of its row or another: no way in or out passes over one)
  const inBeside = (x: number, y: number) => parked.some(n => {
    const dx = x - n.x, dy = y - n.y;
    return Math.abs(dx * n.hx + dy * n.hy) < half - 0.05 && Math.abs(-dx * n.hy + dy * n.hx) < 0.9;
  });
  const clearOf = (acc: BayAccess, way: "in" | "out") => {
    for (let d = 0, L = accessLen(acc, way); d <= L; d += 0.2) {
      const b = bodyOnPath(acc, way, d, CAR_LEN), ux = b.fx - b.rx, uy = b.fy - b.ry, m = Math.hypot(ux, uy) || 1, nx = (-uy / m) * 0.95, ny = (ux / m) * 0.95;
      for (const fr of [0, 0.5, 1]) for (const sd of [-1, 1]) if (inBeside(b.rx + ux * fr + nx * sd, b.ry + uy * fr + ny * sd)) return false;
    }
    return true;
  };
  // (how far before the bay a car leaves the lane: enough to turn in; a parallel bay is entered along it)
  const side = Math.hypot(fr.k.x - k.x, fr.k.y - k.y), d0 = p.alpha === 0 ? p.l + 2 : Math.min(15, Math.max(3, side + 1)), front = { x: c.x + h.x * half, y: c.y + h.y * half };
  // (into a perpendicular or angled bay straight along it, from just outside its opening: the car is lined up
  // before it is between its neighbours; a parallel bay is entered along the kerb)
  const straight = p.alpha === 0 ? 0 : half + p.l / 2 + 0.3;
  const line = (from: { x: number; y: number }, dir: { x: number; y: number }, len: number) => Array.from({ length: 4 }, (_, k) => [from.x + dir.x * (len * (k + 1)) / 4, from.y + dir.y * (len * (k + 1)) / 4]).flat();
  const wayIn = (dIn: number, st: number) => {
    const a = at(clampS(sK - dIn)), o = { x: front.x - h.x * st, y: front.y - h.y * st };
    return new Poly(st > 0 ? [...connectorPoints(a.pt, a.t, o, h, 16), ...line(o, h, st)] : connectorPoints(a.pt, a.t, front, h, 16));
  };
  // (the first that clears the cars parked around it: turning in from further back, or lining up sooner)
  let sIn = clampS(sK - d0), inPath = wayIn(d0, straight);
  search: for (const st of straight > 0 ? [straight, straight + 1, straight + 2, straight + 3] : [0]) for (const m of [1, 1.3, 1.6, 2, 0.8]) {
    const path = wayIn(d0 * m, st);
    if (clearOf({ sIn: 0, sOut: 0, inPath: path, outPath: path, reverse: false, outLane: p.lane, fwd: null }, "in")) { sIn = clampS(sK - d0 * m); inPath = path; break search; }
  }
  if (p.alpha === 0) {
    // out forwards, into the lane ahead of the bay, then a car length straight along it (so the whole car
    // is lined up with the lane by the time it is in the lane's traffic): pulling out sooner or later, so as
    // not to touch the car parked ahead
    const wayOut = (dOut: number): BayAccess => {
      const sQ = clampS(sK + dOut), q = at(sQ), sOut = clampS(sQ + CAR_LEN), pts = connectorPoints(front, h, q.pt, q.t, 16);
      for (let k = 1; k <= 4; k++) { const r = at(sQ + ((sOut - sQ) * k) / 4).pt; pts.push(r.x, r.y); }
      return { sIn, sOut, inPath, outPath: new Poly(pts), reverse: false, outLane: p.lane, fwd: null };
    };
    for (const m of [1, 0.8, 0.65, 1.3, 1.6]) { const acc = wayOut(d0 * m); if (clearOf(acc, "out")) return acc; }
    return wayOut(d0);
  }
  // backing out: the rear leaves the bay and swings back along the lane, so the car ends up facing the traffic
  // backing straight out until its front is clear of the bay, then turning to face the traffic in the bay's
  // lane (the one nearest the bays): the rear moves back along it as the car turns, its front (trailing) on the
  // bays' side
  const rear = { x: c.x - h.x * half, y: c.y - h.y * half }, sinA = Math.max(0.3, Math.sin(p.alpha));
  const toInner = e.lanes[0].poly.project(rear.x, rear.y).d / sinA;
  const build = (back: number, turn: number): BayAccess => {
    const clear = { x: rear.x - h.x * back, y: rear.y - h.y * back };
    const sQ = clampS(lp.poly.project(clear.x, clear.y).s / f - turn), q = at(sQ);
    const span = Math.hypot(q.pt.x - clear.x, q.pt.y - clear.y), k1 = span * 0.5, k2 = span * 0.35;
    const outPath = new Poly([rear.x, rear.y, ...line(rear, { x: -h.x, y: -h.y }, back),
      ...cubicPoints(clear, { x: clear.x - h.x * k1, y: clear.y - h.y * k1 }, { x: q.pt.x + q.t.x * k2, y: q.pt.y + q.t.y * k2 }, q.pt, 16).slice(2)]);
    return { sIn, sOut: clampS(sQ + CAR_LEN), inPath, outPath, reverse: true, outLane: p.lane, fwd: null };
  };
  // (how far the body — its front swings wide as it turns — reaches into the other lanes of its direction;
  // 100 more: into the other direction's; Infinity: no way out. A perpendicular bay's car can't turn within one lane: the least)
  // (Infinity too: into a car parked in a bay near it, of its row or another)
  const others = e.lanes.filter(l => l.lane !== p.lane), o0 = e.reverse?.lanes[0];
  let swing = 0;
  // (`upTo`: looked at as far as this along the way out; `limit`: a candidate reaching further is no better, and
  // is given up as soon as it does)
  const reach = (acc: BayAccess, upTo = accessLen(acc, "out"), limit = Infinity, step = 0.2) => {
    let worst = -Infinity, px = 0, py = 0;
    const kink = Math.cos(0.16 * (step / 0.2));
    swing = 0;
    for (let d = 0; d <= upTo; d += step) {
      const b = bodyOnPath(acc, "out", d, CAR_LEN), ux = b.fx - b.rx, uy = b.fy - b.ry, m = Math.hypot(ux, uy) || 1, nx = (-uy / m) * 0.95, ny = (ux / m) * 0.95;
      // (a car turns no sharper than it can steer: a path that kinks, swinging the body round, is no way out)
      const dot = (ux * px + uy * py) / m;
      if (d > 0 && dot < kink) return Infinity;
      if (d > 0) swing += Math.acos(Math.min(1, dot));
      px = ux / m; py = uy / m;
      for (const fr of [0, 0.5, 1]) for (const sd of [-1, 1]) {
        const x = b.rx + ux * fr + nx * sd, y = b.ry + uy * fr + ny * sd;
        if (inBeside(x, y)) return Infinity;
        for (const l of others) worst = Math.max(worst, e.lw / 2 + 0.15 - l.poly.project(x, y).d);
        // (into the other direction: only where nothing else fits, as little as it can)
        if (o0) { const od = o0.poly.project(x, y).d; if (od < o0.edge.lw / 2 + 0.15) worst = Math.max(worst, 100 + o0.edge.lw / 2 + 0.15 - od); }
        if (worst > limit) return Infinity;
      }
    }
    return worst;
  };
  const back0 = Math.max(0.5, Math.min(straight, toInner)), turn0 = Math.max(3, CAR_LEN * 0.8);
  // (one move — the row's bay before's, if it does as well here — unless two reach less into the other lanes: a
  // bay beyond a bus lane always reaches across it, and backs out in one move all the same)
  let best: BayAccess | null = null, bestR = Infinity, one: { back: number; turn: number; reach: number } | null = null;
  if (hint.one) { const acc = build(hint.one.back, hint.one.turn); if (reach(acc) <= Math.max(0, hint.one.reach) + 0.1) return acc; }
  // (one move is looked for again where fewer cars are parked around than at the bay that needed two: an end
  // bay may well back out within its lane)
  if (!hint.two || parked.length < hint.two.near) for (let back = back0; back >= 0.5; back -= 0.4) for (const turn of [turn0, turn0 * 1.5, turn0 * 2, turn0 * 3]) {
    const acc = build(back, turn), r = reach(acc);
    if (r <= 0) { hint.one = { back, turn, reach: r }; hint.two = undefined; return acc; }
    if (r < bestR - 0.05) { best = acc; bestR = r; one = { back, turn, reach: r }; }
  }
  const oneWins = (twoReach: number) => !!one && twoReach >= one.reach - 0.05;
  // (no way out in one move within the lane: back out in an arc, turning by `th` toward the traffic's way,
  // to a stop across the lanes, then forwards into the lane — backing out no further than it has to)
  const u0 = at(sK).t, hu = u0.x * h.x + u0.y * h.y, wm = Math.hypot(u0.x - h.x * hu, u0.y - h.y * hu) || 1;
  const w = { x: (u0.x - h.x * hu) / wm, y: (u0.y - h.y * hu) / wm };
  const twoMoves = (back: number, r: number, th: number, ahead: number): BayAccess => {
    const clear = { x: rear.x - h.x * back, y: rear.y - h.y * back }, ct = Math.cos(th), st = Math.sin(th);
    const m = { x: h.x * ct + w.x * st, y: h.y * ct + w.y * st }, k = (r * 4 / 3) * Math.tan(th / 4);
    const stop = { x: clear.x - h.x * r * st - w.x * r * (1 - ct), y: clear.y - h.y * r * st - w.y * r * (1 - ct) };
    const outPath = new Poly([rear.x, rear.y, ...line(rear, { x: -h.x, y: -h.y }, back),
      ...cubicPoints(clear, { x: clear.x - h.x * k, y: clear.y - h.y * k }, { x: stop.x + m.x * k, y: stop.y + m.y * k }, stop, 32).slice(2)]);
    const front = { x: stop.x + m.x * CAR_LEN, y: stop.y + m.y * CAR_LEN };
    const sQ0 = lp.poly.project(front.x, front.y).s / f + ahead, sQ = clampS(sQ0), q = at(sQ), sOut = clampS(sQ + CAR_LEN);
    cramped = sQ0 + CAR_LEN > e.length - 0.5;
    const span = Math.hypot(q.pt.x - front.x, q.pt.y - front.y), k1 = span * 0.4;
    const pts = cubicPoints(front, { x: front.x + m.x * k1, y: front.y + m.y * k1 }, { x: q.pt.x - q.t.x * k1, y: q.pt.y - q.t.y * k1 }, q.pt, 32);
    for (let j = 1; j <= 4; j++) { const z = at(sQ + ((sOut - sQ) * j) / 4).pt; pts.push(z.x, z.y); }
    return { sIn, sOut, inPath, outPath, reverse: true, outLane: p.lane, fwd: new Poly(pts) };
  };
  // (turning as sharply as it takes to reach into the other lanes as little as it can — sharper than a car
  // steers, if need be — then, of the ways forwards from there, the one that turns least: it is lined up with
  // its lane as it comes into it, and has the road to straighten up in before the road ends)
  let cramped = false;
  if (hint.two) {
    const t = hint.two, acc = twoMoves(t.back, t.r, t.th, t.ahead), rr = reach(acc, accessLen(acc, "out"), t.reach + 0.1);
    if (rr < Infinity && !oneWins(rr)) return acc;
  }
  // (for each turn, the least it can back out before turning without touching the cars beside it: found by halving)
  const revs: { back: number; r: number; th: number; reach: number }[] = [];
  const revReach = (back: number, r: number, th: number) => { const acc = twoMoves(back, r, th, 5); return reach(acc, acc.outPath.len); };
  for (const th of [Math.PI / 2, Math.PI * 0.42, Math.PI / 3, Math.PI / 4]) for (const r of [1.8, 2.2, 2.6, 3, 3.5, 4, 5]) {
    let lo = 0.2, hi = Math.max(lo, straight);
    if (revReach(hi, r, th) === Infinity) continue;
    if (revReach(lo, r, th) < Infinity) hi = lo;
    else for (let k = 0; k < 6; k++) { const mid = (lo + hi) / 2; if (revReach(mid, r, th) < Infinity) hi = mid; else lo = mid; }
    revs.push({ back: hi, r, th, reach: revReach(hi, r, th) });
  }
  revs.sort((a, b) => a.reach - b.reach);
  let two: BayAccess | null = null, twoHint: AccessHint["two"];
  for (const rev of revs) {
    let bestS = Infinity;
    for (const ahead of [2, 3.5, 5, 8, 12]) {
      const acc = twoMoves(rev.back, rev.r, rev.th, ahead), rr = reach(acc);
      if (rr === Infinity) continue;
      const score = Math.max(0, rr - Math.max(rev.reach, 0)) + (swing * 180) / Math.PI / 50 + (cramped ? 50 : 0);
      if (score < bestS) { two = acc; bestS = score; twoHint = { ...rev, ahead, reach: rr, near: parked.length }; }
    }
    if (bestS < Infinity) break;
  }
  if (two && !oneWins(twoHint!.reach)) { hint.two = twoHint; hint.one = undefined; return two; }
  if (one) { hint.one = one; hint.two = undefined; }
  return best ?? build(back0, turn0);
}

/**
 * Where a car's body is at distance `d` along a bay's path (its front and rear): going in (and out of a
 * parallel bay) the front leads, the rear following along the path (or still in the lane, behind its start);
 * backing out the rear leads, the car facing the other way.
 */
export function bodyOnPath(acc: BayAccess, way: "in" | "out", d: number, len: number): { fx: number; fy: number; rx: number; ry: number } {
  if (way === "out" && acc.reverse) {
    // (after backing out, forwards: its front along `fwd`, which starts where the front stopped)
    if (acc.fwd && d > acc.outPath.len) return frontLeads(acc.fwd, d - acc.outPath.len, len);
    const lead = acc.outPath.at(d), t = acc.outPath.tangent(d);
    return { rx: lead.x, ry: lead.y, fx: lead.x - t.x * len, fy: lead.y - t.y * len };
  }
  return frontLeads(way === "in" ? acc.inPath : acc.outPath, d, len);
}

/** the front at `d` along a path, the rear following along it (or still behind its start, in line with it) */
function frontLeads(path: Poly, d: number, len: number) {
  const lead = path.at(d), t0 = path.tangent(0), p0 = path.at(0), r = d >= len ? path.at(d - len) : { x: p0.x - t0.x * (len - d), y: p0.y - t0.y * (len - d) };
  return { fx: lead.x, fy: lead.y, rx: r.x, ry: r.y };
}
