/**
 * The way a car would go from a lane to an exit lane, as the V2 simulation routes its cars: the shortest way in
 * metres by RouteTable (a lane change counting CHANGE_COST), taken step by step from where it comes in: at each step
 * the connector, or the change to a lane beside, the table says is nearest the exit. With its length and the time at
 * the lanes' speed limits (a bend no faster than it can be taken), or why there is none. Framework-free.
 */
import {
  CHANGE_COST, LastFew, RouteTable, connectorPts, dist, isFullCircle, laneById, laneLength, nearestOn, pointAt, speedLimitOf,
  type Pt, type Sketch,
} from "./lane-sketch";

export type RouteStep = { kind: "lane"; id: string; from: number; to: number } | { kind: "connector"; id: string; len: number } | { kind: "change"; from: string; to: string };
export interface RouteTrace { steps: RouteStep[]; length: number; freeTime: number }
export type RouteResult = { ok: true; route: RouteTrace } | { ok: false; reason: string };

/** m/s² sideways a bend may push (the simulation's) */
const A_LAT = 2.5;
/** the tightest radius along a polyline (m) */
function minRadius(pts: Pt[]) {
  let r = Infinity;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1], ab = dist(a, b), bc = dist(b, c), ca = dist(c, a);
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
    if (area2 > 1e-9) r = Math.min(r, (ab * bc * ca) / (2 * area2));
  }
  return r;
}

/** the lanes beside one in its road, running the same way: as RouteTable takes them */
function besideLanes(sk: Sketch, id: string) {
  const r = sk.roads.find(x => x.lanes.includes(id)), L = laneById(sk, id);
  if (!r || !L) return [];
  const m = pointAt(L.shape, laneLength(L.shape) / 2);
  return r.lanes.filter(b => b !== id).flatMap(b => {
    const Bl = laneById(sk, b);
    if (!Bl) return [];
    const q = nearestOn(Bl.shape, m.p), d = pointAt(Bl.shape, q.s).d;
    return q.d <= (L.width + Bl.width) / 2 + 0.75 && m.d.x * d.x + m.d.y * d.y >= 0.5 ? [Bl] : [];
  });
}

/** the routing table of a sketch, kept (what a test car drove is looked at again as it goes) */
const tables = new LastFew<Sketch, RouteTable>();
/** metres more than the shortest a car may take (the simulation's: one at random from those within 5 m), and a little over */
const TIE = 5 + 1;

/**
 * What a car drove (edge keys, `lane:…` / `conn:…`, in order) off the way traced, where it went another way than the cars
 * would: the stretches off it where it took a connector longer to the end of the way than the shortest from there by more
 * than the simulation's 5 m (as one looking for another way after waiting does), or jumped to a lane not beside its own.
 * Not counted: another lane of the same road beside one of the way's, and the connectors between such lanes, nor a way
 * off it as short as the traced one, give or take those 5 m (the cars take either). Empty if it kept to the way.
 */
export function offRoute(sk: Sketch, steps: ({ kind: "lane" | "connector"; id: string } | { kind: "change"; from: string; to: string })[], path: string[]): string[] {
  const lanes = new Set<string>(), conns = new Set<string>();
  for (const x of steps) {
    if (x.kind === "change") { lanes.add(x.from); lanes.add(x.to); } else (x.kind === "lane" ? lanes : conns).add(x.id);
  }
  const to = [...steps].reverse().find((x): x is { kind: "lane"; id: string } => x.kind === "lane")?.id;
  const near = new Set(lanes);
  for (const id of lanes) for (const b of besideLanes(sk, id)) near.add(b.id);
  const idOf = (k: string) => k.slice(k.indexOf(":") + 1);
  const on = (k: string) => {
    const id = idOf(k);
    if (k.startsWith("lane:")) return near.has(id);
    if (conns.has(id)) return true;
    const c = sk.connectors.find(x => x.id === id);
    return !!c && near.has(c.from.lane) && near.has(c.to.lane);
  };
  const table = routeTableOf(sk);
  /** the step from `prev` to `k` one the cars wouldn't take for the way's end */
  const astray = (prev: string | undefined, k: string) => {
    if (!to) return true;
    if (k.startsWith("lane:")) return !!prev?.startsWith("lane:") && !besideLanes(sk, idOf(prev)).some(b => b.id === idOf(k));
    const c = sk.connectors.find(x => x.id === idOf(k));
    if (!c) return true;
    const via = table.viaConnector(c.id, to), s = Math.max(0, c.from.s - 0.6);
    return via === Infinity || c.from.s - s + via > table.from(c.from.lane, s, to) + TIE;
  };
  const out: string[] = [];
  for (let i = 0; i < path.length; ) {
    if (on(path[i])) { i++; continue; }
    let j = i;
    while (j < path.length && !on(path[j])) j++;
    if (path.slice(i, j).some((k, n) => astray(path[i + n - 1], k))) out.push(...path.slice(i, j));
    i = j;
  }
  return out;
}

/** the sketch's routing table, kept for the last few sketches */
export function routeTableOf(sk: Sketch): RouteTable {
  let table = tables.get(sk);
  if (!table) tables.set(sk, (table = new RouteTable(sk)));
  return table;
}

