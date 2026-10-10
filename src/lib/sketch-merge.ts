/**
 * Merging, the other way from slicing (as V1's "Merge roads", `mergeLinks` in state/ops.ts, does for its roads): two
 * lanes where one carries on the other made one lane, or two roads that carry on each other made one road.
 *  - Lanes: the first's end meets the second's start, right there or through a single connector between just them.
 *    One lane comes of them: the first's points, the connector's bends (or the middle of its curve) and the second's
 *    points; the connector goes. It keeps the first's id, what is at its start (the traffic coming in) and its
 *    width, level and speed limit; what is at the second's end (its sign, its share of the trips out). Connectors on
 *    either stay where they were along it. What the second had otherwise is dropped, and said.
 *  - Roads: each lane of one carries on a lane of the other (as above), as many each way. The first road keeps its
 *    id, name, speed limit and lanes; a side-by-side road is laid out again from its lead lane, merged with the lane
 *    it carries on. A link between the two goes; one at the second's far end now joins the merged road there.
 * Not merged: lanes that don't meet end to start, where something else joins or leaves where they meet, on a
 * junction, rings, lanes following a lead (merge their roads instead), or two that would make a loop. Framework-free.
 */
import {
  arcToPoints, connectorPts, contentsOf, dist, isFullCircle, laneById, laneLength, leadOf, linkEnd, pointAt, settle,
  type LaneAt, type Pt, type Sketch, type SketchConnector, type SketchLane,
} from "./lane-sketch";

export type MergeResult = { ok: true; sketch: Sketch; /** what was dropped (where the two differed), said in words */ dropped: string[] } | { ok: false; reason: string };

/** ends nearer than this (m) meet right there */
const MEET = 1;
/** a connector joining two lanes leaves the first this near its end and comes onto the second this near its start (m) */
const AT_END = 1;
const r2 = (x: number) => Math.round(x * 100) / 100;
const fail = (reason: string): MergeResult => ({ ok: false, reason });

/** how lane `a` carries on into lane `b`: its end meeting b's start (`via` null) or one connector between just them there; null if it doesn't */
function joinOf(sk: Sketch, a: string, b: string): { via: SketchConnector | null } | null {
  const A = laneById(sk, a), B = laneById(sk, b);
  if (!A || !B || a === b || isFullCircle(A.shape) || isFullCircle(B.shape)) return null;
  const LA = laneLength(A.shape);
  const cs = sk.connectors.filter(c => c.from.lane === a && c.to.lane === b && c.from.s >= LA - AT_END && c.to.s <= AT_END);
  if (cs.length === 1) return { via: cs[0] };
  if (cs.length > 1) return null;
  return dist(pointAt(A.shape, LA).p, pointAt(B.shape, 0).p) <= MEET ? { via: null } : null;
}

/** why `first` and `second` (in that order) can't be merged where they meet; null if they can */
function blocked(sk: Sketch, first: string, second: string, via: SketchConnector | null): string | null {
  const A = laneById(sk, first)!, LA = laneLength(A.shape);
  if (joinOf(sk, second, first)) return `Lanes ${first} and ${second} meet at both ends: merged, the lane would lead into itself`;
  const out = sk.connectors.find(c => c !== via && c.from.lane === first && c.from.s >= LA - AT_END);
  if (out) return `Connector ${out.id} also leaves lane ${first} where they meet: another way goes off there (a junction), so they don't just carry on`;
  const into = sk.connectors.find(c => c !== via && c.to.lane === second && c.to.s <= AT_END);
  if (into) return `Connector ${into.id} also joins lane ${second} where they meet: another way comes in there (a junction), so they don't just carry on`;
  const cs = contentsOf(sk);
  for (const j of sk.junctions) {
    const c = cs.get(j.id);
    if (c && (c.lanes.includes(first) || c.lanes.includes(second) || (via && c.connectors.includes(via.id)))) return `${j.name} sits between them (they meet on it): only lanes that carry on outside junctions can be merged`;
  }
  return null;
}

/** a line lane's points and which are curved (an arc made points first) */
function linePts(sk: Sketch, id: string): { sk: Sketch; pts: Pt[]; curved: boolean[] } {
  let lane = laneById(sk, id)!;
  if (lane.shape.kind === "arc") { sk = arcToPoints(sk, id); lane = laneById(sk, id)!; }
  const sh = lane.shape as Extract<SketchLane["shape"], { kind: "line" }>;
  return { sk, pts: sh.pts, curved: sh.pts.map((_, i) => !!sh.curved?.[i]) };
}

