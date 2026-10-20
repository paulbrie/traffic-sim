/**
 * Live traffic from TomTom (ticket #33), without the network:
 * - decodeFlowTile on a vector tile encoded here (the "Traffic flow" layer as TomTom's: lines, string / float / bool
 *   values, two lines in one feature, another layer skipped): points back in latitude / longitude, values and tags kept;
 * - matchTraffic on a two-way road placed on the map: a one-way line each way gives each lane its own speed, a both-ways
 *   line both lanes, a line 30 m off or across the road neither; free-flow speed = speed / share; coverage per road;
 * - freeFlowLimits: rounded to 5 km/h, roads covered too little left alone, the same speed not counted as a change;
 * - sketchArea and tilesFor round the lanes.
 * npm run tomtom:check
 */
import { decodeFlowTile, freeFlowLimits, matchTraffic, sketchArea, tilesFor, trafficColor, type FlowLine, type TrafficSnapshot } from "../src/lib/tomtom";
import { project, unproject } from "../src/lib/osm/area";
import type { Sketch } from "../src/lib/lane-sketch";

let failed = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failed++; };
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------- a vector tile, encoded by hand
const varint = (n: number): number[] => { const out: number[] = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const field = (f: number, wire: number) => varint(f * 8 + wire);
const bytes = (f: number, b: number[]) => [...field(f, 2), ...varint(b.length), ...b];
const str = (f: number, s: string) => bytes(f, [...new TextEncoder().encode(s)]);
const zz = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);
const float = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return [...field(2, 5), ...b]; };
const packed = (f: number, ns: number[]) => bytes(f, ns.flatMap(varint));
/** lines (tile coordinates) as one feature's geometry commands */
const geom = (lines: [number, number][][]) => { let cx = 0, cy = 0; const out: number[] = [];
  for (const l of lines) l.forEach(([x, y], i) => { if (i === 0) out.push(1 | (1 << 3)); else if (i === 1) out.push(2 | ((l.length - 1) << 3)); out.push(zz(x - cx), zz(y - cy)); cx = x; cy = y; });
  return out; };
const KEYS = ["traffic_level", "road_category", "traffic_road_coverage", "road_closure"];
const VALUES = [float(42.5), str(1, "secondary"), str(1, "one_side"), [...field(7, 0), 1], float(0.5), str(1, "full")];
const feature = (tags: number[], lines: [number, number][][]) => bytes(2, [...packed(2, tags), ...field(3, 0), 2, ...packed(4, geom(lines))]);
const layer = (name: string, feats: number[][]) => bytes(3, [...field(15, 0), 2, ...str(1, name), ...feats.flat(), ...KEYS.flatMap(k => str(3, k)), ...VALUES.flatMap(v => bytes(4, v)), ...field(5, 0), ...varint(4096)]);
const tile = new Uint8Array([
  ...layer("Something else", [feature([0, 0], [[[0, 0], [10, 10]]])]),
  ...layer("Traffic flow", [
    feature([0, 0, 1, 1, 2, 2], [[[0, 0], [4096, 4096]]]),
    feature([0, 4, 1, 1, 2, 5, 3, 3], [[[100, 200], [300, 200], [300, 400]], [[1000, 1000], [2000, 1000]]]),
  ]),
]);
const z = 15, tx = 18613, ty = 11506, lines = decodeFlowTile(tile, z, tx, ty);
const lonOf = (x: number) => (x / 2 ** z) * 360 - 180, latOf = (y: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z)));
ok(lines.length === 3, `decoded 3 lines from the "Traffic flow" layer only (${lines.length})`);
ok(near(lines[0].pts[0][0], latOf(ty), 1e-6) && near(lines[0].pts[0][1], lonOf(tx), 1e-6) && near(lines[0].pts[1][0], latOf(ty + 1), 1e-6) && near(lines[0].pts[1][1], lonOf(tx + 1), 1e-6), "the tile's corners at their latitude / longitude");
ok(near(lines[0].v, 42.5, 1e-4) && lines[0].cls === "secondary" && lines[0].oneSide && !lines[0].closed, "a float value, a category, one side");
ok(lines[1].v === 0.5 && !lines[1].oneSide && lines[1].closed === true && lines[1].pts.length === 3 && lines[2].pts.length === 2, "two lines in one feature, both ways, closed");
ok(near(lines[2].pts[0][1], lonOf(tx + 1000 / 4096), 1e-6), "the second line's points relative to the first's (the cursor carries on)");

