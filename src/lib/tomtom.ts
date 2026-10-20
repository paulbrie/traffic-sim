/**
 * Live traffic from TomTom (ticket #33): its flow tiles (each road's speed now, and as a share of its free-flow speed),
 * for the area a V2 plan placed on the map covers, matched onto the plan's lanes. TomTom has speeds,
 * not vehicle counts: what it gives the plan is the speed each road is driven at with no traffic (its speed limit for
 * the cars), how fast it goes now (to compare with the simulation's), and its closures. (The incidents come apart, through
 * /api/plans/[planId]/traffic and the Live traffic sync switch.)
 * Plain data and geometry, no framework: the server fetches and decodes (src/server/traffic.ts), the editor matches.
 */
import type { GeoArea, GeoRef } from "@/engine/types";
import { project } from "@/lib/osm/area";
import { samples, type Pt, type Sketch, type SketchLane } from "./lane-sketch";

/** a road's line in a flow tile: its points (latitude, longitude), its value, its class, one way of it or both */
export interface FlowLine {
  pts: [number, number][];
  /** km/h (absolute tiles) or the share of the free-flow speed, 0–1 (relative tiles) */
  v: number;
  /** TomTom's road category: motorway, trunk, primary, secondary, tertiary, street */
  cls: string;
  /** one way of the road only, drawn the way it runs (else both ways, either way) */
  oneSide: boolean;
  closed?: true;
}
/** what TomTom said for an area at one moment (kept in the page only, never saved: TomTom's terms limit storing it) */
export interface TrafficSnapshot {
  /** when it was fetched (ISO) */
  at: string;
  area: GeoArea;
  speeds: FlowLine[];
  ratios: FlowLine[];
}

// ---------------------------------------------------------------- the area and its tiles

/** the zoom of the flow tiles fetched (the most detail: TomTom's vector tiles thin out the roads above it) */
export const FLOW_ZOOM = 15;
/** at most this many tiles of each kind for one fetch (about 7 × 7 km at zoom 15) */
export const MAX_TILES = 150;
/** metres added round the lanes for the area fetched */
const AREA_MARGIN = 30;

/** the area (latitude / longitude) the sketch's lanes cover, with a margin; null if it isn't placed on the map */
export function sketchArea(sk: Sketch): GeoArea | null {
  const g = sk.geo;
  if (!g) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of sk.lanes) for (const p of samples(l.shape, 5)) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  if (!Number.isFinite(x0)) return null;
  const R = 6378137, k = 180 / Math.PI;
  const lat = (y: number) => g.lat - (y / R) * k, lon = (x: number) => g.lon + (x / (R * Math.cos(g.lat / k))) * k;
  return { south: lat(y1 + AREA_MARGIN), north: lat(y0 - AREA_MARGIN), west: lon(x0 - AREA_MARGIN), east: lon(x1 + AREA_MARGIN) };
}

const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); };
/** the web-map tiles covering an area at zoom `z` */
export function tilesFor(a: GeoArea, z = FLOW_ZOOM): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let x = tileX(a.west, z); x <= tileX(a.east, z); x++) for (let y = tileY(a.north, z); y <= tileY(a.south, z); y++) out.push({ x, y });
  return out;
}

// ---------------------------------------------------------------- decoding a flow tile (Mapbox Vector Tile, lines only)

