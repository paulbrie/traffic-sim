/**
 * A design for the random city (ticket #277): what the planner may change, as a genome a search (or a neural network) can
 * work with, and the plan it makes: a V1 network, converted to a V2 sketch by the app's own converter (`networkToSketch`),
 * with the demand put on it.
 *
 *  - `four`: the two named streets given four lanes (two each way); every other street has one lane each way (the ticket:
 *    only two main streets may have four lanes, the others two at most);
 *  - `centre`: per link inside the ring: 0 two-way, 1 one-way as the link runs (a → b), 2 one-way the other way, 3 closed to
 *    cars (a pedestrian street);
 *  - `control`: per key junction, priority (the main road has right of way, the others give way), lights or a roundabout.
 */
import { DEFAULT_SIGNAL, type LinkDef, type Network, type NodeDef } from "../../../engine/types";
import { networkToSketch } from "../../v1-to-v2";
import { demandWays, dist, type Sketch, type SketchLane, type Pt } from "../../lane-sketch";
import { CONTROLS, STREETS, type City, type Rng, type StreetId, type XY } from "./city";

export interface Design { four: [number, number]; centre: number[]; control: number[] }
export const CENTRE_STATES = ["two-way", "one-way →", "one-way ←", "closed"] as const;

/** the links a design's `centre` genes are for, in order */
export const centreLinks = (city: City) => city.links.filter(l => l.centre);

/** the status quo: the main road four lanes outside the ring (Calea Apusului, Calea Răsăritului), every street open both ways, lights where the main road meets the ring and in the centre */
export function baseline(city: City): Design {
  return { four: [STREETS.findIndex(s => s.id === "mainW"), STREETS.findIndex(s => s.id === "mainE")], centre: centreLinks(city).map(() => 0), control: city.keys.map(k => CONTROLS.indexOf(k.base)) };
}

export function randomDesign(city: City, R: Rng, pClosed = 0.12, pOneWay = 0.2): Design {
  const a = Math.floor(R() * STREETS.length);
  let b = Math.floor(R() * (STREETS.length - 1));
  if (b >= a) b++;
  const centre = centreLinks(city).map(() => { const r = R(); return r < pClosed ? 3 : r < pClosed + pOneWay ? (R() < 0.5 ? 1 : 2) : 0; });
  return repair(city, { four: a < b ? [a, b] : [b, a], centre, control: city.keys.map(() => Math.floor(R() * CONTROLS.length)) }, R);
}

export const sameDesign = (a: Design, b: Design) => designKey(a) === designKey(b);
export const designKey = (d: Design) => `${d.four.join(".")}|${d.centre.join("")}|${d.control.join("")}`;
export function parseKey(k: string): Design {
  const [f, c, j] = k.split("|");
  return { four: f.split(".").map(Number) as [number, number], centre: [...c].map(Number), control: [...j].map(Number) };
}

/**
 * The design's streets as directed edges, and whether every place can still be reached from every other (closures and
 * one-way streets can cut the centre off, or leave a street nobody can leave). Not: put back closed and one-way links,
 * one at a time at random, until it can.
 */
export function repair(city: City, d: Design, R: Rng): Design {
  const out: Design = { four: [...d.four] as [number, number], centre: [...d.centre], control: [...d.control] };
  for (let guard = 0; guard < 500 && !connected(city, out); guard++) {
    const changed = out.centre.map((s, k) => (s ? k : -1)).filter(k => k >= 0);
    if (!changed.length) break;
    out.centre[changed[Math.floor(R() * changed.length)]] = 0;
  }
  return out;
}

/** every node with a street can reach, and be reached from, every other */
export function connected(city: City, d: Design): boolean {
  const fw = new Map<number, number[]>(), bw = new Map<number, number[]>(), used = new Set<number>();
  const add = (a: number, b: number) => { (fw.get(a) ?? fw.set(a, []).get(a)!).push(b); (bw.get(b) ?? bw.set(b, []).get(b)!).push(a); used.add(a); used.add(b); };
  const st = stateOf(city, d);
  for (const l of city.links) {
    const s = st.get(l.id) ?? 0;
    if (s === 3) continue;
    if (s !== 2) add(l.a, l.b);
    if (s !== 1) add(l.b, l.a);
  }
  const reach = (g: Map<number, number[]>) => { const start = city.sw, seen = new Set([start]), q = [start]; while (q.length) for (const n of g.get(q.pop()!) ?? []) if (!seen.has(n)) { seen.add(n); q.push(n); } return seen; };
  const f = reach(fw), b = reach(bw);
  // (every gateway, and every junction left with a street, on both sides)
  for (const n of used) if (!f.has(n) || !b.has(n)) return false;
  for (const g of city.gateways) if (!f.has(g.node) || !b.has(g.node)) return false;
  return true;
}

/** each link's state under a design (0 two-way, 1 a→b, 2 b→a, 3 closed) */
export function stateOf(city: City, d: Design): Map<number, number> {
  const m = new Map<number, number>();
  centreLinks(city).forEach((l, k) => m.set(l.id, d.centre[k] ?? 0));
  return m;
}