/** what lane `b` had that the merged lane, `a`'s, doesn't keep: in words */
function differences(a: SketchLane, b: SketchLane, endOfA: SketchLane, startOfB: SketchLane): string[] {
  const out: string[] = [];
  if (a.width !== b.width) out.push(`lane ${b.id}'s width (${b.width} m; kept ${a.width} m)`);
  if ((a.level ?? 0) !== (b.level ?? 0)) out.push(`lane ${b.id}'s level (${b.level ?? 0}; kept ${a.level ?? 0})`);
  if (a.speed !== b.speed && (a.speed !== undefined || b.speed !== undefined)) out.push(`lane ${b.id}'s speed limit (${b.speed ?? "the sketch's"}; kept ${a.speed ?? "the sketch's"})`);
  if (endOfA.control) out.push(`the ${endOfA.control} line at the end of lane ${endOfA.id} (now partway along)`);
  if (startOfB.inRate !== undefined) out.push(`lane ${startOfB.id}'s traffic coming in (${startOfB.inRate}/h)`);
  if (endOfA.outWeight !== undefined) out.push(`lane ${endOfA.id}'s share of the trips out`);
  return out;
}

/**
 * Lanes `first` and `second` (traffic going from the first on into the second) made one lane `keep` (one of the two),
 * the other's references (journeys, turning shares) to it; `follow`: lanes following a lead are merged too (a road's).
 * Not settled.
 */
function joinLanes(sk0: Sketch, first: string, second: string, via: SketchConnector | null, keep: string): { sketch: Sketch; dropped: string[] } {
  const a0 = laneById(sk0, first)!, b0 = laneById(sk0, second)!;
  const A = linePts(sk0, first), B = linePts(A.sk, second);
  let sk = B.sk;
  const LB = laneLength(laneById(sk, second)!.shape);
  // (between them: the connector's bends, or the middle of its curve; right there: one point where they meet)
  let mid: Pt[] = [], midCurved: boolean[] = [];
  const ca = A.curved;
  let pa = A.pts, pb = B.pts, cb = B.curved;
  if (via?.via?.length) { mid = via.via; midCurved = via.via.map(() => !via.straight); }
  else if (via) {
    const curve = connectorPts(sk, via);
    if (curve && dist(pa[pa.length - 1], pb[0]) > MEET) {
      const q = pointAt({ kind: "line", pts: curve }, laneLength({ kind: "line", pts: curve }) / 2).p;
      mid = [{ x: r2(q.x), y: r2(q.y) }]; midCurved = [!via.straight];
    }
  } else {
    const m = { x: r2((pa[pa.length - 1].x + pb[0].x) / 2), y: r2((pa[pa.length - 1].y + pb[0].y) / 2) };
    pa = [...pa.slice(0, -1), m]; pb = pb.slice(1); cb = cb.slice(1);
  }
  const pts: Pt[] = [], curved: boolean[] = [];
  [...pa, ...mid, ...pb].forEach((p, i) => {
    const c = [...ca, ...midCurved, ...cb][i];
    if (pts.length && dist(pts[pts.length - 1], p) < 0.01) return;
    pts.push(p); curved.push(c);
  });
  curved[0] = false; curved[curved.length - 1] = false;
  const shape = { kind: "line" as const, pts, ...(curved.some(Boolean) ? { curved } : {}) };
  const L = laneLength(shape);
  // (its start the first's: the traffic coming in; its end the second's: its sign, its share of the trips out; the rest the kept one's)
  const base = keep === first ? a0 : b0, gone = keep === first ? second : first;
  const lane: SketchLane = {
    id: keep, shape, width: base.width,
    ...(base.level !== undefined ? { level: base.level } : {}), ...(base.speed !== undefined ? { speed: base.speed } : {}),
    ...(a0.inRate !== undefined ? { inRate: a0.inRate } : {}),
    ...(b0.control ? { control: b0.control } : {}), ...(b0.outWeight !== undefined ? { outWeight: b0.outWeight } : {}),
  };
  const dropped = differences(base, keep === first ? b0 : a0, a0, b0);
  // (connectors on the first as far from its start as they were; on the second as far from its end)
  const place = (x: LaneAt): LaneAt => (x.lane === first ? { lane: keep, s: r2(Math.min(x.s, L)) } : x.lane === second ? { lane: keep, s: r2(Math.max(0, L - (LB - x.s))) } : x);
  const rename = (id: string) => (id === gone ? keep : id);
  sk = {
    ...sk,
    lanes: sk.lanes.flatMap(l => (l.id === keep ? [lane] : l.id === gone ? [] : [l])),
    connectors: sk.connectors.filter(c => c !== via && c.id !== via?.id).map(c => (c.from.lane === first || c.from.lane === second || c.to.lane === first || c.to.lane === second ? { ...c, from: place(c.from), to: place(c.to) } : c)),
    roads: sk.roads.map(r => (r.lanes.includes(gone) ? { ...r, lanes: r.lanes.filter(x => x !== gone) } : r)).filter(r => r.lanes.length),
    ...(sk.journeys ? { journeys: sk.journeys.map(j => ({ ...j, from: rename(j.from), to: rename(j.to) })) } : {}),
    junctions: sk.junctions.map(j => (j.splits?.some(s => s.from === `lane:${gone}` || `lane:${gone}` in s.shares)
      ? { ...j, splits: j.splits.map(s => ({ from: s.from === `lane:${gone}` ? `lane:${keep}` : s.from, shares: Object.fromEntries(Object.entries(s.shares).map(([k, v]) => [k === `lane:${gone}` ? `lane:${keep}` : k, v])) })) }
      : j)),
  };
  return { sketch: sk, dropped };
}

