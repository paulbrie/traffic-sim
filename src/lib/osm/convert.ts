/**
 * Turns OpenStreetMap data (an Overpass JSON answer) into a plan network.
 *
 * Roads: the chosen highway classes, clipped to the area (roads leaving it become entry points),
 * split into links at junctions. Clusters of junction points a few metres apart (dual carriageways
 * crossing, offset T-junctions) become one junction, pairs of one-way carriageways between the same
 * junctions become one two-way road, small roundabouts become roundabout junctions, and each
 * road's shape is fitted with the editor's straight / cubic Bézier links.
 * Tags used: oneway, lanes(:forward/:backward), maxspeed, name/ref, busway, junction=roundabout;
 * on nodes highway=traffic_signals / stop / give_way / mini_roundabout.
 *
 * Buildings: footprints (outer rings of multipolygons too) whose centre lies in the area, with a
 * height from height / building:levels and a use from building / shop / amenity / office tags.
 */
import { DEFAULT_SIGNAL, type ApproachSign, type BuildingDef, type BuildingUse, type Control, type GeoRef, type LinkDef, type Network, type NodeDef, type PlanSettings, type Vec } from "../../engine/types";
import { FLOOR_HEIGHT, polyArea, polyCentroid } from "../../engine/buildings";
import { newId } from "../../engine/sample";
import { highwaysFor, project, type BBox, type RoadClass } from "./area";

type Tags = Record<string, string>;
interface OsmNode { type: "node"; id: number; lat: number; lon: number; tags?: Tags }
interface OsmWay { type: "way"; id: number; nodes: number[]; tags?: Tags }
interface OsmRelation { type: "relation"; id: number; members: { type: string; ref: number; role: string }[]; tags?: Tags }
export interface OsmData { elements: (OsmNode | OsmWay | OsmRelation)[] }

export interface ImportStats {
  roads: number; lengthKm: number; junctions: number; signals: number; roundabouts: number; entries: number; buildings: number;
}

export interface ConvertOptions {
  bbox: BBox;
  /** lat/lon of plan point (0, 0) */
  origin: GeoRef;
  roads: RoadClass[];
  buildings: boolean;
}

/** junction points closer than this along a road are merged into one junction (m) */
const CLUSTER = 25;
/** signal / stop sign nodes this close to a junction belong to it (m) */
const SIGN_REACH = 30;
/** roundabouts up to this radius become one roundabout junction; larger ones stay as roads (m) */
const MAX_RING = 40;
/** tolerance when fitting road shapes with straight lines and curves (m) */
const FIT_TOL = 1.5;
const MAX_LANES = 4;
/** entry roads are at least this long (m), extended past the area's edge when needed */
const MIN_ENTRY = 30;
/** bend points added by the shape fitting stay this far from the road's ends (m) … */
const FIT_END_GAP = 20;
/** … and this far from each other */
const FIT_MIN_PIECE = 8;

interface Pt { key: string; x: number; y: number; osm?: number }
interface Vx {
  key: string; x: number; y: number;
  boundary: boolean; lights: boolean; allStop: boolean; mini: boolean; ring: boolean;
}
interface Seg {
  a: string; b: string; pts: Vec[];
  lanesF: number; lanesB: number; busF: boolean; busB: boolean; speed: number; name: string;
  /** sign for traffic arriving at b (F) / at a (B) */
  signF: ApproachSign | null; signB: ApproachSign | null;
}

export function convertOsm(data: OsmData, opts: ConvertOptions): { network: Network; stats: ImportStats } {
  const nodes = new Map<number, OsmNode>(), ways: OsmWay[] = [], rels: OsmRelation[] = [];
  // a way can be listed twice (as a road or building, and again as a member of a relation)
  const seenWays = new Set<number>();
  for (const el of data.elements ?? []) {
    if (el.type === "node") nodes.set(el.id, el);
    else if (el.type === "way") { if (!seenWays.has(el.id)) { seenWays.add(el.id); ways.push(el); } }
    else if (el.type === "relation") rels.push(el);
  }
  const proj = new Map<number, Vec>();
  const P = (id: number): Vec => {
    let p = proj.get(id);
    if (!p) { const n = nodes.get(id)!; p = project(opts.origin, n.lat, n.lon); proj.set(id, p); }
    return p;
  };
  const sw = project(opts.origin, opts.bbox.south, opts.bbox.west), ne = project(opts.origin, opts.bbox.north, opts.bbox.east);
  const rect = { x0: sw.x, x1: ne.x, y0: ne.y, y1: sw.y };
  const inside = (p: Vec, m = 0) => p.x >= rect.x0 - m && p.x <= rect.x1 + m && p.y >= rect.y0 - m && p.y <= rect.y1 + m;

  const { segs, vx } = buildRoads(ways, nodes, P, rect, inside, opts.roads);
  const net = toNetwork(segs, vx);
  const buildings = opts.buildings ? buildBuildings(ways, rels, nodes, P, inside) : [];
  const network: Network = { ...net.network, ...(buildings.length ? { buildings } : {}), geo: { ...opts.origin, areas: [{ ...opts.bbox }] } };
  return { network, stats: { ...net.stats, buildings: buildings.length } };
}

