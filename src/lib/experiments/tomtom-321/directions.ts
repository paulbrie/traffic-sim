/**
 * The centre's streets turned round (ticket #321): a two-lane street both ways (one lane each way) made one-way on both
 * lanes, or a one-way two-lane street made one lane each way, or a one-lane one-way street the other way round. A street is
 * its road pieces of the same name joined end to end through junctions, set out the same way, so a change is made along all
 * of it at once (half a one-way street turned round would point its halves at each other).
 *
 * Changing a lane's direction (lane-sketch's `reverseLane`) leaves its connectors where they were, so the turns at both its
 * junctions are made again, as the editor's would be drawn: every way in to every way out of another road (no U-turns),
 * straight on lane to lane, a left turn from the leftmost lane to the leftmost, a right turn from the rightmost to the
 * rightmost; the connectors not touching a turned lane stay as they were. A turned lane's sign (give way, stop) is at its end, so
 * it takes the sign the street had at its new end, or none (who goes first is then the simulation's rules: the main road,
 * left turns, from the right). Framework-free.
 */
import { demandWays, junctionContents, laneLength, pointAt, reverseLane, type Pt, type Sketch, type SketchConnector } from "../../lane-sketch";

export interface Street {
  id: string; name: string; roads: string[];
  /** "1": one lane one way; "1+1": a lane each way; "2": two lanes one way */
  kind: "1" | "1+1" | "2";
  /** its lanes in two classes, each running the same way along the street (class 0 the way its first lane runs) */
  cls: Record<string, 0 | 1>;
  lengthM: number;
}
export type Move = { street: string; to: "reverse" | "oneway0" | "oneway1" | "twoway" };

interface Ends { start: string | null; end: string | null }

/** each lane's junction at its start and at its end (by the connectors there; null: none, a way in or out) */
export function laneEnds(sk: Sketch): Map<string, Ends> {
  const jOf = new Map<string, string>();
  for (const j of sk.junctions) for (const c of junctionContents(sk, j).connectors) jOf.set(c, j.id);
  // (connectors in no junction drawn, joining a road's pieces end to end: those within 8 m of each other, by where they
  // leave their lane, count as one junction of their own, "at:<first connector's id>")
  const loose = sk.connectors.filter(c => !jOf.has(c.id)).map(c => {
    const l = sk.lanes.find(x => x.id === c.from.lane);
    return { c, p: l ? pointAt(l.shape, Math.min(c.from.s, laneLength(l.shape))).p : null };
  }).filter((x): x is { c: SketchConnector; p: Pt } => !!x.p);
  const group = new Map<string, string>();
  for (const x of loose) {
    const near = loose.find(y => group.has(y.c.id) && Math.hypot(y.p.x - x.p.x, y.p.y - x.p.y) < 8);
    group.set(x.c.id, near ? group.get(near.c.id)! : `at:${x.c.id}`);
  }
  for (const [c, g] of group) jOf.set(c, g);
  const out = new Map<string, Ends>(sk.lanes.map(l => [l.id, { start: null, end: null }]));
  const len = new Map(sk.lanes.map(l => [l.id, laneLength(l.shape)]));
  for (const c of sk.connectors) {
    const j = jOf.get(c.id);
    if (!j) continue;
    const f = out.get(c.from.lane), t = out.get(c.to.lane);
    // (at the lanes' ends only: a connector off a lane part-way along is a lane change or a slip road, not its junction)
    if (f && c.from.s > (len.get(c.from.lane) ?? 0) - 2) f.end ??= j;
    if (t && c.to.s < 2) t.start ??= j;
  }
  return out;
}

const dirAt = (sk: Sketch, lane: string, atEnd: boolean) => {
  const l = sk.lanes.find(x => x.id === lane)!, L = laneLength(l.shape);
  return pointAt(l.shape, atEnd ? L : 0);
};

