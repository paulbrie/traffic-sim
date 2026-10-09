/**
 * Cars on a lane sketch (an experiment, to try a sketch out): no framework, nothing to do with the
 * plan's engine. Cars come in where lanes start with nothing feeding them, follow each other
 * (IDM), take a connector leaving their lane at random (or drive off the end of a lane that leads
 * nowhere), and slow down for bends.
 *
 * Who goes first:
 *  - a car joining a lane part-way (a roundabout's ring, say) gives way to the cars on that lane, and
 *    doesn't join where there is no room just past where it joins, or a ring that is nearly full
 *    (a full ring locks: every car on it waits for the one ahead);
 *  - where lanes or connectors cross (a connector to a roundabout's inner ring across its outer
 *    one, say), or connectors end at the same place, the car that would get there first goes first;
 *    one already there keeps going, and one kept waiting for 6 s goes before any that can still stop
 *    (a car stopped short of the crossing for something else doesn't count: it isn't on its way);
 *  - one kept waiting 6 s to join a queued lane (not a ring) is let in by the next car along (zipper), and
 *    so is one waiting to join with its body across another path (it can't back out), ring or not;
 *  - a car leaving a lane with a stop or yield line at its end (into a connector leaving there, or
 *    off the end) gives way at the line to every car that has none, going only when they are far
 *    enough off for it to clear their path in time; at a stop line it stops first, at a yield line it
 *    comes up slowly. Cars without a line don't wait for it unless it is already past its line and
 *    can no longer stop;
 *  - at a junction with lights, a car waits at the line at the end of its lane while the light of the
 *    connector it takes is red, and on amber if it can still stop in comfort (lights that respond to
 *    traffic hear of a car within 50 m of its connector);
 *  - a car giving way stops short of every crossing its body would otherwise block;
 *  - cars still found waiting for each other in a ring are sorted out by telling one of them to go
 *    (never into a car in its way), as drivers would.
 *
 * Changing lane: lanes of a road running side by side the same way are neighbours. A car picks where it
 * leaves among the connectors (and ends) of its lane and of the lanes it can change to, and changes lane
 * when there is room on the other (neither it nor the car coming up behind there has to brake hard),
 * clear of crossings; if it can't, it waits where it has to change at the latest, and the next car
 * coming up on the other lane lets it in after a while. A car held up by a slower one changes to a
 * neighbour with clearly more room ahead, to overtake, and changes back once there is room again.
 *
 * It keeps what happened, to copy and look into: a log of each car coming in, moving onto a lane or
 * connector and leaving; every car's state over the last 30 s; and "jumps", where a car is drawn
 * further from where it was drawn a step before than it drove.
 */
import {
  CHANGE_COST, connectorPts, connectorById, connectorLevel, hasLevels, zAt, contentsOf, junctionApproaches, approachKey, wayKey, demandWays, dist, entryLanes, EXIT_CLEAR, laneOutWeight, RouteTable, isFullCircle, laneLength, pointAt, samples, SignalController, signalPlans,
  onCrossing, crossingFrame,
  type LaneControl, type LaneShape, type Pt, type Sketch, type SketchCrossing, type SketchJourney,
} from "./lane-sketch";
import { resolveTuning, type Tuning } from "./sketch-tuning";
import { FUEL_STILL, fuelRate, hasStopStart } from "../engine/fuel";

export interface SimParams {
  /** vehicles per hour coming in on each lane where traffic starts */
  rate: number;
  /** desired speed on straight lanes, km/h */
  speed: number;
  /** the random numbers' seed (the same seed, the same run; default 1) */
  seed?: number;
  /** the simulation settings changed from their defaults (see sketch-tuning.ts) */
  tune?: Partial<Tuning>;
}
export const DEFAULT_SIM: SimParams = { rate: 400, speed: 50 };

export interface SimStats {
  /** simulated seconds */
  t: number;
  vehicles: number;
  spawned: number;
  /** vehicles that drove off the end of a lane */
  finished: number;
  /** mean speed of the vehicles on the sketch, km/h */
  meanSpeed: number;
  /** vehicles that haven't moved for 20 s or more: queues at a full entry, or a gridlock */
  waiting: number;
  /** pairs of vehicles overlapping on the same lane or connector (should stay 0) */
  overlaps: number;
  /** times a car was drawn further from where it was a step before than it drove (should stay 0) */
  jumps: number;
  /** times two cars' bodies came to overlap (should stay 0) */
  collisions: number;
  /** times cars waiting for each other in a ring were sorted out by telling one to go */
  deadlocks: number;
  /** times a car changed lane */
  laneChanges: number;
  /** times a car kept waiting to turn off went another way */
  reroutes: number;
  /** pedestrians who have crossed at the zebras so far, and those waiting at them now */
  pedsCrossed: number;
  pedsWaiting: number;
  /** the journeys' results (when the sketch has journeys) */
  journeys?: JourneyStats[];
  /** vehicles still for STUCK_AFTER seconds or more */
  stuck: number;
  /** turning shares: the vehicles that have gone each way, by `junction|way in|road out` (when the sketch has any) */
  turns?: Record<string, number>;
  /** fuel burnt since the start (see `FuelStats`) */
  fuel: FuelStats;
  /** each junction's results since the start (see `JunctionStats`) */
  junctions: JunctionStats[];
  /** each road's results since the start (see `RoadStats`) */
  roads: RoadStats[];
  /** vehicles broken down so far (at random, or by hand), and those towed away */
  breakdowns: number;
  towed: number;
}
/**
 * Fuel, by V1's model (engine/fuel.ts: from each vehicle's speed and acceleration): litres burnt, the part
 * standing still in traffic (and the vehicle-seconds of it), km driven, trips finished and their fuel, and
 * the CO₂ (kg: 2.31 a litre of petrol for cars, 2.64 of diesel for trucks)
 */
/**
 * A junction's results since the start: vehicles through it; the time they lost (against driving at the speed they
 * want) on the last `APPROACH` metres of its ways in and on it, in vehicle-seconds; the vehicles standing there, on
 * average and at most; the fuel burnt there (L). Only counted: the run is the same with or without them.
 */
/**
 * A road's results since the start: vehicles come onto it from outside it, km driven and hours spent on its lanes (their
 * mean speed: the one over the other), the vehicle-seconds lost against the speed each wanted there, and the most
 * standing on it at once.
 */
export interface RoadStats { id: string; through: number; vehKm: number; vehHours: number; delay: number; queueMax: number; /** of `through`, how many came onto each of its lanes (by lane id) */ lanes?: Record<string, number> }
export interface JunctionStats { id: string; through: number; delay: number; queueMean: number; queueMax: number; fuel: number }
/** metres of a way in counted as the junction's */
const APPROACH = 100;
interface JunctionTally { id: string; through: number; delay: number; queueSum: number; queueMax: number; fuel: number; now: number }
export interface FuelStats { total: number; idle: number; idleTime: number; km: number; trips: number; tripFuel: number; co2: number }
const CO2_PETROL = 2.31, CO2_DIESEL = 2.64;
const noFuel = (): FuelStats => ({ total: 0, idle: 0, idleTime: 0, km: 0, trips: 0, tripFuel: 0, co2: 0 });
/** a journey's results so far: vehicles sent in, arrived at its way out (their mean trip, s), driving now, waiting to come in; those that had no way there */
export interface JourneyStats { id: string; sent: number; arrived: number; meanTrip: number; driving: number; waiting: number; noRoute: number }
/** a journey as the sim runs it: its ways' lanes, the next arrival, those waiting to come in (at a lane, going to a lane), and its counts */
interface SimJourney { def: SketchJourney; from: string[]; to: string[]; next: number; sent: number; arrived: number; tripSum: number; noRoute: number }

/** pedestrians: seconds at the start of a red they may step out in (lights); seconds after a group before the next (zebras); walking speed (m/s) */
let PED_WALK = 8, PED_YIELD = 5, PED_V = 1.2;
/** pedestrians at a zebra: waiting at the kerb (since when), the group on it (from, until), their claim on it, and the counts so far */
interface PedState { waiting: number; since: number; crossing: number; from: number; until: number; redSince: number; claim: boolean; crossed: number; waitSum: number }
/** a zebra as the cars see it: where it runs over each lane and connector (s0..s1), the lights over it (the connectors they hold), and its pedestrians */
interface SimCrossing { def: SketchCrossing; len: number; on: { edge: Edge; s0: number; s1: number }[]; lit: { c: SignalController; conns: string[] }[]; ped: PedState }
/** a zebra's pedestrians, to draw and show: waiting at kerb a, crossing to b (how far across, 0..1) */
export interface PedView { id: string; waiting: number; crossing: number; progress: number; /** (live only) crossed so far, and their mean wait (s) */ crossed?: number; avgWait?: number }

/** something that happened in the run */
export type SimEvent = { t: number; what: "in" | "onto" | "out" | "gone" | "jump" | "collision" | "deadlock" | "edit" | "params" | "change" | "reroute" | "breakdown" | "towed"; car?: number } & Record<string, unknown>;
/**
 * A problem the run had, for the console (as v1's): when, what, the car (and the other one), where (its front then) and
 * on what edge, and a line saying it. Kept apart from the log, which the cars' comings and goings soon fill.
 */
export interface SimProblem { t: number; kind: "collision" | "jump" | "deadlock" | "breakdown" | "towed"; car: number; other?: number; x: number; y: number; edge: string; detail: string }
/** a car stuck a long while (SimStats.stuck), where it is and what it waits for */
export interface StuckCar { car: number; x: number; y: number; edge: string; still: number; why: string | null }
/** a car still this long (s) is stuck */
export const STUCK_AFTER = 60;
const KEEP_PROBLEMS = 2000;
/** a car's state as kept and copied */
interface CarState { edge: string; pos: number; v: number; exit: string | null; run: number; trail: string | null; x: number; y: number; heading: number; why: string | null }
const FRAME_FIELDS = ["car", "edge", "pos", "v", "exit", "run", "trail", "x", "y", "heading", "why"] as const;
const KEEP_FRAMES = 10.5, KEEP_EVENTS = 3000;
/** seconds kept to replay (every car about every 0.1 s, compactly: a few MB for 50 cars) */
const KEEP_REPLAY = 600;
/** at most this many cars and events in a moment copied (the nearest the middle of the view, the nearest in time) */
const MOMENT_CARS = 400, MOMENT_EVENTS = 1500;
/** a recorded car, as replayed */
export interface ReplayCar { id: number; p: Pt; d: Pt; len: number; trailer?: Body; share: number; broken?: boolean; kmh: number; edge: string; exit: string | null; why: string | null }
const r2 = (x: number) => Math.round(x * 100) / 100;
/** seconds for a vehicle going `v` to cover `d` metres, speeding up as it can (`acc`, up to `vmax`) */
function timeTo(d: number, v: number, vmax: number, acc = A_MAX) {
  if (d <= 0) return 0;
  const tUp = Math.max(0, (vmax - v) / acc), dUp = v * tUp + 0.5 * acc * tUp * tUp;
  if (d >= dUp) return tUp + (d - dUp) / Math.max(vmax, 0.5);
  return (-v + Math.sqrt(v * v + 2 * acc * d)) / acc;
}

/**
 * Where two paths come close (cross, run side by side, or end at the same place): the closest point along
 * each, and how far before and after it each is within reach of the other (the zone to keep clear).
 */
/** a lane of the same road running beside this one the same way: along this one from `a0` to `a1`, and the place beside it there (every metre from `a0`) */
interface Neighbor { lane: Edge; a0: number; a1: number; map: number[] }
// (join: two connectors running together into the same place on a lane, see the zip in step)
interface Conflict { other: Edge; at: number; otherAt: number; before: number; after: number; otherBefore: number; otherAfter: number; join: boolean }
interface Edge {
  key: string;
  kind: "lane" | "conn";
  id: string;
  len: number;
  /** its elevation (in levels) `pos` metres along it; null: on the ground all along (a sketch without levels) */
  z: ((pos: number) => number) | null;
  /** a full ring: positions wrap round */
  ring: boolean;
  /** m/s: the desired speed, lower on bends */
  vmax: number;
  /** lanes (not rings): the stop or yield line at its end */
  control: LaneControl | null;
  /** connectors: the line they leave a lane at (leaving it at its end, where it has one) */
  minor: LaneControl | null;
  /** lanes: the lights of the junction it leads into (no stop or yield line then) */
  signal: SignalController | null;
  /** connectors: they leave their lane at its end (past its line, if it has one) */
  atEnd: boolean;
  /** lanes: the connectors leaving it, and where */
  outs: { conn: Edge; s: number }[];
  /** connectors: the lane and place they leave, and the lane and place they join */
  from: { lane: Edge; s: number } | null;
  to: { lane: Edge; s: number } | null;
  /** connectors: the others leaving from the same place (they share their first metres) */
  siblings: Edge[];
  /** connectors: metres along a sibling still within reach of it */
  shared: Map<Edge, number>;
  /** connectors: metres from the start still within reach of the lane they leave, and before the end within reach of the lane they join */
  forkShared: number;
  mergeBefore: number;
  /** connectors: for every half metre along, the place beside it on the lane it leaves and on the lane it joins */
  onFrom: number[];
  onTo: number[];
  /** lanes: the connectors joining it, and where */
  ins: { conn: Edge; s: number }[];
  /** lanes: the ones of its road beside it, going the same way (a car can change to them) */
  neighbors: Neighbor[];
  /** where it crosses other lanes and connectors (or, connectors, ends where another does) */
  conflicts: Conflict[];
  /** connectors: stretches of it in reach of other paths (crossing zones overlapping one another as one; not joins): one in there is committed */
  runs: { s: number; e: number }[];
  /** where `pos` is, and the direction of travel there */
  locate: (pos: number) => { p: Pt; d: Pt };
}
/** where a car left an edge, and the metres it drove on it; on one shorter than a car, also where it left the edge before (its back still there) */
/** the edges a vehicle's body is still over behind it: the one it came from (where it left it, how far it drove on it), and the ones before (a long vehicle over short edges) */
interface Trail { edge: Edge; pos: number; run: number; before: Trail | null }
export interface SimVehicle {
  id: number;
  /** where its front was drawn after the step before (rounded as the state kept), to tell a jump; NaN before its first */
  seenX: number;
  seenY: number;
  edge: Edge;
  pos: number;
  v: number;
  /** on a lane: the connector it will take (null: off the end of the lane, or round a ring; or, its goal on another lane, it has to change first) */
  exit: Edge | null;
  /** on a lane: where it is going, maybe from a lane beside it (`conn` null: off the end of `lane`); null round a ring with no way off */
  goal: { lane: Edge; conn: Edge | null } | null;
  /** the exit lane it is going to (by the shortest way), drawn when it came in by the exits' shares; null: wandering (no exit it can reach) */
  dest: string | null;
  /** when it last changed lane, and the lane it left (its body still partly over it for `SHIFT_T`) */
  changedAt: number;
  left: Edge | null;
  /** where it was drawn before changing lane, from where it would be on the new one (drawn sliding over) */
  shift: Pt | null;
  /** seconds without moving */
  still: number;
  /** metres driven since it came onto its edge */
  run: number;
  /** the edge it came from and where it left it (to draw its back there while it isn't all on this one) */
  trail: Trail | null;
  /** what holds it back this step: "car 12" (behind it), "merge lane:l5", "zone conn:c7 for car 12" */
  why: string | null;
  /** its body is in a zone where its path meets another (it can't back out: it blocks that path while it waits) */
  blocking: boolean;
  /** told to go (a deadlock broken) until this time: it skips giving way, though never into a car in its way */
  forceUntil: number;
  /** times it was told to go (the next deadlock tries another car first) */
  forced: number;
  /** its desired speed as a share of the lanes' (1, or within the settings' spread of it; trucks slower) */
  vf: number;
  /** a truck (longer, slower to speed up, a longer time gap) */
  truck: boolean;
  /** its length, metres */
  len: number;
  /** fuel it has burnt, mL */
  fuel: number;
  /** when its engine failed (it rolls to a stop and stays, hazard lights on, until towed away); null: running */
  broken: number | null;
  /** the journey it is on (going to that journey's way out), and when it came in */
  journey: string | null;
  /** the road out it drew at a way in with turning shares (`at`: the junction and way in), kept while it is on that way in */
  turn: { at: string; out: string } | null;
  born: number;
  /** seconds stopped, not counting the time at red lights (kept through them) */
  held: number;
  /** the connectors it gave up waiting to take (each looked past once), when it last did, and how many times it went another way */
  gaveUp: Edge[] | null;
  rerouteT: number;
  reroutes: number;
  /** it has stopped at the stop line of the lane it is on */
  stopped: boolean;
}

/** the lane changes found, from a lane to a goal (its connector, or its lane for its end): the lanes don't change while the edges are the same */
const hopsKept = new WeakMap<Edge, Map<Edge, { n: Neighbor; hops: number; by: number } | null>>();
/** (no vehicles at places: none there) */
const NO_PLACES: { w: SimVehicle; pos: number }[] = [];
/** (no vehicles: at a light) */
const NO_VEHICLES: SimVehicle[] = [];
/** (no vehicles: a cell of the grid the collision check looks in, empty) */
const NO_CARS: number[] = [];
const LEN = 4.5, A_LAT = 2.5, LOOK = 120;
/** a truck's cab, and how far its trailer reaches under it (to the hitch) */
const CAB = 4, HITCH = 1;
/** how far past a crossing a truck's trailer may still sweep across it, cutting in on a bend: it is clear that much later */
const SWEEP = 3;
/** the drivers (settable: see applyTuning): the gap when stopped (m), the time gap (s), acceleration and comfortable braking (m/s²) */
let S0 = 2, T_HEAD = 1.2, A_MAX = 1.5, B_COMF = 2;
/** trucks: acceleration (m/s²) and time gap (s) */
let TRUCK_A = 1, TRUCK_HW = 1.8;
/** a vehicle's acceleration and time gap (a truck's, or the drivers') */
/** how far behind its front a vehicle's body may still be over something it went past */
const reach = (v: SimVehicle) => (v.truck ? v.len + SWEEP : v.len);
const accOf = (v: SimVehicle) => (v.truck ? TRUCK_A : A_MAX);
const hwOf = (v: SimVehicle) => (v.truck ? TRUCK_HW : T_HEAD);
/** seconds of waiting after which a car goes before cars that can still stop for it */
let PATIENCE = 6;
/** seconds kept waiting where it turns off before a car looks for another way */
let REROUTE = 40;
const HALF_W = 0.9;
/** paths closer than this (centre to centre) are within reach of each other: cars on them could touch */
const NEAR = 2.4;
/** m/s: the speed to come up to a yield line at */
let YIELD_V = 4;
/** seconds a car giving way at a line wants between clearing the path and the next car getting there */
let GAP = 1.5;
/**
 * The settings a simulation runs with, put in place (they are the module's: set again at the start of every
 * step, so simulations with different settings in one place each run with their own)
 */
