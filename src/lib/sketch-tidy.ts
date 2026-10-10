/**
 * Tidying a sketch converted from V1 (or drawn so): V1 nodes close together leave lanes a couple of metres
 * long between connectors, too short for a car — it is on the next connector before its back is off the one
 * before, and cars coming up can't see the queue beyond. Two fixes, each leaving ordinary pieces:
 *  - a short lane between connectors (traffic in and out) is folded into them: each way in to it and each
 *    way out of it become one connector along the same path (through the lane's ends), and the lane goes
 *    (its road too, if that was all of it);
 *  - a short lane where traffic comes in or leaves (nothing joining it at that end, at its road's end) is
 *    made longer there, so the ways in and out start and end on a lane a car fits on.
 *  - a lane that doubles back on itself (a hairpin of a few points, left by a conversion) is straightened
 *    there: those points taken out (its connectors kept where they were along it); and one that crosses itself in
 *    a small loop (an inside corner offset too far) cut at the crossing.
 * Left as they are: lanes with a sign or a level, held by lights, named by a journey or a junction's turning
 * shares, rings, arcs. Framework-free.
 */
import { dist, laneById, laneLength, leadOf, nearestOn, pointAt, remove, settle, signalPlans, type Pt, type Sketch, type SketchConnector, type SketchLane } from "./lane-sketch";

export interface TidyOptions { /** lanes shorter than this between connectors are folded (m) */ stub?: number; /** ways in and out shorter than this are made this long (m) */ minEnd?: number }
export interface TidyReport { kinks: number; folded: number; added: number; removed: number; extended: number; kept: { lane: string; why: string }[] }

const r2 = (x: number) => Math.round(x * 100) / 100;
/** the longest loop cut out of a lane crossing itself (m): one longer is drawn so */
const LOOP = 40;
/** where segments a–b and c–d cross (not just touch), or null */
function crossing(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den, u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  return t > 1e-6 && t < 1 - 1e-6 && u > 1e-6 && u < 1 - 1e-6 ? { x: a.x + rx * t, y: a.y + ry * t } : null;
}