/** the streets inside `area` (a polygon) that may be turned: every lane of them joined at both ends, none both ways in one, no lights */
export function streetsIn(sk: Sketch, inArea: (p: Pt) => boolean): Street[] {
  const ends = laneEnds(sk), lanes = new Map(sk.lanes.map(l => [l.id, l]));
  const lit = new Set(sk.junctions.filter(j => j.lights).map(j => j.id));
  const kindOf = (lids: string[]): Street["kind"] | null => {
    if (lids.length === 1) return "1";
    if (lids.length !== 2) return null;
    // (by their middles: a lane each way, or both the same way)
    const ma = pointAt(lanes.get(lids[0])!.shape, laneLength(lanes.get(lids[0])!.shape) / 2).d, mb = pointAt(lanes.get(lids[1])!.shape, laneLength(lanes.get(lids[1])!.shape) / 2).d;
    return ma.x * mb.x + ma.y * mb.y < 0 ? "1+1" : "2";
  };
  const ok = sk.roads.filter(r => {
    const ls = r.lanes.map(id => lanes.get(id));
    if (!ls.length || ls.some(l => !l || l.twoWay || l.bike || l.shape.kind !== "line")) return false;
    if (!ls.every(l => inArea(pointAt(l!.shape, laneLength(l!.shape) / 2).p))) return false;
    return r.lanes.every(id => { const e = ends.get(id)!; return e.start && e.end && !lit.has(e.start) && !lit.has(e.end); }) && kindOf(r.lanes) !== null;
  });
  // (pieces joined: the same name and kind, a connector from a lane of one to a lane of the other)
  const roadOfLane = new Map<string, string>();
  for (const r of ok) for (const id of r.lanes) roadOfLane.set(id, r.id);
  const parent = new Map(ok.map(r => [r.id, r.id]));
  const find = (x: string): string => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x)!)), parent.get(x)!));
  const info = new Map(ok.map(r => [r.id, { name: r.name.replace(/ \(\d+\)$/, ""), kind: kindOf(r.lanes)! }]));
  // (lanes running the same way: joined by a connector going straight on)
  const same: [string, string][] = [];
  for (const c of sk.connectors) {
    const ra = roadOfLane.get(c.from.lane), rb = roadOfLane.get(c.to.lane);
    if (!ra || !rb || ra === rb) continue;
    const ia = info.get(ra)!, ib = info.get(rb)!;
    if (ia.name !== ib.name || ia.kind !== ib.kind) continue;
    const a = dirAt(sk, c.from.lane, true).d, b = dirAt(sk, c.to.lane, false).d;
    if (a.x * b.x + a.y * b.y < 0.7) continue;
    parent.set(find(ra), find(rb));
    same.push([c.from.lane, c.to.lane]);
  }
  const groups = new Map<string, string[]>();
  for (const r of ok) (groups.get(find(r.id)) ?? groups.set(find(r.id), []).get(find(r.id))!).push(r.id);
  const out: Street[] = [];
  for (const roads of groups.values()) {
    const kind = info.get(roads[0])!.kind, lids = roads.flatMap(r => sk.roads.find(x => x.id === r)!.lanes);
    // (the two ways along it: lanes joined straight on the same way; a two-way piece's lanes the two ways)
    const cls = new Map<string, 0 | 1>();
    const adj = new Map<string, { to: string; flip: boolean }[]>();
    const link = (a: string, b: string, flip: boolean) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push({ to: b, flip }); (adj.get(b) ?? adj.set(b, []).get(b)!).push({ to: a, flip }); };
    const set = new Set(lids);
    for (const [a, b] of same) if (set.has(a) && set.has(b)) link(a, b, false);
    for (const r of roads) {
      const ls = sk.roads.find(x => x.id === r)!.lanes;
      if (ls.length === 2) link(ls[0], ls[1], kind === "1+1");
    }
    let consistent = true;
    for (const start of lids) {
      if (cls.has(start)) continue;
      cls.set(start, 0);
      const q = [start];
      while (q.length) {
        const x = q.pop()!;
        for (const { to, flip } of adj.get(x) ?? []) {
          const want = (flip ? 1 - cls.get(x)! : cls.get(x)!) as 0 | 1;
          if (!cls.has(to)) { cls.set(to, want); q.push(to); } else if (cls.get(to) !== want) consistent = false;
        }
      }
    }
    // (pieces of it not joined to the rest: a street only where it is one)
    const comps = new Set(lids.map(l => find(roadOfLane.get(l)!)));
    if (!consistent || comps.size !== 1) continue;
    const name = info.get(roads[0])!.name;
    out.push({ id: roads.slice().sort()[0], name, roads, kind, cls: Object.fromEntries(cls), lengthM: Math.round(roads.reduce((a, r) => a + laneLength(lanes.get(sk.roads.find(x => x.id === r)!.lanes[0])!.shape), 0)) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** the moves a street may make */
export function movesOf(s: Street): Move[] {
  if (s.kind === "1") return [{ street: s.id, to: "reverse" }];
  if (s.kind === "1+1") return [{ street: s.id, to: "oneway0" }, { street: s.id, to: "oneway1" }];
  return [{ street: s.id, to: "twoway" }];
}

/** the lanes a move turns round */
export function lanesTurned(sk: Sketch, s: Street, m: Move): string[] {
  const lids = Object.keys(s.cls);
  if (m.to === "reverse") return lids;
  if (m.to === "oneway0") return lids.filter(l => s.cls[l] === 1);
  if (m.to === "oneway1") return lids.filter(l => s.cls[l] === 0);
  // (two lanes one way to one each way: in each piece its left lane as it runs, so each way keeps to its right)
  const out: string[] = [];
  for (const r of s.roads) {
    const [a, b] = sk.roads.find(x => x.id === r)!.lanes;
    const A = dirAt(sk, a, false), pb = dirAt(sk, b, false).p;
    // (b to the right of a, as a runs: a is the left one; y down, so right is (-dy, dx))
    const right = (pb.x - A.p.x) * -A.d.y + (pb.y - A.p.y) * A.d.x;
    out.push(right > 0 ? a : b);
  }
  return out;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** the sketch with lanes `turn` turned round and their junctions' turns made again (new connectors `idPrefix`1, 2, …) */
export function turnLanes(sk0: Sketch, turn: string[], idPrefix = "c"): Sketch {
  const ends0 = laneEnds(sk0), T = new Set(turn);
  // (the signs at each junction's ways in, by road, before: a turned lane takes its street's there)
  const signAt = new Map<string, string>();
  const roadOf = new Map<string, string>();
  for (const r of sk0.roads) for (const l of r.lanes) roadOf.set(l, r.id);
  for (const l of sk0.lanes) { const e = ends0.get(l.id)?.end; if (e && l.control && !T.has(l.id)) signAt.set(`${e}|${roadOf.get(l.id)}`, l.control); }
  let sk = sk0;
  for (const id of turn) sk = reverseLane(sk, id);
  sk = { ...sk, lanes: sk.lanes.map(l => {
    if (!T.has(l.id)) return l;
    const { control: _c, ...rest } = l;
    const e = ends0.get(l.id)!.start; // (its new end)
    const sign = e ? signAt.get(`${e}|${roadOf.get(l.id)}`) : undefined;
    return sign ? { ...rest, control: sign as typeof l.control } : rest;
  }) };
  // (each turned lane's new ends: the other way round)
  const ends = new Map(ends0);
  for (const id of turn) { const e = ends0.get(id)!; ends.set(id, { start: e.end, end: e.start }); }
  const junctions = new Set(turn.flatMap(id => [ends.get(id)!.start, ends.get(id)!.end]).filter((x): x is string => !!x));
  // (the connectors touching a turned lane go; the junctions' others stay)
  const kept = sk.connectors.filter(c => !T.has(c.from.lane) && !T.has(c.to.lane));
  // (new connectors' ids: the prefix and the next number free after it)
  let n = 0;
  // (the prefix escaped for a RegExp: every character not a word character gets a backslash)
  const re = new RegExp(`^${idPrefix.replace(/\W/g, "\\$&")}(\\d+)$`);
  for (const c of sk.connectors) { const m = re.exec(c.id); if (m) n = Math.max(n, Number(m[1])); }
  const made: SketchConnector[] = [];
  const len = new Map(sk.lanes.map(l => [l.id, laneLength(l.shape)]));
  for (const j of junctions) {
    // (the junction's lanes: in, ending there; out, starting there; by road)
    const ins = new Map<string, string[]>(), outs = new Map<string, string[]>();
    for (const [id, e] of ends) {
      if (e.end === j) (ins.get(roadOf.get(id) ?? id) ?? ins.set(roadOf.get(id) ?? id, []).get(roadOf.get(id) ?? id)!).push(id);
      if (e.start === j) (outs.get(roadOf.get(id) ?? id) ?? outs.set(roadOf.get(id) ?? id, []).get(roadOf.get(id) ?? id)!).push(id);
    }
    for (const [ri, li] of ins) for (const [ro, lo] of outs) {
      if (ri === ro || (!li.some(l => T.has(l)) && !lo.some(l => T.has(l)))) continue;
      const a = dirAt(sk, li[0], true), b = dirAt(sk, lo[0], false);
      const turnA = Math.atan2(a.d.x * b.d.y - a.d.y * b.d.x, a.d.x * b.d.x + a.d.y * b.d.y);
      if (Math.abs(turnA) > 2.6) continue; // (a U-turn)
      // (left to right as each runs: y down, right is (-dy, dx))
      const across = (ids: string[], atEnd: boolean) => ids.map(id => { const p = dirAt(sk, id, atEnd); return { id, r: p.p.x * -p.d.y + p.p.y * p.d.x }; }).sort((x, y) => x.r - y.r).map(x => x.id);
      const L = across(li, true), O = across(lo, false);
      const pairs: [string, string][] = turnA < -0.6 ? [[L[0], O[0]]] : turnA > 0.6 ? [[L[L.length - 1], O[O.length - 1]]]
        : L.map((l, i) => [l, O[Math.min(O.length - 1, Math.round((i * (O.length - 1)) / Math.max(1, L.length - 1)))]] as [string, string]);
      for (const [f, t] of pairs) {
        if (kept.some(c => c.from.lane === f && c.to.lane === t) || made.some(c => c.from.lane === f && c.to.lane === t)) continue;
        made.push({ id: `${idPrefix}${++n}`, from: { lane: f, s: r2(len.get(f)!) }, to: { lane: t, s: 0 } });
      }
    }
  }
  return { ...sk, connectors: [...kept, ...made] };
}

/**
 * The turned lanes nothing can drive: no way onto one at its new start, or none off it at its new end (a street turned to
 * run back into a junction every other road only leaves, say). A move leaving one is refused.
 */
export function deadLanes(sk: Sketch, turned: string[]): string[] {
  const len = new Map(sk.lanes.map(l => [l.id, laneLength(l.shape)]));
  return turned.filter(id => !sk.connectors.some(c => c.to.lane === id && c.to.s < 0.5) || !sk.connectors.some(c => c.from.lane === id && c.from.s > len.get(id)! - 0.5));
}

/**
 * The lanes a change leaves with nothing onto them or nothing off them that had both before: new ways in or out, which
 * are stubs of street nobody can drive (a two-way street's other way, one piece on, left running out of a junction
 * nothing now leads into). Not only the turned lanes: their neighbours too. A change leaving one is refused.
 */
export function newEnds(before: Sketch, after: Sketch): string[] {
  const w0 = demandWays(before), w1 = demandWays(after);
  const was = new Set([...w0.entries, ...w0.exits].flatMap(e => e.lanes));
  return [...new Set([...w1.entries, ...w1.exits].flatMap(e => e.lanes))].filter(l => !was.has(l));
}

/** the ways out each way in reaches (lanes and connectors as a graph) */
export function reach(sk: Sketch, entries: string[], exits: string[]): Map<string, Set<string>> {
  const next = new Map<string, string[]>();
  for (const c of sk.connectors) (next.get(c.from.lane) ?? next.set(c.from.lane, []).get(c.from.lane)!).push(c.to.lane);
  const ex = new Set(exits), out = new Map<string, Set<string>>();
  for (const e of entries) {
    const seen = new Set([e]), q = [e], got = new Set<string>();
    while (q.length) { const x = q.pop()!; if (ex.has(x)) got.add(x); for (const y of next.get(x) ?? []) if (!seen.has(y)) { seen.add(y); q.push(y); } }
    out.set(e, got);
  }
  return out;
}