/** the street ranks at a priority junction: who has right of way (the highest present), the others give way */
const RANK: Record<StreetId, number> = { mainW: 5, mainC: 5, mainE: 5, ring: 4, station: 3, bypassSE: 2, bypassNW: 2 };

/** the design as a V1 network (nodes `n<id>`, links `l<id>`) */
export function designNetwork(city: City, d: Design): Network {
  const four = new Set(d.four.map(k => STREETS[k].id as StreetId));
  const ctrl = new Map(city.keys.map((k, i) => [k.node, CONTROLS[d.control[i]] ?? "priority"]));
  const st = stateOf(city, d);
  const gate = new Set(city.gateways.map(g => g.node));
  const live = city.links.filter(l => (st.get(l.id) ?? 0) !== 3);
  const deg = new Map<number, number>(), best = new Map<number, number>();
  const rank = (s: StreetId | null) => (s ? RANK[s] : 0);
  for (const l of live) for (const n of [l.a, l.b]) { deg.set(n, (deg.get(n) ?? 0) + 1); best.set(n, Math.max(best.get(n) ?? 0, rank(l.street))); }
  const nodes: NodeDef[] = city.nodes.filter(n => deg.has(n.id)).map(n => {
    const c = ctrl.get(n.id) ?? "priority";
    const node: NodeDef = { id: `n${n.id}`, x: n.x, y: n.y, control: (deg.get(n.id) ?? 0) >= 3 ? c : "priority", gateway: gate.has(n.id), signal: { ...DEFAULT_SIGNAL } };
    if (node.control === "roundabout") node.ringLanes = 1;
    return node;
  });
  const signAt = (n: number, l: (typeof live)[number]) => {
    // (at a priority junction of three streets or more, those of a lower rank than the best there give way)
    if ((deg.get(n) ?? 0) < 3 || (ctrl.get(n) ?? "priority") !== "priority" || gate.has(n)) return null;
    return rank(l.street) < (best.get(n) ?? 0) ? ("yield" as const) : null;
  };
  const links: LinkDef[] = live.map(l => {
    const s = st.get(l.id) ?? 0, n = l.street && four.has(l.street) ? 2 : 1;
    const link: LinkDef = { id: `l${l.id}`, name: l.name, from: `n${l.a}`, to: `n${l.b}`, c1: null, c2: null, lanesF: s === 2 ? 0 : n, lanesB: s === 1 ? 0 : n, busF: false, busB: false, speed: 50 };
    const sf = link.lanesF ? signAt(l.b, l) : null, sb = link.lanesB ? signAt(l.a, l) : null;
    if (sf) link.signF = sf;
    if (sb) link.signB = sb;
    return link;
  });
  return { version: 1, nodes, links, stops: [], lines: [] };
}

export interface Built { sketch: Sketch; /** the V2 roads inside the ring (their traffic is the centre's) */ centreRoads: string[]; corridor: { swIn: string[]; neOut: string[]; neIn: string[]; swOut: string[] }; error?: string }

/** the design as a V2 sketch with its demand: each way in's own traffic and share of the trips out, and the corridor's journeys both ways */
export function designSketch(city: City, d: Design, opts: { seed?: number; warmupMin?: number } = {}): Built {
  const net = designNetwork(city, d);
  const { sketch } = networkToSketch(net);
  const sk: Sketch = { ...sketch, traffic: { rate: 0, speed: 50, seed: opts.seed ?? 1, tune: { ringLanes: 1, ringDriving: 1 }, warmup: opts.warmupMin ?? 5 } };
  const ways = demandWays(sk);
  const near = (p: Pt, q: XY) => dist(p, q) < 25;
  const gp = (n: number) => city.nodes[n];
  const lanes: SketchLane[] = sk.lanes.map(l => ({ ...l }));
  const lane = new Map(lanes.map(l => [l.id, l]));
  // every way in and out not one of the city's gateways (none should be): nothing in, nothing out
  for (const l of lanes) { if (ways.entries.some(w => w.lanes.includes(l.id))) l.inRate = 0; if (ways.exits.some(w => w.lanes.includes(l.id))) l.outWeight = 0; }
  const swIn: string[] = [], toNE: string[] = [], fromNE: string[] = [], toSW: string[] = [];
  for (const g of city.gateways) {
    const p = gp(g.node);
    const ins = ways.entries.filter(w => near(w.at, p)), outs = ways.exits.filter(w => near(w.at, p));
    for (const w of ins) for (const id of w.lanes) lane.get(id)!.inRate = Math.round((g.inRate * city.load) / w.lanes.length);
    for (const w of outs) for (const id of w.lanes) lane.get(id)!.outWeight = g.outWeight / w.lanes.length;
    if (g.node === city.sw) { swIn.push(...ins.flatMap(w => w.lanes)); toSW.push(...outs.flatMap(w => w.lanes)); }
    if (g.node === city.ne) { fromNE.push(...ins.flatMap(w => w.lanes)); toNE.push(...outs.flatMap(w => w.lanes)); }
  }
  const corridor = { swIn, neOut: toNE, neIn: fromNE, swOut: toSW };
  const out: Sketch = { ...sk, lanes };
  if (!swIn.length || !toNE.length || !fromNE.length || !toSW.length) return { sketch: out, centreRoads: [], corridor, error: "the main road's ends have no way in or out" };
  out.journeys = [
    { id: "jNE", from: swIn[0], to: toNE[0], rate: city.corridor },
    { id: "jSW", from: fromNE[0], to: toSW[0], rate: city.corridor },
  ];
  out.zones = [{ id: "z1", name: "Centre (inside the ring)", outline: city.centre.map(p => ({ x: p.x, y: p.y })), color: "#f59e0b", note: "Ticket #277: the traffic inside it is what the design should reduce" }];
  // the centre's roads: those whose middle is inside the ring (the ring itself not)
  const centreRoads: string[] = [];
  for (const r of out.roads) {
    const l = lane.get(r.lanes[0]);
    if (!l || l.shape.kind !== "line") continue;
    const pts = l.shape.pts, m = { x: (pts[0].x + pts[pts.length - 1].x) / 2, y: (pts[0].y + pts[pts.length - 1].y) / 2 };
    if (insideShrunk(m, city.centre, 12) && !r.name.startsWith(STREETS.find(s => s.id === "ring")!.name)) centreRoads.push(r.id);
  }
  return { sketch: out, centreRoads, corridor };
}