export function tidySketch(sk0: Sketch, opts: TidyOptions = {}): { sketch: Sketch; report: TidyReport } {
  const STUB = opts.stub ?? 4, MIN_END = opts.minEnd ?? 15;
  const report: TidyReport = { kinks: 0, folded: 0, added: 0, removed: 0, extended: 0, kept: [] };
  let sk = sk0;
  // (what must stay: lanes and connectors the lights hold or a journey or turning share names)
  const held = new Set(signalPlans(sk).flatMap(p => p.controlled));
  for (const j of sk.junctions) for (const p of j.lights?.phases ?? []) for (const c of p.conns) held.add(c);
  const named = new Set<string>();
  for (const j of sk.journeys ?? []) { named.add(j.from); named.add(j.to); }
  for (const j of sk.junctions) for (const s of j.splits ?? []) { named.add(s.from); for (const k of Object.keys(s.shares)) named.add(k); }
  const roadOf = (sk: Sketch, id: string) => sk.roads.find(r => r.lanes.includes(id)) ?? null;
  const isLine = (l: SketchLane) => l.shape.kind === "line" && !l.shape.closed;

  // 0. hairpins taken out: a point where the lane turns back on itself (more than 120°); a road's lead lane (its others follow it)
  const before = new Map(sk.lanes.map(l => [l.id, l.shape]));
  sk = settle({ ...sk, lanes: sk.lanes.map(l => {
    if (l.shape.kind !== "line" || leadOf(sk, l.id)) return l;
    let pts = l.shape.pts, curved = l.shape.curved, n = 0;
    for (let again = true; again && pts.length > 2;) {
      again = false;
      for (let i = 1; i + 1 < pts.length; i++) {
        const ax = pts[i].x - pts[i - 1].x, ay = pts[i].y - pts[i - 1].y, bx = pts[i + 1].x - pts[i].x, by = pts[i + 1].y - pts[i].y, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la > 1e-6 && lb > 1e-6 && (ax * bx + ay * by) / (la * lb) < -0.5) { pts = pts.filter((_, k) => k !== i); curved = curved?.filter((_, k) => k !== i); n++; again = true; break; }
      }
      // (and a small loop, the lane crossing itself, as an inside corner offset too far leaves: cut at the crossing;
      // the cars on it would run through one another there, nothing telling them they cross)
      for (let i = 0; !again && i + 3 < pts.length; i++) {
        let run = 0;
        for (let j = i + 2; j + 1 < pts.length; j++) {
          run += dist(pts[j - 1], pts[j]);
          if (run > LOOP) break;
          const x = crossing(pts[i], pts[i + 1], pts[j], pts[j + 1]);
          if (!x) continue;
          pts = [...pts.slice(0, i + 1), { x: r2(x.x), y: r2(x.y) }, ...pts.slice(j + 1)];
          curved = curved && [...curved.slice(0, i + 1), false, ...curved.slice(j + 1)];
          n += j - i - 1; again = true; break;
        }
      }
    }
    if (!n) return l;
    report.kinks += n;
    return { ...l, shape: { ...l.shape, pts, ...(curved ? { curved } : {}) } };
  }) });
  // (connectors on a lane reshaped: at the same place along it as before, its ends kept its ends)
  const moved = new Map(sk.lanes.filter(l => before.get(l.id) !== l.shape).map(l => [l.id, { was: before.get(l.id)!, now: l.shape }]));
  if (moved.size) {
    const place = (lane: string, s: number) => {
      const m = moved.get(lane);
      if (!m) return s;
      const L0 = laneLength(m.was), L1 = laneLength(m.now);
      return s <= 0.01 ? s : s >= L0 - 0.01 ? r2(L1) : r2(nearestOn(m.now, pointAt(m.was, s).p).s);
    };
    sk = { ...sk, connectors: sk.connectors.map(c => (moved.has(c.from.lane) || moved.has(c.to.lane) ? { ...c, from: { ...c.from, s: place(c.from.lane, c.from.s) }, to: { ...c.to, s: place(c.to.lane, c.to.s) } } : c)) };
  }

  // 1. folding the short lanes between connectors, one at a time (a chain of them folds into one)
  for (let guard = 0; guard < 5000; guard++) {
    const ins = new Map<string, SketchConnector[]>(), outs = new Map<string, SketchConnector[]>();
    for (const c of sk.connectors) { (outs.get(c.from.lane) ?? outs.set(c.from.lane, []).get(c.from.lane)!).push(c); (ins.get(c.to.lane) ?? ins.set(c.to.lane, []).get(c.to.lane)!).push(c); }
    const fold = sk.lanes.find(l => {
      if (!isLine(l) || laneLength(l.shape) >= STUB) return false;
      const i = ins.get(l.id) ?? [], o = outs.get(l.id) ?? [];
      if (!i.length || !o.length) return false;
      const road = roadOf(sk, l.id);
      const why = l.control ? "it has a sign" : l.level ? "it is on a level" : [...i, ...o].some(c => held.has(c.id)) ? "lights hold it" : named.has(l.id) || (road && named.has(road.id)) ? "a journey or turning share names it" : null;
      if (why) { if (!report.kept.some(k => k.lane === l.id)) report.kept.push({ lane: l.id, why }); return false; }
      return true;
    });
    if (!fold) break;
    // (every way onto it joined to every way off it: one connector through the lane's ends, along their bends)
    const i = ins.get(fold.id)!, o = outs.get(fold.id)!, L = laneLength(fold.shape);
    const a = pointAt(fold.shape, 0).p, b = pointAt(fold.shape, L).p;
    const ids = sk.connectors.map(c => c.id);
    const fresh = () => { let n = 0; for (const id of ids) if (id.startsWith("c")) n = Math.max(n, Number(id.slice(1)) || 0); const id = `c${n + 1}`; ids.push(id); return id; };
    const made: SketchConnector[] = [];
    for (const ci of i) for (const co of o) {
      if (ci.from.lane === co.to.lane) continue;
      if (made.some(m => m.from.lane === ci.from.lane && m.from.s === ci.from.s && m.to.lane === co.to.lane && m.to.s === co.to.s)) continue;
      const mid: Pt[] = dist(a, b) < 0.5 ? [{ x: r2((a.x + b.x) / 2), y: r2((a.y + b.y) / 2) }] : [{ x: r2(a.x), y: r2(a.y) }, { x: r2(b.x), y: r2(b.y) }];
      made.push({ id: fresh(), from: ci.from, to: co.to, via: [...(ci.via ?? []), ...mid, ...(co.via ?? [])], ...(ci.straight && co.straight ? { straight: true as const } : {}) });
    }
    const gone = [...i, ...o].map(c => c.id);
    sk = remove(sk, { lanes: [fold.id], connectors: gone });
    sk = { ...sk, connectors: [...sk.connectors, ...made] };
    report.folded++; report.added += made.length; report.removed += gone.length;
  }

  // 2. the short ways in and out made longer at their free end (a road's: its lead lane, which the others follow)
  const ins = new Map<string, number>(), outs = new Map<string, number>();
  for (const c of sk.connectors) { outs.set(c.from.lane, (outs.get(c.from.lane) ?? 0) + 1); ins.set(c.to.lane, (ins.get(c.to.lane) ?? 0) + 1); }
  const done = new Set<string>();
  for (const l of sk.lanes) {
    if (done.has(l.id) || !isLine(l)) continue;
    const len = laneLength(l.shape), entry = !ins.get(l.id), exit = !outs.get(l.id);
    if (len >= MIN_END || entry === exit) continue;
    const road = roadOf(sk, l.id), lead = road?.align ? laneById(sk, road.align.ref) : l;
    if (!lead || !isLine(lead)) continue;
    const members = road ? road.lanes.map(id => laneById(sk, id)!).filter(Boolean) : [l];
    members.forEach(m => done.add(m.id));
    // (which end of the lead: the lane's start for a way in, its end for a way out; the other way round for a lane running against the lead)
    const against = !!road?.align?.lanes.find(x => x.id === l.id)?.reverse;
    const atStart = entry !== against;
    // (only where nothing joins any lane of the road at that end)
    const free = members.every(m => {
      const rev = !!road?.align?.lanes.find(x => x.id === m.id)?.reverse, mStart = atStart !== rev;
      return mStart ? !ins.get(m.id) : !outs.get(m.id);
    });
    if (!free || members.some(m => m.level || m.shape.kind !== "line")) { report.kept.push({ lane: l.id, why: "something joins its road at that end" }); continue; }
    const shortest = Math.min(...members.map(m => laneLength(m.shape))), grow = MIN_END - shortest;
    if (grow <= 0.01) continue;
    const pts = (lead.shape as Extract<SketchLane["shape"], { kind: "line" }>).pts, curved = (lead.shape as Extract<SketchLane["shape"], { kind: "line" }>).curved;
    const p = atStart ? pointAt(lead.shape, 0) : pointAt(lead.shape, laneLength(lead.shape));
    const q = atStart ? { x: r2(p.p.x - p.d.x * grow), y: r2(p.p.y - p.d.y * grow) } : { x: r2(p.p.x + p.d.x * grow), y: r2(p.p.y + p.d.y * grow) };
    const next = { ...lead.shape, pts: atStart ? [q, ...pts.slice(1)] : [...pts.slice(0, -1), q], ...(curved ? { curved } : {}) };
    // (the lead's own end point moved, not added to: no new corner)
    const before = new Map(members.map(m => [m.id, { start: pointAt(m.shape, 0).p, len: laneLength(m.shape) }]));
    sk = settle({ ...sk, lanes: sk.lanes.map(x => (x.id === lead.id ? { ...x, shape: next } : x)) });
    // (connectors on a lane whose start moved: their places on it along by as much)
    const shift = new Map<string, number>();
    for (const m of members) {
      const now = laneById(sk, m.id)!, was = before.get(m.id)!;
      if (dist(pointAt(now.shape, 0).p, was.start) > 0.01) shift.set(m.id, laneLength(now.shape) - was.len);
    }
    if (shift.size) sk = { ...sk, connectors: sk.connectors.map(c => {
      const f = shift.get(c.from.lane), t = shift.get(c.to.lane);
      return f || t ? { ...c, ...(f ? { from: { ...c.from, s: r2(c.from.s + f) } } : {}), ...(t ? { to: { ...c.to, s: r2(c.to.s + t) } } : {}) } : c;
    }) };
    report.extended++;
  }
  return { sketch: settle(sk), report };
}