// ---------------------------------------------------------------- matching onto a sketch
const geo = { lat: 47.1349, lon: 24.4962 };
const ll = (x: number, y: number): [number, number] => { const g = unproject(geo, { x, y }); return [g.lat, g.lon]; };
// (a two-way road along x, 400 m: l1 eastbound at y = 1.75, l2 westbound at y = -1.75; a side street across it, its own road)
const sk: Sketch = {
  lanes: [
    { id: "l1", width: 3.5, shape: { kind: "line", pts: [{ x: 0, y: 1.75 }, { x: 400, y: 1.75 }] } },
    { id: "l2", width: 3.5, shape: { kind: "line", pts: [{ x: 400, y: -1.75 }, { x: 0, y: -1.75 }] } },
    { id: "l3", width: 3.5, shape: { kind: "line", pts: [{ x: 200, y: 5 }, { x: 200, y: 200 }] } },
    { id: "l4", width: 2, bike: true, shape: { kind: "line", pts: [{ x: 0, y: 4 }, { x: 400, y: 4 }] } },
  ],
  connectors: [], junctions: [],
  roads: [{ id: "r1", name: "Main", lanes: ["l1", "l2", "l4"] }, { id: "r2", name: "Side", lanes: ["l3"], speed: 30 }],
  traffic: { rate: 50, speed: 50 }, geo,
};
const line = (pts: [number, number][], v: number, oneSide: boolean): FlowLine => ({ pts: pts.map(([x, y]) => ll(x, y)), v, cls: "secondary", oneSide });
// (TomTom's line down the road's middle; one way each, or both; the side street's 30 m off its lane)
const snap = (speeds: FlowLine[], ratios: FlowLine[]): TrafficSnapshot => ({ at: "", area: { south: 0, west: 0, north: 0, east: 0 }, speeds, ratios });
let m = matchTraffic(sk, snap(
  [line([[0, 0], [400, 0]], 40, true), line([[400, 0], [0, 0]], 20, true), line([[230, 5], [230, 200]], 30, false)],
  [line([[0, 0], [400, 0]], 0.8, true), line([[400, 0], [0, 0]], 0.4, true)],
))!;
const l1 = m.lanes.get("l1"), l2 = m.lanes.get("l2");
ok(!!l1 && near(l1.kmh!, 40, 0.01) && near(l1.rel!, 0.8, 0.01) && near(l1.free!, 50, 0.1) && near(l1.cover, 1, 0.01), `eastbound lane: its own way's line, 40 km/h at 80%, free flow 50 (${JSON.stringify(l1)})`);
ok(!!l2 && near(l2.kmh!, 20, 0.01) && near(l2.free!, 50, 0.1), `westbound lane: the other way's, 20 km/h, free flow 50 (${JSON.stringify(l2)})`);
ok(!m.lanes.has("l3") && !m.roads.has("r2"), "a line 30 m off the side street isn't matched to it");
ok(!m.lanes.has("l4"), "the bike lane is left out");
ok(near(m.roads.get("r1")!.kmh!, 30, 0.01) && near(m.roads.get("r1")!.cover, 1, 0.01) && near(m.length, 995, 1) && near(m.covered, 800, 1), `the road over its two lanes: 30 km/h, all covered; 800 of the 995 m of lanes covered (${m.covered.toFixed(0)} of ${m.length.toFixed(0)})`);
m = matchTraffic(sk, snap([line([[400, 0], [0, 0]], 35, false), line([[200, -100], [200, 100]], 99, false)], []))!;
ok(near(m.lanes.get("l1")!.kmh!, 35, 0.01) && near(m.lanes.get("l2")!.kmh!, 35, 0.01) && m.lanes.get("l1")!.rel === null && m.lanes.get("l1")!.free === null, "a both-ways line: both lanes, whichever way it's drawn; no share without the relative tiles");
ok(near(m.lanes.get("l1")!.cover, 1, 0.01), "a line across the road isn't matched (its direction)");
m = matchTraffic(sk, snap([line([[0, 0], [100, 0]], 40, true)], [line([[0, 0], [100, 0]], 0.5, true)]))!;
ok(near(m.lanes.get("l1")!.cover, 0.25, 0.02) && near(m.roads.get("r1")!.cover, 0.125, 0.02), "a quarter of a lane covered, an eighth of its road (its other lane not)");