function applyTuning(t: Tuning) {
  A_MAX = t.accel; B_COMF = t.brake; T_HEAD = t.headway; S0 = t.minGap;
  PATIENCE = t.patience; REROUTE = t.rerouteAfter; GAP = t.yieldGap; YIELD_V = t.yieldSpeed;
  PED_WALK = t.pedWalk; PED_YIELD = t.pedYield; PED_V = t.pedSpeed;
  TRUCK_A = t.truckAccel; TRUCK_HW = t.truckHeadway;
}
/** seconds a car takes to move over to the lane it changes to */
const SHIFT_T = 2;
/** a connector shorter than this (m) between one lane's end and another's start: the two are one way on (no crossing between them) */
const CHAIN_GAP = 5;
/** a way in whose first metres (this many) cross another's way: no car let in while that crossing is taken, or one is
 * within SPAWN_COMING metres of it */
const SPAWN_CLEAR = 10, SPAWN_COMING = 15;
/** a lane ahead with less than this left (metres): the connector after it is looked at too (see `beyond`) */
const SHORT_AHEAD = 30;
/** m/s²: the hardest braking a lane change may ask of the car changing or the one coming up behind it */
const B_SAFE = 3;

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function polyline(pts: Pt[]) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
  const locate = (s: number) => {
    s = Math.max(0, Math.min(cum[cum.length - 1], s));
    let i = 1;
    while (i < pts.length - 1 && cum[i] < s) i++;
    const a = pts[i - 1], b = pts[i], l = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / l;
    return { p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, d: { x: (b.x - a.x) / l, y: (b.y - a.y) / l } };
  };
  return { len: cum[cum.length - 1], cum, locate };
}
/** the tightest bend of a polyline (radius, m), from points about `step` apart */
function minRadius(pts: Pt[]) {
  let r = Infinity;
  for (let i = 2; i < pts.length; i += 1) {
    const a = pts[i - 2], b = pts[i - 1], c = pts[i];
    const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    if (area2 > 1e-6) r = Math.min(r, (dist(a, b) * dist(b, c) * dist(a, c)) / (2 * area2));
  }
  return r;
}
const bendSpeed = (r: number, v0: number) => Math.max(3, Math.min(v0, Math.sqrt(A_LAT * r)));

function bounds(pts: Pt[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}
/** the nearest point of a polyline to `p`: how far, and where along it */
function nearestOnPolyline(pts: Pt[], cum: number[], p: Pt) {
  let best = { d: Infinity, s: 0 };
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    const d = Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
    if (d < best.d) best = { d, s: cum[i - 1] + t * Math.sqrt(l2) };
  }
  return best;
}
interface Run { a0: number; a1: number; at: number; otherAt: number; otherBefore: number; otherAfter: number; b1: number; best: number }
/**
 * The stretches of path A within reach (`NEAR`) of path B: where along A they start and end, A's
 * closest point and B's place there, and how far B's own stretch reaches before and after it.
 */