/** the "Traffic flow" layer's lines of a vector tile (protobuf), in latitude / longitude */
export function decodeFlowTile(buf: Uint8Array, z: number, tx: number, ty: number): FlowLine[] {
  let pos = 0;
  const varint = (): number => { let v = 0, m = 1, b: number; do { b = buf[pos++]; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return v; };
  // (where a length-prefixed field ends: its length read first, then added to where it starts)
  const until = () => { const n = varint(); return pos + n; };
  const skip = (wire: number) => { if (wire === 0) varint(); else if (wire === 1) pos += 8; else if (wire === 2) pos = until(); else if (wire === 5) pos += 4; else throw new Error(`bad wire type ${wire}`); };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const text = (end: number) => new TextDecoder().decode(buf.subarray(pos, end));
  const packed = (): number[] => { const end = until(), out: number[] = []; while (pos < end) out.push(varint()); return out; };
  const zz = (n: number) => (n % 2 ? -(n + 1) / 2 : n / 2);
  const out: FlowLine[] = [];
  while (pos < buf.length) {
    const tag = varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
    // a layer
    const end = until();
    let name = "", extent = 4096;
    const keys: string[] = [], values: (string | number | boolean)[] = [], feats: { tags: number[]; type: number; geom: number[] }[] = [];
    while (pos < end) {
      const t = varint(), f = t >> 3;
      if (f === 1) { const e = until(); name = text(e); pos = e; }
      else if (f === 3) { const e = until(); keys.push(text(e)); pos = e; }
      else if (f === 5) extent = varint();
      else if (f === 4) {
        const e = until();
        let v: string | number | boolean = 0;
        while (pos < e) {
          const vt = varint(), vf = vt >> 3;
          if (vf === 1) { const se = until(); v = text(se); pos = se; }
          else if (vf === 2) { v = view.getFloat32(pos, true); pos += 4; }
          else if (vf === 3) { v = view.getFloat64(pos, true); pos += 8; }
          else if (vf === 4 || vf === 5) v = varint();
          else if (vf === 6) v = zz(varint());
          else if (vf === 7) v = varint() !== 0;
          else skip(vt & 7);
        }
        values.push(v);
      } else if (f === 2) {
        const e = until(), ft = { tags: [] as number[], type: 0, geom: [] as number[] };
        while (pos < e) {
          const tt = varint(), tf = tt >> 3;
          if (tf === 2) ft.tags = packed(); else if (tf === 3) ft.type = varint(); else if (tf === 4) ft.geom = packed(); else skip(tt & 7);
        }
        feats.push(ft);
      } else skip(t & 7);
    }
    if (name !== "Traffic flow") continue;
    const n = 2 ** z, deg = 180 / Math.PI;
    const ll = (px: number, py: number): [number, number] => {
      const lon = ((tx + px / extent) / n) * 360 - 180, lat = deg * Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + py / extent)) / n)));
      return [Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6];
    };
    for (const ft of feats) {
      if (ft.type !== 2) continue;
      const props: Record<string, string | number | boolean> = {};
      for (let i = 0; i + 1 < ft.tags.length; i += 2) props[keys[ft.tags[i]]] = values[ft.tags[i + 1]];
      const v = Number(props.traffic_level);
      if (!Number.isFinite(v)) continue;
      // (the commands: move-to and line-to, each point relative to the last)
      let i = 0, cx = 0, cy = 0, line: [number, number][] = [];
      const lines: [number, number][][] = [];
      while (i < ft.geom.length) {
        const c = ft.geom[i++], cmd = c & 7, count = c >> 3;
        if (cmd === 7) continue;
        for (let k = 0; k < count; k++) {
          cx += zz(ft.geom[i++]); cy += zz(ft.geom[i++]);
          if (cmd === 1) { if (line.length > 1) lines.push(line); line = []; }
          line.push(ll(cx, cy));
        }
      }
      if (line.length > 1) lines.push(line);
      for (const pts of lines) out.push({ pts, v, cls: String(props.road_category ?? ""), oneSide: props.traffic_road_coverage === "one_side", ...(props.road_closure === true ? { closed: true as const } : {}) });
    }
  }
  return out;
}

// ---------------------------------------------------------------- matching onto the plan's lanes

/** what TomTom says of a lane (or a road, over its lanes): speed now, share of free flow, free-flow speed (km/h), how much of it TomTom covers */
export interface LaneTraffic {
  /** km/h now */
  kmh: number | null;
  /** now as a share of the free-flow speed (1: no traffic) */
  rel: number | null;
  /** the free-flow speed, km/h */
  free: number | null;
  /** the share of its length TomTom has a road for */
  cover: number;
  /** most of what is covered closed */
  closed: boolean;
}
export interface TrafficMatch {
  lanes: Map<string, LaneTraffic>;
  roads: Map<string, LaneTraffic>;
  /** metres of the roads' lanes (bike lanes left out), and of those TomTom covers */
  length: number; covered: number;
}

