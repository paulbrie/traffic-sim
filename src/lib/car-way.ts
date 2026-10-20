/**
 * A car's way on to the end of its trip, as V1 shows a selected vehicle's (dashed, in the selection's colour), but all
 * of it: from where it is, along the lane or connector it is on, the connector it has chosen, then the way the cars go
 * from there to its way out (route-trace.ts, as the simulation routes them). Worked out again only when it is on
 * another lane or connector, has chosen another connector, or is going elsewhere (a reroute); between, the first stretch
 * only is cut to where it is. Framework-free.
 */
import { connectorPts, dist, drivable, isFullCircle, laneById, laneLength, pointAt, speedLimitOf, type Pt, type Sketch } from "./lane-sketch";
import { routeTableOf, traceRoute, type RouteStep } from "./route-trace";

/** what the car's panel and the map need of the car (what `inspect` gives) */
export interface CarAt { edge: string; pos: number; exit: string | null; dest: string | null; kmh: number }
export interface CarWay {
  /** the line from where it is to its way out */
  pts: Pt[];
  /** the roads (or lanes in no road) on it in order, each with its id (`road`, or null: `lane`, its first lane) and metres; and in all, the metres and seconds at the limits left */
  roads: WayRoad[]; length: number; freeTime: number;
  /** its way out: the lane, and its road (null: in no road) and that road's name */
  dest: string; destRoad: string | null; destName: string;
}

export interface WayRoad { name: string; road: string | null; lane: string; m: number }

const idOf = (key: string) => key.slice(key.indexOf(":") + 1);
interface Plan { key: string; first: RouteStep; restPts: Pt[]; restLen: number; restTime: number; roads: WayRoad[] }
let last: { sk: Sketch; plan: Plan } | null = null;

/** a stretch's line: a lane from `a` to `b` metres, or a connector from `a` metres along it */
function stretch(sk: Sketch, x: RouteStep, from = 0): Pt[] {
  if (x.kind === "lane") {
    const l = laneById(sk, x.id);
    if (!l) return [];
    // (a ring: `to` may run past the lane's length, round it again - wrapped back into [0, len) before locating a point,
    // or it draws a straight line, cutting across, to wherever that overshoot happens to land past the lane's own end)
    const len = laneLength(l.shape), ring = isFullCircle(l.shape), at = (s: number) => (ring ? ((s % len) + len) % len : s);
    const a = Math.max(x.from, from), b = x.to, pts: Pt[] = [];
    for (let s = a; s < b; s += 2) pts.push(pointAt(l.shape, at(s)).p);
    pts.push(pointAt(l.shape, at(b)).p);
    return pts;
  }
  if (x.kind === "connector") {
    const c = sk.connectors.find(y => y.id === x.id), pts = c ? connectorPts(sk, c) ?? [] : [];
    if (!from) return pts;
    // (on its way along it: from where it is)
    let run = 0;
    for (let i = 1; i < pts.length; i++) { run += dist(pts[i - 1], pts[i]); if (run >= from) return pts.slice(i - 1); }
    return pts.slice(-1);
  }
  return [];
}
const lenOf = (pts: Pt[]) => pts.slice(1).reduce((a, p, i) => a + dist(pts[i], p), 0);

/** the car's way to the end of its trip; null if it has no way out to go to (wandering) or none is found from where it is */
export function carWay(sk: Sketch, car: CarAt): CarWay | null {
  // (as the cars see it: a lane both ways' way back a lane of its own, ticket #53)
  sk = drivable(sk);
  if (!car.dest || !Number.isFinite(car.pos)) return null;
  const key = `${car.edge}|${car.exit}|${car.dest}`;
  let plan = last && last.sk === sk && last.plan.key === key ? last.plan : null;
  if (!plan) {
    const table = routeTableOf(sk), here = idOf(car.edge), onConn = car.edge.startsWith("conn:");
    let head: RouteStep[] = [], from: { lane: string; s: number };
    if (onConn) {
      const c = sk.connectors.find(x => x.id === here);
      if (!c) return null;
      head = [{ kind: "connector", id: c.id, len: 0 }]; from = c.to;
    } else if (car.exit) {
      const c = sk.connectors.find(x => x.id === idOf(car.exit!));
      if (!c) return null;
      head = [{ kind: "lane", id: here, from: car.pos, to: c.from.s }, { kind: "connector", id: c.id, len: 0 }]; from = c.to;
    } else from = { lane: here, s: car.pos };
    const r = traceRoute(sk, from.lane, car.dest, table, from.s);
    if (!r.ok) return null;
    const steps = [...head, ...r.route.steps];
    const restPts: Pt[] = [];
    for (const x of steps.slice(1)) restPts.push(...stretch(sk, x));
    // (the roads in order, each with its metres; lane changes and connectors to the road they lead onto)
    const roads: WayRoad[] = [];
    for (const x of steps) {
      if (x.kind !== "lane") continue;
      const rd = sk.roads.find(r => r.lanes.includes(x.id)), name = rd?.name ?? `lane ${x.id}`, m = Math.max(0, x.to - x.from);
      const prev = roads[roads.length - 1];
      if (prev?.name === name) prev.m += m; else roads.push({ name, road: rd?.id ?? null, lane: x.id, m });
    }
    const v0 = (sk.traffic?.speed ?? 50) / 3.6;
    const restTime = r.route.freeTime + head.filter(x => x.kind === "connector").reduce((a, x) => a + lenOf(stretch(sk, x)) / v0, 0);
    plan = { key, first: steps[0], restPts, restLen: lenOf(restPts), restTime, roads };
    last = { sk, plan };
  }
  // (the first stretch cut to where it is now)
  const head = stretch(sk, plan.first, car.pos), pts = [...head, ...plan.restPts], length = lenOf(head) + plan.restLen;
  const firstLimit = plan.first.kind === "lane" ? (speedLimitOf(sk, plan.first.id) ?? sk.traffic?.speed ?? 50) / 3.6 : (sk.traffic?.speed ?? 50) / 3.6;
  const destLane = laneById(sk, car.dest), destRoad = sk.roads.find(r => r.lanes.includes(car.dest!));
  // (the first road's metres: from where it is)
  const done = plan.first.kind === "lane" ? Math.max(0, car.pos - plan.first.from) : 0;
  const roads = done ? plan.roads.map((r, i) => (i ? r : { ...r, m: Math.max(0, r.m - done) })) : plan.roads;
  return {
    pts, roads, length, freeTime: plan.restTime + lenOf(head) / firstLimit, dest: car.dest, destRoad: destRoad?.id ?? null,
    destName: destRoad?.name ?? (destLane ? `lane ${car.dest}` : car.dest),
  };
}