function nearRuns(pa: Pt[], ringA: boolean, pb: Pt[], ringB: boolean): Run[] {
  const A = polyline(pa), B = polyline(pb), out: Run[] = [];
  const wrapB = (x: number) => (ringB ? ((((x + B.len / 2) % B.len) + B.len) % B.len) - B.len / 2 : x);
  let cur: { a0: number; a1: number; best: number; at: number; bAt: number; bs: number[] } | null = null;
  const finish = () => {
    if (!cur) return;
    const diffs = cur.bs.map(x => wrapB(x - cur!.bAt));
    out.push({ a0: cur.a0, a1: cur.a1, at: cur.at, otherAt: cur.bAt, best: cur.best, b1: Math.max(...cur.bs), otherBefore: Math.max(0, -Math.min(...diffs)), otherAfter: Math.max(0, Math.max(...diffs)) });
    cur = null;
  };
  const n = Math.max(1, Math.ceil(A.len / 0.5));
  for (let i = 0; i <= n; i++) {
    const sA = (A.len * i) / n, q = nearestOnPolyline(pb, B.cum, A.locate(sA).p);
    if (q.d >= NEAR) { finish(); continue; }
    if (!cur) cur = { a0: sA, a1: sA, best: q.d, at: sA, bAt: q.s, bs: [] };
    cur.a1 = sA; cur.bs.push(q.s);
    if (q.d < cur.best) { cur.best = q.d; cur.at = sA; cur.bAt = q.s; }
  }
  finish();
  // (round a ring, a stretch over its start is one)
  if (ringA && out.length > 1 && out[0].a0 === 0 && out[out.length - 1].a1 >= A.len - 1e-6) {
    const last = out.pop()!, first = out[0];
    const keep = last.best < first.best ? { ...last } : { ...first, at: first.at };
    out[0] = { ...keep, a0: last.a0 - A.len, a1: first.a1, at: keep === last ? last.at - A.len : first.at };
  }
  return out;
}
/** a vehicle's body as drawn (a car; a truck's cab or trailer): its middle, heading and length */
export interface Body { p: Pt; d: Pt; len: number }
/** how far `p` is from the middle of the vehicle drawn as `q` (its body or a truck's trailer) if on it or within `tol` metres; null if not */
export function bodyHit(p: Pt, q: Body & { trailer?: Body }, tol: number): number | null {
  let best: number | null = null;
  for (const b of q.trailer ? [q, q.trailer] : [q]) {
    const dx = p.x - b.p.x, dy = p.y - b.p.y, along = Math.abs(dx * b.d.x + dy * b.d.y), side = Math.abs(dx * b.d.y - dy * b.d.x);
    if (along > b.len / 2 + tol || side > HALF_W + tol) continue;
    const dd = Math.hypot(dx, dy);
    if (best === null || dd < best) best = dd;
  }
  return best;
}
/** do two bodies overlap? (separating axes) */
function bodiesOverlap(a: Body, b: Body) {
  const corners = (q: Body) => [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([x, y]) => ({ x: q.p.x + q.d.x * x * q.len / 2 - q.d.y * y * HALF_W, y: q.p.y + q.d.y * x * q.len / 2 + q.d.x * y * HALF_W }));
  const A = corners(a), B = corners(b);
  for (const ax of [a.d, { x: -a.d.y, y: a.d.x }, b.d, { x: -b.d.y, y: b.d.x }]) {
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const c of A) { const v = c.x * ax.x + c.y * ax.y; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
    for (const c of B) { const v = c.x * ax.x + c.y * ax.y; b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

export class SketchSim {
  vehicles: SimVehicle[] = [];
  /** the junctions' lights, as they are now (and were, to replay) */
  signals: SignalController[] = [];
  t = 0;
  spawned = 0;
  finished = 0;
  private edges = new Map<string, Edge>();
  /** where cars come in: the lane, when the next one is due, and how many per hour (its own, or the sketch's) */
  private sources: {
    lane: Edge; next: number; rate: number | null; /** the next one in a truck (drawn when it is due) */ truck?: boolean;
    /** vehicles on journeys waiting to come in here (before the lane's own next one) */ wait?: { journey: string; dest: string; truck: boolean }[];
  }[] = [];
  private journeys: SimJourney[] = [];
  /** the journeys' own random numbers (so runs without journeys stay as they were); and the breakdowns' */
  private jRnd: () => number;
  private bRnd: () => number;
  /** the shortest ways to the exits, and the exits' shares of the trips */
  private routes: RouteTable | null = null;
  private exitWeights = new Map<string, number>();
  private nextId = 1;
  private sketch: Sketch;
  private rnd: () => number;
  /** what happened (the last few thousand events) */
  log: SimEvent[] = [];
  private jumps = 0;
  /** every car's state, about every 0.1 s, over the last 30 s */
  /** per frame (every 0.1 s, the last 10 s): per car [id, pos, v, run, trail pos, x, y, heading] and its [edge, exit, trail edge, why] (rows only made when asked for) */
  private frames: { t: number; nums: Float64Array; refs: (string | null)[] }[] = [];
  /** when collisions are next looked for (once a second, as v1) */
  private checkAt = 0;
  /** the sketch just changed (the cars put where they now are): no jumps told at the next step */
  private unseen = false;

  /** where each car was drawn last step, and its state then */
  private drawn = new Map<number, CarState>();
  private collisions = 0;
  private deadlocks = 0;
  private changes = 0;
  private reroutes = 0;
  private fuel = noFuel();
  /** per junction: its tally, and the junction each of its connectors and lanes on it is in, each lane ending into it its way in to */
  private jTally: JunctionTally[] = [];
  private jOn = new Map<Edge, number>();
  private jIn = new Map<Edge, number>();
  private jSince = 0;
  /** per road: its tally, and the road each of its lanes is in */
  private rTally: (RoadStats & { now: number })[] = [];
  private rOn = new Map<Edge, number>();
  /** a vehicle come onto road `r` from outside it, on its lane `lane` */
  private countOnto(r: number, lane: string) { const R = this.rTally[r]; R.through++; (R.lanes ??= {})[lane] = (R.lanes[lane] ?? 0) + 1; }
  private breakdowns = 0;
  private towed = 0;
  /** pairs of cars overlapping last step ("a-b") */
  private touching = new Set<string>();
  /** the zebras, and where they run over each lane and connector */
  private crossings: SimCrossing[] = [];
  private crossOn = new Map<Edge, { k: number; s0: number; s1: number }[]>();
  /** pedestrians draw their own random numbers, so adding them leaves the cars' run as it was */
  private pedRnd: () => number;

  /** the settings, every one (those not changed at their defaults) */
  private tuning: Tuning;
  private seed: number;
  constructor(sk: Sketch, public params: SimParams = DEFAULT_SIM, seed = 1) {
    this.seed = params.seed ?? seed;
    this.rnd = mulberry32(this.seed);
    this.pedRnd = mulberry32((this.seed * 7919) ^ 0x9ed5);
    this.jRnd = mulberry32((this.seed * 104729) ^ 0x3c6e);
    this.bRnd = mulberry32((this.seed * 15485863) ^ 0x7f4a);
    this.tuning = resolveTuning(params.tune);
    applyTuning(this.tuning);
    this.sketch = sk;
    this.build();
  }

  /** the sketch changed: the lanes and connectors rebuilt; vehicles on ones that are gone are taken off */
  setSketch(sk: Sketch) {
    if (sk === this.sketch) return;
    this.sketch = sk;
    this.posed = null;
    this.note({ what: "edit", lanes: sk.lanes.length, connectors: sk.connectors.length });
    this.build();
  }

  /** the problems so far (see SimProblem) */
  private problemList: SimProblem[] = [];
  private problem(kind: SimProblem["kind"], v: SimVehicle, detail: string, other?: SimVehicle) {
    const { p } = this.posed?.get(v) ?? this.poseOf(v);
    this.problemList.push({ t: r2(this.t), kind, car: v.id, ...(other ? { other: other.id } : {}), x: r2(p.x), y: r2(p.y), edge: v.edge.key, detail });
    if (this.problemList.length > KEEP_PROBLEMS) this.problemList.splice(0, this.problemList.length - KEEP_PROBLEMS);
  }
  /** the problems so far, and the cars stuck now (for the console) */
  problems(): { problems: SimProblem[]; stuck: StuckCar[] } {
    const stuck = this.vehicles.filter(v => v.still >= STUCK_AFTER).map(v => {
      const { p } = this.posed?.get(v) ?? this.poseOf(v);
      return { car: v.id, x: r2(p.x), y: r2(p.y), edge: v.edge.key, still: Math.round(v.still), why: v.why };
    });
    return { problems: this.problemList, stuck };
  }

  private note(e: Omit<SimEvent, "t">) {
    this.log.push({ t: r2(this.t), ...e } as SimEvent);
    if (this.log.length > KEEP_EVENTS) this.log.splice(0, this.log.length - KEEP_EVENTS);
  }

  private build() {
    const sk = this.sketch;
    // (where it is drawn moves with the lanes: an edit isn't a jump)
    this.drawn.clear(); this.unseen = true;
    const v0 = this.params.speed / 3.6, edges = new Map<string, Edge>(), paths = new Map<string, Pt[]>();
    // (lanes into a junction with lights: those, not lines; the lights carried on as they were)
    const prevSignals = this.signals;
    this.signals = signalPlans(sk).map(p => new SignalController(p, prevSignals.find(o => o.plan.junction === p.junction)));
    const signals = new Map<string, SignalController>();
    for (const c of this.signals) {
      for (const ph of c.plan.phases) for (const id of ph.lanes) signals.set(id, c);
      for (const k of sk.connectors) if (c.plan.controlled.includes(k.id)) signals.set(k.from.lane, c);
    }
    for (const l of sk.lanes) {
      const sh: LaneShape = l.shape, len = laneLength(sh);
      if (len < 0.5) continue;
      const ring = isFullCircle(sh);
      paths.set(`lane:${l.id}`, samples(sh, 1));
      edges.set(`lane:${l.id}`, {
        key: `lane:${l.id}`, kind: "lane", id: l.id, len, ring, z: null, outs: [], ins: [], from: null, to: null, siblings: [], shared: new Map(), forkShared: 0, mergeBefore: 0, onFrom: [], onTo: [], conflicts: [], runs: [], neighbors: [],
        control: ring || signals.has(l.id) ? null : l.control ?? null, minor: null, signal: ring ? null : signals.get(l.id) ?? null, atEnd: false,
        // (bends slow it down: arcs, and lines with curved points or closed round; a sharp drawn corner doesn't slow a whole lane)
        vmax: sh.kind === "arc" ? bendSpeed(sh.r, v0) : sh.curved?.some(Boolean) || ring ? bendSpeed(minRadius(samples(sh, 1)), v0) : v0,
        locate: pos => pointAt(sh, ring ? ((pos % len) + len) % len : pos),
      });
    }
    for (const c of sk.connectors) {
      const from = edges.get(`lane:${c.from.lane}`), to = edges.get(`lane:${c.to.lane}`), pts = connectorPts(sk, c);
      if (!from || !to || !pts) continue;
      // (one of no length, a road cut and linked where it was: kept, a hand-off from one lane to the next)
      const pl = polyline(pts);
      // (places rounded to the centimetre can be a hair past a lane's end)
      const e: Edge = {
        key: `conn:${c.id}`, kind: "conn", id: c.id, len: Math.max(pl.len, 0.1), ring: false, z: null, outs: [], ins: [], siblings: [], shared: new Map(), forkShared: 0, mergeBefore: 0, onFrom: [], onTo: [], conflicts: [], runs: [], neighbors: [],
        control: null, minor: from.control && c.from.s >= from.len - 1 ? from.control : null, signal: null, atEnd: c.from.s >= from.len - 1,
        from: { lane: from, s: Math.min(c.from.s, from.len) }, to: { lane: to, s: Math.min(c.to.s, to.len) }, vmax: bendSpeed(minRadius(pts), v0), locate: pl.locate,
      };
      edges.set(e.key, e);
      paths.set(e.key, pts);
      from.outs.push({ conn: e, s: e.from!.s });
      to.ins.push({ conn: e, s: e.to!.s });
    }
    // (where a connector is beside the lanes it leaves and joins)
    for (const e of edges.values()) {
      if (e.kind !== "conn") continue;
      const from = paths.get(e.from!.lane.key)!, to = paths.get(e.to!.lane.key)!;
      const cf = polyline(from).cum, ct = polyline(to).cum;
      for (let i = 0; i * 0.5 <= e.len + 0.25; i++) {
        const p = e.locate(Math.min(e.len, i * 0.5)).p;
        e.onFrom.push(nearestOnPolyline(from, cf, p).s);
        e.onTo.push(nearestOnPolyline(to, ct, p).s);
      }
      // (never back along a lane it leaves, nor on along one it joins: where a lane nearly closes on itself its start is beside its end)
      if (!e.from!.lane.ring) for (let i = 1; i < e.onFrom.length; i++) e.onFrom[i] = Math.max(e.onFrom[i], e.onFrom[i - 1]);
      if (!e.to!.lane.ring) for (let i = e.onTo.length - 2; i >= 0; i--) e.onTo[i] = Math.min(e.onTo[i], e.onTo[i + 1]);
    }
    for (const lane of edges.values()) for (const o of lane.outs) o.conn.siblings = lane.outs.filter(x => x.conn !== o.conn && Math.abs(x.s - o.s) < 1).map(x => x.conn);
    // (levels: each lane's height along it, ramps and all; a connector at the lower of its ends' (as v1's junction paths))
    if (hasLevels(sk)) for (const e of edges.values()) {
      if (e.kind === "lane") { const id = e.id; e.z = pos => zAt(sk, id, pos); }
      else { const c = connectorById(sk, e.id), lv = c ? connectorLevel(sk, c) : 0; e.z = () => lv; }
    }
    // lanes of a road beside each other the same way (about a lane's width apart): the longest stretch, at least 10 m
    const width = new Map(sk.lanes.map(l => [`lane:${l.id}`, l.width ?? 3.5]));
    for (const road of sk.roads) {
      const ls = road.lanes.map(id => edges.get(`lane:${id}`)).filter((e): e is Edge => !!e && !e.ring);
      for (const A of ls) for (const B of ls) {
        if (A === B) continue;
        const pb = paths.get(B.key)!, cb = polyline(pb).cum, far = (width.get(A.key)! + width.get(B.key)!) / 2 + 0.75;
        let best: Neighbor | null = null, cur: Neighbor | null = null;
        for (let s = 0; s <= A.len; s++) {
          const a = A.locate(s), q = nearestOnPolyline(pb, cb, a.p), d = B.locate(q.s).d;
          if (q.d > 0.5 && q.d <= far && q.s > 0.01 && q.s < B.len - 0.01 && a.d.x * d.x + a.d.y * d.y >= 0.8) {
            if (!cur) cur = { lane: B, a0: s, a1: s, map: [] };
            cur.a1 = s; cur.map.push(q.s);
          } else cur = null;
          if (cur && (!best || cur.a1 - cur.a0 > best.a1 - best.a0)) best = cur;
        }
        // (not one at another level: a lane over or under it is no lane to change to)
        if (best && best.a1 - best.a0 >= 10 && Math.abs(this.zOf(A, (best.a0 + best.a1) / 2) - this.zOf(B, best.map[best.map.length >> 1])) < 0.5) A.neighbors.push(best);
      }
    }
    // where lanes and connectors come close: crossing, side by side, ending at the same place (and,
    // where a connector leaves or joins a lane or a sibling, how long they stay close)
    const roadOf = new Map(sk.roads.flatMap(rd => rd.lanes.map(id => [id, rd.id] as const)));
    const all = [...edges.values()], boxes = new Map(all.map(e => [e, bounds(paths.get(e.key)!)]));
    const attached = (c: Edge, l: Edge) => c.kind === "conn" && (c.from!.lane === l || c.to!.lane === l);
    const chained = (X: Edge, Y: Edge) => X.kind === "lane" && Y.kind === "lane" && X.outs.some(o => o.conn.to!.lane === Y && o.conn.len < CHAIN_GAP && o.s >= X.len - 1 && o.conn.to!.s <= 1);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      let A = all[i], B = all[j];
      // (the connector first, where one is attached to the other)
      if (attached(B, A)) [A, B] = [B, A];
      const ba = boxes.get(A)!, bb = boxes.get(B)!;
      if (ba.minX > bb.maxX + NEAR || bb.minX > ba.maxX + NEAR || ba.minY > bb.maxY + NEAR || bb.minY > ba.maxY + NEAR) continue;
      // (each side's stretch measured along its own path)
      const back = nearRuns(paths.get(B.key)!, B.ring, paths.get(A.key)!, A.ring);
      const sideB = (at: number) => {
        const q = back.find(x => (B.ring ? this.along(B, x.a0, at) <= x.a1 - x.a0 + 0.5 : at >= x.a0 - 0.5 && at <= x.a1 + 0.5));
        return q ? { before: Math.max(0, B.ring ? this.along(B, q.a0, at) : at - q.a0), after: Math.max(0, B.ring ? this.along(B, at, q.a1) : q.a1 - at), b1: q.a1 } : null;
      };
      for (const r0 of nearRuns(paths.get(A.key)!, A.ring, paths.get(B.key)!, B.ring)) {
        const sb = sideB(r0.otherAt), r = sb ? { ...r0, otherBefore: sb.before, otherAfter: sb.after, b1: sb.b1 } : r0;
        if (A.kind === "conn") {
          if (B === A.from!.lane && r.a0 < 0.5) { A.forkShared = Math.max(A.forkShared, r.a1); continue; }
          if (B === A.to!.lane && r.a1 > A.len - 0.5) { A.mergeBefore = Math.max(A.mergeBefore, A.len - r.a0); continue; }
          if (A.siblings.includes(B) && r.a0 < 0.5) { A.shared.set(B, r.a1); B.shared.set(A, r.b1); continue; }
        }
        // (a lane and the one it carries on into, joined end to start by a connector hardly there: one way on, not a crossing; the
        // cars on them follow one another along it)
        if (chained(A, B) || chained(B, A)) continue;
        // (one passing over or under the other, at another level there: they don't meet)
        if (Math.abs(this.zOf(A, r.at) - this.zOf(B, r.otherAt)) >= 0.5) continue;
        // (lanes merging: from lanes of one road; from different roads they are traffic meeting, giving way as at a crossing)
        const join = A.kind === "conn" && B.kind === "conn" && A.to!.lane === B.to!.lane && Math.abs(A.to!.s - B.to!.s) < 1
          && r.a1 > A.len - 0.5 && r.b1 > B.len - 0.5 && !!roadOf.get(A.from!.lane.id) && roadOf.get(A.from!.lane.id) === roadOf.get(B.from!.lane.id);
        A.conflicts.push({ other: B, at: r.at, otherAt: r.otherAt, before: r.at - r.a0, after: r.a1 - r.at, otherBefore: r.otherBefore, otherAfter: r.otherAfter, join });
        B.conflicts.push({ other: A, at: r.otherAt, otherAt: r.at, before: r.otherBefore, after: r.otherAfter, otherBefore: r.at - r.a0, otherAfter: r.a1 - r.at, join });
      }
    }
    for (const e of all) {
      const zs = e.conflicts.filter(k => !k.join).map(k => ({ s: k.at - k.before, e: k.at + k.after })).sort((p, q) => p.s - q.s);
      for (const z of zs) { const last = e.runs[e.runs.length - 1]; if (last && z.s <= last.e) last.e = Math.max(last.e, z.e); else e.runs.push({ ...z }); }
    }
    // turning shares: each lane of a way in that has them, and the connectors out of it, by the road they lead to
    this.splitAt = new Map(); this.splitOut = new Map();
    if (sk.junctions.some(j => j.splits?.length)) {
      const cs = contentsOf(sk);
      for (const j of sk.junctions) {
        if (!j.splits?.length) continue;
        const c = cs.get(j.id);
        if (!c) continue;
        for (const a of junctionApproaches(sk, c)) {
          const sp = j.splits.find(x => x.from === approachKey(a));
          if (!sp) continue;
          const key = `${j.id}|${sp.from}`, outs = Object.keys(sp.shares).filter(k => sp.shares[k] > 0), w = outs.map(k => sp.shares[k]), total = w.reduce((x, y) => x + y, 0);
          if (total <= 0) continue;
          for (const id of a.lanes) this.splitAt.set(id, { key, outs, w, total });
          const lanes = new Set(a.lanes);
          for (const cid of c.connectors) { const cn = connectorById(sk, cid); if (cn && lanes.has(cn.from.lane)) { const out = wayKey(sk, cn.to.lane); this.splitOut.set(cid, { out, count: `${key}|${out}` }); } }
        }
      }
    }
    // traffic comes in where a lane starts with nothing joining it near its start (see entryLanes)
    const entries = new Map(entryLanes(sk).map(l => [`lane:${l.id}`, l]));
    const old = new Map(this.sources.map(s => [s.lane.key, s]));
    this.sources = [...edges.values()].filter(e => entries.has(e.key)).map(lane => {
      const rate = entries.get(lane.key)!.inRate ?? null, was = old.get(lane.key);
      // (its rate changed: the next arrival drawn again)
      return { lane, rate, next: was && was.rate === rate ? was.next : this.t + this.gap(rate) };
    });
    // where cars go: the shortest ways to the exits, and their shares
    this.routes = new RouteTable(sk);
    this.exitWeights = new Map(sk.lanes.map(l => [l.id, laneOutWeight(l)]));
    // journeys: their ways' lanes (as the Demand panel groups them); their counts kept, the next arrival drawn again if the rate changed
    const ways = demandWays(sk), oldJ = new Map(this.journeys.map(j => [j.def.id, j]));
    this.journeys = (sk.journeys ?? []).map(def => {
      const was = oldJ.get(def.id), from = ways.entries.find(w => w.lanes.includes(def.from))?.lanes ?? [], to = ways.exits.find(w => w.lanes.includes(def.to))?.lanes ?? [];
      return { def, from, to, next: was && was.def.rate === def.rate ? was.next : this.t + this.jGap(def.rate), sent: was?.sent ?? 0, arrived: was?.arrived ?? 0, tripSum: was?.tripSum ?? 0, noRoute: was?.noRoute ?? 0 };
    });
    for (const s of this.sources) if (s.wait) { s.wait = s.wait.filter(w => this.journeys.some(j => j.def.id === w.journey && j.to.includes(w.dest))); if (!s.wait.length) delete s.wait; }
    this.edges = edges;
    // junctions: what is on each and its ways in (their tallies kept by id)
    {
      const cs = contentsOf(sk), oldT = new Map(this.jTally.map(j => [j.id, j]));
      this.jTally = []; this.jOn = new Map(); this.jIn = new Map();
      for (const j of sk.junctions) {
        const c = cs.get(j.id);
        if (!c) continue;
        const k = this.jTally.length;
        this.jTally.push(oldT.get(j.id) ?? { id: j.id, through: 0, delay: 0, queueSum: 0, queueMax: 0, fuel: 0, now: 0 });
        for (const id of c.connectors) { const e = edges.get(`conn:${id}`); if (e) this.jOn.set(e, k); }
        for (const id of c.lanes) { const e = edges.get(`lane:${id}`); if (e) this.jOn.set(e, k); }
        for (const a of junctionApproaches(sk, c)) for (const id of a.lanes) { const e = edges.get(`lane:${id}`); if (e && !this.jOn.has(e)) this.jIn.set(e, k); }
      }
    }
    // roads: the road each lane is in (their tallies kept by id)
    {
      const oldR = new Map(this.rTally.map(r => [r.id, r]));
      this.rTally = []; this.rOn = new Map();
      for (const r of sk.roads) {
        const k = this.rTally.length;
        this.rTally.push(oldR.get(r.id) ?? { id: r.id, through: 0, vehKm: 0, vehHours: 0, delay: 0, queueMax: 0, now: 0, lanes: {} });
        for (const id of r.lanes) { const e = edges.get(`lane:${id}`); if (e) this.rOn.set(e, k); }
      }
    }
    this.buildCrossings(sk, edges);
    this.vehicles = this.vehicles.flatMap(v => {
      const e = edges.get(v.edge.key);
      if (!e) { this.note({ what: "gone", car: v.id, edge: v.edge.key }); return []; }
      const exit = v.exit && edges.get(v.exit.key);
      const trailOn = (t: Trail | null): Trail | null => { const te = t && edges.get(t.edge.key); return te ? { edge: te, pos: Math.min(t!.pos, te.len), run: t!.run, before: trailOn(t!.before) } : null; };
      const gl = v.goal && edges.get(v.goal.lane.key), gc = v.goal?.conn ? edges.get(v.goal.conn.key) : undefined;
      const goal = gl && (!v.goal!.conn || (gc && gl.outs.some(o => o.conn === gc))) ? { lane: gl, conn: gc ?? null } : null;
      const nv = {
        ...v, edge: e, pos: Math.min(v.pos, e.len), exit: e.kind === "lane" ? (goal?.lane === e ? goal.conn : null) : exit ?? null, goal, left: (v.left && edges.get(v.left.key)) ?? null,
        trail: trailOn(v.trail),
      };
      // (its exit gone or closed: another, from where it is)
      if (nv.dest && !((this.exitWeights.get(nv.dest)! > 0 || nv.journey) && this.routes!.exits.includes(nv.dest))) nv.dest = e.kind === "lane" ? this.pickDest(e.id, nv.pos) : null;
      // (where it was going gone, or moved behind it)
      if (e.kind === "lane" && (!goal || this.exitBehind(nv) || (goal.lane !== e && !this.hop(nv)))) this.plan(nv);
      return [nv];
    });
  }

  /** how many lanes traffic comes in on */
  get entries() { return this.sources.length; }

  /** new speed and demand: speeds worked out again, the next arrivals drawn again */
  setParams(p: SimParams) {
    this.posed = null;
    this.params = p;
    this.tuning = resolveTuning(p.tune);
    applyTuning(this.tuning);
    // (a new seed: the run from the start, restarted, is the one it gives)
    if (p.seed !== undefined) this.seed = p.seed;
    this.note({ what: "params", ...p });
    this.build();
    for (const s of this.sources) s.next = this.t + this.gap(s.rate);
  }

  reset() {
    this.posed = null;
    this.vehicles = []; this.t = 0; this.spawned = 0; this.finished = 0; this.jumps = 0;
    this.log = []; this.frames = []; this.drawn.clear(); this.checkAt = 0; this.turnCounts.clear(); this.problemList = []; this.collisions = 0; this.touching.clear(); this.deadlocks = 0; this.changes = 0; this.reroutes = 0; this.fuel = noFuel(); for (const j of this.jTally) Object.assign(j, { through: 0, delay: 0, queueSum: 0, queueMax: 0, fuel: 0, now: 0 }); for (const r of this.rTally) Object.assign(r, { through: 0, vehKm: 0, vehHours: 0, delay: 0, queueMax: 0, now: 0, lanes: {} }); this.jSince = 0; this.breakdowns = 0; this.towed = 0;
    this.replay = []; this.tags = [""]; this.tagIndex = new Map([["", 0]]);
    for (const c of this.signals) c.reset();
    for (const x of this.crossings) x.ped = newPed();
    // (from the start again: the same random numbers, the same run)
    this.rnd = mulberry32(this.seed); this.pedRnd = mulberry32((this.seed * 7919) ^ 0x9ed5); this.jRnd = mulberry32((this.seed * 104729) ^ 0x3c6e); this.bRnd = mulberry32((this.seed * 15485863) ^ 0x7f4a);
    for (const s of this.sources) { s.next = this.gap(s.rate); delete s.wait; }
    for (const j of this.journeys) Object.assign(j, { next: this.jGap(j.def.rate), sent: 0, arrived: 0, tripSum: 0, noRoute: 0 });
  }

  /**
   * Where each zebra runs over the lanes and connectors (sampled every 25 cm along those near it), and the
   * lights over it: the connectors on it a junction's lights hold, or those out of a lane on it they hold. Its
   * pedestrians carry on as they were (the same id).
   */
  private buildCrossings(sk: Sketch, edges: Map<string, Edge>) {
    const old = new Map(this.crossings.map(x => [x.def.id, x.ped]));
    this.crossings = []; this.crossOn = new Map();
    for (const def of sk.crossings ?? []) {
      const f = crossingFrame(def), xs = f.corners.map(p => p.x), ys = f.corners.map(p => p.y);
      const x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1, y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;
      const k = this.crossings.length, on: SimCrossing["on"] = [];
      for (const e of edges.values()) {
        // (quick: the ends and every 5 m, against the zebra's box)
        let near = false;
        for (let s0 = 0; s0 <= e.len && !near; s0 += 5) { const q = e.locate(Math.min(s0, e.len)).p; near = q.x >= x0 - 5 && q.x <= x1 + 5 && q.y >= y0 - 5 && q.y <= y1 + 5; }
        if (!near) continue;
        let lo = -1, hi = -1;
        for (let s0 = 0; s0 <= e.len + 1e-9; s0 += 0.25) if (onCrossing(def, e.locate(Math.min(s0, e.len)).p)) { if (lo < 0) lo = s0; hi = Math.min(s0, e.len); }
        if (lo < 0) continue;
        const span = { edge: e, s0: Math.max(0, lo - 0.125), s1: Math.min(e.len, hi + 0.125) };
        on.push(span);
        (this.crossOn.get(e) ?? this.crossOn.set(e, []).get(e)!).push({ k, s0: span.s0, s1: span.s1 });
      }
      const lit: SimCrossing["lit"] = [];
      for (const c of this.signals) {
        const conns = on.flatMap(o => (o.edge.kind === "conn" ? [o.edge.id] : o.edge.outs.filter(x => x.conn.len > 0 && o.s1 > o.edge.len - 15).map(x => x.conn.id))).filter(id => c.plan.controlled.includes(id));
        if (conns.length) lit.push({ c, conns });
      }
      this.crossings.push({ def, len: f.len, on, lit, ped: old.get(def.id) ?? newPed() });
    }
  }

  /**
   * The zebras' pedestrians, a step on: new ones come to the kerb; a group on it gets across; those waiting
   * claim it (no new car may drive onto it) when they may go: at lights early in the red of the traffic over
   * it, at a zebra a little after the last group (to let cars by); and they step out once no car is on it or
   * too close to stop.
   */
  private stepPeds(dt: number, byEdge: Map<Edge, SimVehicle[]>) {
    for (const x of this.crossings) {
      const p = x.ped;
      if (x.def.peds > 0 && this.pedRnd() < (x.def.peds / 3600) * dt) { if (!p.waiting) p.since = this.t; p.waiting++; }
      if (p.crossing && this.t >= p.until) p.crossing = 0;
      const lights = x.lit.length > 0;
      const red = lights && x.lit.every(({ c, conns }) => conns.every(id => c.stateOf(id) === "red"));
      if (lights) { if (!red) p.redSince = -1; else if (p.redSince < 0) p.redSince = this.t; }
      if (!p.waiting || p.crossing) { p.claim = false; continue; }
      const allowed = lights ? red && this.t - p.redSince < PED_WALK : this.t >= p.until + PED_YIELD;
      p.claim = allowed;
      if (!allowed || this.crossingBusy(x, byEdge)) continue;
      p.crossing = p.waiting; p.from = this.t; p.until = this.t + x.len / PED_V + 1.5;
      p.crossed += p.waiting; p.waitSum += p.waiting * (this.t - p.since);
      p.waiting = 0; p.claim = false;
    }
  }
  /** a car on the zebra (its body over it), or too close to stop before it */
  private crossingBusy(x: SimCrossing, byEdge: Map<Edge, SimVehicle[]>) {
    for (const o of x.on) for (const v of byEdge.get(o.edge) ?? []) {
      const front = this.diff(o.edge, o.s0, v.pos);
      if (front > -0.5 && front - v.len < o.s1 - o.s0 + 0.5) return true;
      if (front <= -0.5 && v.v > 1 && -front < (v.v * v.v) / (2 * B_COMF) + 1) return true;
    }
    // (one whose back is still on it, just turned off onto the next edge)
    for (const v of this.vehicles) for (let t = v.trail, run = v.run; t && run < v.len; run += t.run, t = t.before) {
      const rest = v.len - run, at = t;
      if (x.on.some(o => o.edge === at.edge && at.pos - rest < o.s1 + 0.5 && at.pos > o.s0 - 0.5)) return true;
    }
    return false;
  }
  /** the zebras' pedestrians now, to draw */
  peds(): PedView[] {
    return this.crossings.map(x => ({
      id: x.def.id, waiting: x.ped.waiting, crossing: x.ped.crossing, progress: x.ped.crossing ? Math.min(1, (this.t - x.ped.from) / Math.max(0.1, x.ped.until - x.ped.from)) : 0,
      crossed: x.ped.crossed, avgWait: x.ped.crossed ? x.ped.waitSum / x.ped.crossed : 0,
    }));
  }
  /** a zebra's numbers: waiting and crossing now, crossed so far, their mean wait (s) */
  crossingStats(id: string) {
    const x = this.crossings.find(c => c.def.id === id);
    if (!x) return null;
    const p = x.ped;
    return { waiting: p.waiting, crossing: p.crossing, crossed: p.crossed, avgWait: p.crossed ? p.waitSum / p.crossed : 0, lights: x.lit.length > 0, over: x.on.map(o => o.edge.key) };
  }

  /** the engine of car `id` fails: it rolls to a stop and stays there, hazard lights on, until towed away (false: no such car, or broken already) */
  breakDown(id: number): boolean {
    const v = this.vehicles.find(x => x.id === id);
    if (!v || v.broken !== null) return false;
    v.broken = this.t; this.breakdowns++;
    this.note({ what: "breakdown", car: v.id, edge: v.edge.key, at: r2(v.pos) });
    this.problem("breakdown", v, `broke down ${Math.round(v.pos)} m along`);
    return true;
  }
  /** car `id` (broken down, or any) towed away now */
  tow(id: number): boolean {
    const v = this.vehicles.find(x => x.id === id);
    if (!v) return false;
    const gone = new Set<SimVehicle>();
    this.towAway(v, gone);
    this.vehicles = this.vehicles.filter(x => !gone.has(x));
    this.posed = null;
    return true;
  }
  private towAway(v: SimVehicle, gone: Set<SimVehicle>) {
    gone.add(v); this.towed++;
    this.note({ what: "towed", car: v.id, edge: v.edge.key, ...(v.broken !== null ? { after: r2(this.t - v.broken) } : {}) });
    this.problem("towed", v, v.broken !== null ? `towed away, ${Math.round(this.t - v.broken)} s after breaking down` : "towed away");
  }
  /** seconds to a journey's next vehicle */
  private jGap(rate: number) { return rate > 0 ? (-Math.log(1 - this.jRnd()) * 3600) / rate : Infinity; }
  /** seconds to the next vehicle at a source */
  private gap(rate: number | null = null) { const r = rate ?? this.params.rate; return r > 0 ? (-Math.log(1 - this.rnd()) * 3600) / r : Infinity; }

  /** an exit for a car at `s` on a lane: drawn by the exits' shares among those it can reach (null: none) */
  private pickDest(lane: string, s: number): string | null {
    const rt = this.routes;
    if (!rt) return null;
    const opts = rt.exits.filter(ex => (this.exitWeights.get(ex) ?? 1) > 0 && rt.from(lane, s, ex) < Infinity);
    const total = opts.reduce((a, ex) => a + (this.exitWeights.get(ex) ?? 1), 0);
    let r = this.rnd() * total;
    for (const ex of opts) { r -= this.exitWeights.get(ex) ?? 1; if (r <= 0) return ex; }
    return opts[opts.length - 1] ?? null;
  }

  /** metres from `a` to `b` along a lane (round a ring) */
  /** an edge's elevation `pos` metres along it (in levels) */
  private zOf(e: Edge, pos: number) { return e.z ? e.z(pos) : 0; }
  /** a vehicle's elevation, where its front is */
  private zOfV(v: SimVehicle) { return v.edge.z ? v.edge.z(v.pos) : 0; }
  private along(e: Edge, a: number, b: number) {
    return e.ring ? (((b - a) % e.len) + e.len) % e.len : b - a;
  }

  /** its connector leaves its lane behind it (moved there while it drove) */
  private exitBehind(v: SimVehicle) {
    const o = v.exit && v.edge.outs.find(x => x.conn === v.exit);
    return !!o && !v.edge.ring && o.s < v.pos - 0.01;
  }

  /**
   * A car on a lane picks where it leaves: a connector further on, or the lane's end if nothing leaves
   * there; on its own lane or one it can change to (a neighbour, or one of its neighbours, with 20 m to
   * change in per lane over).
   */
  private plan(v: SimVehicle, ownLane = false) {
    // (each with how far it is: along the lane, a lane change counting `CHANGE_COST`)
    const goals: { lane: Edge; conn: Edge | null; d: number }[] = [];
    const add = (lane: Edge, from: number) => {
      const extra = lane === v.edge ? 0 : CHANGE_COST;
      for (const o of lane.outs) if (this.along(lane, from, o.s) > 0.5 || (!lane.ring && o.s >= lane.len - 0.01 && from < lane.len - 0.01)) goals.push({ lane, conn: o.conn, d: extra + Math.max(0, this.along(lane, from, o.s)) });
      // (something leaves near its end: it leads on there, cars don't drive off it)
      if (!lane.ring && from < lane.len - 0.01 && !lane.outs.some(o => o.s >= lane.len - EXIT_CLEAR)) goals.push({ lane, conn: null, d: extra + lane.len - from });
    };
    const seen = new Set([v.edge]), todo = [{ lane: v.edge, at: v.pos }];
    while (todo.length) {
      const { lane, at } = todo.shift()!;
      add(lane, at);
      if (ownLane) break;
      for (const n of lane.neighbors) {
        const there = Math.max(at, n.a0) + 20;
        if (seen.has(n.lane) || there > n.a1) continue;
        seen.add(n.lane);
        todo.push({ lane: n.lane, at: this.across(n, there)! });
      }
    }
    // going to an exit: the way there that is shortest (from those within 5 m of it, one at random)
    const rt = this.routes;
    let dest = v.dest;
    // turning shares (as v1's): on a way in that has them, its road out drawn by them (once on the way in), only the
    // ways there taken; where it was going not to be reached from there, another way out that can be (journeys keep theirs)
    const sp = v.edge.kind === "lane" && !v.journey ? this.splitAt.get(v.edge.id) : undefined;
    if (sp) {
      // (drawn among the roads out it can get to from where it is, by their shares; again if it can't get to the one drawn)
      const reach = new Set(goals.flatMap(g => (g.conn ? [this.splitOut.get(g.conn.id)?.out ?? ""] : [])));
      const outs = sp.outs.map((o, i) => ({ o, w: sp.w[i] })).filter(x => reach.has(x.o)), total = outs.reduce((a, x) => a + x.w, 0);
      if (total > 0 && (v.turn?.at !== sp.key || !reach.has(v.turn.out))) {
        let r = this.rnd() * total, k = 0;
        for (; k < outs.length - 1; k++) { r -= outs[k].w; if (r <= 0) break; }
        v.turn = { at: sp.key, out: outs[k].o };
      }
      const out = v.turn?.at === sp.key ? v.turn.out : null, mine = out ? goals.filter(g => g.conn && this.splitOut.get(g.conn.id)?.out === out) : [];
      if (mine.length) {
        goals.splice(0, goals.length, ...mine);
        if (rt && dest && !mine.some(g => rt.viaConnector(g.conn!.id, dest!) < Infinity)) {
          const opts = rt.exits.filter(ex => (this.exitWeights.get(ex) ?? 1) > 0 && mine.some(g => rt.viaConnector(g.conn!.id, ex) < Infinity));
          const total = opts.reduce((a, ex) => a + (this.exitWeights.get(ex) ?? 1), 0);
          let r = this.rnd() * total;
          for (const ex of opts) { r -= this.exitWeights.get(ex) ?? 1; if (r <= 0) { dest = ex; break; } }
          if (opts.length && dest === v.dest) dest = opts[opts.length - 1];
          v.dest = dest;
        }
      }
    }
    if (rt && dest) {
      const cost = (g: (typeof goals)[number]) => g.d + (g.conn ? rt.viaConnector(g.conn.id, dest) : g.lane.id === dest ? 0 : Infinity);
      const best = goals.reduce((m, g) => Math.min(m, cost(g)), Infinity);
      if (best < Infinity) {
        const near = goals.filter(g => cost(g) <= best + 5);
        const g = near[Math.floor(this.rnd() * near.length)];
        v.goal = { lane: g.lane, conn: g.conn };
        v.exit = v.goal.lane === v.edge ? v.goal.conn : null;
        return;
      }
    }
    // (one place to go reached from several lanes: from the nearest, its own if it can; no changing lane for nothing)
    const where = new Map<string, { lane: Edge; conn: Edge | null }>();
    for (const g of goals) { const k = g.conn ? g.conn.to!.lane.key : `end:${g.lane.key}`; if (!where.has(k)) where.set(k, { lane: g.lane, conn: g.conn }); }
    const options = [...where.values()];
    v.goal = options.length ? options[Math.floor(this.rnd() * options.length)] : null;
    v.exit = v.goal?.lane === v.edge ? v.goal.conn : null;
  }

  /** the place on the neighbour beside `pos` (null: not beside it there) */
  private across(n: Neighbor, pos: number) {
    if (pos < n.a0 - 0.01 || pos > n.a1 + 0.01) return null;
    const i = Math.max(0, Math.min(n.map.length - 1, pos - n.a0)), k = Math.floor(i), f = i - k;
    return k + 1 < n.map.length ? n.map[k] * (1 - f) + n.map[k + 1] * f : n.map[k];
  }

  /** a car whose goal is on another lane: the neighbour to change to next, how many changes it has to make, and where it has to have changed at the latest */
  private hop(v: SimVehicle): { n: Neighbor; hops: number; by: number } | null {
    const g = v.goal, e = v.edge;
    if (!g || g.lane === e || e.kind !== "lane") return null;
    // (the same from one lane for one goal, whoever asks: kept)
    let byGoal = hopsKept.get(e);
    if (!byGoal) hopsKept.set(e, (byGoal = new Map()));
    const key = g.conn ?? g.lane;
    if (byGoal.has(key)) return byGoal.get(key)!;
    const h = this.hopOf(e, g);
    byGoal.set(key, h);
    return h;
  }
  private hopOf(e: Edge, g: { lane: Edge; conn: Edge | null }): { n: Neighbor; hops: number; by: number } | null {
    const first = new Map<Edge, Neighbor>(), depth = new Map<Edge, number>([[e, 0]]), todo = [e];
    while (todo.length) {
      const l = todo.shift()!;
      for (const n of l.neighbors) {
        if (depth.has(n.lane)) continue;
        depth.set(n.lane, depth.get(l)! + 1);
        first.set(n.lane, l === e ? n : first.get(l)!);
        todo.push(n.lane);
      }
    }
    const n = first.get(g.lane);
    if (!n) return null;
    const hops = depth.get(g.lane)!;
    let by = n.a1 - 15 - 20 * (hops - 1);
    // (one change: before where it leaves, as beside this lane)
    if (hops === 1) {
      const back = g.lane.neighbors.find(x => x.lane === e), s = g.conn ? this.exitS(g.conn) : g.lane.len;
      if (back) { const b = s < back.a0 ? back.a0 : this.across(back, Math.min(s, back.a1)); if (b !== null) by = Math.min(by, b - 15); }
    }
    return { n, hops, by };
  }

  /** where a car that just changed lane still is on the lane it left (its body partly over it), if it is */
  private ghostPos(w: SimVehicle) {
    if (!w.left || this.t - w.changedAt >= SHIFT_T) return null;
    const n = w.edge.neighbors.find(x => x.lane === w.left);
    return n ? this.across(n, w.pos) : null;
  }

  /** the cars on a lane or beside it (turning off it, joining it, or just changed lane off it), and where along it */
  private occupants(lane: Edge, byEdge: Map<Edge, SimVehicle[]>, ghosts: Map<Edge, { w: SimVehicle; pos: number }[]>) {
    const out = (byEdge.get(lane) ?? []).map(w => ({ w, pos: w.pos }));
    for (const o of lane.outs) for (const { w, pos } of (byEdge.get(o.conn) ?? []).map(w => ({ w, pos: w.pos })).concat(this.tails.get(o.conn) ?? []))
      if (pos - w.len < o.conn.forkShared) out.push({ w, pos: this.beside(o.conn.onFrom, pos) });
    for (const o of lane.ins) for (const w of byEdge.get(o.conn) ?? []) if (w.pos > o.conn.len - o.conn.mergeBefore) out.push({ w, pos: this.beside(o.conn.onTo, w.pos) });
    return out.concat(ghosts.get(lane) ?? []);
  }

  /** IDM acceleration going `v`, `gap` metres behind a car going `lead` (with the acceleration `acc` and time gap `hw` of the one following) */
  private idm(v: number, vmax: number, gap: number, lead: number, acc = A_MAX, hw = T_HEAD) {
    const s = S0 + v * hw + (v * (v - lead)) / (2 * Math.sqrt(acc * B_COMF));
    return acc * (1 - (v / Math.max(vmax, 0.1)) ** 4 - (Math.max(S0, s) / Math.max(gap, 0.1)) ** 2);
  }

  /**
   * Can car `v` change to neighbour `n` now: not in a crossing there, and neither it nor the car coming up behind it there
   * has to brake hard; and the gap ahead of it there (Infinity: none within 80 m)
   */
  private room(v: SimVehicle, n: Neighbor, byEdge: Map<Edge, SimVehicle[]>, ghosts: Map<Edge, { w: SimVehicle; pos: number }[]>) {
    const m = this.across(n, v.pos), L = n.lane;
    if (m === null || m < v.len || m > L.len - 1) return null;
    for (const k of L.conflicts) if (k.at - k.before < m + 2 && k.at + k.after > m - v.len - 2) return null;
    // (each one there, as occupants() has them, looked at in place: whoever it is, any one too close is enough)
    let ahead = Infinity;
    const at = (w: SimVehicle, pos: number) => {
      if (w === v) return true;
      const d = pos - m;
      if (d >= 0) {
        // (never onto a lane only to stop behind one broken down there)
        if (w.broken !== null && d < 60) return false;
        const gap = d - w.len;
        if (gap < 1 || this.idm(v.v, L.vmax, gap, w.v, accOf(v), hwOf(v)) < -B_SAFE) return false;
        if (gap < 80) ahead = Math.min(ahead, gap);
      } else {
        const gap = -d - v.len;
        if (gap < 1 || this.idm(w.v, L.vmax, gap, v.v, accOf(w), hwOf(w)) < -B_SAFE) return false;
      }
      return true;
    };
    for (const w of byEdge.get(L) ?? NO_VEHICLES) if (!at(w, w.pos)) return null;
    for (const o of L.outs) {
      for (const w of byEdge.get(o.conn) ?? NO_VEHICLES) if (w.pos - w.len < o.conn.forkShared && !at(w, this.beside(o.conn.onFrom, w.pos))) return null;
      for (const { w, pos } of this.tails.get(o.conn) ?? NO_PLACES) if (pos - w.len < o.conn.forkShared && !at(w, this.beside(o.conn.onFrom, pos))) return null;
    }
    for (const o of L.ins) for (const w of byEdge.get(o.conn) ?? NO_VEHICLES) if (w.pos > o.conn.len - o.conn.mergeBefore && !at(w, this.beside(o.conn.onTo, w.pos))) return null;
    for (const { w, pos } of ghosts.get(L) ?? NO_PLACES) if (!at(w, pos)) return null;
    return { ahead };
  }

  /** `change`, keeping the cars by edge up to date, and those still partly over the lane they left (so another doesn't change onto it beside it) */
  private changeIn(byEdge: Map<Edge, SimVehicle[]>, ghosts: Map<Edge, { w: SimVehicle; pos: number }[]>, v: SimVehicle, n: Neighbor) {
    const was = byEdge.get(v.edge);
    if (was) was.splice(was.indexOf(v), 1);
    this.change(v, n);
    (byEdge.get(v.edge) ?? byEdge.set(v.edge, []).get(v.edge)!).push(v);
    const g = this.ghostPos(v);
    if (g !== null) (ghosts.get(v.left!) ?? ghosts.set(v.left!, []).get(v.left!)!).push({ w: v, pos: g });
  }

  /** onto the neighbour, drawn sliding over to it */
  private change(v: SimVehicle, n: Neighbor) {
    const before = this.poseOf(v).p, from = v.edge;
    v.left = from; v.edge = n.lane; v.pos = this.across(n, v.pos)!; v.trail = null; v.run = Math.max(v.run, v.len); v.changedAt = this.t; v.shift = null; v.stopped = false;
    const after = this.poseOf(v).p;
    v.shift = { x: before.x - after.x, y: before.y - after.y };
    v.exit = v.goal?.lane === v.edge ? v.goal.conn : null;
    if (this.exitBehind(v)) this.plan(v);
    this.changes++;
    this.note({ what: "change", car: v.id, from: from.key, to: v.edge.key, at: r2(v.pos), goal: v.goal ? v.goal.conn?.key ?? `end of ${v.goal.lane.key}` : null });
  }

  /** the stretches a car will drive next: its edge from where it is, then its connector, then the lane that joins */
  private route(v: SimVehicle) {
    const e = v.edge, out: { edge: Edge; a: number; b: number; off: number }[] = [];
    if (e.kind === "conn") {
      out.push({ edge: e, a: v.pos, b: e.len, off: 0 });
      const t = e.to!;
      out.push({ edge: t.lane, a: t.s, b: t.lane.ring ? t.s + LOOK : Math.min(t.lane.len, t.s + LOOK), off: e.len - v.pos });
      this.beyond(v, t.lane, t.s, e.len - v.pos, out);
      return out;
    }
    const exitAt = v.exit ? e.outs.find(o => o.conn === v.exit)!.s : null;
    const toExit = exitAt === null ? (e.ring ? LOOK : e.len - v.pos) : this.along(e, v.pos, exitAt);
    out.push({ edge: e, a: v.pos, b: v.pos + toExit, off: 0 });
    if (v.exit) {
      out.push({ edge: v.exit, a: 0, b: v.exit.len, off: toExit });
      const t = v.exit.to!;
      out.push({ edge: t.lane, a: t.s, b: t.s + LOOK, off: toExit + v.exit.len });
      this.beyond(v, t.lane, t.s, toExit + v.exit.len, out);
    }
    return out;
  }
  /**
   * Past a short lane it will be on (under SHORT_AHEAD metres left of it from `s`): the connector it is likeliest to take
   * from its end too (the only one, or the one with the shortest way to where it is going), so it sees a queue there in
   * time to stop; it hasn't chosen yet, and the lane is too short to stop on once it has.
   */
  private beyond(v: SimVehicle, lane: Edge, s: number, off: number, out: { edge: Edge; a: number; b: number; off: number }[]) {
    if (lane.ring || lane.len - s > SHORT_AHEAD) return;
    const ends = lane.outs.filter(o => o.s >= lane.len - EXIT_CLEAR && o.s >= s);
    if (!ends.length) return;
    let next = ends[0];
    if (ends.length > 1) {
      const rt = this.routes, dest = v.dest;
      if (!rt || !dest) return;
      let best = Infinity;
      for (const o of ends) { const c = rt.viaConnector(o.conn.id, dest); if (c < best) { best = c; next = o; } }
      if (best === Infinity) return;
    }
    out.push({ edge: next.conn, a: 0, b: next.conn.len, off: off + (next.s - s) });
  }

  /** metres from a car's front to the line (or lights) at the end of its lane, if it is to go past it */
  private lineAhead(v: SimVehicle): number | null {
    const e = v.edge;
    if (e.kind !== "lane" || (!e.control && !e.signal) || (v.exit && !v.exit.atEnd)) return null;
    const d = (v.exit ? this.exitS(v.exit) : e.len) - v.pos;
    return d < -0.01 ? null : d;
  }

  /** where a connector leaves its lane */
  private exitS(c: Edge) { return c.from!.s; }

  /** the place on a lane beside `pos` on a connector (`side`: its `onFrom` or `onTo`) */
  private beside(side: number[], pos: number) { return side[Math.max(0, Math.min(side.length - 1, Math.round(pos / 0.5)))]; }
  /** metres along a lane from `a` to `b` (round a ring: either way, the shorter) */
  private diff(e: Edge, a: number, b: number) {
    if (!e.ring) return b - a;
    const d = this.along(e, a, b);
    return d > e.len / 2 ? d - e.len : d;
  }

  /**
   * Metres from a car's front to place `at` on edge `e`, if it is on its way there (negative: just
   * past it, its body maybe still over it); null if it isn't going there (as far as it knows). Round a
   * ring, up to `past` metres past it counts as past (its body over what reaches that far past it).
   */
  private toPlace(w: SimVehicle, e: Edge, at: number, past = w.len + 1): number | null {
    const rel = (lane: Edge, from: number) => (lane.ring ? this.along(lane, from, at) : at - from);
    if (w.edge === e) {
      let d = rel(e, w.pos);
      if (e.ring && d > e.len - Math.min(past, e.len / 2)) d -= e.len;
      // (it turns off before getting there)
      if (d > 0 && e.kind === "lane" && w.exit && this.along(e, w.pos, this.exitS(w.exit)) < d) return null;
      return d;
    }
    // (just left it, its back still on it; or one before that, across edges shorter than it)
    for (let t = w.trail, run = w.run; t && run < w.len + 2; run += t.run, t = t.before) if (t.edge === e) return e.ring ? -this.along(e, at, t.pos) - run : at - t.pos - run;
    if (w.edge.kind === "lane" && w.exit === e) return this.along(w.edge, w.pos, this.exitS(e)) + at;
    if (w.edge.kind === "conn" && w.edge.to!.lane === e) { const r = rel(e, w.edge.to!.s); return r < 0 ? null : w.edge.len - w.pos + r; }
    if (w.edge.kind === "lane" && w.exit && w.exit.to!.lane === e) {
      const r = rel(e, w.exit.to!.s);
      return r < 0 ? null : this.along(w.edge, w.pos, this.exitS(w.exit)) + w.exit.len + r;
    }
    return null;
  }

  /**
   * Cars waiting for each other in a ring (each one's reason names the next, all stopped 8 s or more) never move
   * on their own: the one in it that has waited longest only by courtesy (giving way, a gap to join, keeping a
   * crossing clear), and been told to go least, is told to go for 6 s, as a driver would.
   */
  private breakDeadlocks() {
    const byId = new Map(this.vehicles.map(v => [v.id, v]));
    const next = (v: SimVehicle) => {
      if (v.still < 8 || !v.why) return null;
      const m = /car (\d+)/.exec(v.why);
      return m ? byId.get(Number(m[1])) ?? null : null;
    };
    const done = new Set<number>();
    for (const v of this.vehicles) {
      if (done.has(v.id)) continue;
      const path: SimVehicle[] = [], at = new Map<number, number>();
      let c: SimVehicle | null = v;
      while (c && !at.has(c.id) && !done.has(c.id)) { at.set(c.id, path.length); path.push(c); c = next(c); }
      path.forEach(x => done.add(x.id));
      if (!c || !at.has(c.id)) continue;
      const ring = path.slice(at.get(c.id)!);
      if (ring.some(x => x.forceUntil > this.t)) continue;
      const soft = ring.filter(x => /^(zone |keeping clear|merge \S+ for car)/.test(x.why ?? ""));
      if (!soft.length) continue;
      const pick = soft.reduce((a, b) => (b.forced < a.forced || (b.forced === a.forced && b.still > a.still) ? b : a));
      pick.forceUntil = this.t + 6; pick.forced++;
      this.deadlocks++;
      this.note({ what: "deadlock", car: pick.id, ring: ring.map(x => x.id), why: pick.why });
      this.problem("deadlock", pick, `deadlock of ${ring.length} broken: let go first (it waited for ${pick.why ?? "nothing said"})`);
    }
  }

  /** a car with its front at `pos` on `e`, past the start of the zones that the one starting at `zs` is part of */
  private inRun(e: Edge, pos: number, zs: number) {
    return e.runs.some(q => q.s + 0.1 < pos && q.s <= zs + 0.01 && zs <= q.e);
  }

  /** must car `v` (`dv` metres from the zone where their paths meet) let car `w` (`dw` metres from it) go first? */
  private yieldsTo(v: SimVehicle, dv: number, vmaxV: number, w: SimVehicle, dw: number, vmaxW: number) {
    const tv = timeTo(dv, v.v, vmaxV, accOf(v)), tw = timeTo(dw, w.v, vmaxW, accOf(w));
    const wFirst = tw < tv - 0.05 || (Math.abs(tw - tv) <= 0.05 && w.id < v.id);
    const canStop = (x: SimVehicle, d: number) => d > (x.v * x.v) / (2 * B_COMF) + 1;
    // (whoever has waited too long goes before one that can still stop for it)
    if (wFirst) return !(v.still > PATIENCE && v.still > w.still && canStop(w, dw));
    return w.still > PATIENCE && w.still > v.still && canStop(v, dv);
  }

  step(dt: number) {
    // (the bodies as the last step left them: nothing has moved since)
    const lastPosed = this.posed;
    this.posed = null;
    applyTuning(this.tuning);
    this.t += dt;
    if (Math.floor(this.t) !== Math.floor(this.t - dt)) this.breakDeadlocks();
    // engines failing at random (one moving on a lane; none drawn while there are none, so runs stay as they were)
    const bph = this.tuning.breakdownsPerHour;
    if (bph > 0 && this.bRnd() < (bph * dt) / 3600) {
      const can = this.vehicles.filter(v => v.broken === null && v.edge.kind === "lane" && v.v > 3);
      if (can.length) this.breakDown(can[Math.floor(this.bRnd() * can.length)].id);
    }
    // lights (those that respond to traffic: is a car within 50 m of a connector they hold?)
    // (the vehicles on each one's lanes, found once, not every vehicle looked at for every light)
    const atLight = new Map<SignalController, SimVehicle[]>();
    if (this.signals.length) for (const v of this.vehicles) {
      const c = v.edge.signal;
      if (!c || !v.exit) continue;
      const l = atLight.get(c);
      if (l) l.push(v); else atLight.set(c, [v]);
    }
    for (const c of this.signals) c.step(this.t, dt, conns => (atLight.get(c) ?? NO_VEHICLES).some(v => conns.includes(v.exit!.id) && this.exitS(v.exit!) - v.pos < 50));
    const byEdge = new Map<Edge, SimVehicle[]>();
    for (const v of this.vehicles) { const l = byEdge.get(v.edge); if (l) l.push(v); else byEdge.set(v.edge, [v]); }
    if (this.crossings.length) this.stepPeds(dt, byEdge);

    // new cars where there is room
    // journeys: those due come in on a lane of their way in that leads to their way out (waiting there for room)
    for (const j of this.journeys) while (this.t >= j.next) {
      j.next += this.jGap(j.def.rate);
      const rt = this.routes, opts = j.from.flatMap(l => { const to = rt ? j.to.filter(x => rt.from(l, 0, x) < Infinity) : []; return to.length ? [{ l, to }] : []; });
      if (!opts.length) { j.noRoute++; continue; }
      const o = opts[Math.floor(this.jRnd() * opts.length)], s = this.sources.find(x => x.lane.id === o.l);
      if (!s) { j.noRoute++; continue; }
      (s.wait ??= []).push({ journey: j.def.id, dest: o.to[Math.floor(this.jRnd() * o.to.length)], truck: this.jRnd() * 100 < (j.def.trucks ?? 0) });
    }
    // (the vehicles' bodies, each worked out once, on a grid: a new one's way checked against those that could be
    // in it, the fastest of them 1.5 s on and the longest, not against every one; made when first wanted)
    const bodyKept = new Map<SimVehicle, Body[]>(), bodies = (w: SimVehicle) => {
      let b = bodyKept.get(w);
      if (!b) { const q = lastPosed?.get(w); bodyKept.set(w, (b = q ? (q.trailer ? [q, q.trailer] : [q]) : this.bodiesOf(w))); }
      return b;
    };
    const CELL = 25, cellKey = (i: number, j: number) => i * 1_000_003 + j;
    let spawnGrid: { cells: Map<number, SimVehicle[]>; fastest: number; longest: number } | null = null;
    const toGrid = (w: SimVehicle) => {
      const g = spawnGrid!;
      g.fastest = Math.max(g.fastest, w.v);
      for (const b of bodies(w)) {
        g.longest = Math.max(g.longest, b.len);
        const k = cellKey(Math.floor(b.p.x / CELL), Math.floor(b.p.y / CELL)), l = g.cells.get(k);
        if (!l) g.cells.set(k, [w]); else if (l[l.length - 1] !== w) l.push(w);
      }
    };
    const near = (c: Pt, len: number) => {
      if (!spawnGrid) { spawnGrid = { cells: new Map(), fastest: 0, longest: 0 }; for (const w of this.vehicles) toGrid(w); }
      const g = spawnGrid, R = (len + g.longest) / 2 + 0.5 + g.fastest * 1.5 + 1, out = new Set<SimVehicle>();
      for (let i = Math.floor((c.x - R) / CELL); i <= Math.floor((c.x + R) / CELL); i++)
        for (let j = Math.floor((c.y - R) / CELL); j <= Math.floor((c.y + R) / CELL); j++) for (const w of g.cells.get(cellKey(i, j)) ?? NO_VEHICLES) out.add(w);
      return [...out];
    };
    // (the vehicles over a lane they changed off, and those with their backs on one: to find where the last one in is, without looking at all of them)
    const offLane = new Map<Edge, SimVehicle[]>(), tailOn = new Map<Edge, SimVehicle[]>();
    for (const v of this.vehicles) {
      if (v.left) { const l = offLane.get(v.left); if (l) l.push(v); else offLane.set(v.left, [v]); }
      // (every edge its trail goes back over, a little past its body: on a short lane, the one before the connector before)
      for (let t = v.trail, run = v.run; t && run < v.len + 30; run += t.run, t = t.before) { const l = tailOn.get(t.edge); if (!l) tailOn.set(t.edge, [v]); else if (l[l.length - 1] !== v) l.push(v); }
    }
    for (const s of this.sources) {
      const jw = s.wait?.[0];
      if (this.t < s.next && !jw) continue;
      // (one just changed lane off it still partly over it)
      // (or one just turned off it, its back still on it)
      // (a truck or a car: drawn once, kept until it comes in; nothing drawn while there are no trucks, so runs stay as they were)
      // (one on a journey first: its truck or car as drawn when it came)
      const share = this.tuning.truckShare / 100;
      if (!jw && share > 0 && s.truck === undefined) s.truck = this.rnd() < share;
      const truck = jw ? jw.truck : share > 0 && !!s.truck, len = truck ? this.tuning.truckLength : LEN;
      // (where the back of the last one in is, along the lane and on from its end: of those on it, over it from changing lane off it, on a
      // connector leaving it, or gone on with their backs on it or not far past it; on a short way in, that one may be two edges on)
      const outS = new Map(s.lane.outs.map(o => [o.conn, o.s]));
      const backAlong = (v: SimVehicle) => {
        if (v.edge === s.lane) return v.pos - v.len;
        if (v.left === s.lane) { const g = this.ghostPos(v); return g === null ? Infinity : g - v.len; }
        if (outS.has(v.edge)) return outS.get(v.edge)! + v.pos - v.len;
        for (let t = v.trail, run = v.run; t && run < v.len + 30; run += t.run, t = t.before) {
          if (t.edge === s.lane) return t.pos + run - v.len;
          if (outS.has(t.edge)) return outS.get(t.edge)! + t.pos + run - v.len;
        }
        return Infinity;
      };
      let first = Infinity;
      for (const l of [byEdge.get(s.lane), offLane.get(s.lane), tailOn.get(s.lane), ...s.lane.outs.flatMap(o => [byEdge.get(o.conn), tailOn.get(o.conn)])]) if (l) for (const v of l) first = Math.min(first, backAlong(v));
      if (first < S0 + 1) continue;
      // (nor where its body, just before the lane's start, would be on another car's way: one there, or about to be)
      if (!s.lane.ring) {
        const st = s.lane.locate(0), c = { x: st.p.x - st.d.x * len / 2, y: st.p.y - st.d.y * len / 2 };
        const z0 = this.zOf(s.lane, 0);
        if (near(c, len).some(w => {
          if (w.edge === s.lane || Math.abs(this.zOfV(w) - z0) >= 0.5) return false;
          for (const { p, d, len: bl } of bodies(w))
            for (const t of [0, 0.75, 1.5]) if (Math.hypot(p.x + d.x * w.v * t - c.x, p.y + d.y * w.v * t - c.y) < (len + bl) / 2 + 0.5) return true;
          return false;
        })) continue;
      }
      // (nor where its lane starts across the way of another lane or connector with a vehicle on it there, or coming up
      // to it: it would come in on top of it, too late to give way)
      // (on a ring: how far before or past the crossing, along it)
      const toCross = (k: Conflict, w: SimVehicle) => (k.other.ring ? ((((k.otherAt - w.pos) % k.other.len) + k.other.len * 1.5) % k.other.len) - k.other.len / 2 : k.otherAt - w.pos);
      if (s.lane.conflicts.some(k => !k.join && k.at - k.before < SPAWN_CLEAR && (byEdge.get(k.other) ?? NO_VEHICLES).some(w => { const d = toCross(k, w); return d < k.otherBefore + SPAWN_COMING && d > -(k.otherAfter + w.len); }))) continue;
      if (jw) s.wait!.shift(); else s.next = this.t + this.gap(s.rate);
      if (s.wait && !s.wait.length) delete s.wait;
      // (no faster than it can stop from behind the last car in, nor than it can stop before the first crossing on its lane)
      const zone = s.lane.conflicts.reduce((m, k) => (k.join || k.at - k.before < 0 ? m : Math.min(m, k.at - k.before)), Infinity);
      const v0 = Math.min(s.lane.vmax, (0.6 * this.params.speed) / 3.6, Math.sqrt(2 * B_COMF * Math.max(0, first - S0 - 1)), Math.sqrt(2 * B_COMF * Math.max(0, zone - 1)));
      const v: SimVehicle = { id: this.nextId++, seenX: NaN, seenY: NaN, edge: s.lane, pos: 0, v: v0, exit: null, goal: null, dest: jw ? jw.dest : this.pickDest(s.lane.id, 0), changedAt: -Infinity, left: null, shift: null, still: 0, run: len, trail: null, why: null, stopped: false, blocking: false, forceUntil: 0, forced: 0, vf: truck ? this.tuning.truckSpeed / 100 : 1, truck, len, held: 0, gaveUp: null, rerouteT: -Infinity, reroutes: 0, journey: jw?.journey ?? null, turn: null, born: this.t, fuel: 0, broken: null };
      if (jw) this.journeys.find(j => j.def.id === jw.journey)!.sent++;
      else s.truck = undefined;
      // (speeds varying: its own share of the lanes' speed; no random number drawn when they don't, so runs stay as they were)
      const spread = this.tuning.speedSpread / 100;
      if (spread > 0) v.vf *= 1 + (this.rnd() * 2 - 1) * spread;
      this.plan(v);
      this.note({ what: "in", car: v.id, lane: s.lane.key, exit: v.exit?.key ?? null, dest: v.dest, ...(jw ? { journey: jw.journey } : {}) });
      this.vehicles.push(v);
      (byEdge.get(s.lane) ?? byEdge.set(s.lane, []).get(s.lane)!).push(v);
      if (spawnGrid) toGrid(v);
      this.spawned++;
      // (come in on a road: onto it from outside)
      { const r = this.rOn.get(s.lane); if (r !== undefined) this.countOnto(r, s.lane.id); }
    }

    // cars just changed lane, their bodies still partly over the lane they left; and cars waiting to change lane, where they would be on the other
    const ghosts = new Map<Edge, { w: SimVehicle; pos: number }[]>(), waitIn = new Map<Edge, { w: SimVehicle; pos: number }[]>();
    const put = (m: Map<Edge, { w: SimVehicle; pos: number }[]>, e: Edge, x: { w: SimVehicle; pos: number }) => { const l = m.get(e); if (l) l.push(x); else m.set(e, [x]); };
    for (const w of this.vehicles) {
      const g = this.ghostPos(w);
      if (g !== null) put(ghosts, w.left!, { w, pos: g });
      const h = w.still > 2 && w.why?.startsWith("changing to") ? this.hop(w) : null, m = h && this.across(h.n, w.pos);
      if (m != null) put(waitIn, h!.n.lane, { w, pos: m });
    }
    // trucks gone on past a connector, their trailers still on it: where their fronts would be along it (not cars: their
    // backs are as good as off a connector's shared metres once their fronts are past it, and runs without trucks stay as they were)
    this.tails.clear();
    for (const w of this.vehicles) if (w.truck) for (let t = w.trail, run = w.run; t && run < w.len; run += t.run, t = t.before) if (t.edge.kind === "conn") put(this.tails, t.edge, { w, pos: t.pos + run });

    // the cars that may be on their way to an edge (as toPlace sees it): on it, just off it (their backs still on
    // it), about to take it from the lane before, or on the connector or lane leading into it; in the cars' order,
    // so each car meets the others as it did when it looked at every car
    const toward = new Map<Edge, SimVehicle[]>();
    const mark = (e: Edge | null | undefined, w: SimVehicle) => { if (!e) return; const l = toward.get(e); if (!l) toward.set(e, [w]); else if (l[l.length - 1] !== w) l.push(w); };
    for (const w of this.vehicles) {
      mark(w.edge, w);
      for (let t = w.trail, run = w.run; t && run < w.len + 2; run += t.run, t = t.before) mark(t.edge, w);
      if (w.edge.kind === "conn") mark(w.edge.to!.lane, w);
      else if (w.exit) { mark(w.exit, w); mark(w.exit.to!.lane, w); }
    }
    const NONE: SimVehicle[] = [];

    const acc = new Map<SimVehicle, number>(), held = new Map<SimVehicle, { gap: number; lead: number }>();
    for (const v of this.vehicles) {
      // (broken down: rolls to a stop where it is, an obstacle in its lane)
      if (v.broken !== null) { acc.set(v, v.v > 0 ? -Math.min(2.5, v.v / dt) : 0); held.set(v, { gap: Infinity, lead: 0 }); v.why = "broken down"; v.blocking = false; continue; }
      const route = this.route(v);
      let gap = Infinity, lead = 0, vmax = v.edge.vmax * v.vf, why: string | null = null;
      // (the reason: a car's "car <id>" made only when it is the nearest yet, not for every car looked at)
      const behind = (g: number, speed: number, reason: string | SimVehicle) => { if (g < gap) { gap = g; lead = speed; why = typeof reason === "string" ? reason : `car ${reason.id}`; } };
      /** the zones ahead where its path meets another (not to stop in), and where those it gives way at start */
      const zones: { s: number; e: number }[] = [], yields: { at: number; why: string }[] = [];
      // (a car stops 0.5 m short of a zone; one closer than 0.1 m, or too fast to stop before it, is committed)
      const canStopBefore = (d: number) => d >= Math.max(0.1, (v.v * v.v) / 8 - 1);
      const forced = v.forceUntil > this.t;
      // a line at the end of its lane: stopping there first, or coming up to it slowly
      const line = this.lineAhead(v);
      if (line !== null && v.edge.control === "stop" && !v.stopped) {
        if (line < 1.5 && v.v < 0.2) v.stopped = true;
        else behind(Math.max(0.1, line - 0.5 + S0), 0, `stop ${v.edge.key}`);
      }
      if (line !== null && v.edge.control === "yield") vmax = Math.min(vmax, Math.sqrt(YIELD_V ** 2 + 2 * B_COMF * line));
      // lights: waiting at the line on red, and on amber if it can still stop in comfort
      if (line !== null && v.edge.signal) {
        const st = v.exit ? v.edge.signal.stateOf(v.exit.id) : null;
        if (st === "red" || (st === "amber" && line > (v.v * v.v) / (2 * B_COMF))) behind(Math.max(0.1, line - 0.5 + S0), 0, `signal ${v.edge.key} ${st}`);
      }
      // changing lane: waiting where it has to have changed, if it can't before
      const hop = v.run >= v.len ? this.hop(v) : null;
      if (hop) {
        // (beside one waiting to change onto its lane, the two of them in each other's way: the one with the lower number goes on, to make room)
        const swap = (waitIn.get(v.edge) ?? []).some(({ w, pos }) => w.edge === hop.n.lane && w.id > v.id && Math.abs(pos - v.pos) < v.len + w.len + 3);
        const by = swap ? hop.n.a1 - 2 : hop.by;
        if (by - v.pos < LOOK) behind(Math.max(0.1, by - v.pos + S0), 0, `changing to ${hop.n.lane.key}`);
      }
      // (just changed lane: still partly over the one it left, the cars ahead there are in its way)
      const mine = this.ghostPos(v);
      if (mine !== null) for (const w of byEdge.get(v.left!) ?? []) {
        const x = w.pos - mine;
        if (x > 0 && x < 40) behind(x - w.len, w.v, w);
      }
      for (const r of route) {
        const ahead = (pos: number) => (r.edge.ring ? this.along(r.edge, r.a, pos) : pos - r.a);
        // the car ahead…
        for (const w of byEdge.get(r.edge) ?? []) {
          if (w === v) continue;
          const x = ahead(w.pos);
          if (x <= (r.edge === v.edge ? 0 : -0.01) || x > r.b - r.a) continue;
          behind(r.off + x - w.len, w.v, w);
        }
        if (r.edge.kind === "lane") {
          const at = (pos: number) => (r.edge.ring ? ((pos % r.edge.len) + r.edge.len) % r.edge.len : pos);
          // …or one just changed lane off it, still partly over it…
          for (const { w, pos } of ghosts.get(r.edge) ?? []) {
            const x = ahead(pos);
            if (w !== v && x > 0 && x <= r.b - r.a) behind(r.off + x - w.len, w.v, w);
          }
          // (one waiting to change onto it, a while: let in, stopping short of it with room for it)
          if (r.edge === v.edge) for (const { w, pos } of waitIn.get(r.edge) ?? []) {
            const x = ahead(pos) - w.len - 3;
            if (x > 0.1 && x <= 30 && canStopBefore(x)) behind(x + S0, 0, `letting car ${w.id} change lane`);
          }
          // …also one turning off this lane, while still beside it…
          for (const o of r.edge.outs) {
            const one = (w: SimVehicle, pos: number) => {
              if (w === v || pos - w.len >= o.conn.forkShared) return;
              // (past the lane's end its place beside the lane is the end: then as far as along the way it went)
              const b = this.beside(o.conn.onFrom, pos);
              const x = !r.edge.ring && b >= r.edge.len - 0.01 ? ahead(o.s) + pos : ahead(at(b));
              if (x > 0 && x <= r.b - r.a + w.len) behind(r.off + x - w.len, w.v, w);
            };
            // (those on it, then those with their backs still on it, without a list made)
            for (const w of byEdge.get(o.conn) ?? NO_VEHICLES) one(w, w.pos);
            for (const { w, pos } of this.tails.get(o.conn) ?? NO_PLACES) one(w, pos);
          }
          // …or one joining it, already beside it
          for (const o of r.edge.ins) for (const w of byEdge.get(o.conn) ?? []) {
            if (w === v) continue;
            if (w.pos <= o.conn.len - o.conn.mergeBefore) {
              // (zipper: one kept waiting to join a queue is let in by the next car along, which stops short of where it joins; not on a ring, where those on it go first)
              // (and, ring or not, one waiting with its body across another path: it can't back out, and blocks that path)
              if (!w.why?.startsWith(`merge ${r.edge.key}`) || !(w.blocking || (!r.edge.ring && w.still > PATIENCE))) continue;
              const x = ahead(at(this.beside(o.conn.onTo, o.conn.len - o.conn.mergeBefore))) - 1;
              if (x > 0 && x <= 30 && canStopBefore(x)) behind(r.off + x + S0, 0, `letting car ${w.id} in`);
              continue;
            }
            const x = ahead(at(this.beside(o.conn.onTo, w.pos)));
            if (x > 0 && x <= r.b - r.a) behind(r.off + x - w.len, w.v, w);
          }
        } else {
          const f = r.edge.from!;
          // …on a connector: one that took a sibling, in the metres they share…
          for (const sib of r.edge.siblings) {
            const shared = r.edge.shared.get(sib) ?? 0, one = (w: SimVehicle, pos: number) => {
              if (w === v || pos - w.len >= shared) return;
              const x = pos - r.a;
              if (x > 0) behind(r.off + x - w.len, w.v, w);
            };
            for (const w of byEdge.get(sib) ?? NO_VEHICLES) one(w, w.pos);
            for (const { w, pos } of this.tails.get(sib) ?? NO_PLACES) one(w, pos);
          }
          // …or one going on along the lane it leaves, still beside it…
          if (r.a < r.edge.forkShared) {
            const me = this.beside(r.edge.onFrom, r.a), end = this.beside(r.edge.onFrom, r.edge.forkShared);
            for (const w of byEdge.get(f.lane) ?? []) {
              if (w === v) continue;
              const x = this.diff(f.lane, me, w.pos);
              // (its body along the lane as far back as it has come on it)
              if (x > 0 && x - Math.min(w.len, w.run) < this.diff(f.lane, me, end)) behind(r.off + x - w.len, w.v, w);
            }
          }
          // …or, joining a lane, one on it beside or just past where it joins
          const t = r.edge.to!, zs = r.edge.len - r.edge.mergeBefore;
          if (r.edge.mergeBefore > 0 && r.a >= zs - 0.5) {
            const me = this.beside(r.edge.onTo, r.a), lim = this.diff(t.lane, me, t.s) + 2;
            // (before the lane's start its place beside the lane is the start: then as far as along the way it goes)
            const before = !t.lane.ring && me <= 0.01;
            for (const w of byEdge.get(t.lane) ?? []) {
              if (w === v) continue;
              const x = before ? r.edge.len - r.a + w.pos - t.s : this.diff(t.lane, me, w.pos);
              if (x > 0 && x <= lim + w.len) behind(r.off + x - w.len, w.v, w);
            }
          }
        }
        // a zebra pedestrians are on, or claim (unless too close to stop for those only waiting: they wait for it);
        // not one it is on already (it drives off it)
        for (const o of this.crossOn.get(r.edge) ?? []) {
          const ped = this.crossings[o.k].ped;
          if (!ped.crossing && !ped.claim) continue;
          if (r.edge === v.edge && this.diff(r.edge, o.s0, v.pos) > -0.3) continue;
          const x = ahead(o.s0);
          if (x < 0 || x > r.b - r.a + 0.01) continue;
          const d = r.off + x - 0.5;
          if (!ped.crossing && d < ((v.v * v.v) / (2 * B_COMF)) * 0.8) continue;
          behind(Math.max(0.1, d + S0), 0, `pedestrians at ${this.crossings[o.k].def.id}`);
        }
        // slowing down in time for a slower stretch
        if (r.off > 0) vmax = Math.min(vmax, Math.sqrt((r.edge.vmax * v.vf) ** 2 + 2 * B_COMF * r.off));
        const tMe = (d: number) => timeTo(d, v.v, r.edge.vmax, accOf(v));
        // (on a connector from a line it gives way at; still before the line, it waits there, not at the zone)
        const minor = r.edge.kind === "conn" && !!r.edge.minor;
        const hold = (z: number) => (minor && v.edge !== r.edge ? Math.min(z, r.off + 0.5) : z);
        // joining a lane part-way: give way to the cars coming along it
        if (r.edge.kind === "conn") {
          const t = r.edge.to!, dMerge = r.off + r.edge.len - r.a, z = dMerge - r.edge.mergeBefore;
          if ((t.lane.ring || t.s > 1) && dMerge < 40) {
            zones.push({ s: z, e: dMerge });
            if (canStopBefore(hold(z))) {
              const arrive = tMe(dMerge), onLane = byEdge.get(t.lane) ?? [];
              // (how far back along the lane the joining stretch reaches)
              const laneZone = Math.max(0, this.diff(t.lane, this.beside(r.edge.onTo, r.edge.len - r.edge.mergeBefore), t.s));
              if (!forced && t.lane.ring && onLane.reduce((a, w) => a + w.len + S0, 0) > 0.75 * t.lane.len) yields.push({ at: hold(z), why: `merge ${t.lane.key}: ring nearly full` });
              for (const w of onLane) {
                // (one holding back to let it in)
                if (w === v || (w.v < 0.3 && w.why?.includes(`letting car ${v.id} in`))) continue;
                // (no room just past where it joins)
                const past = this.along(t.lane, t.s, w.pos);
                if (past < w.len + S0 + 2 && w.v < 3 && (t.lane.ring || w.pos > t.s)) { yields.push({ at: hold(z), why: `merge ${t.lane.key}: no room for car ${w.id}` }); break; }
                const u = this.along(t.lane, w.pos, t.s);
                if (!t.lane.ring && w.pos > t.s) { if (w.pos - t.s < w.len + 1) { yields.push({ at: hold(z), why: `merge ${t.lane.key} for car ${w.id}` }); break; } continue; }
                if (u > 70) continue;
                // (it leaves before getting here)
                if (w.exit && this.along(t.lane, w.pos, this.exitS(w.exit)) < u) continue;
                // (told to go: only one right there stops it)
                if (forced && u >= laneZone + v.len + 1) continue;
                if (u < laneZone + v.len + 1 || u - laneZone - w.v * arrive < Math.max(8, 2 * w.v)) { yields.push({ at: hold(z), why: `merge ${t.lane.key} for car ${w.id}` }); break; }
              }
            }
          }
        }
        // where its path meets another lane or connector
        for (const k of r.edge.conflicts) {
          // two connectors running together into one lane: a zip, not a crossing to wait at. Who is nearer
          // where they join goes first, the other following it in (as v1 does), on the move
          if (k.join) {
            const O = k.other, mine = r.off + r.edge.len - r.a;
            if (mine > 80) continue;
            const zip = (w: SimVehicle, theirs: number) => {
              if (w !== v && (theirs < mine || (theirs === mine && w.id < v.id))) behind(mine - theirs - w.len, w.v, w);
            };
            for (const w of byEdge.get(O) ?? []) zip(w, O.len - w.pos);
            // (and one about to take it, still on the lane into it)
            const f = O.from!;
            for (const w of byEdge.get(f.lane) ?? []) if (w.exit === O) zip(w, O.len + this.along(f.lane, w.pos, f.s));
            continue;
          }
          const rel = ahead(k.at);
          // (a crossing right at the edge's end, two connectors joining a lane at the same place, can be a hair past it)
          if (rel < -0.01 || rel > r.b - r.a + 0.01) continue;
          const dMe = r.off + rel, zs = dMe - k.before;
          if (zs > 60) continue;
          zones.push({ s: zs, e: dMe + k.after });
          // (too late to stop: on it goes)
          if (!canStopBefore(hold(zs))) continue;
          // (giving way at a line, it goes when it would be through before the other gets there, with time to spare)
          const tClear = minor ? timeTo(dMe + k.after + reach(v), v.v, r.edge.vmax, accOf(v)) + GAP : 0;
          // (already in among the zones this one is part of: it can't stop short of them any more, it goes through first)
          const meIn = r.edge === v.edge && r.edge.kind === "conn" && this.inRun(r.edge, v.pos, k.at - k.before);
          for (const w of toward.get(k.other) ?? NONE) {
            if (w === v) continue;
            const dW = this.toPlace(w, k.other, k.otherAt, reach(w) + 1 + k.otherAfter);
            if (dW === null) continue;
            const ws = dW - k.otherBefore;
            // (gone through, its back clear of the zone; or far off)
            if (dW + k.otherAfter < -reach(w) || ws > (minor ? LOOK : 70)) continue;
            const wIn = ws > 0 && w.edge === k.other && k.other.kind === "conn" && this.inRun(k.other, w.pos, k.otherAt - k.otherBefore);
            // (in among the zones, it is on its way through: it goes first, unless this one is in among them too)
            if (wIn && !meIn && !forced) { yields.push({ at: hold(zs), why: `zone ${k.other.key} for car ${w.id}` }); break; }
            // (this one in among them, the other able to stop short: it waits)
            if (meIn && !wIn && ws > 0 && ws >= (w.v * w.v) / 8) continue;
            // (stopped short of the zone for something else, the car ahead, keeping another crossing clear,
            // joining a lane: it isn't on its way through here, and waiting for it would lock the junction)
            if (w.v < 0.3 && ws > 0.1 && !w.why?.startsWith(`zone ${r.edge.key}`)) continue;
            // (one from a line goes after those without one, unless it is past its line and can't stop any more)
            const wMinor = !!k.other.minor, committed = w.edge === k.other && ws < Math.max(0.1, (w.v * w.v) / 8 - 1);
            const first = ws <= 0
              || (!forced && (minor === wMinor ? this.yieldsTo(v, zs, r.edge.vmax, w, ws, k.other.vmax) : minor ? timeTo(ws, w.v, k.other.vmax, accOf(w)) < tClear : committed));
            if (first) { yields.push({ at: hold(zs), why: `zone ${k.other.key} for car ${w.id}` }); break; }
          }
        }
      }
      // keeping clear: not going into a zone it couldn't get its body out of, the car ahead (slow) just past it
      // (zones overlapping one another are one: past the first it is in the next)
      if (lead < 3 && !forced) {
        const runs: { s: number; e: number }[] = [];
        for (const z of [...zones].sort((p, q) => p.s - q.s)) {
          const last = runs[runs.length - 1];
          if (last && z.s <= last.e) last.e = Math.max(last.e, z.e); else runs.push({ ...z });
        }
        for (const z of runs) if (z.s > 0.1 && canStopBefore(z.s) && gap < z.e + reach(v) + 1) yields.push({ at: z.s, why: `keeping clear (${why})` });
      }
      // giving way: stopping short of the zone, and of every other zone its body would block there
      for (const { at: x, why: reason } of yields) {
        let t = x - 0.5;
        for (let i = 0; i < 12; i++) {
          const z = zones.find(q => q.s >= 0.6 && q.s < t - 0.01 && q.e > t - v.len);
          if (!z) break;
          t = z.s - 0.5;
        }
        // (an obstacle with its back at `t + S0`: the front stops at `t`)
        behind(Math.max(0.1, t + S0), 0, reason);
      }
      v.why = gap < 30 ? why : null;
      v.blocking = zones.some(q => q.s < -0.01 && q.e > -reach(v));
      // IDM
      const free = 1 - (v.v / Math.max(vmax, 0.1)) ** 4;
      const A = accOf(v);
      let a = A * free;
      if (gap < Infinity) {
        const s = S0 + v.v * hwOf(v) + (v.v * (v.v - lead)) / (2 * Math.sqrt(A * B_COMF));
        a = A * (free - (Math.max(S0, s) / Math.max(gap, 0.1)) ** 2);
      }
      acc.set(v, Math.max(-9, a));
      held.set(v, { gap, lead });
    }

    // another way: at the head of the queue where it turns off, kept waiting there long (not by lights), a connector further along its
    // lane that leads where it is going too (the shortest such way; none it gave up on before; then as long again before it looks once more)
    // (the vehicles by number, made when first wanted: the car one is behind, found without looking through them all)
    let ids: Map<number, SimVehicle> | null = null;
    const byId = () => (ids ??= new Map(this.vehicles.map(w => [w.id, w])));
    const rt = this.routes;
    if (rt) for (const v of this.vehicles) {
      const x = v.exit, dest = v.dest;
      if (!x || !dest || v.broken !== null || v.held < REROUTE || this.t - v.rerouteT < REROUTE || v.gaveUp?.includes(x) || v.edge.kind !== "lane" || this.along(v.edge, v.pos, this.exitS(x)) > 10) continue;
      // (nor queued behind another on its lane: the one at the head looks)
      const ahead = /^car (\d+)/.exec(v.why ?? ""), lead = ahead && byId().get(Number(ahead[1]));
      if (lead && lead.edge === v.edge) continue;
      (v.gaveUp ??= []).push(x); v.rerouteT = this.t;
      let best: Edge | null = null, bc = Infinity;
      for (const o of v.edge.outs) {
        if (v.gaveUp.includes(o.conn)) continue;
        const d = this.along(v.edge, v.pos, o.s);
        if (d < -0.01 || (v.edge.ring && d > v.edge.len - 1)) continue;
        const c = d + rt.viaConnector(o.conn.id, dest);
        if (c < bc) { bc = c; best = o.conn; }
      }
      if (!best) continue;
      v.goal = { lane: v.edge, conn: best }; v.exit = best; v.reroutes++; this.reroutes++;
      this.note({ what: "reroute", car: v.id, from: x.key, to: best.key, waited: r2(v.still) });
    }

    // changing lane: to get where it is going, as soon as there is room (well before it has to, only where it is no worse off);
    // or to overtake, a slower car in its way and clearly more room on the other
    for (const v of this.vehicles) {
      const e = v.edge;
      if (e.kind !== "lane" || !e.neighbors.length || v.broken !== null || v.run < v.len || this.t - v.changedAt < SHIFT_T + 1) continue;
      const h = this.hop(v), { gap, lead } = held.get(v)!;
      if (h) {
        if (v.pos > h.n.a1 - 1) { this.plan(v); continue; }
        // (kept waiting to change lane: somewhere else it can go from its own lane will do)
        if (v.still > 8 && v.why?.startsWith("changing to")) {
          const was = v.goal;
          this.plan(v, true);
          if (v.goal) { this.note({ what: "change", car: v.id, gaveUp: was?.conn?.key ?? null, goal: v.goal.conn?.key ?? `end of ${v.goal.lane.key}` }); continue; }
          v.goal = was; v.exit = null;
        }
        const q = this.room(v, h.n, byEdge, ghosts);
        if (!q || (h.by - v.pos > 60 && q.ahead < Math.min(gap, 50) - 5)) continue;
        this.changeIn(byEdge, ghosts, v, h.n);
      } else {
        // (stopped behind one broken down in its lane: any lane beside with room will do, to get round it)
        const m = gap < 60 && v.v < 3 ? /^car (\d+)/.exec(v.why ?? "") : null, lw = m && byId().get(Number(m[1]));
        if (lw && lw.broken !== null && lw.edge === e) {
          const n = e.neighbors.find(n => n.a1 - v.pos > 10 && this.room(v, n, byEdge, ghosts));
          if (n) this.changeIn(byEdge, ghosts, v, n);
          continue;
        }
        const g = v.goal;
        if (!g || this.t - v.changedAt < 5 || v.blocking || gap > 40 || lead > 0.7 * e.vmax || v.v > 0.85 * e.vmax) continue;
        if (!(v.why ?? "").startsWith("car ")) continue;
        // (far enough from where it leaves to come back)
        if ((g.conn ? this.exitS(g.conn) : e.len) - v.pos < 80) continue;
        const best = e.neighbors
          .filter(n => n.a1 - v.pos > 60)
          .map(n => ({ n, q: this.room(v, n, byEdge, ghosts) }))
          .filter(x => x.q && x.q.ahead > gap + 10)
          .sort((a, b) => b.q!.ahead - a.q!.ahead)[0];
        if (best) this.changeIn(byEdge, ghosts, v, best.n);
      }
    }

    const gone = new Set<SimVehicle>(), drove = new Map<SimVehicle, number>();
    const T = this.tuning, F = this.fuel;
    for (const J of this.jTally) J.now = 0;
    for (const R of this.rTally) R.now = 0;
    for (const v of this.vehicles) {
      const nv = Math.max(0, v.v + acc.get(v)! * dt);
      let move = (v.v + nv) * 0.5 * dt;
      drove.set(v, move);
      // (fuel: idling standing still, unless its engine stops; more with speed and speeding up)
      const vAvg = (v.v + nv) / 2, still = vAvg < FUEL_STILL;
      const idle = v.broken !== null || (still && hasStopStart(v.id, T.stopStartShare)) ? 0 : (v.truck ? T.fuelIdleTruck : T.fuelIdleCar) / 3.6;
      const mL = fuelRate(v.truck ? "truck" : "car", vAvg, (nv - v.v) / dt, idle) * dt;
      v.fuel += mL; F.total += mL / 1000; F.km += move / 1000; F.co2 += (mL / 1000) * (v.truck ? CO2_DIESEL : CO2_PETROL);
      if (still) { F.idle += mL / 1000; F.idleTime += dt; }
      // (a junction's: on it, or on the last metres of a way into it)
      const jk = this.jOn.get(v.edge) ?? (v.edge.kind === "lane" && !v.edge.ring && v.edge.len - v.pos < APPROACH ? this.jIn.get(v.edge) : undefined);
      if (jk !== undefined) {
        const J = this.jTally[jk];
        J.delay += dt * Math.max(0, 1 - nv / Math.max(1, v.edge.vmax * v.vf)); J.fuel += mL / 1000;
        if (nv < 0.5) J.now++;
      }
      // (a road's: on one of its lanes)
      const rk = this.rOn.get(v.edge);
      if (rk !== undefined) {
        const R = this.rTally[rk];
        R.vehKm += move / 1000; R.vehHours += dt / 3600; R.delay += dt * Math.max(0, 1 - nv / Math.max(1, v.edge.vmax * v.vf));
        if (nv < 0.5) R.now++;
      }
      v.v = nv;
      v.still = nv < 0.1 ? v.still + dt : 0;
      v.held = nv < 0.1 && !v.why?.startsWith("signal") ? v.held + dt : nv < 0.1 ? v.held : 0;
      for (let guard = 0; move > 0 && guard < 4; guard++) {
        const e = v.edge;
        if (e.kind === "conn") {
          if (v.pos + move < e.len) { v.pos += move; v.run += move; move = 0; break; }
          move -= e.len - v.pos;
          v.trail = this.trailOf(v, e, e.len);
          v.edge = e.to!.lane; v.pos = e.to!.s; v.run = 0; v.stopped = false;
          { const a = this.jOn.get(v.edge); if (a !== undefined && a !== this.jOn.get(e)) this.jTally[a].through++; }
          // (onto a road from outside it: not from one of its own lanes)
          { const r = this.rOn.get(v.edge); if (r !== undefined && this.rOn.get(e.from!.lane) !== r) this.countOnto(r, v.edge.id); }
          this.plan(v);
          this.note({ what: "onto", car: v.id, from: e.key, to: v.edge.key, at: r2(v.pos), exit: v.exit?.key ?? null });
          continue;
        }
        if (this.exitBehind(v)) this.plan(v);
        const exitAt = v.exit ? e.outs.find(o => o.conn === v.exit)?.s : undefined;
        const toExit = exitAt === undefined ? Infinity : this.along(e, v.pos, exitAt);
        if (move >= toExit) {
          { const sc = this.splitOut.get(v.exit!.id); if (sc) this.turnCounts.set(sc.count, (this.turnCounts.get(sc.count) ?? 0) + 1); }
          move -= toExit; v.trail = this.trailOf(v, e, exitAt!); v.edge = v.exit!; v.pos = 0; v.run = 0; v.exit = null; v.goal = null; v.stopped = false;
          { const a = this.jOn.get(v.edge); if (a !== undefined && a !== this.jOn.get(e)) this.jTally[a].through++; }
          this.note({ what: "onto", car: v.id, from: e.key, left: r2(exitAt!), to: v.edge.key });
          continue;
        }
        v.pos += move; v.run += move; move = 0;
        if (e.ring) v.pos %= e.len;
        else if (v.pos >= e.len) {
          gone.add(v); this.finished++; this.note({ what: "out", car: v.id, lane: e.key });
          F.trips++; F.tripFuel += v.fuel / 1000;
          const j = v.journey ? this.journeys.find(x => x.def.id === v.journey) : null;
          if (j && j.to.includes(e.id)) { j.arrived++; j.tripSum += this.t - v.born; }
        }
      }
    }
    // (the junctions' queues: how many stand there now, over the time so far)
    for (const J of this.jTally) { J.queueSum += J.now * dt; if (J.now > J.queueMax) J.queueMax = J.now; }
    for (const R of this.rTally) if (R.now > R.queueMax) R.queueMax = R.now;
    this.jSince += dt;
    // (broken down long enough: towed away)
    for (const v of this.vehicles) if (v.broken !== null && this.t - v.broken >= this.tuning.brokenTowAfter) this.towAway(v, gone);
    if (gone.size) this.vehicles = this.vehicles.filter(v => !gone.has(v));
    this.record(drove);
  }

  private stateOf(v: SimVehicle, pose = this.poseOf(v)): CarState {
    const { p, d } = pose;
    return {
      edge: v.edge.key, pos: r2(v.pos), v: r2(v.v), exit: v.exit?.key ?? null, run: r2(v.run),
      trail: v.trail ? `${v.trail.edge.key}@${r2(v.trail.pos)}` : null, x: r2(p.x), y: r2(p.y), heading: Math.round((Math.atan2(d.y, d.x) * 180) / Math.PI), why: v.why,
    };
  }

  /** jumps noticed and logged; the frame kept */
  /** what is kept to replay: per frame, per car [id, x, y, dx, dy, v, share] and [edge, exit, why] as indexes into `tags` */
  /** per connector, the vehicles gone on past it with their backs still on it (as `step` found them) */
  private tails = new Map<Edge, { w: SimVehicle; pos: number }[]>();
  /** turning shares (as v1's): per lane of a way in that has them, the roads out and their weights; per connector out of it, the way it counts as */
  private splitAt = new Map<string, { key: string; outs: string[]; w: number[]; total: number }>();
  private splitOut = new Map<string, { out: string; count: string }>();
  private turnCounts = new Map<string, number>();
  /** the vehicles' bodies as the last step left them (until the next step, or the sketch or the run changes) */
  private posed: Map<SimVehicle, Body & { trailer?: Body }> | null = null;
  private replay: { t: number; nums: Float32Array; tags: Uint32Array; peds?: { ids: Uint32Array; nums: Float32Array }; /** per truck [index, x, y, dx, dy, len] */ trailers?: Float32Array }[] = [];
  private tags: string[] = [""];
  private tagIndex = new Map<string, number>([["", 0]]);
  private tag(s: string | null) {
    if (!s) return 0;
    let i = this.tagIndex.get(s);
    if (i === undefined) { i = this.tags.length; this.tags.push(s); this.tagIndex.set(s, i); }
    return i;
  }

  /** the time span that can be replayed, the frames kept for it and their size in memory (null: nothing kept yet) */
  replayRange() {
    const fr = this.replay;
    if (!fr.length) return null;
    let bytes = 0;
    for (const f of fr) bytes += f.nums.byteLength + f.tags.byteLength + 16 + (f.peds ? f.peds.ids.byteLength + f.peds.nums.byteLength : 0);
    return { from: fr[0].t, to: fr[fr.length - 1].t, frames: fr.length, bytes };
  }
  /**
   * The moment `t` (a replayed one, or now) as it was, to copy: the cars in `box` (the view; null: all) as
   * the frame kept for it has them, the nearest the middle first, what the lights showed, and what happened
   * within a minute either side.
   */
  moment(t: number, box: { x0: number; y0: number; x1: number; y1: number } | null) {
    const f = this.replayAt(t), cx = box ? (box.x0 + box.x1) / 2 : 0, cy = box ? (box.y0 + box.y1) / 2 : 0;
    const inBox = (p: Pt) => !box || (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1);
    const cars = (f?.cars ?? []).filter(c => inBox(c.p))
      .sort((a, b) => Math.hypot(a.p.x - cx, a.p.y - cy) - Math.hypot(b.p.x - cx, b.p.y - cy)).slice(0, MOMENT_CARS)
      .map(c => ({ car: c.id, x: r2(c.p.x), y: r2(c.p.y), heading: Math.round((Math.atan2(c.d.y, c.d.x) * 180) / Math.PI), kmh: Math.round(c.kmh), edge: c.edge, exit: c.exit, why: c.why }));
    const at = f?.t ?? t;
    const lights = this.signals.map(c => {
      let h = c.history[0];
      for (const x of c.history) { if (x.t > at) break; h = x; }
      return { junction: c.plan.junction, phase: h.phase, stage: h.stage, since: r2(at - h.t) };
    });
    const events = this.log.filter(e => Math.abs(e.t - at) <= 60).sort((a, b) => Math.abs(a.t - at) - Math.abs(b.t - at)).slice(0, MOMENT_EVENTS).sort((a, b) => a.t - b.t);
    const crossings = (f?.peds ?? []).map(q => ({ ...q, progress: r2(q.progress), ...(() => { const s = this.crossingStats(q.id); return s ? { crossedSoFar: s.crossed, avgWaitSoFar: r2(s.avgWait), lights: s.lights } : {}; })() }));
    return { time: r2(at), now: r2(this.t), kept: this.replayRange(), params: this.params, stats: this.stats(), cars, lights, crossings, events };
  }
  /** the cars as they were at time `t` (the frame kept just before it) */
  replayAt(t: number): { t: number; cars: ReplayCar[]; peds: PedView[] } | null {
    const fr = this.replay;
    if (!fr.length) return null;
    let lo = 0, hi = fr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fr[mid].t <= t) lo = mid; else hi = mid - 1; }
    const f = fr[lo], n = f.tags.length / 3, cars: ReplayCar[] = [];
    for (let i = 0; i < n; i++) {
      const a = f.nums.subarray(i * 8, i * 8 + 8), g = f.tags.subarray(i * 3, i * 3 + 3);
      cars.push({ id: a[0], p: { x: a[1], y: a[2] }, d: { x: a[3], y: a[4] }, len: a[7], kmh: a[5] * 3.6, share: Math.max(0, a[6]), ...(a[6] < 0 ? { broken: true } : {}), edge: this.tags[g[0]], exit: this.tags[g[1]] || null, why: this.tags[g[2]] || null });
    }
    const tr = f.trailers;
    if (tr) for (let i = 0; i < tr.length; i += 6) cars[tr[i]].trailer = { p: { x: tr[i + 1], y: tr[i + 2] }, d: { x: tr[i + 3], y: tr[i + 4] }, len: tr[i + 5] };
    const peds: PedView[] = [];
    if (f.peds) for (let i = 0; i < f.peds.ids.length; i++) peds.push({ id: this.tags[f.peds.ids[i]], waiting: f.peds.nums[i * 3], crossing: f.peds.nums[i * 3 + 1], progress: f.peds.nums[i * 3 + 2] });
    return { t: f.t, cars, peds };
  }
  /** the recorded car under `p` at time `t` (on its body, or within `tol` metres) */
  replayCarAt(t: number, p: Pt, tol: number): number | null {
    let best: number | null = null, bd = Infinity;
    for (const c of this.replayAt(t)?.cars ?? []) {
      const dd = bodyHit(p, c, tol);
      if (dd !== null && dd < bd) { bd = dd; best = c.id; }
    }
    return best;
  }

  private record(drove: Map<SimVehicle, number>) {
    // (each one's body once: for the frames kept, the collisions, the replay and the page's next frame)
    const posed = new Map(this.vehicles.map(v => [v, this.poseOf(v)]));
    this.posed = posed;
    // jumps: a car further from where it was drawn a step ago than it drove (its state then from the frame kept)
    for (const v of this.vehicles) {
      const { p } = posed.get(v)!, x = r2(p.x), y = r2(p.y), m = drove.get(v) ?? 0;
      if (!this.unseen && !Number.isNaN(v.seenX)) {
        const moved = Math.hypot(x - v.seenX, y - v.seenY);
        if (moved > m + 0.75) {
          const f = this.frames[this.frames.length - 1], row = f && this.frameRows(f, v.id)[0];
          const before = row ? (Object.fromEntries(FRAME_FIELDS.slice(1).map((k, i) => [k, row[i + 1]])) as unknown as CarState) : undefined;
          this.jumps++; this.note({ what: "jump", car: v.id, moved: r2(moved), drove: r2(m), before, after: this.stateOf(v, posed.get(v)) });
          this.problem("jump", v, `moved ${r2(moved)} m in a step, having driven ${r2(m)} m`);
        }
      }
      v.seenX = x; v.seenY = y;
    }
    this.unseen = false;
    const last = this.frames[this.frames.length - 1];
    if (!last || this.t - last.t >= 0.099) {
      const n = this.vehicles.length, fnums = new Float64Array(n * 8), refs: (string | null)[] = new Array(n * 4);
      this.vehicles.forEach((v, i) => {
        const { p, d } = posed.get(v)!;
        fnums.set([v.id, r2(v.pos), r2(v.v), r2(v.run), v.trail ? r2(v.trail.pos) : 0, r2(p.x), r2(p.y), Math.round((Math.atan2(d.y, d.x) * 180) / Math.PI)], i * 8);
        refs[i * 4] = v.edge.key; refs[i * 4 + 1] = v.exit?.key ?? null; refs[i * 4 + 2] = v.trail ? v.trail.edge.key : null; refs[i * 4 + 3] = v.why;
      });
      this.frames.push({ t: r2(this.t), nums: fnums, refs });
      while (this.frames.length && this.frames[0].t < this.t - KEEP_FRAMES) this.frames.shift();
      // (to replay)
      const nums = new Float32Array(n * 8), tags = new Uint32Array(n * 3);
      const trailers: number[] = [];
      this.vehicles.forEach((v, i) => {
        const { p, d, len, trailer: t } = posed.get(v)!;
        // (broken down: its share kept as -1)
        nums.set([v.id, p.x, p.y, d.x, d.y, v.v, v.broken !== null ? -1 : v.v / Math.max(1, v.edge.vmax), len], i * 8);
        if (t) trailers.push(i, t.p.x, t.p.y, t.d.x, t.d.y, t.len);
        tags.set([this.tag(v.edge.key), this.tag(v.exit?.key ?? null), this.tag(v.why)], i * 3);
      });
      // (the zebras' pedestrians: waiting, crossing, how far across)
      const peds = this.crossings.length ? { ids: Uint32Array.from(this.crossings, x => this.tag(x.def.id)), nums: Float32Array.from(this.peds().flatMap(q => [q.waiting, q.crossing, q.progress])) } : undefined;
      this.replay.push({ t: r2(this.t), nums, tags, ...(peds ? { peds } : {}), ...(trailers.length ? { trailers: Float32Array.from(trailers) } : {}) });
      let cut = 0;
      while (cut < this.replay.length && this.replay[cut].t < this.t - KEEP_REPLAY) cut++;
      if (cut) this.replay.splice(0, cut);
    }
    if (this.t < this.checkAt) return;
    this.checkAt = Math.floor(this.t + 1e-9) + 1;
    // once a second (as v1): collisions, bodies overlapping (logged when they start to; with the cars' states then)
    this.drawn = new Map(this.vehicles.map(v => [v.id, this.stateOf(v, posed.get(v))]));
    const now = new Set<string>(), cars = this.vehicles.map(v => ({ v, ...posed.get(v)! }));
    // (only two in the same or neighbouring cells, as wide as the longest vehicle, can be that near; the pairs
    // looked at in the vehicles' order, as when every pair was)
    const cell = Math.max(LEN, ...cars.map(c => c.v.len)), grid = new Map<number, number[]>();
    const cellKey = (cx: number, cy: number) => cx * 1_000_003 + cy;
    cars.forEach((c, i) => { const key = cellKey(Math.floor(c.p.x / cell), Math.floor(c.p.y / cell)), g = grid.get(key); if (g) g.push(i); else grid.set(key, [i]); });
    const pairs: number[] = [];
    for (let i = 0; i < cars.length; i++) {
      const cx = Math.floor(cars[i].p.x / cell), cy = Math.floor(cars[i].p.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) for (const j of grid.get(cellKey(gx, gy)) ?? NO_CARS) if (j > i) pairs.push(i * cars.length + j);
    }
    pairs.sort((x, y) => x - y);
    for (const ij of pairs) {
      const a = cars[Math.floor(ij / cars.length)], b = cars[ij % cars.length];
      const far = (a.v.len + b.v.len) / 2;
      if (Math.abs(a.p.x - b.p.x) > far || Math.abs(a.p.y - b.p.y) > far) continue;
      // (one over the other, at another level: not touching)
      if (Math.abs(this.zOfV(a.v) - this.zOfV(b.v)) >= 0.5) continue;
      const as = a.trailer ? [a, a.trailer] : [a], bs = b.trailer ? [b, b.trailer] : [b];
      if (!as.some(x => bs.some(y => bodiesOverlap(x, y)))) continue;
      const key = a.v.id < b.v.id ? `${a.v.id}-${b.v.id}` : `${b.v.id}-${a.v.id}`;
      now.add(key);
      if (!this.touching.has(key)) {
        this.collisions++;
        this.note({ what: "collision", car: a.v.id, with: b.v.id, a: this.drawn.get(a.v.id), b: this.drawn.get(b.v.id) });
        this.problem("collision", a.v, `ran into car ${b.v.id} (${b.v.edge.key})`, b.v);
      }
    }
    this.touching = now;
  }
  /** a kept frame's rows, as the fields in FRAME_FIELDS (only those of car `id`, if given) */
  private frameRows(f: { nums: Float64Array; refs: (string | null)[] }, id?: number): (string | number | null)[][] {
    const out: (string | number | null)[][] = [];
    for (let i = 0; i < f.refs.length / 4; i++) {
      const q = f.nums, o = i * 8, r = i * 4;
      if (id !== undefined && q[o] !== id) continue;
      out.push([q[o], f.refs[r], q[o + 1], q[o + 2], f.refs[r + 1], q[o + 3], f.refs[r + 2] === null ? null : `${f.refs[r + 2]}@${q[o + 4]}`, q[o + 5], q[o + 6], q[o + 7], f.refs[r + 3]]);
    }
    return out;
  }

  /** what is kept, to copy: the run's numbers, the cars now, the jumps, the events of the last minute and the frames of the last 10 s */
  report() {
    return {
      time: r2(this.t), params: this.params, stats: this.stats(),
      cars: this.vehicles.map(v => ({ car: v.id, ...this.stateOf(v, this.posed?.get(v)) })),
      jumps: this.log.filter(e => e.what === "jump").slice(-40),
      collisions: this.log.filter(e => e.what === "collision").slice(-40),
      events: this.log.filter(e => e.what !== "jump" && e.what !== "collision" && e.t >= this.t - 60).slice(-1500),
      frameFields: FRAME_FIELDS, frames: this.frames.filter(f => f.t >= this.t - 10).map(f => ({ t: f.t, cars: this.frameRows(f) })),
    };
  }

  stats(): SimStats {
    const byEdge = new Map<Edge, SimVehicle[]>();
    for (const v of this.vehicles) { const l = byEdge.get(v.edge); if (l) l.push(v); else byEdge.set(v.edge, [v]); }
    let overlaps = 0;
    for (const [e, vs] of byEdge) {
      for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
        const d = e.ring ? Math.min(this.along(e, vs[i].pos, vs[j].pos), this.along(e, vs[j].pos, vs[i].pos)) : Math.abs(vs[i].pos - vs[j].pos);
        if (d < Math.min(vs[i].len, vs[j].len) - 0.5) overlaps++;
      }
    }
    const n = this.vehicles.length;
    return {
      t: this.t, vehicles: n, spawned: this.spawned, finished: this.finished, overlaps,
      meanSpeed: n ? (this.vehicles.reduce((a, v) => a + v.v, 0) / n) * 3.6 : 0,
      waiting: this.vehicles.filter(v => v.still >= 20).length, stuck: this.vehicles.filter(v => v.still >= STUCK_AFTER).length, jumps: this.jumps, collisions: this.collisions, deadlocks: this.deadlocks, laneChanges: this.changes, reroutes: this.reroutes, fuel: { ...this.fuel },
      roads: this.rTally.map(r => ({ id: r.id, through: r.through, vehKm: r.vehKm, vehHours: r.vehHours, delay: r.delay, queueMax: r.queueMax, lanes: { ...r.lanes } })),
      junctions: this.jTally.map(j => ({ id: j.id, through: j.through, delay: j.delay, queueMean: this.jSince > 0 ? j.queueSum / this.jSince : 0, queueMax: j.queueMax, fuel: j.fuel })),
      breakdowns: this.breakdowns, towed: this.towed,
      pedsCrossed: this.crossings.reduce((a, x) => a + x.ped.crossed, 0), pedsWaiting: this.crossings.reduce((a, x) => a + x.ped.waiting, 0),
      ...(this.splitOut.size ? { turns: Object.fromEntries(this.turnCounts) } : {}),
      ...(this.journeys.length ? { journeys: this.journeys.map(j => ({
        id: j.def.id, sent: j.sent, arrived: j.arrived, meanTrip: j.arrived ? j.tripSum / j.arrived : 0, noRoute: j.noRoute,
        driving: this.vehicles.filter(v => v.journey === j.def.id).length, waiting: this.sources.reduce((a, s) => a + (s.wait?.filter(w => w.journey === j.def.id).length ?? 0), 0),
      })) } : {}),
    };
  }

  /**
   * Where each vehicle is drawn: between its front and its back (traced back onto the edge it came
   * from while it isn't all on this one), and its speed as a share of its desired speed.
   */
  poses() {
    return this.vehicles.map(v => ({ id: v.id, ...(this.posed?.get(v) ?? this.poseOf(v)), share: v.v / Math.max(1, v.edge.vmax), ...(v.broken !== null ? { broken: true } : {}), ...(v.edge.z ? { z: v.edge.z(v.pos) } : {}) }));
  }

  /** the car under `p` (on its body, or within `tol` metres of it): the nearest; null if none */
  carAt(p: Pt, tol: number): number | null {
    let best: number | null = null, bd = Infinity;
    for (const v of this.vehicles) {
      const dd = bodyHit(p, this.poseOf(v), tol);
      if (dd !== null && dd < bd) { bd = dd; best = v.id; }
    }
    return best;
  }

  /** a car as it is now, to inspect it, with the way it will go (about 80 m of it); null once it has left */
  inspect(id: number) {
    const v = this.vehicles.find(x => x.id === id);
    if (!v) return null;
    const route: Pt[] = [];
    let total = 0;
    for (const r of this.route(v)) {
      const end = Math.min(r.b, r.a + 80 - total);
      for (let s = r.a; s <= end + 1e-6; s += 1) route.push(r.edge.locate(Math.min(s, end)).p);
      route.push(r.edge.locate(end).p);
      total += end - r.a;
      if (total >= 80) break;
    }
    const pose = this.poseOf(v);
    return {
      id: v.id, truck: v.truck, length: v.len, edge: v.edge.key, pos: v.pos, len: v.edge.len, ring: v.edge.ring,
      kmh: v.v * 3.6, desiredKmh: v.edge.vmax * v.vf * 3.6, exit: v.exit?.key ?? null, then: v.exit?.to?.lane.key ?? (v.edge.kind === "conn" ? v.edge.to!.lane.key : null),
      /** drives off the end of the lane it is on (leaves the sketch there) */
      leaves: v.edge.kind === "lane" && !v.exit && !v.edge.ring && v.goal?.lane === v.edge,
      /** its goal on another lane: the lane to change to next, and where it is going from there (a connector, or the end of a lane) */
      /** the exit it is going to (by the shortest way), or null (wandering) */
      dest: v.dest,
      changeTo: this.hop(v)?.n.lane.key ?? null, goal: v.goal && v.goal.lane !== v.edge ? v.goal.conn?.key ?? `end:${v.goal.lane.key}` : null,
      why: v.why, still: v.still, reroutes: v.reroutes, journey: v.journey, fuel: v.fuel, broken: v.broken !== null ? this.t - v.broken : null, p: pose.p, d: pose.d, route,
    };
  }

  /** a car's states over the last 10 s (as kept every 0.1 s), to copy */
  carFrames(id: number) {
    return this.frames.filter(f => f.t >= this.t - 10).flatMap(f => {
      const row = this.frameRows(f, id)[0];
      return row ? [Object.fromEntries([["t", f.t], ...FRAME_FIELDS.map((k, i) => [k, row[i]])])] : [];
    });
  }
  /** the trail of a car leaving edge `e` at `at` (where it is now) */
  private trailOf(v: SimVehicle, e: Edge, at: number): Trail {
    const run = v.run + this.along(e, v.pos, at);
    // (the edges before, as far back as its body reaches: the rest let go)
    const keep = (t: Trail | null, got: number): Trail | null => !t ? null : { ...t, before: got + t.run < v.len ? keep(t.before, got + t.run) : null };
    return { edge: e, pos: at, run, before: run < v.len ? keep(v.trail, run) : null };
  }

  /** the point `dist` metres back from a vehicle's front, along the way it came (before the lane's start, if just in: on the way in) */
  private behindFront(v: SimVehicle, dist: number): { p: Pt; d: Pt } {
    let t = v.trail, rest = dist - v.run;
    if (!t && !v.edge.ring && v.pos < dist) { const s0 = v.edge.locate(0); return { p: { x: s0.p.x - s0.d.x * (dist - v.pos), y: s0.p.y - s0.d.y * (dist - v.pos) }, d: s0.d }; }
    if (rest <= 0 || !t) return v.edge.locate(v.pos - dist);
    while (t.before && rest > t.run) { rest -= t.run; t = t.before; }
    // (back past the start of a lane it came in on, nothing before it: still on the way in, behind the lane's start)
    const x = t.pos - rest;
    if (x < 0 && !t.before && !t.edge.ring) { const s0 = t.edge.locate(0); return { p: { x: s0.p.x + s0.d.x * x, y: s0.p.y + s0.d.y * x }, d: s0.d }; }
    return t.edge.locate(x);
  }

  /**
   * Where a vehicle is drawn: a car between its front and its back; a truck's cab between its front and `CAB`
   * back, its trailer (`trailer`) from the hitch to its back, each following the way it goes (so a truck bends
   * round tight corners). Sliding over to a lane it changed to: what is left of the way over, the cab turned
   * a little towards it.
   */
  private poseOf(v: SimVehicle): Body & { trailer?: Body } {
    const front = v.edge.locate(v.pos), len = v.truck ? CAB : v.len, back = this.behindFront(v, len);
    const mid = (a: { p: Pt }, b: { p: Pt }, fb: Pt): { p: Pt; d: Pt } => {
      const dx = a.p.x - b.p.x, dy = a.p.y - b.p.y, l = Math.hypot(dx, dy);
      return { p: { x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 }, d: l > 0.5 ? { x: dx / l, y: dy / l } : fb };
    };
    const body = mid(front, back, front.d);
    let trailer: Body | undefined;
    if (v.truck) {
      // (its middle 40% of the way from the line from hitch to back to the way at its middle: on a bend it cuts in less, its ends swing out a little)
      const h = this.behindFront(v, CAB - HITCH), c = mid(h, this.behindFront(v, v.len), h.d), w = this.behindFront(v, (CAB - HITCH + v.len) / 2).p;
      trailer = { p: { x: c.p.x + (w.x - c.p.x) * 0.4, y: c.p.y + (w.y - c.p.y) * 0.4 }, d: c.d, len: v.len - CAB + HITCH };
    }
    const u = v.shift ? (this.t - v.changedAt) / SHIFT_T : 1;
    if (u >= 1) return trailer ? { ...body, len, trailer } : { ...body, len };
    const k = 1 - u * u * (3 - 2 * u), turn = (6 * u * (1 - u)) / (SHIFT_T * Math.max(v.v, 2));
    const sx = v.shift!.x * k, sy = v.shift!.y * k, { d } = body, tx = d.x - v.shift!.x * turn, ty = d.y - v.shift!.y * turn, tl = Math.hypot(tx, ty) || 1;
    const moved = { p: { x: body.p.x + sx, y: body.p.y + sy }, d: { x: tx / tl, y: ty / tl }, len };
    return trailer ? { ...moved, trailer: { ...trailer, p: { x: trailer.p.x + sx, y: trailer.p.y + sy } } } : moved;
  }
  /** a vehicle's bodies: a car's; a truck's cab and trailer */
  private bodiesOf(v: SimVehicle): Body[] {
    const q = this.poseOf(v);
    return q.trailer ? [q, q.trailer] : [q];
  }
}

const newPed = (): PedState => ({ waiting: 0, since: 0, crossing: 0, from: 0, until: -Infinity, redSince: -1, claim: false, crossed: 0, waitSum: 0 });