// ---------------------------------------------------------------- speed limits
const full = matchTraffic(sk, snap(
  [line([[0, 0], [400, 0]], 40, true), line([[400, 0], [0, 0]], 20, true), line([[200, 5], [200, 200]], 42, false)],
  [line([[0, 0], [400, 0]], 0.8, true), line([[400, 0], [0, 0]], 0.3, true), line([[200, 5], [200, 200]], 0.7, false)],
))!;
let lim = freeFlowLimits(sk, full);
const r1 = full.roads.get("r1")!.free!, r2 = full.roads.get("r2")!.free!;
ok(lim.sketch.roads.find(r => r.id === "r2")!.speed === 60 && near(r2, 60, 0.1), `the side street: free flow ${r2.toFixed(1)} → 60 km/h`);
ok(near(r1, (50 + 66.67) / 2, 0.2) && lim.sketch.roads.find(r => r.id === "r1")!.speed === 60, `the main road: free flow ${r1.toFixed(1)} → 60`);
ok(lim.changed.length === 2 && sk.roads[0].speed === undefined, "two roads changed, the sketch given left as it was");
lim = freeFlowLimits(lim.sketch, full);
ok(lim.changed.length === 0 && lim.sketch === lim.sketch, "again: nothing changes");
lim = freeFlowLimits(sk, m);
ok(lim.changed.length === 0, "a road an eighth covered keeps its limit");
ok(trafficColor({ kmh: 10, rel: 0.2, free: 50, cover: 1, closed: false }) === "#8b1a1a" && trafficColor({ kmh: 50, rel: 1, free: 50, cover: 1, closed: false }) === "#2f9e44" && trafficColor({ kmh: 0, rel: 0, free: null, cover: 1, closed: true }) === "#212529", "colours: jammed, free, closed");

// ---------------------------------------------------------------- the area and its tiles
const a = sketchArea(sk)!, sw = project(geo, a.south, a.west), ne = project(geo, a.north, a.east);
ok(near(sw.x, -30, 0.5) && near(ne.x, 430, 0.5) && near(ne.y, -1.75 - 30, 0.5) && near(sw.y, 230, 0.5), `the area: the lanes plus 30 m (${sw.x.toFixed(1)}, ${ne.y.toFixed(1)} – ${ne.x.toFixed(1)}, ${sw.y.toFixed(1)})`);
ok(sketchArea({ ...sk, geo: undefined }) === null, "no area off the map");
const bistrita = tilesFor({ south: 47.119555, west: 24.464167, north: 47.150391, east: 24.528307 });
ok(bistrita.length === 35 && bistrita.every(t => t.x >= 18610 && t.x <= 18616 && t.y >= 11505 && t.y <= 11509), `Bistrița's plan: 7 × 5 tiles at zoom 15 (${bistrita.length})`);

console.log(failed ? `\n${failed} failed` : "\nall ok");
process.exit(failed ? 1 : 0);