/** a lane's points are matched to a TomTom line this close (m: a lane's middle is a few metres off the road's) … */
export const MATCH_DIST = 12;
/** … running this close to its direction (cosine) */
const MATCH_COS = 0.8;
/** a point every this many metres along each lane */
const MATCH_STEP = 10;
/** … and within this of a line's ends (m) */
const END_SLACK = 3;
const CELL = 25;

interface Seg { a: Pt; b: Pt; v: number; oneSide: boolean; closed: boolean }
function indexLines(lines: FlowLine[], geo: GeoRef) {
  const grid = new Map<string, Seg[]>();
  for (const f of lines) {
    const ps = f.pts.map(([lat, lon]) => project(geo, lat, lon));
    for (let k = 1; k < ps.length; k++) {
      const s: Seg = { a: ps[k - 1], b: ps[k], v: f.v, oneSide: f.oneSide, closed: !!f.closed };
      const i0 = Math.floor(Math.min(s.a.x, s.b.x) / CELL), i1 = Math.floor(Math.max(s.a.x, s.b.x) / CELL), j0 = Math.floor(Math.min(s.a.y, s.b.y) / CELL), j1 = Math.floor(Math.max(s.a.y, s.b.y) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const key = `${i},${j}`; const c = grid.get(key); if (c) c.push(s); else grid.set(key, [s]); }
    }
  }
  return (q: Pt, d: Pt): Seg | null => {
    let best: Seg | null = null, bd = MATCH_DIST;
    const i0 = Math.floor(q.x / CELL), j0 = Math.floor(q.y / CELL);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) for (const s of grid.get(`${i},${j}`) ?? []) {
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, L = Math.hypot(dx, dy);
      if (!L) continue;
      const cos = (dx * d.x + dy * d.y) / L;
      // (one way of the road: only lanes running its way; both: either)
      if (s.oneSide ? cos < MATCH_COS : Math.abs(cos) < MATCH_COS) continue;
      // (beside the line, not past its ends: the next line there, TomTom's or none, has its say)
      const along = ((q.x - s.a.x) * dx + (q.y - s.a.y) * dy) / L;
      if (along < -END_SLACK || along > L + END_SLACK) continue;
      const t = Math.max(0, Math.min(1, along / L)), e = Math.hypot(q.x - s.a.x - t * dx, q.y - s.a.y - t * dy);
      if (e < bd) { bd = e; best = s; }
    }
    return best;
  };
}

type Acc = { len: number; hit: number; kmh: number; rel: number; relLen: number; free: number; freeLen: number; closed: number };
const acc = (): Acc => ({ len: 0, hit: 0, kmh: 0, rel: 0, relLen: 0, free: 0, freeLen: 0, closed: 0 });
const add = (a: Acc, b: Acc) => { for (const k of Object.keys(a) as (keyof Acc)[]) a[k] += b[k]; };
const done = (a: Acc): LaneTraffic => ({
  kmh: a.hit ? a.kmh / a.hit : null, rel: a.relLen ? a.rel / a.relLen : null, free: a.freeLen ? a.free / a.freeLen : null,
  cover: a.len ? a.hit / a.len : 0, closed: a.hit > 0 && a.closed > a.hit / 2,
});

/**
 * A matcher for one snapshot: TomTom's roads matched onto a sketch's lanes (each lane's points to the nearest line running
 * its way) and summed up per road. Each lane's match is kept by the lane (the object), so after an edit only the lanes
 * changed are matched again; a sketch moved on the map starts afresh.
 */