/** demand that suits an imported network: roughly one vehicle per 110 m of lane */
export function suggestSettings(net: Network): PlanSettings {
  const byId = new Map(net.nodes.map(n => [n.id, n]));
  let laneM = 0;
  for (const l of net.links) {
    const a = byId.get(l.from), b = byId.get(l.to);
    if (a && b) laneM += Math.hypot(a.x - b.x, a.y - b.y) * (l.lanesF + l.lanesB);
  }
  const cars = Math.round(Math.min(3000, Math.max(40, laneM / 110)) / 10) * 10;
  return { cars, trucks: Math.round(cars * 0.06), seed: 7 };
}

// ---------------------------------------------------------------- roads

function wayAttrs(t: Tags) {
  const hw = t.highway;
  const ring = t.junction === "roundabout" || t.junction === "circular";
  const ow = t.oneway;
  let oneway: 0 | 1 | -1 = ow === "yes" || ow === "true" || ow === "1" ? 1 : ow === "-1" || ow === "reverse" ? -1 : 0;
  if (!ow && (ring || hw === "motorway" || hw === "motorway_link")) oneway = 1;
  if (ow === "no" || ow === "reversible" || ow === "alternating") oneway = 0;
  const int = (v: string | undefined) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : null; };
  const big = /^(motorway|trunk)/.test(hw), main = /^(primary|secondary)/.test(hw);
  let lanesF: number, lanesB: number;
  const total = int(t.lanes), fw = int(t["lanes:forward"]), bw = int(t["lanes:backward"]);
  if (oneway !== 0) {
    lanesF = total ?? (big || main ? 2 : 1); lanesB = 0;
  } else {
    lanesF = fw ?? (total ? (bw ? Math.max(1, total - bw) : Math.max(1, Math.floor(total / 2))) : big ? 2 : 1);
    lanesB = bw ?? (total ? Math.max(1, total - lanesF) : big ? 2 : 1);
  }
  lanesF = Math.min(MAX_LANES, lanesF); lanesB = Math.min(MAX_LANES, lanesB);
  const bus = (side: string) => ["lane", "opposite_lane"].includes(t[`busway:${side}`] ?? "") || t.busway === "lane";
  const busF = bus("right") || bus("both"), busB = oneway === 0 && (bus("left") || bus("both"));
  return {
    oneway, ring, lanesF, lanesB, speed: parseSpeed(t.maxspeed, hw), name: (t.name || t.ref || "").slice(0, 120),
    busF: busF && lanesF >= 2, busB: busB && lanesB >= 2,
  };
}

function parseSpeed(v: string | undefined, hw: string): number {
  const def = /^motorway/.test(hw) ? 110 : /^trunk/.test(hw) ? 90 : hw === "living_street" ? 20 : hw === "service" ? 20 : 50;
  if (!v) return def;
  const m = /^(\d+(?:\.\d+)?)\s*(mph)?/.exec(v.trim());
  if (m) return clampSpeed(parseFloat(m[1]) * (m[2] ? 1.609 : 1));
  if (v === "walk") return 10;
  if (v === "none") return 130;
  if (/urban/.test(v)) return 50;
  if (/living_street/.test(v)) return 20;
  if (/motorway/.test(v)) return 130;
  if (/rural|trunk/.test(v)) return 90;
  return def;
}
const clampSpeed = (s: number) => Math.round(Math.min(130, Math.max(10, s)));

