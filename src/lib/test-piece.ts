/**
 * A piece of a plan to test on its own ("Test in Sketch"): the junctions chosen with what is on them (lanes,
 * connectors, signs, lights, turning shares, zebras), the lanes chosen, and a short stretch of each lane leading
 * in and out where the piece was cut off, so it has ways in and out of its own. Kept where it was (the same
 * coordinates and ids: the satellite imagery still lines up, the lights' phases and turning shares still name
 * what they did), with the plan's simulation settings; the new ways in come in at the rate measured there in
 * the plan's last run if there was one. Framework-free.
 */
import { tidySketch } from "./sketch-tidy";
import { isFullCircle, junctionContents, laneById, laneLength, nearestOn, pointAt, splitShape, type LaneAt, type LaneShape, type Pt, type Sketch, type SketchConnector, type SketchLane } from "./lane-sketch";

export interface TestPieceOptions {
  /** how much of each lane leading in or out is kept beyond where the piece's connectors meet it (m) */
  cut?: number;
  /** vehicles an hour on each lane in the plan's last run (by lane id), for the rates at the new ways in */
  rates?: Map<string, number>;
}
export interface TestPieceReport { junctions: number; lanes: number; cut: number; entries: number; measured: number; groups: number }

/** ways in and out shorter than this are made this long (as Tidy does) */
const MIN_END = 15;