export function trafficMatcher(snap: TrafficSnapshot): (sk: Sketch) => TrafficMatch | null {
  let geo: GeoRef | null = null, speedAt: ReturnType<typeof indexLines> | null = null, ratioAt: ReturnType<typeof indexLines> | null = null;
  let kept = new WeakMap<SketchLane, Acc>();
  const matchLane = (l: SketchLane): Acc => {
    const a = acc(), pts = samples(l.shape, 2);
    for (let k = 1; k < pts.length; k++) {
      const p = pts[k - 1], q = pts[k], L = Math.hypot(q.x - p.x, q.y - p.y);
      if (!L) continue;
      const d = { x: (q.x - p.x) / L, y: (q.y - p.y) / L }, n = Math.max(1, Math.round(L / MATCH_STEP)), w = L / n;
      for (let m = 0; m < n; m++) {
        const t = (m + 0.5) / n, at = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }, s = speedAt!(at, d), r = ratioAt!(at, d);
        a.len += w;
        if (!s) continue;
        a.hit += w; a.kmh += s.v * w;
        if (s.closed) a.closed += w;
        if (r) { a.rel += r.v * w; a.relLen += w; if (r.v > 0.05 && !s.closed) { a.free += (s.v / r.v) * w; a.freeLen += w; } }
      }
    }
    return a;
  };
  return sk => {
    if (!sk.geo) return null;
    if (!geo || geo.lat !== sk.geo.lat || geo.lon !== sk.geo.lon) {
      geo = { ...sk.geo }; speedAt = indexLines(snap.speeds, geo); ratioAt = indexLines(snap.ratios, geo); kept = new WeakMap();
    }
    const inRoad = new Map<string, string>();
    for (const r of sk.roads) for (const id of r.lanes) inRoad.set(id, r.id);
    const lanes = new Map<string, LaneTraffic>(), roads = new Map<string, Acc>();
    let length = 0, covered = 0;
    for (const l of sk.lanes) {
      if (l.bike) continue;
      let a = kept.get(l);
      if (!a) { a = matchLane(l); kept.set(l, a); }
      if (a.hit) lanes.set(l.id, done(a));
      const road = inRoad.get(l.id);
      if (road) { const ra = roads.get(road) ?? acc(); add(ra, a); roads.set(road, ra); length += a.len; covered += a.hit; }
    }
    return { lanes, roads: new Map([...roads].filter(([, a]) => a.hit > 0).map(([id, a]) => [id, done(a)])), length, covered };
  };
}
/** TomTom's roads matched onto the sketch's lanes once (see `trafficMatcher`) */
export const matchTraffic = (sk: Sketch, snap: TrafficSnapshot) => trafficMatcher(snap)(sk);

// ---------------------------------------------------------------- what the plan takes from it

/** a road TomTom covers at least this much of gets its free-flow speed as its speed limit */
export const LIMIT_MIN_COVER = 0.5;
/** the speed limits set: rounded to this (km/h), within these */
const LIMIT_STEP = 5, LIMIT_MIN = 10, LIMIT_MAX = 130;

/** each road's free-flow speed, rounded, as its speed limit (the roads TomTom covers well enough); the roads changed */
export function freeFlowLimits(sk: Sketch, m: TrafficMatch, minCover = LIMIT_MIN_COVER): { sketch: Sketch; changed: string[] } {
  const changed: string[] = [];
  const roads = sk.roads.map(r => {
    const t = m.roads.get(r.id);
    if (!t || t.free === null || t.cover < minCover) return r;
    const kmh = Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, Math.round(t.free / LIMIT_STEP) * LIMIT_STEP));
    if (kmh === (r.speed ?? sk.traffic?.speed)) return r;
    changed.push(r.id);
    return { ...r, speed: kmh };
  });
  return { sketch: changed.length ? { ...sk, roads } : sk, changed };
}

/** how congested, by the share of the free-flow speed driven now: its colour on the map (as TomTom's and Google's) */
export const TRAFFIC_BANDS: { below: number; color: string; label: string }[] = [
  { below: 0.25, color: "#8b1a1a", label: "under 25%" },
  { below: 0.5, color: "#e03131", label: "25–50%" },
  { below: 0.75, color: "#f08c00", label: "50–75%" },
  { below: 0.9, color: "#fab005", label: "75–90%" },
  { below: Infinity, color: "#2f9e44", label: "90% and more" },
];
export const TRAFFIC_CLOSED = "#212529";
/** a lane TomTom has no road for */
export const TRAFFIC_NO_DATA = "#adb5bd";
export const trafficColor = (t: LaneTraffic) => (t.closed ? TRAFFIC_CLOSED : t.rel === null ? null : TRAFFIC_BANDS.find(b => t.rel! < b.below)!.color);