function buildRoads(
  ways: OsmWay[], nodes: Map<number, OsmNode>, P: (id: number) => Vec,
  rect: { x0: number; x1: number; y0: number; y1: number }, inside: (p: Vec, m?: number) => boolean, classes: RoadClass[],
) {
  const allowed = new Set(highwaysFor(classes));
  const minorHw = new Set(["residential", "living_street", "service", "unclassified"]);
  const roadWays = ways.filter(w => {
    const t = w.tags;
    if (!t?.highway || !allowed.has(t.highway) || t.area === "yes" || w.nodes.length < 2) return false;
    if (t.access === "no" || t.motor_vehicle === "no" || t.motorcar === "no") return false;
    if (t.access === "private" && minorHw.has(t.highway)) return false;
    if (t.highway === "service" && ["parking_aisle", "driveway", "drive-through", "emergency_access"].includes(t.service ?? "")) return false;
    return w.nodes.every(id => nodes.has(id));
  });
  const nodeTags = (id: number | undefined) => (id === undefined ? undefined : nodes.get(id)?.tags);

  // ---- small roundabouts → one junction
  const alias = new Map<number, Pt>();
  const ringWays = roadWays.filter(w => wayAttrs(w.tags!).ring);
  const collapsed = new Set<OsmWay>();
  {
    const parent = new Map<OsmWay, OsmWay>();
    const find = (w: OsmWay): OsmWay => { let r = w; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
    const byNode = new Map<number, OsmWay>();
    for (const w of ringWays) {
      parent.set(w, w);
      for (const id of w.nodes) { const o = byNode.get(id); if (o) parent.set(find(o), find(w)); else byNode.set(id, w); }
    }
    const groups = new Map<OsmWay, OsmWay[]>();
    for (const w of ringWays) { const r = find(w); let g = groups.get(r); if (!g) groups.set(r, (g = [])); g.push(w); }
    let k = 0;
    for (const g of groups.values()) {
      const ids = [...new Set(g.flatMap(w => w.nodes))];
      const pts = ids.map(P);
      const c = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
      const r = pts.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / pts.length;
      // only closed rings: every way end meets another way end (or its own start)
      const ends = new Map<number, number>();
      for (const w of g) for (const id of [w.nodes[0], w.nodes[w.nodes.length - 1]]) ends.set(id, (ends.get(id) ?? 0) + 1);
      const closed = ids.length >= 3 && [...ends.values()].every(c => c % 2 === 0);
      if (!closed || r > MAX_RING || !pts.every(p => inside(p, -5))) continue;
      const key = `r${k++}`;
      for (const id of ids) alias.set(id, { key, x: c.x, y: c.y });
      for (const w of g) collapsed.add(w);
    }
  }

  // ---- clip every way to the area; roads leaving it end at boundary points
  const boundary = new Set<string>();
  const pieces: Pt[][] = [];
  const attrsOf = new Map<Pt[], ReturnType<typeof wayAttrs>>();
  for (const w of roadWays) {
    if (collapsed.has(w)) continue;
    const at = wayAttrs(w.tags!);
    let ids = w.nodes;
    if (at.oneway === -1) ids = [...ids].reverse();
    const pts: Pt[] = [];
    for (const id of ids) {
      const al = alias.get(id);
      const p: Pt = al ? { ...al } : { key: `n${id}`, osm: id, ...P(id) };
      if (pts.length && pts[pts.length - 1].key === p.key) continue;
      pts.push(p);
    }
    for (const piece of clip(pts, rect, boundary, w.id)) { pieces.push(piece); attrsOf.set(piece, at); }
  }

  // ---- vertices: piece ends, points shared by several pieces, roundabouts, signals away from junctions
  const uses = new Map<string, number>();
  for (const pc of pieces) pc.forEach((p, i) => uses.set(p.key, (uses.get(p.key) ?? 0) + (i === 0 || i === pc.length - 1 ? 1 : 2)));
  const vx = new Map<string, Vx>();
  const addVx = (p: Pt) => {
    let v = vx.get(p.key);
    if (!v) {
      const t = nodeTags(p.osm);
      vx.set(p.key, (v = {
        key: p.key, x: p.x, y: p.y, boundary: boundary.has(p.key), ring: p.key.startsWith("r"),
        lights: t?.highway === "traffic_signals", allStop: t?.highway === "stop" && t?.stop === "all", mini: t?.highway === "mini_roundabout",
      }));
    }
    return v;
  };
  const isVertexKey = (pc: Pt[], i: number) => i === 0 || i === pc.length - 1 || (uses.get(pc[i].key) ?? 0) > 2 || pc[i].key.startsWith("r");
  for (const pc of pieces) pc.forEach((p, i) => { if (isVertexKey(pc, i)) addVx(p); });
  const junctionVx = [...vx.values()].filter(v => (uses.get(v.key) ?? 0) >= 3);
  const nearestJunction = (p: Vec, reach: number) => {
    let best: Vx | null = null, bd = reach;
    for (const v of junctionVx) { const d = Math.hypot(v.x - p.x, v.y - p.y); if (d < bd) { bd = d; best = v; } }
    return best;
  };
  for (const pc of pieces) for (const p of pc) {
    if (vx.has(p.key) || nodeTags(p.osm)?.highway !== "traffic_signals") continue;
    const j = nearestJunction(p, SIGN_REACH);
    if (j) j.lights = true;
    else addVx(p).lights = true; // lights at a crossing between junctions
  }

  // ---- split pieces into segments between vertices
  let segs: Seg[] = [];
  for (const pc of pieces) {
    const at = attrsOf.get(pc)!;
    let start = 0;
    for (let i = 1; i < pc.length; i++) {
      if (!vx.has(pc[i].key)) continue;
      const run = pc.slice(start, i + 1);
      const seg: Seg = {
        a: run[0].key, b: run[run.length - 1].key, pts: run.map(p => ({ x: p.x, y: p.y })),
        lanesF: at.lanesF, lanesB: at.lanesB, busF: at.busF, busB: at.busB, speed: at.speed, name: at.name, signF: null, signB: null,
      };
      // stop / give-way signs on the approach to either end
      let along = 0;
      const total = polyLen(seg.pts);
      for (let k = 1; k < run.length - 1; k++) {
        along += Math.hypot(run[k].x - run[k - 1].x, run[k].y - run[k - 1].y);
        const hw = nodeTags(run[k].osm)?.highway;
        if (hw !== "stop" && hw !== "give_way") continue;
        const sign: ApproachSign = hw === "stop" ? "stop" : "yield";
        if (total - along < SIGN_REACH) seg.signF = sign; else if (along < SIGN_REACH) seg.signB = sign;
      }
      segs.push(seg);
      start = i;
    }
  }

  // ---- merge junction points that sit close together along a road
  const degree = () => { const d = new Map<string, number>(); for (const s of segs) { d.set(s.a, (d.get(s.a) ?? 0) + 1); d.set(s.b, (d.get(s.b) ?? 0) + 1); } return d; };
  {
    const deg = degree();
    const cand = (k: string) => (deg.get(k) ?? 0) >= 3 && !vx.get(k)!.boundary && !vx.get(k)!.ring;
    const parent = new Map<string, string>();
    const find = (k: string): string => { let r = k; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
    for (const s of segs) if (s.a !== s.b && cand(s.a) && cand(s.b) && polyLen(s.pts) < CLUSTER) {
      parent.set(find(s.a), find(s.b)); if (!parent.has(find(s.b))) parent.set(find(s.b), find(s.b));
    }
    const members = new Map<string, Vx[]>();
    for (const k of parent.keys()) { const r = find(k); let m = members.get(r); if (!m) members.set(r, (m = [])); m.push(vx.get(k)!); }
    const remap = new Map<string, Vx>();
    let k = 0;
    for (const m of members.values()) {
      if (m.length < 2) continue;
      const c: Vx = {
        key: `c${k++}`, x: m.reduce((s, v) => s + v.x, 0) / m.length, y: m.reduce((s, v) => s + v.y, 0) / m.length,
        boundary: false, ring: false, lights: m.some(v => v.lights), allStop: m.some(v => v.allStop), mini: m.some(v => v.mini),
      };
      vx.set(c.key, c);
      for (const v of m) remap.set(v.key, c);
    }
    if (remap.size) {
      const out: Seg[] = [];
      for (const s of segs) {
        const ca = remap.get(s.a), cb = remap.get(s.b);
        if (ca && cb && ca === cb && polyLen(s.pts) < 2 * CLUSTER) continue; // inside the junction
        const pts = s.pts.slice();
        if (ca) pts[0] = { x: ca.x, y: ca.y };
        if (cb) pts[pts.length - 1] = { x: cb.x, y: cb.y };
        out.push({ ...s, a: ca?.key ?? s.a, b: cb?.key ?? s.b, pts: dedupe(pts) });
      }
      segs = out;
    }
  }

  // ---- entry roads that only just reach into the area: lengthen them outwards so traffic can queue
  for (const s of segs) for (const end of ["a", "b"] as const) {
    if (!vx.get(s[end])!.boundary) continue;
    const L = polyLen(s.pts);
    if (L >= MIN_ENTRY || s.pts.length < 2) continue;
    const [p, q] = end === "a" ? [s.pts[0], s.pts[1]] : [s.pts[s.pts.length - 1], s.pts[s.pts.length - 2]];
    const d = Math.hypot(p.x - q.x, p.y - q.y) || 1, k = (MIN_ENTRY - L) / d;
    const moved = { x: p.x + (p.x - q.x) * k, y: p.y + (p.y - q.y) * k };
    if (end === "a") s.pts[0] = moved; else s.pts[s.pts.length - 1] = moved;
    const v = vx.get(s[end])!; v.x = moved.x; v.y = moved.y;
  }

  // ---- drop short dead-end stubs left by the clipping / merging
  for (let pass = 0; pass < 2; pass++) {
    const deg = degree();
    segs = segs.filter(s => !(((deg.get(s.a) === 1 && !vx.get(s.a)!.boundary) || (deg.get(s.b) === 1 && !vx.get(s.b)!.boundary)) && polyLen(s.pts) < 15));
  }

  segs = mergeChains(segs, vx);
  segs = mergeParallel(segs, vx);
  segs = mergeChains(segs, vx);
  return { segs, vx };
}

/** Liang–Barsky clipping of a polyline against the area */
function clip(pts: Pt[], r: { x0: number; x1: number; y0: number; y1: number }, boundary: Set<string>, wayId: number): Pt[][] {
  const inR = (p: Vec) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  const bpt = (q: Pt, p: Pt, t: number, i: number): Pt => {
    const key = `e${wayId}_${i}_${t.toFixed(4)}`;
    boundary.add(key);
    return { key, x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t };
  };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i === 0) { if (inR(p)) cur.push(p); continue; }
    const q = pts[i - 1];
    const dx = p.x - q.x, dy = p.y - q.y;
    let t0 = 0, t1 = 1, ok = true;
    for (const [pp, qq] of [[-dx, q.x - r.x0], [dx, r.x1 - q.x], [-dy, q.y - r.y0], [dy, r.y1 - q.y]] as [number, number][]) {
      if (pp === 0) { if (qq < 0) { ok = false; break; } continue; }
      const t = qq / pp;
      if (pp < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { if (cur.length > 1) out.push(cur); cur = []; continue; }
    if (t0 > 0) { if (cur.length > 1) out.push(cur); cur = [bpt(q, p, t0, i)]; }
    else if (!cur.length) cur = [q];
    if (t1 < 1) { cur.push(bpt(q, p, t1, i)); if (cur.length > 1) out.push(cur); cur = []; }
    else cur.push(p);
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

function reverseSeg(s: Seg): Seg {
  return { ...s, a: s.b, b: s.a, pts: s.pts.slice().reverse(), lanesF: s.lanesB, lanesB: s.lanesF, busF: s.busB, busB: s.busF, signF: s.signB, signB: s.signF };
}

/** join the two roads meeting at a plain 2-way point when they have the same lanes, speed and name */
function mergeChains(segs: Seg[], vx: Map<string, Vx>): Seg[] {
  const at = new Map<string, Set<Seg>>();
  const add = (s: Seg) => { for (const k of [s.a, s.b]) { let x = at.get(k); if (!x) at.set(k, (x = new Set())); x.add(s); } };
  const del = (s: Seg) => { at.get(s.a)?.delete(s); at.get(s.b)?.delete(s); };
  segs.forEach(add);
  const live = new Set(segs);
  for (const [k, set] of at) {
    const v = vx.get(k)!;
    if (v.boundary || v.lights || v.allStop || v.mini || v.ring) continue;
    if (set.size !== 2) continue;
    let [s1, s2] = [...set];
    if (s1 === s2 || s1.a === s1.b || s2.a === s2.b) continue;
    if (s1.a === k) s1 = reverseSeg(s1);
    if (s2.b === k) s2 = reverseSeg(s2);
    if (s1.b !== k || s2.a !== k || s1.a === s2.b) continue;
    if (s1.lanesF !== s2.lanesF || s1.lanesB !== s2.lanesB || s1.speed !== s2.speed || s1.name !== s2.name || s1.busF !== s2.busF || s1.busB !== s2.busB) continue;
    const orig = [...set];
    orig.forEach(s => { del(s); live.delete(s); });
    const m: Seg = { ...s1, b: s2.b, pts: [...s1.pts, ...s2.pts.slice(1)], signF: s2.signF, signB: s1.signB };
    add(m); live.add(m);
  }
  return [...live];
}

/**
 * Roads that share both ends: a pair of opposite one-way carriageways becomes one two-way road,
 * near-identical duplicates are dropped, and genuinely different roads get a bend point so no two
 * links join the same pair of nodes.
 */
function mergeParallel(segs: Seg[], vx: Map<string, Vx>): Seg[] {
  const groups = new Map<string, Seg[]>();
  const out: Seg[] = [];
  for (const s0 of segs) {
    if (s0.a === s0.b) { out.push(...splitMid(s0, vx)); continue; }
    const s = s0.a < s0.b ? s0 : reverseSeg(s0);
    const k = `${s.a}|${s.b}`;
    let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(s);
  }
  for (const g of groups.values()) {
    const rest = g.slice();
    const kept: Seg[] = [];
    while (rest.length) {
      const s = rest.shift()!;
      const mid = polyAt(s.pts, 0.5);
      const partner = rest.findIndex(o => {
        const d = Math.hypot(polyAt(o.pts, 0.5).x - mid.x, polyAt(o.pts, 0.5).y - mid.y);
        return d < 40 && ((s.lanesB === 0 && o.lanesF === 0) || (s.lanesF === 0 && o.lanesB === 0));
      });
      if (partner >= 0) {
        const o = rest.splice(partner, 1)[0];
        const [f, b] = s.lanesB === 0 ? [s, o] : [o, s];
        kept.push({ ...f, lanesB: b.lanesB, busB: b.busB, signB: b.signB, name: f.name || b.name, speed: Math.max(f.speed, b.speed), pts: averagePolys(f.pts, b.pts) });
        continue;
      }
      const dup = kept.findIndex(o => Math.hypot(polyAt(o.pts, 0.5).x - mid.x, polyAt(o.pts, 0.5).y - mid.y) < 8);
      if (dup >= 0) { if (s.lanesF + s.lanesB > kept[dup].lanesF + kept[dup].lanesB) kept[dup] = s; continue; }
      kept.push(s);
    }
    out.push(kept[0], ...kept.slice(1).flatMap(s => splitMid(s, vx)));
  }
  return out;
}

/** split a road at its middle with a plain bend point */
function splitMid(s: Seg, vx: Map<string, Vx>): Seg[] {
  const L = polyLen(s.pts);
  if (L < 20) return [];
  const mid = polyAt(s.pts, 0.5);
  const key = `m${vx.size}_${Math.round(mid.x)}_${Math.round(mid.y)}`;
  vx.set(key, { key, x: mid.x, y: mid.y, boundary: false, lights: false, allStop: false, mini: false, ring: false });
  let acc = 0, i = 1;
  for (; i < s.pts.length; i++) { const d = Math.hypot(s.pts[i].x - s.pts[i - 1].x, s.pts[i].y - s.pts[i - 1].y); if (acc + d >= L / 2) break; acc += d; }
  const first = [...s.pts.slice(0, i), mid], second = [mid, ...s.pts.slice(i)];
  return [{ ...s, b: key, pts: dedupe(first), signF: null }, { ...s, a: key, pts: dedupe(second), signB: null }];
}

// ---------------------------------------------------------------- network output

function toNetwork(segs: Seg[], vx: Map<string, Vx>): { network: Network; stats: Omit<ImportStats, "buildings"> } {
  const nodes: NodeDef[] = [], links: LinkDef[] = [];
  const idOf = new Map<string, NodeDef>();
  const deg = new Map<string, number>();
  for (const s of segs) { deg.set(s.a, (deg.get(s.a) ?? 0) + 1); deg.set(s.b, (deg.get(s.b) ?? 0) + 1); }
  const mkNode = (x: number, y: number, v?: Vx, degree = 2): NodeDef => {
    let control: Control = "priority";
    if (v?.ring || (v?.mini && degree >= 3)) control = "roundabout";
    else if (v?.lights) control = "lights";
    else if (v?.allStop && degree >= 3) control = "stop";
    const n: NodeDef = { id: newId("n"), x: r1(x), y: r1(y), control, gateway: !!v?.boundary, signal: { ...DEFAULT_SIGNAL } };
    if (v?.lights && degree === 2) n.junction = true;
    nodes.push(n);
    return n;
  };
  const node = (k: string) => {
    let n = idOf.get(k);
    if (!n) { const v = vx.get(k)!; n = mkNode(v.x, v.y, v, deg.get(k) ?? 0); idOf.set(k, n); }
    return n;
  };
  let lengthM = 0;
  for (const s of segs) {
    const pts = simplify(s.pts, 0.8);
    lengthM += polyLen(pts);
    const parts = fit(pts);
    let from = node(s.a);
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      const to = last ? node(s.b) : mkNode(pts[p.end].x, pts[p.end].y);
      links.push({
        id: newId("l"), name: s.name, from: from.id, to: to.id, c1: p.c1 && rv(p.c1), c2: p.c2 && rv(p.c2),
        lanesF: s.lanesF, lanesB: s.lanesB, busF: s.busF, busB: s.busB, speed: s.speed,
        ...(last && s.signF ? { signF: s.signF } : {}), ...(i === 0 && s.signB ? { signB: s.signB } : {}),
      });
      from = to;
    });
  }
  // rounded kerbs where roads meet at shallow angles (slip roads, merges)
  const arms = new Map<string, number[]>();
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const l of links) {
    const A = byId.get(l.from)!, B = byId.get(l.to)!;
    const a = l.c1 ?? B, b = l.c2 ?? A;
    (arms.get(A.id) ?? arms.set(A.id, []).get(A.id)!).push(Math.atan2(a.y - A.y, a.x - A.x));
    (arms.get(B.id) ?? arms.set(B.id, []).get(B.id)!).push(Math.atan2(b.y - B.y, b.x - B.x));
  }
  for (const n of nodes) {
    const as = (arms.get(n.id) ?? []).sort((x, y) => x - y);
    if (as.length < 3) continue;
    const gaps = as.map((a, i) => (i ? a - as[i - 1] : a + 2 * Math.PI - as[as.length - 1]));
    if (Math.min(...gaps) < (30 * Math.PI) / 180) n.smooth = true;
  }
  const degOf = (id: string) => arms.get(id)?.length ?? 0;
  return {
    network: { version: 1, nodes, links, stops: [], lines: [] },
    stats: {
      roads: links.length, lengthKm: Math.round(lengthM / 100) / 10,
      junctions: nodes.filter(n => degOf(n.id) >= 3).length,
      signals: nodes.filter(n => n.control === "lights").length,
      roundabouts: nodes.filter(n => n.control === "roundabout" && degOf(n.id) >= 3).length,
      entries: nodes.filter(n => n.gateway && degOf(n.id) === 1).length,
    },
  };
}

/**
 * Split a polyline into pieces that are each close to a straight line or one cubic Bézier
 * (tangent-continuous at the joins). Returns the index each piece ends at.
 */
function fit(pts: Vec[]): { end: number; c1: Vec | null; c2: Vec | null }[] {
  const n = pts.length;
  const tan = (i: number): Vec => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (b.x - a.x) / d, y: (b.y - a.y) / d };
  };
  const along = [0];
  for (let k = 1; k < n; k++) along.push(along[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
  const total = along[n - 1];
  const out: { end: number; c1: Vec | null; c2: Vec | null }[] = [];
  const go = (i0: number, i1: number) => {
    const A = pts[i0], B = pts[i1], chord = Math.hypot(B.x - A.x, B.y - A.y);
    let wd = 0;
    for (let k = i0 + 1; k < i1; k++) wd = Math.max(wd, segDist(pts[k], A, B));
    if (i1 - i0 === 1 || wd < FIT_TOL * 0.7) { out.push({ end: i1, c1: null, c2: null }); return; }
    const t0 = tan(i0), t1 = tan(i1);
    // chord-length parameters, then least squares for the two handle lengths (Schneider)
    const u = [0];
    for (let k = i0 + 1; k <= i1; k++) u.push(u[u.length - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
    const L = u[u.length - 1] || 1;
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let k = 0; k < u.length; k++) {
      const t = u[k] / L, s = 1 - t, b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
      const a1 = { x: t0.x * b1, y: t0.y * b1 }, a2 = { x: -t1.x * b2, y: -t1.y * b2 };
      const p = pts[i0 + k];
      const tx = p.x - (A.x * (b0 + b1) + B.x * (b2 + b3)), ty = p.y - (A.y * (b0 + b1) + B.y * (b2 + b3));
      c00 += a1.x * a1.x + a1.y * a1.y; c01 += a1.x * a2.x + a1.y * a2.y; c11 += a2.x * a2.x + a2.y * a2.y;
      x0 += a1.x * tx + a1.y * ty; x1 += a2.x * tx + a2.y * ty;
    }
    const det = c00 * c11 - c01 * c01;
    let al1 = det > 1e-9 ? (x0 * c11 - x1 * c01) / det : chord / 3, al2 = det > 1e-9 ? (c00 * x1 - c01 * x0) / det : chord / 3;
    if (!(al1 > chord * 0.02 && al1 < chord * 1.5 && al2 > chord * 0.02 && al2 < chord * 1.5)) al1 = al2 = chord / 3;
    const c1 = { x: A.x + t0.x * al1, y: A.y + t0.y * al1 }, c2 = { x: B.x - t1.x * al2, y: B.y - t1.y * al2 };
    const curve: Vec[] = [];
    for (let k = 0; k <= 32; k++) {
      const t = k / 32, s = 1 - t;
      curve.push({ x: s * s * s * A.x + 3 * s * s * t * c1.x + 3 * s * t * t * c2.x + t * t * t * B.x, y: s * s * s * A.y + 3 * s * s * t * c1.y + 3 * s * t * t * c2.y + t * t * t * B.y });
    }
    let err = 0, errAt = -1;
    for (let k = i0 + 1; k < i1; k++) {
      let d = Infinity;
      for (let j = 1; j < curve.length; j++) d = Math.min(d, segDist(pts[k], curve[j - 1], curve[j]));
      if (d > err) { err = d; errAt = k; }
    }
    // split at the worst-fitting point that leaves room at the junctions and between bend points
    const ok = (k: number) => along[k] >= FIT_END_GAP && total - along[k] >= FIT_END_GAP && along[k] - along[i0] >= FIT_MIN_PIECE && along[i1] - along[k] >= FIT_MIN_PIECE;
    let at = -1, ad = -1;
    if (err > FIT_TOL) for (let k = i0 + 1; k < i1; k++) {
      if (!ok(k)) continue;
      let d = Infinity;
      for (let j = 1; j < curve.length; j++) d = Math.min(d, segDist(pts[k], curve[j - 1], curve[j]));
      if (k === errAt) d += 1e-6;
      if (d > ad) { ad = d; at = k; }
    }
    if (at < 0) { out.push({ end: i1, c1, c2 }); return; }
    go(i0, at); go(at, i1);
  };
  go(0, n - 1);
  return out;
}

// ---------------------------------------------------------------- buildings

function buildBuildings(ways: OsmWay[], rels: OsmRelation[], nodes: Map<number, OsmNode>, P: (id: number) => Vec, inside: (p: Vec) => boolean): BuildingDef[] {
  const out: BuildingDef[] = [];
  const wayById = new Map(ways.map(w => [w.id, w]));
  const add = (id: string, ring: number[], tags: Tags) => {
    if (ring.length < 4 || ring[0] !== ring[ring.length - 1] || !ring.every(n => nodes.has(n))) return;
    let pts = ring.slice(0, -1).map(P);
    pts = simplifyRing(pts, 0.3);
    if (pts.length < 3) return;
    const area = polyArea(pts);
    if (area < 10 || !inside(polyCentroid(pts))) return;
    const use = buildingUse(tags);
    const b: BuildingDef = { id, pts: pts.map(rv), height: buildingHeight(tags, use), use };
    if (tags.name) b.name = tags.name.slice(0, 120);
    out.push(b);
  };
  for (const w of ways) {
    const t = w.tags;
    if (!t?.building || t.building === "no" || t.highway) continue;
    add(`w${w.id}`, w.nodes, t);
  }
  for (const r of rels) {
    const t = r.tags;
    if (!t?.building || t.building === "no") continue;
    const outer = r.members.filter(m => m.type === "way" && (m.role === "outer" || m.role === "")).map(m => wayById.get(m.ref)?.nodes).filter((x): x is number[] => !!x);
    joinRings(outer).forEach((ring, k) => add(`r${r.id}_${k}`, ring, t));
  }
  return out;
}

/** join way fragments end to end into closed rings */
function joinRings(parts: number[][]): number[][] {
  const rest = parts.map(p => p.slice());
  const rings: number[][] = [];
  while (rest.length) {
    let ring = rest.shift()!;
    for (let guard = 0; ring[0] !== ring[ring.length - 1] && guard < 1000; guard++) {
      const end = ring[ring.length - 1];
      const i = rest.findIndex(p => p[0] === end || p[p.length - 1] === end);
      if (i < 0) break;
      const p = rest.splice(i, 1)[0];
      ring = ring.concat((p[0] === end ? p : p.slice().reverse()).slice(1));
    }
    if (ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

const MINOR = new Set(["garage", "garages", "shed", "carport", "hut", "roof", "cabin", "service", "transformer_tower", "bunker", "toilets", "greenhouse", "container", "tent", "ruins", "construction", "boathouse"]);
const HOMES = new Set(["house", "detached", "semidetached_house", "terrace", "apartments", "residential", "bungalow", "dormitory", "farm", "static_caravan", "villa"]);
const SHOPS = new Set(["retail", "commercial", "supermarket", "kiosk", "mall", "shop", "store"]);
const SCHOOLS = new Set(["school", "university", "college", "kindergarten"]);
const CIVIC = new Set(["hospital", "civic", "public", "government", "church", "cathedral", "chapel", "mosque", "synagogue", "temple", "train_station", "transportation", "museum", "hotel", "stadium", "sports_hall", "townhall", "fire_station", "police"]);

export function buildingUse(t: Tags): BuildingUse {
  const b = t.building;
  if (MINOR.has(b)) return "minor";
  if (t.shop || SHOPS.has(b) || ["restaurant", "cafe", "fast_food", "bar", "pub", "marketplace", "bank", "pharmacy", "fuel", "cinema", "theatre"].includes(t.amenity ?? "")) return "shop";
  if (t.office || b === "office") return "office";
  if (["industrial", "warehouse", "factory", "manufacture"].includes(b) || t.industrial || t.man_made === "works") return "industry";
  if (SCHOOLS.has(b) || SCHOOLS.has(t.amenity ?? "")) return "school";
  if (CIVIC.has(b) || ["hospital", "townhall", "library", "place_of_worship", "community_centre", "courthouse", "police", "clinic", "university"].includes(t.amenity ?? "") || t.tourism === "hotel") return "civic";
  if (HOMES.has(b)) return "home";
  return "other";
}

function buildingHeight(t: Tags, use: BuildingUse): number {
  const h = /^(\d+(?:\.\d+)?)\s*(m|ft|')?/.exec(t.height ?? "");
  if (h) return clampH(parseFloat(h[1]) * (h[2] === "ft" || h[2] === "'" ? 0.3048 : 1));
  const lv = parseFloat(t["building:levels"] ?? "");
  if (Number.isFinite(lv) && lv > 0) return clampH(lv * FLOOR_HEIGHT + (parseFloat(t["roof:levels"] ?? "") > 0 ? 1.5 : 0.8));
  const b = t.building;
  if (use === "minor") return 3;
  if (["house", "detached", "semidetached_house", "bungalow", "terrace", "villa", "farm"].includes(b)) return 7;
  if (["apartments", "residential", "dormitory"].includes(b)) return 15;
  if (["church", "cathedral"].includes(b)) return 18;
  if (use === "industry") return 9;
  if (use === "shop" || use === "office") return 12;
  return 9;
}
const clampH = (h: number) => Math.round(Math.min(400, Math.max(2.5, h)) * 10) / 10;

// ---------------------------------------------------------------- geometry helpers

const r1 = (v: number) => Math.round(v * 10) / 10;
const rv = (p: Vec): Vec => ({ x: r1(p.x), y: r1(p.y) });

function polyLen(pts: Vec[]) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return L;
}

/** point at fraction f of the polyline's length */
function polyAt(pts: Vec[], f: number): Vec {
  const target = polyLen(pts) * f;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + d >= target && d > 0) { const t = (target - acc) / d; return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t }; }
    acc += d;
  }
  return pts[pts.length - 1];
}

/** centreline between two polylines running the same way */
function averagePolys(a: Vec[], b: Vec[]): Vec[] {
  const n = Math.max(2, Math.min(40, Math.max(a.length, b.length) * 2));
  const out: Vec[] = [];
  for (let k = 0; k < n; k++) { const f = k / (n - 1), p = polyAt(a, f), q = polyAt(b, f); out.push({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }); }
  out[0] = a[0]; out[n - 1] = a[a.length - 1];
  return out;
}

function dedupe(pts: Vec[]): Vec[] {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i].x - out[out.length - 1].x, pts[i].y - out[out.length - 1].y) > 0.05 || i === pts.length - 1) out.push(pts[i]);
  if (out.length > 2 && Math.hypot(out[out.length - 1].x - out[out.length - 2].x, out[out.length - 1].y - out[out.length - 2].y) < 0.05) out.splice(out.length - 2, 1);
  return out;
}

function segDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

/** Douglas–Peucker */
function simplify(pts: Vec[], tol: number): Vec[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let md = 0, mk = -1;
    for (let k = i + 1; k < j; k++) { const d = segDist(pts[k], pts[i], pts[j]); if (d > md) { md = d; mk = k; } }
    if (md > tol && mk > 0) { keep[mk] = 1; stack.push([i, mk], [mk, j]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(pts: Vec[], tol: number): Vec[] {
  if (pts.length <= 4) return pts;
  // split at the point farthest from the first, simplify both halves
  let far = 1, fd = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y); if (d > fd) { fd = d; far = i; } }
  const a = simplify(pts.slice(0, far + 1), tol), b = simplify([...pts.slice(far), pts[0]], tol);
  return [...a, ...b.slice(1, -1)];
}