/** `start`: metres along `from` it starts (a car on its way: where it is) */
export function traceRoute(sk: Sketch, from: string, to: string, table = new RouteTable(sk), start = 0): RouteResult {
  const name = (id: string) => sk.roads.find(r => r.lanes.includes(id))?.name ?? `lane ${id}`;
  const A = laneById(sk, from), B = laneById(sk, to);
  if (!A) return { ok: false, reason: `no lane ${from}` };
  if (!B) return { ok: false, reason: `no lane ${to}` };
  if (!table.exits.includes(to)) return { ok: false, reason: `${name(to)} (${to}) isn't a way out: connectors leave its end` };
  if (table.from(from, start, to) === Infinity) {
    const outs = sk.connectors.filter(c => c.from.lane === from);
    if (!outs.length && from !== to) return { ok: false, reason: `no connector leaves ${name(from)} (${from})` };
    if (!sk.connectors.some(c => c.to.lane === to) && from !== to) return { ok: false, reason: `no connector comes onto ${name(to)} (${to})` };
    const n = table.reachable(from).length;
    return { ok: false, reason: `${name(to)} (${to}) can't be reached from ${name(from)} (${from}): ${n ? `${n} other way${n === 1 ? "" : "s"} out can` : "no way out can"}` };
  }
  const v0 = (sk.traffic?.speed ?? 50) / 3.6, limit = (lane: string) => { const k = speedLimitOf(sk, lane); return k !== undefined ? k / 3.6 : v0; };
  const beside = (id: string) => besideLanes(sk, id);
  // (each lane's connectors leaving it)
  const outsOf = new Map<string, typeof sk.connectors>();
  for (const c of sk.connectors) outsOf.set(c.from.lane, [...(outsOf.get(c.from.lane) ?? []), c]);
  const steps: RouteStep[] = [];
  let lane = from, s = start, length = 0, time = 0, changed = false;
  for (let guard = 0; guard < 2000; guard++) {
    const L = laneById(sk, lane)!, len = laneLength(L.shape), ring = isFullCircle(L.shape);
    /** metres on from `s` to `at` as a car may go (round a ring; half a metre on at least, or the lane's very end); null: not that way */
    const reach = (at: number) => { const a = ring ? (((at - s) % len) + len) % len : at - s; return a > 0.5 || (!ring && at >= len - 0.01 && s < len - 0.01) ? Math.max(0, a) : null; };
    type Opt = { cost: number; go: () => void };
    const opts: Opt[] = [];
    if (lane === to && !ring) opts.push({ cost: len - s, go: () => { steps.push({ kind: "lane", id: lane, from: s, to: len }); length += len - s; time += (len - s) / limit(lane); s = len; } });
    for (const c of outsOf.get(lane) ?? []) {
      const a = reach(c.from.s), via = a === null ? Infinity : table.viaConnector(c.id, to);
      if (a === null || via === Infinity) continue;
      opts.push({ cost: a + via, go: () => {
        steps.push({ kind: "lane", id: lane, from: s, to: s + a }); length += a; time += a / limit(lane);
        const pts = connectorPts(sk, c) ?? [], cl = pts.slice(1).reduce((a, p, i) => a + dist(pts[i], p), 0);
        steps.push({ kind: "connector", id: c.id, len: cl }); length += cl;
        time += cl / Math.max(3, Math.min(limit(c.to.lane), Math.sqrt(A_LAT * minRadius(pts))));
        lane = c.to.lane; s = c.to.s; changed = false;
      } });
    }
    if (!changed) for (const b of beside(lane)) {
      const bs = nearestOn(b.shape, pointAt(L.shape, s).p).s, rest = table.from(b.id, bs, to);
      if (rest === Infinity) continue;
      opts.push({ cost: CHANGE_COST + rest, go: () => { steps.push({ kind: "change", from: lane, to: b.id }); lane = b.id; s = bs; changed = true; } });
    }
    if (!opts.length) return { ok: false, reason: `stuck on ${name(lane)} (${lane}) at ${s.toFixed(0)} m: nothing on from there leads to ${to}` };
    opts.sort((x, y) => x.cost - y.cost)[0].go();
    if (lane === to && s >= laneLength(laneById(sk, to)!.shape) - 0.01) return { ok: true, route: { steps: merge(steps), length, freeTime: time } };
  }
  return { ok: false, reason: "the way there goes round and round (a loop with no way out)" };
}

/** stretches of one lane one after another made one */
function merge(steps: RouteStep[]): RouteStep[] {
  const out: RouteStep[] = [];
  for (const x of steps) {
    const last = out[out.length - 1];
    if (x.kind === "lane" && last?.kind === "lane" && last.id === x.id) { last.to = x.to; continue; }
    if (x.kind === "lane" && x.to - x.from < 0.01 && out.length) continue;
    out.push({ ...x });
  }
  return out;
}

/** the exit lane of a way out nearest by the route from `from`, and that route */
export function traceToWay(sk: Sketch, from: string, exits: string[]): RouteResult {
  const table = new RouteTable(sk);
  const best = exits.map(ex => ({ ex, d: table.from(from, 0, ex) })).sort((a, b) => a.d - b.d)[0];
  return traceRoute(sk, from, best?.ex ?? exits[0], table);
}