/**
 * Two lanes merged into one (in either order: the one traffic comes along first keeps its id), or why not.
 */
export function mergeLanes(sk: Sketch, a: string, b: string): MergeResult {
  if (a === b) return fail("Select two different lanes.");
  for (const id of [a, b]) {
    const l = laneById(sk, id);
    if (!l) return fail(`There is no lane ${id}.`);
    if (isFullCircle(l.shape)) return fail(`Lane ${id} is a ring: it has no ends to merge at.`);
    if (leadOf(sk, id)) return fail(`Lane ${id} follows its road's lead lane (side by side): merge the two roads instead.`);
    const r = sk.roads.find(x => x.align?.ref === id && x.lanes.length > 1);
    if (r) return fail(`Lane ${id} leads ${r.name}'s other lanes (side by side): merge the two roads instead.`);
  }
  const ab = joinOf(sk, a, b), ba = joinOf(sk, b, a);
  if (ab && ba) return fail(`Lanes ${a} and ${b} meet at both ends: merged, the lane would lead into itself.`);
  const [first, second, j] = ab ? [a, b, ab] : ba ? [b, a, ba] : [a, b, null];
  if (!j) return fail(`Lanes ${a} and ${b} don't carry on one into the other: one's end must meet the other's start, right there or through one connector between just them.`);
  const why = blocked(sk, first, second, j.via);
  if (why) return fail(`${why}.`);
  const out = joinLanes(sk, first, second, j.via, first);
  return { ok: true, sketch: settle(out.sketch), dropped: out.dropped };
}

/**
 * Two roads merged into one, the first (`a`) keeping its id, name and lanes, or why not.
 */