/** the piece of `sk` round the junctions, lanes and connectors chosen (ids), as a sketch of its own */
export function testPiece(sk: Sketch, sel: { lanes: string[]; junctions: string[]; connectors?: string[] }, opts: TestPieceOptions = {}): { sketch: Sketch; report: TestPieceReport } {
  const CUT = Math.max(MIN_END, opts.cut ?? 70);
  const js = sk.junctions.filter(j => sel.junctions.includes(j.id));
  // what is wholly in: the lanes chosen and those on the junctions; their connectors and the junctions'
  const core = new Set(sel.lanes), conns = new Set<string>(sel.connectors ?? []);
  for (const j of js) { const c = junctionContents(sk, j); c.lanes.forEach(l => core.add(l)); c.connectors.forEach(x => conns.add(x)); }
  for (const c of sk.connectors) if (core.has(c.from.lane) && core.has(c.to.lane)) conns.add(c.id);
  // the lanes they lead from or to, kept only near where they meet them: `want` metres before (leading in) and after
  // (leading out); a lane shorter than that carries on into the lane before it (after it), the straightest way on
  const len = new Map(sk.lanes.map(l => [l.id, laneLength(l.shape)]));
  const touched = new Map<string, number[]>();
  for (const c of sk.connectors) if (conns.has(c.id)) for (const a of [c.from, c.to]) if (!core.has(a.lane)) touched.set(a.lane, [...(touched.get(a.lane) ?? []), a.s]);
  const span = new Map<string, [number, number]>(), chain = new Set<string>();
  const widen = (id: string, s0: number, s1: number) => { const w = span.get(id); span.set(id, w ? [Math.min(w[0], s0), Math.max(w[1], s1)] : [s0, s1]); };
  const dir = (id: string, s: number) => pointAt(laneById(sk, id)!.shape, s).d;
  const straightest = (cs: SketchConnector[], d: (c: SketchConnector) => [Pt, Pt]) => cs.sort((x, y) => { const [a, b] = d(y), [c, e] = d(x); return a.x * b.x + a.y * b.y - (c.x * e.x + c.y * e.y); })[0];
  const back = (id: string, want: number, depth: number) => {
    if (want < 1 || depth > 8) return;
    const feeds = sk.connectors.filter(c => c.to.lane === id && c.to.s < 1 && !conns.has(c.id) && !core.has(c.from.lane) && !span.has(c.from.lane));
    const c = straightest(feeds, x => [dir(x.from.lane, x.from.s), dir(id, 0)]);
    if (!c) return;
    conns.add(c.id); chain.add(c.from.lane);
    widen(c.from.lane, Math.max(0, c.from.s - want), c.from.s);
    back(c.from.lane, want - c.from.s, depth + 1);
  };
  const on = (id: string, want: number, depth: number) => {
    if (want < 1 || depth > 8) return;
    const L = len.get(id)!;
    const leads = sk.connectors.filter(c => c.from.lane === id && c.from.s > L - 1 && !conns.has(c.id) && !core.has(c.to.lane) && !span.has(c.to.lane));
    const c = straightest(leads, x => [dir(id, L), dir(x.to.lane, x.to.s)]);
    if (!c) return;
    conns.add(c.id); chain.add(c.to.lane);
    const Lt = len.get(c.to.lane)!;
    widen(c.to.lane, c.to.s, Math.min(Lt, c.to.s + want));
    on(c.to.lane, want - (Lt - c.to.s), depth + 1);
  };
  for (const [id, at] of touched) {
    const L = len.get(id)!, lo = Math.min(...at), hi = Math.max(...at);
    widen(id, Math.max(0, lo - CUT), Math.min(L, hi + CUT));
    // (leading in: traffic leaves it for the piece; leading out: traffic joins it from the piece)
    const leadsIn = sk.connectors.some(c => conns.has(c.id) && c.from.lane === id), leadsOut = sk.connectors.some(c => conns.has(c.id) && c.to.lane === id);
    if (leadsIn && lo < CUT) back(id, CUT - lo, 0);
    if (leadsOut && L - hi < CUT) on(id, CUT - (L - hi), 0);
  }
  const cs = sk.connectors.filter(c => conns.has(c.id));
  let cutN = 0;
  const lanes: SketchLane[] = [];
  for (const l of sk.lanes) {
    if (core.has(l.id)) { lanes.push(l); continue; }
    const sp = span.get(l.id);
    if (!sp) continue;
    const L = len.get(l.id)!, [s0, s1] = sp;
    // (on the way to or from the piece: no sign where it met what isn't taken)
    const lane: SketchLane = { ...l };
    if (chain.has(l.id)) delete lane.control;
    if (isFullCircle(l.shape) || (s0 < 0.5 && s1 > L - 0.5)) { span.delete(l.id); lanes.push(lane); continue; }
    const shape = stretch(l.shape, s0, s1);
    if (!shape) { span.delete(l.id); lanes.push(lane); continue; }
    // (cut at its start: traffic comes in there now, not what came in where the lane started; cut at its end: no sign)
    lane.shape = shape;
    if (s0 >= 0.5) delete lane.inRate;
    if (s1 <= L - 0.5) { delete lane.control; delete lane.outWeight; }
    lanes.push(lane); cutN++;
  }
  const kept = new Set(lanes.map(l => l.id));
  const move = (a: LaneAt): LaneAt => { const sp = span.get(a.lane); return sp ? { ...a, s: Math.round(Math.min(sp[1] - sp[0], Math.max(0, a.s - sp[0])) * 100) / 100 } : a; };
  const connectors = cs.map(c => (span.has(c.from.lane) || span.has(c.to.lane) ? { ...c, from: move(c.from), to: move(c.to) } : c));
  // roads: their lanes in the piece (side by side no more where cut: each lane keeps its own shape)
  const roads = sk.roads.flatMap(r => {
    const ls = r.lanes.filter(id => kept.has(id));
    if (!ls.length) return [];
    const { align, ...rest } = r;
    return [ls.some(id => span.has(id)) || ls.length !== r.lanes.length || !align ? { ...rest, lanes: ls } : { ...rest, lanes: ls, align }];
  });
  // zebras on the lanes kept; signal groups with every junction in the piece; journeys between ways still there
  const near = (p: Pt) => lanes.some(l => nearestOn(l.shape, p).d < l.width);
  const crossings = (sk.crossings ?? []).filter(x => near({ x: (x.a.x + x.b.x) / 2, y: (x.a.y + x.b.y) / 2 }));
  const jIds = new Set(js.map(j => j.id));
  const groups = (sk.signalGroups ?? []).filter(g => g.members.every(m => jIds.has(m.junction)));
  const journeys = (sk.journeys ?? []).filter(j => kept.has(j.from) && kept.has(j.to) && !span.has(j.from) && !span.has(j.to));
  let piece: Sketch = {
    lanes, connectors, roads, junctions: js,
    ...(sk.traffic ? { traffic: sk.traffic } : {}), ...(sk.geo ? { geo: sk.geo } : {}),
    ...(crossings.length ? { crossings } : {}), ...(groups.length ? { signalGroups: groups } : {}), ...(journeys.length ? { journeys } : {}),
  };
  // (ways in and out too short for a car made longer, nothing folded)
  piece = tidySketch(piece, { stub: 0, minEnd: MIN_END }).sketch;
  // the ways in: as much traffic as came there in the plan's last run (a lane that was a way in keeps its own rate)
  const fed = new Set(piece.connectors.map(c => c.to.lane));
  let entries = 0, measured = 0;
  piece = { ...piece, lanes: piece.lanes.map(l => {
    if (fed.has(l.id) || isFullCircle(l.shape)) return l;
    entries++;
    const r = opts.rates?.get(l.id);
    if (l.inRate !== undefined || r === undefined) return l;
    measured++;
    return { ...l, inRate: Math.max(0, Math.round(r)) };
  }) };
  return { sketch: piece, report: { junctions: js.length, lanes: piece.lanes.length, cut: cutN, entries, measured, groups: groups.length } };
}

/** a lane's shape from `s0` to `s1` metres along it */
function stretch(sh: LaneShape, s0: number, s1: number): LaneShape | null {
  let out: LaneShape = sh;
  if (s1 < laneLength(sh) - 0.5) { const p = splitShape(out, s1); if (!p) return null; out = p[0]; }
  if (s0 >= 0.5) { const p = splitShape(out, s0); if (!p) return null; out = p[1]; }
  return out;
}