/** inside a convex polygon, at least `m` metres in from its edges */
function insideShrunk(p: XY, poly: XY[], m: number): boolean {
  const cx = poly.reduce((a, q) => a + q.x, 0) / poly.length, cy = poly.reduce((a, q) => a + q.y, 0) / poly.length;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], L = Math.hypot(b.x - a.x, b.y - a.y);
    const side = ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / L, cside = (b.x - a.x) * (cy - a.y) - (b.y - a.y) * (cx - a.x);
    const s = Math.sign(cside);
    if (!sign) sign = s;
    if (side * s < m) return false;
  }
  return true;
}

/** a design as numbers for a neural network: one-hot of every gene (the four-lane streets as a 7-wide two-hot) */
export function encode(_city: City, d: Design): number[] {
  const x: number[] = STREETS.map((_, k) => (d.four.includes(k) ? 1 : 0));
  for (const s of d.centre) for (let k = 1; k < 4; k++) x.push(s === k ? 1 : 0);
  for (const c of d.control) for (let k = 0; k < CONTROLS.length; k++) x.push(c === k ? 1 : 0);
  return x;
}

/**
 * What the networks see of a design: its one-hot genes (`encode`), and a few sums over them (the share of the centre's
 * links closed, and one-way; closures and one-ways on Strada Mare and on Bulevardul Gării). With a few dozen designs
 * run, the networks could not find such sums in 256 inputs themselves (cross-validated rank correlation on the centre's
 * traffic 0.52 without them, 0.64 with)
 */
export function features(city: City, d: Design): number[] {
  const cl = centreLinks(city), n = d.centre.length;
  const count = (ok: (s: number, i: number) => boolean) => d.centre.filter(ok).length;
  const on = (street: StreetId, states: number[]) => count((s, i) => cl[i].street === street && states.includes(s));
  return [...encode(city, d), (4 * count(s => s === 3)) / n, (4 * count(s => s === 1 || s === 2)) / n, on("mainC", [3]), on("mainC", [1, 2]) / 2, on("station", [3]), on("station", [1, 2]) / 2];
}

/** small random changes (a search's step): another four-lane street, a centre link's state, a junction's control */
export function mutate(city: City, d: Design, R: Rng, rate = 1): Design {
  const o: Design = { four: [...d.four] as [number, number], centre: [...d.centre], control: [...d.control] };
  const n = 1 + Math.floor(R() * 3 * rate);
  for (let k = 0; k < n; k++) {
    const r = R();
    if (r < 0.15) {
      const which = R() < 0.5 ? 0 : 1, other = o.four[1 - which];
      let s = Math.floor(R() * STREETS.length);
      while (s === other) s = Math.floor(R() * STREETS.length);
      o.four[which] = s;
      o.four.sort((a, b) => a - b);
    } else if (r < 0.75) {
      const i = Math.floor(R() * o.centre.length);
      o.centre[i] = (o.centre[i] + 1 + Math.floor(R() * 3)) % 4;
    } else {
      const i = Math.floor(R() * o.control.length);
      o.control[i] = (o.control[i] + 1 + Math.floor(R() * 2)) % 3;
    }
  }
  return repair(city, o, R);
}

/** uniform crossover (the four-lane pair from one parent or the other) */
export function crossover(city: City, a: Design, b: Design, R: Rng): Design {
  const o: Design = { four: [...(R() < 0.5 ? a : b).four] as [number, number], centre: a.centre.map((s, i) => (R() < 0.5 ? s : b.centre[i])), control: a.control.map((s, i) => (R() < 0.5 ? s : b.control[i])) };
  return repair(city, o, R);
}