export function mergeRoads(sk: Sketch, a: string, b: string): MergeResult {
  const R1 = sk.roads.find(r => r.id === a), R2 = sk.roads.find(r => r.id === b);
  if (!R1 || !R2) return fail("Select two roads.");
  if (a === b) return fail("Select two different roads.");
  if (R1.lanes.length !== R2.lanes.length) return fail(`${R1.name} has ${R1.lanes.length} lanes and ${R2.name} ${R2.lanes.length}: they must have as many each way.`);
  // (each lane of the first carrying on one of the second, or carried on by one: once each)
  type Pair = { r1: string; r2: string; first: string; second: string; via: SketchConnector | null };
  const pairs: Pair[] = [];
  for (const x of R1.lanes) {
    let loop = false;
    const found = R2.lanes.flatMap((y): Pair[] => {
      const xy = joinOf(sk, x, y), yx = joinOf(sk, y, x);
      if (xy && yx) { loop = true; return []; }
      return xy ? [{ r1: x, r2: y, first: x, second: y, via: xy.via }] : yx ? [{ r1: x, r2: y, first: y, second: x, via: yx.via }] : [];
    });
    if (loop) return fail(`${R1.name} and ${R2.name} meet at both ends: merged, the road would lead into itself.`);
    const free = found.filter(f => !pairs.some(p => p.r2 === f.r2));
    if (!free.length) return fail(`Lane ${x} of ${R1.name} doesn't carry on into a lane of ${R2.name} (nor one into it): their lanes must meet end to start, as many each way.`);
    pairs.push(free[0]);
  }
  for (const p of pairs) {
    const why = blocked(sk, p.first, p.second, p.via);
    if (why) return fail(`${why}.`);
  }
  // (where they meet: a link there to a third road is a way off there)
  const leadPair = pairs.find(p => p.r1 === (R1.align?.ref ?? R1.lanes[0]))!, r1First = leadPair.first === leadPair.r1;
  const meet = (() => { const l = laneById(sk, leadPair.first)!; return pointAt(l.shape, laneLength(l.shape)).p; })();
  const nearMeet = (e: { road: string; end: "start" | "end" }) => { const E = linkEnd(sk, e); return !!E && dist(E.p, meet) < 15; };
  const links = sk.links ?? [];
  for (const k of links) {
    const ends = [k.a, k.b], r1 = ends.find(e => e.road === a), r2e = ends.find(e => e.road === b), other = ends.find(e => e.road !== a && e.road !== b);
    if ((r1 && other && nearMeet(r1)) || (r2e && other && nearMeet(r2e))) return fail(`${R1.name} and ${R2.name} meet where a link joins another road: a way goes off there.`);
  }
  const dropped: string[] = [];
  if (R1.name !== R2.name) dropped.push(`${R2.name}'s name (kept ${R1.name})`);
  if (R1.speed !== R2.speed) dropped.push(`${R2.name}'s speed limit (${R2.speed ?? "the sketch's"}; kept ${R1.speed ?? "the sketch's"})`);
  // (the links between them go, with their connectors; one at the second's far end joins the merged road there)
  const between = new Set(links.filter(k => [k.a.road, k.b.road].includes(a) && [k.a.road, k.b.road].includes(b)).map(k => k.id));
  const betweenConns = new Set(links.filter(k => between.has(k.id)).flatMap(k => k.conns));
  const farEnd = r1First ? "end" as const : "start" as const;
  let out: Sketch = {
    ...sk,
    connectors: sk.connectors.filter(c => !betweenConns.has(c.id)),
    ...(sk.links ? { links: links.filter(k => !between.has(k.id)).map(k => ({ ...k, a: k.a.road === b ? { road: a, end: farEnd } : k.a, b: k.b.road === b ? { road: a, end: farEnd } : k.b })) } : {}),
  };
  // (a road side by side: only its lead merged, the others laid out from it again, their connectors kept along them)
  const aligned = !!R1.align && R1.lanes.length > 1;
  const merged = aligned ? [leadPair] : pairs;
  for (const p of merged) {
    const via = p.via && out.connectors.some(c => c.id === p.via!.id) ? p.via : null;
    const r = joinLanes(out, p.first, p.second, via, p.r1);
    out = r.sketch; dropped.push(...r.dropped);
  }
  out = { ...out, roads: out.roads.filter(r => r.id !== b).map(r => (r.id === a ? { ...R1, lanes: R1.lanes } : r)) };
  if (aligned) {
    // (the followers: each the length it is now, laid out from the merged lead; the second road's lane's connectors onto it)
    const before = new Map(pairs.filter(p => p !== leadPair).map(p => [p.r1, { first: p.first, second: p.second, L1: laneLength(laneById(sk, p.first)!.shape), L2: laneLength(laneById(sk, p.second)!.shape), via: p.via }]));
    const gone = new Set(pairs.filter(p => p !== leadPair).map(p => p.r2));
    out = { ...out, lanes: out.lanes.filter(l => !gone.has(l.id)), connectors: out.connectors.filter(c => !pairs.some(p => p !== leadPair && p.via && c.id === p.via.id)) };
    const settled = settle({ ...out, connectors: out.connectors.filter(c => !gone.has(c.from.lane) && !gone.has(c.to.lane)) });
    const len = new Map(settled.lanes.map(l => [l.id, laneLength(l.shape)]));
    const place = (x: LaneAt): LaneAt => {
      for (const [keep, f] of before) {
        const L = len.get(keep) ?? 0;
        if (x.lane === f.first) return { lane: keep, s: r2(Math.min(x.s, L)) };
        if (x.lane === f.second) return { lane: keep, s: r2(Math.max(0, L - (f.L2 - x.s))) };
      }
      return x;
    };
    const moved = new Set([...before].flatMap(([, f]) => [f.first, f.second]));
    const rename = (id: string) => { for (const p of pairs) if (p !== leadPair && id === p.r2) return p.r1; return id; };
    out = {
      ...out,
      connectors: out.connectors.map(c => (moved.has(c.from.lane) || moved.has(c.to.lane) ? { ...c, from: place(c.from), to: place(c.to) } : c)),
      ...(out.journeys ? { journeys: out.journeys.map(j => ({ ...j, from: rename(j.from), to: rename(j.to) })) } : {}),
    };
  }
  // (turning shares: the second road's now the first's)
  out = { ...out, junctions: out.junctions.map(j => (j.splits?.some(s => s.from === b || b in s.shares)
    ? { ...j, splits: j.splits.map(s => ({ from: s.from === b ? a : s.from, shares: Object.fromEntries(Object.entries(s.shares).map(([k, v]) => [k === b ? a : k, v])) })) }
    : j)) };
  return { ok: true, sketch: settle(out), dropped };
}
