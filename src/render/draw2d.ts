/** Canvas 2D renderer for the plan view (world units = metres). */
import { connectorHandles, connectorId, connectorPreview, type Compiled, type ConnectorView, type Piece } from "@/engine/compile";
import { DEFAULT_MARKER_COLOR } from "@/engine/markers";
import type { Poly } from "@/engine/geom";
import type { SimMirror as Sim, VehicleView as Vehicle } from "@/engine/sim/mirror";
import type { BuildingDef, BuildingUse, LinkDef, Network, Vec } from "@/engine/types";
import { laneSign, type LaneSign, type RoadGeo, type Strip } from "./geometry";
import { buildingColor, speedColor, type Palette } from "./palette";
import { underlayCorners, type Underlay } from "@/lib/underlay";
import { junctionRefs } from "@/engine/refs";
import { drawSatellite } from "./satellite";

export interface Camera { cx: number; cy: number; scale: number; w: number; h: number; dpr: number }
export const toScreen = (c: Camera, x: number, y: number): Vec => ({ x: (x - c.cx) * c.scale + c.w / 2, y: (y - c.cy) * c.scale + c.h / 2 });
export const toWorld = (c: Camera, sx: number, sy: number): Vec => ({ x: (sx - c.w / 2) / c.scale + c.cx, y: (sy - c.h / 2) / c.scale + c.cy });

/** everything drawn for one elevation level */
export interface LayerPaths {
  level: number;
  /** where the roads of this level are off the ground: their shadow, cast further the higher they are */
  shadow: Path2D;
  /** roads (layer "roads"): surface, kerb, islands and medians, centre lines and hatching */
  curb: Path2D; asphalt: Path2D; island: Path2D; islandEdge: Path2D; centerDash: Path2D; centerSolid: Path2D; hatch: Path2D;
  /** lanes (layer "lanes"): lane lines, bus lanes, lane arrows */
  bus: Path2D; laneDash: Path2D; laneSolid: Path2D; arrows: Path2D;
  /** junctions (layer "junctions"): their area, roundabout islands, zebras, stop and give-way lines, turn guides */
  jCurb: Path2D; jAsphalt: Path2D; jIsland: Path2D; jIslandEdge: Path2D; guide: Path2D; zebra: Path2D; stopLine: Path2D; yieldLine: Path2D;
}
/** which of the layers drawn into the cached road images are on */
export interface RoadLayers { roads: boolean; lanes: boolean; junctions: boolean }
export interface PathCache {
  /** lowest level first: drawn in this order, so bridges cover what passes beneath */
  layers: LayerPaths[];
  linkPaths: Map<string, Path2D>;
}

/** how far a road one level up casts its shadow (m, sun from the upper left) */
const SHADOW = { x: 1.2, y: 1.8 };
/** a road's outline moved by its shadow offset, point by point by its height there (none where it is on the ground) */
function shadowStrip(p: Path2D, s: Strip, z: Float32Array) {
  const L = s.left.pts, R = s.right.pts, n = Math.min(L.length, R.length) / 2;
  const at = (a: Float64Array, k: number) => [a[2 * k] + SHADOW.x * z[Math.min(k, z.length - 1)], a[2 * k + 1] + SHADOW.y * z[Math.min(k, z.length - 1)]] as const;
  p.moveTo(...at(L, 0));
  for (let k = 1; k < n; k++) p.lineTo(...at(L, k));
  for (let k = n - 1; k >= 0; k--) p.lineTo(...at(R, k));
  p.closePath();
}

const polyPath = (p: Path2D, poly: Poly) => {
  const a = poly.pts;
  p.moveTo(a[0], a[1]);
  for (let k = 2; k < a.length; k += 2) p.lineTo(a[k], a[k + 1]);
};
const stripPath = (p: Path2D, s: Strip) => {
  const L = s.left.pts, R = s.right.pts;
  p.moveTo(L[0], L[1]);
  for (let k = 2; k < L.length; k += 2) p.lineTo(L[k], L[k + 1]);
  for (let k = R.length - 2; k >= 0; k -= 2) p.lineTo(R[k], R[k + 1]);
  p.closePath();
};

function arrowGlyph(p: Path2D, at: Vec, d: Vec, turns: string) {
  // local frame: forward = d, right = r
  const r = { x: -d.y, y: d.x };
  const P = (f: number, s: number) => ({ x: at.x + d.x * f + r.x * s, y: at.y + d.y * f + r.y * s });
  const seg = (pts: [number, number][]) => { const a = P(...pts[0]); p.moveTo(a.x, a.y); for (const q of pts.slice(1)) { const b = P(...q); p.lineTo(b.x, b.y); } };
  seg([[-2.2, 0], [0.4, 0]]);
  if (turns.includes("S")) { seg([[0.4, 0], [2.2, 0]]); seg([[1.3, -0.55], [2.2, 0], [1.3, 0.55]]); }
  if (turns.includes("L") || turns.includes("U")) { seg([[0.4, 0], [1.3, -0.9]]); seg([[0.55, -1.0], [1.3, -0.9], [1.25, -0.2]]); }
  if (turns.includes("R")) { seg([[0.4, 0], [1.3, 0.9]]); seg([[0.55, 1.0], [1.3, 0.9], [1.25, 0.2]]); }
}

export function buildPaths(geo: RoadGeo): PathCache {
  const byLevel = new Map<number, LayerPaths>();
  const L = (on: { lv: number }) => {
    let c = byLevel.get(on.lv);
    if (!c) byLevel.set(on.lv, (c = {
      level: on.lv, shadow: new Path2D(), curb: new Path2D(), asphalt: new Path2D(), island: new Path2D(), islandEdge: new Path2D(), bus: new Path2D(),
      laneDash: new Path2D(), laneSolid: new Path2D(), centerDash: new Path2D(), centerSolid: new Path2D(), hatch: new Path2D(), guide: new Path2D(), zebra: new Path2D(),
      stopLine: new Path2D(), yieldLine: new Path2D(), arrows: new Path2D(), jCurb: new Path2D(), jAsphalt: new Path2D(), jIsland: new Path2D(), jIslandEdge: new Path2D(),
    }));
    return c;
  };
  const linkPaths = new Map<string, Path2D>();
  const poly = (p: Path2D, pts: Vec[]) => { p.moveTo(pts[0].x, pts[0].y); for (const q of pts.slice(1)) p.lineTo(q.x, q.y); p.closePath(); };
  for (const s of geo.surfaces) {
    const c = L(s.on);
    stripPath(c.curb, s.curb); stripPath(c.asphalt, s.asphalt);
    if (s.z.some(z => z > 0.01)) shadowStrip(c.shadow, s.curb, s.z);
    const lp = new Path2D(); stripPath(lp, s.curb); linkPaths.set(s.linkId, lp);
  }
  for (const j of geo.junctions) {
    const c = L(j.on);
    // kerb out to the roads' kerb edge, asphalt inside it, so the white edge runs on unbroken
    if (j.polygon.length >= 3) {
      poly(c.jAsphalt, j.surface.length >= 3 ? j.surface : j.polygon); poly(c.jCurb, j.polygon);
      if (j.on.lv > 0) poly(c.shadow, j.polygon.map(p => ({ x: p.x + SHADOW.x * j.on.lv, y: p.y + SHADOW.y * j.on.lv })));
    }
    if (j.ring) {
      c.jAsphalt.moveTo(j.ring.c.x + j.ring.r + 2.4, j.ring.c.y); c.jAsphalt.arc(j.ring.c.x, j.ring.c.y, j.ring.r + 2.4, 0, Math.PI * 2);
      c.jCurb.moveTo(j.ring.c.x + j.ring.r + 3, j.ring.c.y); c.jCurb.arc(j.ring.c.x, j.ring.c.y, j.ring.r + 3, 0, Math.PI * 2);
      const ir = Math.max(2, (j.ring.r2 ?? j.ring.r) - 2.4);
      c.jIsland.moveTo(j.ring.c.x + ir, j.ring.c.y); c.jIsland.arc(j.ring.c.x, j.ring.c.y, ir, 0, Math.PI * 2);
      c.jIslandEdge.moveTo(j.ring.c.x + ir, j.ring.c.y); c.jIslandEdge.arc(j.ring.c.x, j.ring.c.y, ir, 0, Math.PI * 2);
    }
    if (j.deadEnd) {
      c.jAsphalt.moveTo(j.deadEnd.c.x + j.deadEnd.r, j.deadEnd.c.y); c.jAsphalt.arc(j.deadEnd.c.x, j.deadEnd.c.y, j.deadEnd.r, 0, Math.PI * 2);
      c.jCurb.moveTo(j.deadEnd.c.x + j.deadEnd.r + 0.6, j.deadEnd.c.y); c.jCurb.arc(j.deadEnd.c.x, j.deadEnd.c.y, j.deadEnd.r + 0.6, 0, Math.PI * 2);
    }
  }
  for (const b of geo.busBands) stripPath(L(b.on).bus, b);
  // raised medians are kerbed islands; painted ones are just their lines and hatching
  for (const m of geo.medians) if (m.kind === "raised") { const c = L(m.on); stripPath(c.island, m.strip); stripPath(c.islandEdge, m.strip); }
  for (const isl of geo.islands) { const c = L(isl.on); poly(c.island, isl.pts); poly(c.islandEdge, isl.pts); }
  for (const z of geo.zebras) poly(L(z.on).zebra, z.pts);
  for (const l of geo.lines) { const c = L(l.on); polyPath(l.kind === "guide" ? c.guide : l.kind === "hatch" ? c.hatch : l.kind === "center" ? (l.dashed ? c.centerDash : c.centerSolid) : l.dashed ? c.laneDash : c.laneSolid, l.poly); }
  for (const s of geo.stopLines) { const c = L(s.on), p = s.kind === "yield" ? c.yieldLine : c.stopLine; p.moveTo(s.a.x, s.a.y); p.lineTo(s.b.x, s.b.y); }
  for (const a of geo.arrows) arrowGlyph(L(a.on).arrows, a.p, a.dir, a.turns);
  return { layers: [...byLevel.values()].sort((a, b) => a.level - b.level), linkPaths };
}

export interface Overlay {
  /** drawing a lane connector: where it starts, the lanes it may end in, the pointer */
  /**
   * Drawing or moving a lane connector: the fixed end, the lanes it may go to (with the points it would attach
   * at), the one it would snap to now, and the pointer.
   */
  connectPick?: { from: Vec; targets: ArrayLike<number>[]; ends?: Vec[]; snap?: Vec | null; cursor: Vec | null } | null;
  /** junction editor: the outline being edited (its points), a painted area being drawn, the pointer */
  shape?: { outline: Vec[] | null; paint: Vec[] | null; cursor: Vec | null };
  selection: { kind: string; id: string } | null;
  hover: { kind: "node" | "link" | "stop" | "handle"; id: string } | null;
  showNodes: boolean;
  draft: { from: Vec; to: Vec; lanes: number; label: string; c1?: Vec; c2?: Vec } | null;
  pendingPoint: Vec | null;
  reservations: boolean;
  bySpeed: boolean;
  labels: boolean;
  snapStep: number;
  gridOn: boolean;
  underlay: { u: Underlay; img: HTMLImageElement | null; editing: boolean; hover: UnderlayHandle | null } | null;
  calib: { a: Vec | null; b: Vec | null; cursor: Vec | null } | null;
  /** junction references and live stats on the map */
  junctions: boolean;
  /** extra links to highlight with the selection (segment tool, whole-road scope) */
  alsoSelected: string[];
  buildings: boolean;
  /** draw satellite imagery under the plan (plans with a known location); `onTile` redraws when tiles arrive */
  satellite: boolean;
  /** imagery brightness, 0.3–1 (dimmer imagery lets the roads and traffic stand out) */
  satBrightness?: number;
  onTile?: () => void;
  /** draw every lane connector through the junctions */
  connectors: boolean;
  /** junctions (node indexes) whose connectors are drawn anyway: the one selected, or of a selected lane / connector */
  focusNodes?: readonly number[];
  /** lane ends a connector can be started from (click or drag from them), marked when zoomed in */
  laneEnds?: readonly Vec[];
  /** picking a transit flow's exit: the exit points it can go to (each marked with a target), and the one it goes to now */
  exitPick?: { targets: readonly Vec[]; current: Vec | null } | null;
  /** markers selected (by id): drawn with a ring */
  markersSel?: readonly string[];
  /** a selection box being dragged (Shift+drag), world coordinates */
  box?: { a: Vec; b: Vec } | null;
  /** more objects selected with the main selection (Shift+click, a box): highlighted like it */
  group?: { links: readonly string[]; nodes: readonly Vec[]; stops: readonly Vec[]; buildings: readonly (readonly Vec[])[]; connectors: readonly ArrayLike<number>[] } | null;
  /** layers whose objects are highlighted (lane outlines, connectors, rings around junctions…) */
  highlight: readonly string[];
  /** layers that are on: only their objects are drawn (see LAYERS; none = just the background) */
  show: readonly string[];
  /** roads as thin outlines only (no surface, markings or names), to see the map or image under them */
  maskRoads?: boolean;
  /** the route tracer's route, as x, y points */
  trace?: number[] | null;
}

const connectorCache = new WeakMap<Compiled, ConnectorView[]>();
export function connectorsOf(c: Compiled) {
  let list = connectorCache.get(c);
  if (!list) connectorCache.set(c, (list = connectorPreview(c)));
  return list;
}

/** building footprints as one path per use, cached per buildings array (it only changes on edits) */
const buildingCache = new WeakMap<BuildingDef[], { fills: Map<BuildingUse, Path2D>; edges: Path2D }>();
function buildingPaths(list: BuildingDef[]) {
  let c = buildingCache.get(list);
  if (!c) {
    c = { fills: new Map(), edges: new Path2D() };
    for (const b of list) {
      let f = c.fills.get(b.use); if (!f) c.fills.set(b.use, (f = new Path2D()));
      const p = new Path2D();
      p.moveTo(b.pts[0].x, b.pts[0].y);
      for (let i = 1; i < b.pts.length; i++) p.lineTo(b.pts[i].x, b.pts[i].y);
      p.closePath();
      f.addPath(p); c.edges.addPath(p);
    }
    buildingCache.set(list, c);
  }
  return c;
}

function drawBuildings(ctx: CanvasRenderingContext2D, pal: Palette, list: BuildingDef[], px: number) {
  const c = buildingPaths(list);
  for (const [use, path] of c.fills) { ctx.fillStyle = buildingColor(pal, use); ctx.fill(path); }
  ctx.strokeStyle = pal.buildingEdge; ctx.lineWidth = Math.max(0.15, px); ctx.lineJoin = "miter";
  ctx.stroke(c.edges);
}

/** selected building: outline, and a dashed line to where its traffic joins the road */
function drawBuildingSelection(ctx: CanvasRenderingContext2D, pal: Palette, compiled: Compiled, b: BuildingDef, px: number) {
  ctx.beginPath();
  ctx.moveTo(b.pts[0].x, b.pts[0].y);
  for (let i = 1; i < b.pts.length; i++) ctx.lineTo(b.pts[i].x, b.pts[i].y);
  ctx.closePath();
  ctx.globalAlpha = 0.22; ctx.fillStyle = pal.select; ctx.fill(); ctx.globalAlpha = 1;
  ctx.strokeStyle = pal.select; ctx.lineWidth = px * 2.5; ctx.stroke();
  const place = compiled.places.find(p => p.building.id === b.id);
  if (!place) return;
  ctx.setLineDash([px * 5, px * 4]); ctx.lineWidth = px * 2;
  ctx.beginPath(); ctx.moveTo(place.door.x, place.door.y); ctx.lineTo(place.road.x, place.road.y); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = pal.select;
  ctx.beginPath(); ctx.arc(place.road.x, place.road.y, px * 4.5, 0, Math.PI * 2); ctx.fill();
}

export type UnderlayHandle = "move" | "rotate" | "c0" | "c1" | "c2" | "c3";

/** screen positions of the underlay's corner handles and rotate knob */
export function underlayHandles(cam: Camera, u: Underlay) {
  const corners = underlayCorners(u).map(p => toScreen(cam, p.x, p.y));
  const top = { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 };
  const c = toScreen(cam, u.x, u.y);
  const d = Math.hypot(top.x - c.x, top.y - c.y) || 1;
  const rotate = { x: top.x + ((top.x - c.x) / d) * 28, y: top.y + ((top.y - c.y) / d) * 28 };
  return { corners, top, rotate, center: c };
}

/** the static part of the picture: ground, imagery, grid, reference image, buildings, roads by level */
interface Background { key: string; stale: boolean; base: HTMLCanvasElement; layers: HTMLCanvasElement[] }
const backgrounds = new WeakMap<CanvasRenderingContext2D, Background>();
const objIds = new WeakMap<object, number>();
let nextObjId = 1;
const idOf = (o: object | null | undefined) => { if (!o) return 0; let k = objIds.get(o); if (!k) objIds.set(o, (k = nextObjId++)); return k; };
function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h; return c;
}
/** draw an image of the whole view (in device pixels) over the world-transformed context */
function blit(ctx: CanvasRenderingContext2D, img: HTMLCanvasElement | undefined, dpr: number, scale: number, w: number, h: number, cam: Camera) {
  if (!img) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(img, 0, 0);
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (w / 2 - cam.cx * scale), dpr * (h / 2 - cam.cy * scale));
}
const roadLayers = (ov: Overlay): RoadLayers => ({ roads: ov.show.includes("roads"), lanes: ov.show.includes("lanes"), junctions: ov.show.includes("junctions") });
function background(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, paths: PathCache, net: Network, ov: Overlay): Background {
  const { w, h, dpr } = cam, W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  const ul = ov.underlay?.u.visible && ov.underlay.img ? ov.underlay : null;
  const key = [cam.cx, cam.cy, cam.scale, W, H, dpr, idOf(paths), idOf(pal), ov.buildings ? idOf(net.buildings) : 0, ov.satellite ? idOf(net.geo) : 0,
    ov.satBrightness ?? 1, ov.gridOn ? ov.snapStep : 0, ov.maskRoads ? 1 : 0, ov.show.join("+"),
    ul ? [idOf(ul.img), ul.u.x, ul.u.y, ul.u.rot, ul.u.mpp, ul.u.opacity, ul.u.w, ul.u.h].join(":") : 0].join(",");
  let bg = backgrounds.get(ctx);
  if (bg && bg.key === key && !bg.stale) return bg;
  if (!bg || bg.base.width !== W || bg.base.height !== H) { bg = { key: "", stale: false, base: makeCanvas(W, H), layers: [] }; backgrounds.set(ctx, bg); }
  const b = bg;
  b.key = key; b.stale = false;
  const onTile = () => { b.stale = true; ov.onTile?.(); };
  const g = b.base.getContext("2d")!;
  paintBase(g, cam, pal, paths, net, ov, onTile);
  // roads above the lowest level: each on its own transparent image, so vehicles go in between
  const levels = ov.maskRoads ? [] : paths.layers;
  for (let i = 1; i < levels.length; i++) {
    const c = (b.layers[i] = b.layers[i]?.width === W && b.layers[i]?.height === H ? b.layers[i] : makeCanvas(W, H)), lg = c.getContext("2d")!;
    lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, W, H);
    lg.setTransform(dpr * cam.scale, 0, 0, dpr * cam.scale, dpr * (w / 2 - cam.cx * cam.scale), dpr * (h / 2 - cam.cy * cam.scale));
    paintLevel(lg, levels[i], pal, 1 / cam.scale, cam.scale, roadLayers(ov));
  }
  b.layers.length = Math.max(1, levels.length);
  return b;
}
function paintBase(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, paths: PathCache, net: Network, ov: Overlay, onTile: () => void) {
  const { w, h, dpr, scale } = cam;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, w, h);
  if (ov.satellite && net.geo) {
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (w / 2 - cam.cx * scale), dpr * (h / 2 - cam.cy * scale));
    const a = toWorld(cam, 0, 0), b = toWorld(cam, w, h);
    drawSatellite(ctx, net.geo, { minX: a.x, minY: a.y, maxX: b.x, maxY: b.y }, scale * dpr, onTile);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dim = 1 - (ov.satBrightness ?? 1);
    if (dim > 0.005) { ctx.fillStyle = `rgba(0,0,0,${dim.toFixed(3)})`; ctx.fillRect(0, 0, w, h); }
  }
  drawGrid(ctx, cam, pal, ov);

  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (w / 2 - cam.cx * scale), dpr * (h / 2 - cam.cy * scale));
  const px = 1 / scale;
  // reference image underlay
  const ul = ov.underlay;
  if (ul && ul.u.visible && ul.img) {
    const u = ul.u;
    ctx.save();
    ctx.translate(u.x, u.y); ctx.rotate((u.rot * Math.PI) / 180); ctx.scale(u.mpp, u.mpp);
    ctx.globalAlpha = u.opacity;
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = scale * u.mpp < 1 ? "high" : "low";
    ctx.drawImage(ul.img, -u.w / 2, -u.h / 2, u.w, u.h);
    ctx.restore();
  }
  if (ov.buildings && ov.show.includes("buildings") && net.buildings?.length) {
    // over satellite imagery, footprints are see-through so the photo still shows
    if (ov.satellite && net.geo) ctx.globalAlpha = 0.4;
    drawBuildings(ctx, pal, net.buildings, px);
    ctx.globalAlpha = 1;
  }
  if (ov.maskRoads) {
    // just the outline of each road, so what is underneath (imagery, reference image) shows
    if (!ov.show.includes("roads")) return;
    ctx.strokeStyle = "#22d3ee"; ctx.globalAlpha = 0.85; ctx.lineWidth = px * 1.2; ctx.lineJoin = "round";
    for (const p of paths.linkPaths.values()) ctx.stroke(p);
    ctx.globalAlpha = 1;
  } else if (paths.layers.length) {
    paintLevel(ctx, paths.layers[0], pal, px, scale, roadLayers(ov));
  }
}
/** one level's roads, junctions and markings (only the layers that are on) */
function paintLevel(ctx: CanvasRenderingContext2D, c: LayerPaths, pal: Palette, px: number, scale: number, show: RoadLayers) {
  const { roads: R, lanes: Ln, junctions: J } = show;
  if (!R && !Ln && !J) return;
  if (R || J) { ctx.fillStyle = "rgba(0,0,0,0.28)"; ctx.fill(c.shadow, "nonzero"); }
  // below ground (tunnels, underpasses): faded
  const a0 = c.level < 0 ? 0.55 : 1;
  ctx.globalAlpha = a0;
  ctx.fillStyle = pal.curb; if (R) ctx.fill(c.curb, "nonzero"); if (J) ctx.fill(c.jCurb, "nonzero");
  ctx.fillStyle = pal.asphalt; if (R) ctx.fill(c.asphalt, "nonzero"); if (J) ctx.fill(c.jAsphalt, "nonzero");
  if (Ln) { ctx.fillStyle = pal.bus; ctx.fill(c.bus); }
  ctx.fillStyle = pal.island; if (R) ctx.fill(c.island); if (J) ctx.fill(c.jIsland);
  ctx.strokeStyle = pal.curb; ctx.lineWidth = 0.6; if (R) ctx.stroke(c.islandEdge); if (J) ctx.stroke(c.jIslandEdge);
  ctx.lineCap = "butt";
  if (Ln) {
    ctx.strokeStyle = pal.mark; ctx.lineWidth = Math.max(0.15, px * 1); ctx.setLineDash([3, 4]); ctx.stroke(c.laneDash);
    ctx.setLineDash([]); ctx.lineWidth = Math.max(0.2, px * 1.2); ctx.stroke(c.laneSolid);
  }
  if (R) {
    ctx.strokeStyle = pal.divider; ctx.lineWidth = Math.max(0.15, px * 1); ctx.setLineDash([3, 4]); ctx.stroke(c.centerDash);
    ctx.setLineDash([]); ctx.stroke(c.centerSolid);
    ctx.strokeStyle = pal.mark; ctx.globalAlpha = 0.75 * a0; ctx.lineWidth = Math.max(0.12, px * 0.8); ctx.stroke(c.hatch); ctx.globalAlpha = a0;
  }
  if (J) {
    if (scale > 1.2) {
      ctx.fillStyle = pal.mark; ctx.globalAlpha = 0.85 * a0; ctx.fill(c.zebra);
      ctx.strokeStyle = pal.mark; ctx.globalAlpha = 0.55 * a0; ctx.lineWidth = Math.max(0.12, px * 0.8); ctx.setLineDash([1, 1.6]); ctx.stroke(c.guide); ctx.setLineDash([]); ctx.globalAlpha = a0;
    }
    ctx.strokeStyle = pal.mark; ctx.lineWidth = 0.5; ctx.stroke(c.stopLine);
    ctx.setLineDash([0.9, 0.7]); ctx.stroke(c.yieldLine); ctx.setLineDash([]);
  }
  if (Ln && scale > 1) { ctx.strokeStyle = pal.mark; ctx.lineWidth = Math.max(0.22, px * 1.1); ctx.lineJoin = "round"; ctx.stroke(c.arrows); }
  ctx.globalAlpha = 1;
}

/**
 * LED lane signs over each lane of a reversible corridor's roads, for each direction: a green arrow
 * (open), a red X (closed) or a yellow arrow slanting toward the lane beside (move over: closing).
 */
function drawLaneSigns(ctx: CanvasRenderingContext2D, pal: Palette, geo: RoadGeo, sim: Sim | null, px: number) {
  for (const g of geo.gantries) {
    const state = sim?.rev[g.corr]?.state;
    for (const s of g.signs) drawLaneSign(ctx, pal, s.p, g.dir, laneSign(state, g.cdir, g.entry, s.rev), 2.2, px);
  }
}
function drawLaneSign(ctx: CanvasRenderingContext2D, pal: Palette, p: Vec, t: Vec, sign: LaneSign, S: number, px: number) {
  ctx.save();
  ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(t.y, t.x));
  // (in this frame +x is the way traffic goes, +y its right)
  const h = S / 2;
  ctx.fillStyle = "#111827"; ctx.fillRect(-h, -h, S, S);
  ctx.lineWidth = Math.max(S * 0.14, px * 1.5); ctx.lineCap = "round"; ctx.lineJoin = "round";
  const k = S * 0.3;
  ctx.beginPath();
  if (sign === "closed") {
    ctx.strokeStyle = pal.stop;
    ctx.moveTo(-k, -k); ctx.lineTo(k, k); ctx.moveTo(-k, k); ctx.lineTo(k, -k);
  } else if (sign === "open") {
    ctx.strokeStyle = pal.go;
    ctx.moveTo(-k, 0); ctx.lineTo(k, 0); ctx.moveTo(k * 0.2, -k * 0.75); ctx.lineTo(k, 0); ctx.lineTo(k * 0.2, k * 0.75);
  } else {
    // slanting forward and to the right: into the fixed lane beside
    ctx.strokeStyle = pal.slow;
    ctx.moveTo(-k, -k); ctx.lineTo(k, k); ctx.moveTo(k * 0.05, k); ctx.lineTo(k, k); ctx.lineTo(k, k * 0.05);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawScene(
  ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, geo: RoadGeo, paths: PathCache,
  net: Network, compiled: Compiled, sim: Sim | null, ov: Overlay,
) {
  const { w, h, dpr, scale } = cam;
  /** is this layer on (drawn) */
  const on = (l: string) => ov.show.includes(l), showVehicles = !!sim && on("vehicles");
  // everything that doesn't move comes from cached images, redrawn only when the view or the plan changes
  const bg = background(ctx, cam, pal, paths, net, ov);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bg.base, 0, 0);

  // world transform
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (w / 2 - cam.cx * scale), dpr * (h / 2 - cam.cy * scale));
  const px = 1 / scale; // one screen pixel in metres
  // what is on screen (with a margin for vehicles straddling the edge)
  const tl = toWorld(cam, 0, 0), br = toWorld(cam, w, h), m = 20;
  const view = { minX: tl.x - m, minY: tl.y - m, maxX: br.x + m, maxY: br.y + m };
  const ul = ov.underlay;

  if (ov.maskRoads) {
    // (the road outlines are in the background image)
  } else {
    // level by level, lowest first: a bridge (with its shadow) covers the roads and traffic beneath.
    // The roads come from the background images (bg.layers[0] is in the base image already).
    let prev = -Infinity;
    paths.layers.forEach((c, i) => {
      if (i > 0) blit(ctx, bg.layers[i], dpr, scale, w, h, cam);
      const a0 = c.level < 0 ? 0.55 : 1;
      if (sim && showVehicles) { const lo = prev; drawVehicles(ctx, pal, sim, ov.bySpeed, px, v => v.level > lo && v.level <= c.level, a0, view); }
      prev = c.level;
    });
    if (sim && showVehicles) { const lo = prev; drawVehicles(ctx, pal, sim, ov.bySpeed, px, v => v.level > lo, 1, view); }
  }

  const allConnectors = ov.connectors || ov.highlight.includes("connectors");
  if ((allConnectors || ov.focusNodes?.length) && on("connectors")) {
    const focus = allConnectors ? null : new Set(ov.focusNodes);
    const list = focus ? connectorsOf(compiled).filter(c => focus.has(c.node.idx)) : connectorsOf(compiled);
    ctx.strokeStyle = "#e8c547"; ctx.globalAlpha = 0.9; ctx.lineWidth = Math.max(0.18, px * 1.2); ctx.lineCap = "round";
    ctx.beginPath();
    for (const { pts } of list) { ctx.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  // selection highlight under traffic
  if (ov.selection?.kind === "link") {
    for (const id of [ov.selection.id, ...ov.alsoSelected]) {
      const p = paths.linkPaths.get(id);
      if (p) { ctx.strokeStyle = pal.select; ctx.lineWidth = px * 3; ctx.stroke(p); ctx.globalAlpha = id === ov.selection.id ? 0.14 : 0.08; ctx.fillStyle = pal.select; ctx.fill(p); ctx.globalAlpha = 1; }
    }
    drawTravelArrows(ctx, pal, compiled, [ov.selection.id, ...ov.alsoSelected], px);
  }
  if (ov.hover?.kind === "link" && ov.selection?.id !== ov.hover.id) {
    const p = paths.linkPaths.get(ov.hover.id);
    if (p) { ctx.strokeStyle = pal.select; ctx.globalAlpha = 0.6; ctx.lineWidth = px * 1.5; ctx.stroke(p); ctx.globalAlpha = 1; }
  }

  if (ov.trace && ov.trace.length >= 4) {
    // the traced route: a wide band along it, with an arrowhead where it leaves the plan
    const t = ov.trace, n = t.length;
    ctx.strokeStyle = pal.select; ctx.globalAlpha = 0.45; ctx.lineWidth = Math.max(4, px * 9); ctx.lineCap = "round"; ctx.lineJoin = "round";
    strokePts(ctx, t); ctx.globalAlpha = 1;
    const dx = t[n - 2] - t[n - 4], dy = t[n - 1] - t[n - 3], d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d, s = Math.max(4, px * 16);
    ctx.fillStyle = pal.select; ctx.beginPath();
    ctx.moveTo(t[n - 2] + ux * s, t[n - 1] + uy * s); ctx.lineTo(t[n - 2] - uy * s * 0.6, t[n - 1] + ux * s * 0.6); ctx.lineTo(t[n - 2] + uy * s * 0.6, t[n - 1] - ux * s * 0.6); ctx.closePath(); ctx.fill();
  }

  if (ov.selection?.kind === "building") {
    const b = net.buildings?.find(x => x.id === ov.selection!.id);
    if (b) drawBuildingSelection(ctx, pal, compiled, b, px);
  }

  // more objects selected with it
  if (ov.group) {
    const g = ov.group;
    ctx.strokeStyle = pal.select; ctx.fillStyle = pal.select;
    for (const id of g.links) { const p = paths.linkPaths.get(id); if (p) { ctx.lineWidth = px * 3; ctx.stroke(p); ctx.globalAlpha = 0.12; ctx.fill(p); ctx.globalAlpha = 1; } }
    ctx.lineWidth = Math.max(1, px * 4); ctx.lineCap = "round";
    for (const c of g.connectors) strokePts(ctx, c);
    ctx.lineWidth = px * 2.5;
    for (const pts of g.buildings) { ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke(); ctx.globalAlpha = 0.15; ctx.fill(); ctx.globalAlpha = 1; }
    for (const q of [...g.nodes, ...g.stops]) { ctx.beginPath(); ctx.arc(q.x, q.y, Math.max(2.5, px * 9), 0, Math.PI * 2); ctx.stroke(); }
  }
  if (ov.box) {
    const a = ov.box.a, b = ov.box.b;
    ctx.strokeStyle = pal.select; ctx.lineWidth = px * 1.5; ctx.setLineDash([px * 6, px * 4]);
    ctx.strokeRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.setLineDash([]);
    ctx.fillStyle = pal.select; ctx.globalAlpha = 0.08; ctx.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); ctx.globalAlpha = 1;
  }

  // the highlighted layers' objects, and a selected lane or connector
  if (ov.highlight.includes("lanes")) {
    ctx.strokeStyle = "#38bdf8"; ctx.globalAlpha = 0.7; ctx.lineWidth = Math.max(0.2, px * 1.2);
    ctx.beginPath();
    for (const e of compiled.edges) for (const lp of e.lanes) { const q = lp.poly.pts; ctx.moveTo(q[0], q[1]); for (let k = 2; k < q.length; k += 2) ctx.lineTo(q[k], q[k + 1]); }
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (ov.selection?.kind === "lane") {
    const [lid, dir, lane] = ov.selection.id.split("|"), e = compiled.edgeByKey.get(`${lid}:${dir}`), lp = e?.lanes[Number(lane)];
    if (lp) { ctx.strokeStyle = pal.select; ctx.lineWidth = Math.max(1.2, px * 4); ctx.lineCap = "round"; strokePts(ctx, lp.poly.pts); }
  }
  if (ov.selection?.kind === "connector") {
    const c = connectorsOf(compiled).find(x => connectorId(x) === ov.selection!.id);
    if (c) { ctx.strokeStyle = pal.select; ctx.lineWidth = Math.max(1, px * 4); ctx.lineCap = "round"; strokePts(ctx, c.pts); }
  }

  // reservations and selected vehicle route
  if (sim) {
    if (ov.reservations && on("junctions")) {
      ctx.strokeStyle = pal.select; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.1; ctx.lineCap = "round";
      for (const pts of sim.reservations()) {
        ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
        for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    const sv = ov.selection?.kind === "vehicle" ? sim.vehicles.find(v => String(v.id) === ov.selection!.id && !v.dead) : null;
    if (sv) {
      const pts = sim.routeAhead(sv);
      if (pts.length >= 4) {
      ctx.strokeStyle = pal.select; ctx.lineWidth = Math.max(0.6, px * 2); ctx.setLineDash([2, 1.5]);
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]); ctx.stroke();
      ctx.setLineDash([]);
      }
    }
    if (ov.maskRoads && showVehicles) drawVehicles(ctx, pal, sim, ov.bySpeed, px);
    if (sv) {
      const q = sim.pose(sv);
      ctx.strokeStyle = pal.select; ctx.lineWidth = px * 2;
      ctx.beginPath(); ctx.arc((q.fx + q.rx) / 2, (q.fy + q.ry) / 2, Math.max(sv.len * 0.8, px * 12), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // pedestrians: walking across the zebra, or waiting at the kerb
  if (showVehicles && sim && scale > 1.2) for (const n of compiled.nodes) {
    if (!n.peds) continue;
    for (const p of sim.pedView(n.idx)) {
      const a = n.degree === 2 ? n.arms[0] : n.arms[p.arm];
      if (!a) continue;
      const base = n.degree === 2 ? { x: n.pos.x, y: n.pos.y } : { x: a.mouth.x - a.mu.x * 2.1, y: a.mouth.y - a.mu.y * 2.1 };
      const u = n.degree === 2 ? a.u : a.mu, r = { x: -u.y, y: u.x };
      const at = (along: number, across: number) => ({ x: base.x + u.x * along + r.x * across, y: base.y + u.y * along + r.y * across });
      const dots: Vec[] = [];
      for (let i = 0; i < Math.min(p.crossing, 8); i++) dots.push(at(((i % 3) - 1) * 0.7, a.lo + 0.6 + p.progress * (a.hi - a.lo - 1.2) - Math.floor(i / 3) * 0.7));
      for (let i = 0; i < Math.min(p.waiting, 8); i++) dots.push(at(((i % 3) - 1) * 0.7, a.hi + 0.9 + Math.floor(i / 3) * 0.7));
      for (const d of dots) {
        ctx.beginPath(); ctx.arc(d.x, d.y, 0.34, 0, Math.PI * 2);
        ctx.fillStyle = "#f8fafc"; ctx.fill(); ctx.strokeStyle = "#334155"; ctx.lineWidth = Math.max(0.08, px); ctx.stroke();
      }
    }
  }

  // signals & stop signs
  if (on("signals")) for (const s of geo.signals) {
    if (s.kind === "lights") {
      const st = sim ? sim.signalFor(s.nodeIdx, s.arm, s.lane) : null;
      // per-lane heads (custom phases) sit on the lane, just before the stop line, and are smaller
      const R = s.lane === undefined ? 1.25 : 0.8;
      ctx.fillStyle = pal.asphalt; ctx.beginPath(); ctx.arc(s.p.x, s.p.y, R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = st === "green" ? pal.go : st === "yellow" ? pal.slow : st === "red" ? pal.stop : pal.muted;
      ctx.beginPath(); ctx.arc(s.p.x, s.p.y, R * 0.68, 0, Math.PI * 2); ctx.fill();
    } else if (s.kind === "yield") {
      // give-way triangle, point towards the junction the driver faces
      const t = s.dir, r = { x: -t.y, y: t.x }, R = 1.35;
      const tip = { x: s.p.x + t.x * R * 0.9, y: s.p.y + t.y * R * 0.9 };
      const b1 = { x: s.p.x - t.x * R * 0.6 + r.x * R, y: s.p.y - t.y * R * 0.6 + r.y * R }, b2 = { x: s.p.x - t.x * R * 0.6 - r.x * R, y: s.p.y - t.y * R * 0.6 - r.y * R };
      ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(b1.x, b1.y); ctx.lineTo(b2.x, b2.y); ctx.closePath();
      ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.strokeStyle = pal.stop; ctx.lineWidth = 0.35; ctx.lineJoin = "round"; ctx.stroke();
    } else {
      ctx.fillStyle = pal.stop; ctx.beginPath();
      for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k * Math.PI) / 4; ctx.lineTo(s.p.x + Math.cos(a) * 1.1, s.p.y + Math.sin(a) * 1.1); }
      ctx.closePath(); ctx.fill();
    }
  }

  // reversible lanes: the lane signs on their gantries
  if (geo.gantries.length && scale > 1.2 && on("signals")) drawLaneSigns(ctx, pal, geo, sim, px);

  // bus stops
  if (on("stops")) for (const s of geo.stops) {
    const sel = ov.selection?.kind === "stop" && ov.selection.id === s.id;
    ctx.save(); ctx.translate(s.p.x, s.p.y); ctx.rotate(Math.atan2(s.dir.y, s.dir.x));
    ctx.fillStyle = s.color; ctx.fillRect(-2.2, -0.9, 4.4, 1.8);
    if (sel) { ctx.strokeStyle = pal.select; ctx.lineWidth = px * 2.5; ctx.strokeRect(-2.6, -1.3, 5.2, 2.6); }
    ctx.restore();
  }

  // ---- screen-space overlays ----
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (ul && (ul.editing || (ul.u.visible && !ul.img))) drawUnderlayFrame(ctx, cam, pal, ul.u, ul.editing && !ul.u.locked, ul.hover);
  if (ov.junctions && on("junctions")) drawJunctionTags(ctx, cam, pal, compiled, sim);
  if (on("counters")) drawCounters(ctx, cam, pal, net, compiled, sim);
  if (on("markers") && net.markers?.length) drawMarkers(ctx, cam, pal, net, ov.markersSel ?? []);
  if (ov.exitPick) {
    // a target on every exit point the flow can go to, filled on the one it goes to now
    for (const t of ov.exitPick.targets) {
      const q = toScreen(cam, t.x, t.y), cur = !!ov.exitPick.current && Math.hypot(ov.exitPick.current.x - t.x, ov.exitPick.current.y - t.y) < 0.01;
      ctx.strokeStyle = pal.select; ctx.fillStyle = pal.select; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(q.x, q.y, 12, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); if (cur) ctx.fill(); else ctx.stroke();
      ctx.beginPath(); ctx.moveTo(q.x - 17, q.y); ctx.lineTo(q.x - 9, q.y); ctx.moveTo(q.x + 9, q.y); ctx.lineTo(q.x + 17, q.y);
      ctx.moveTo(q.x, q.y - 17); ctx.lineTo(q.x, q.y - 9); ctx.moveTo(q.x, q.y + 9); ctx.lineTo(q.x, q.y + 17); ctx.stroke();
    }
  }
  if (ov.highlight.includes("lanes")) drawLaneIds(ctx, cam, pal, compiled);
  if (ov.selection) drawSelectionIds(ctx, cam, pal, geo, net, compiled, sim, ov.selection, ov.alsoSelected);
  if (ov.selection?.kind === "node") drawFlows(ctx, cam, pal, net, ov.selection.id);
  if (ov.highlight.includes("zones") || ov.selection?.kind === "zone") drawZones(ctx, cam, pal, net, ov.selection?.kind === "zone" ? ov.selection.id : null);
  const hl = (l: string) => ov.highlight.includes(l);
  if (hl("junctions") || hl("signals") || hl("entries")) {
    ctx.strokeStyle = pal.primary; ctx.lineWidth = 2;
    for (const n of compiled.nodes) {
      const on = (hl("entries") && n.gateway) || (hl("signals") && n.controlled && n.def.control === "lights") || (hl("junctions") && n.controlled && n.degree >= 2);
      if (!on) continue;
      const q = toScreen(cam, n.pos.x, n.pos.y);
      ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.stroke();
    }
  }
  if (ov.labels && !ov.maskRoads && scale > 0.35 && on("roads")) drawStreetNames(ctx, cam, pal, geo, net);
  if (ov.labels && scale > 1.1 && on("stops")) {
    ctx.font = `500 11px ${pal.sans}`; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    for (const s of geo.stops) {
      const q = toScreen(cam, s.p.x, s.p.y);
      const tw = ctx.measureText(s.name).width + 10;
      ctx.fillStyle = s.color; roundRect(ctx, q.x - tw / 2, q.y - 24, tw, 16, 4); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.fillText(s.name, q.x, q.y - 10);
    }
  }
  const sel = ov.selection;
  if (ov.showNodes) {
    for (const n of net.nodes) {
      const q = toScreen(cam, n.x, n.y);
      if (q.x < -20 || q.y < -20 || q.x > w + 20 || q.y > h + 20) continue;
      const selected = sel?.kind === "node" && sel.id === n.id, hovered = ov.hover?.kind === "node" && ov.hover.id === n.id;
      const cn = compiled.nodeById.get(n.id);
      // (road ends and joints with the roads; junctions and entry points with their own layers)
      if (!selected && !on("roads") && !(cn && ((on("junctions") && cn.controlled && cn.degree >= 2) || (on("entries") && cn.gateway)))) continue;
      const r = selected || hovered ? 6 : 4.5;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = selected ? pal.select : pal.bg;
      ctx.strokeStyle = selected || hovered ? pal.select : pal.fg;
      ctx.beginPath();
      if (cn?.gateway) ctx.rect(q.x - r, q.y - r, r * 2, r * 2); else ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
    }
  }
  if (sel?.kind === "node") {
    const n = net.nodes.find(x => x.id === sel.id);
    if (n) { const q = toScreen(cam, n.x, n.y); ctx.strokeStyle = pal.select; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(q.x, q.y, 11, 0, Math.PI * 2); ctx.stroke(); }
  }
  if (sel?.kind === "link") {
    const l = net.links.find(x => x.id === sel.id);
    if (l) drawLinkHandles(ctx, cam, pal, net, l, ov.hover?.kind === "handle" ? ov.hover.id : null);
  }
  // drawing a lane connector: the lanes it may end in, and a line from its start to the pointer
  if (ov.laneEnds?.length && !ov.connectPick) {
    ctx.lineWidth = 1.5; ctx.strokeStyle = pal.select; ctx.fillStyle = "#ffffff";
    for (const e of ov.laneEnds) { const q = toScreen(cam, e.x, e.y); ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
  }
  if (ov.connectPick) {
    const cp = ov.connectPick;
    ctx.strokeStyle = pal.select; ctx.lineWidth = 3; ctx.globalAlpha = 0.55; ctx.lineCap = "round";
    for (const pts of cp.targets) { ctx.beginPath(); for (let k = 0; k < pts.length; k += 2) { const q = toScreen(cam, pts[k], pts[k + 1]); if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); } ctx.stroke(); }
    ctx.globalAlpha = 1;
    // where it can attach: a ring at each lane end, the one it would snap to filled
    ctx.lineWidth = 2;
    for (const e of cp.ends ?? []) { const q = toScreen(cam, e.x, e.y); ctx.fillStyle = "#ffffff"; ctx.strokeStyle = pal.select; ctx.beginPath(); ctx.arc(q.x, q.y, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
    const a = toScreen(cam, cp.from.x, cp.from.y);
    ctx.fillStyle = pal.select; ctx.beginPath(); ctx.arc(a.x, a.y, 5, 0, Math.PI * 2); ctx.fill();
    const to = cp.snap ?? cp.cursor;
    if (to) { const b = toScreen(cam, to.x, to.y); ctx.strokeStyle = pal.select; ctx.setLineDash(cp.snap ? [] : [6, 4]); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]); }
    if (cp.snap) { const b = toScreen(cam, cp.snap.x, cp.snap.y); ctx.fillStyle = pal.select; ctx.beginPath(); ctx.arc(b.x, b.y, 9, 0, Math.PI * 2); ctx.fill(); }
  }
  // junction editor: the outline's points (drag; double-click an edge to add, Alt+click to remove),
  // and the painted area being drawn (click points, double-click or Enter to finish)
  if (ov.shape?.outline) {
    const pts = ov.shape.outline.map(p => toScreen(cam, p.x, p.y));
    ctx.strokeStyle = pal.select; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
    ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = pal.bg; ctx.lineWidth = 2;
    for (const q of pts) { ctx.beginPath(); ctx.rect(q.x - 4.5, q.y - 4.5, 9, 9); ctx.fill(); ctx.stroke(); }
  }
  if (ov.shape?.paint) {
    const pts = ov.shape.paint.map(p => toScreen(cam, p.x, p.y)), cur = ov.shape.cursor ? toScreen(cam, ov.shape.cursor.x, ov.shape.cursor.y) : null;
    ctx.strokeStyle = pal.select; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); if (cur && pts.length) ctx.lineTo(cur.x, cur.y); if (pts.length >= 2) ctx.lineTo(pts[0].x, pts[0].y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = pal.select;
    for (const q of pts) { ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill(); }
  }
  // a selected lane connector: its two curve handles, each sliding along its lane's direction
  if (sel?.kind === "connector") {
    const v = connectorsOf(compiled).find(x => connectorId(x) === sel.id);
    if (v) {
      const h = connectorHandles(v.node, v.move, v.inLane, v.outLane), hov = ov.hover?.kind === "handle" ? ov.hover.id : null;
      const P = toScreen(cam, h.P.x, h.P.y), Q = toScreen(cam, h.Q.x, h.Q.y), a = toScreen(cam, h.h1.x, h.h1.y), b = toScreen(cam, h.h2.x, h.h2.y);
      ctx.strokeStyle = pal.select; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(P.x, P.y); ctx.lineTo(a.x, a.y); ctx.moveTo(Q.x, Q.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
      for (const [q, id] of [[a, "k1"], [b, "k2"]] as const) {
        const r = hov === id ? 7 : 5.5;
        ctx.fillStyle = hov === id ? pal.select : pal.bg; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
      // its two ends: square handles to drag onto another lane end
      for (const q of [P, Q]) { ctx.fillStyle = pal.select; ctx.strokeStyle = pal.bg; ctx.lineWidth = 2; ctx.beginPath(); ctx.rect(q.x - 5, q.y - 5, 10, 10); ctx.fill(); ctx.stroke(); }
      ctx.strokeStyle = pal.select;
    }
  }
  if (ov.pendingPoint) {
    const q = toScreen(cam, ov.pendingPoint.x, ov.pendingPoint.y);
    ctx.fillStyle = pal.select; ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill();
  }
  if (ov.draft) {
    const a = toScreen(cam, ov.draft.from.x, ov.draft.from.y), b = toScreen(cam, ov.draft.to.x, ov.draft.to.y);
    ctx.strokeStyle = pal.select; ctx.globalAlpha = 0.35; ctx.lineCap = "round";
    ctx.lineWidth = Math.max(4, ov.draft.lanes * 3.2 * scale);
    const d = ov.draft;
    const path = () => {
      ctx.beginPath(); ctx.moveTo(a.x, a.y);
      if (d.c1 && d.c2) { const q1 = toScreen(cam, d.c1.x, d.c1.y), q2 = toScreen(cam, d.c2.x, d.c2.y); ctx.bezierCurveTo(q1.x, q1.y, q2.x, q2.y, b.x, b.y); }
      else ctx.lineTo(b.x, b.y);
    };
    path(); ctx.stroke();
    ctx.globalAlpha = 1; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    path(); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = pal.select; ctx.beginPath(); ctx.arc(b.x, b.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.font = `600 12px ${pal.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const tw = ctx.measureText(ov.draft.label).width + 12;
    ctx.fillStyle = pal.fg; roundRect(ctx, b.x + 12, b.y - 22, tw, 20, 4); ctx.fill();
    ctx.fillStyle = pal.bg; ctx.fillText(ov.draft.label, b.x + 18, b.y - 12);
  }
  if (ov.calib) drawCalib(ctx, cam, pal, ov.calib);
}

function drawUnderlayFrame(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, u: Underlay, editable: boolean, hover: UnderlayHandle | null) {
  const hd = underlayHandles(cam, u);
  const q = hd.corners;
  ctx.strokeStyle = pal.select; ctx.lineWidth = hover === "move" ? 2 : 1.25; ctx.setLineDash([6, 4]);
  ctx.beginPath(); ctx.moveTo(q[0].x, q[0].y); for (const p of q.slice(1)) ctx.lineTo(p.x, p.y); ctx.closePath(); ctx.stroke();
  ctx.setLineDash([]);
  if (!editable) return;
  ctx.beginPath(); ctx.moveTo(hd.top.x, hd.top.y); ctx.lineTo(hd.rotate.x, hd.rotate.y); ctx.stroke();
  q.forEach((p, i) => {
    const hov = hover === `c${i}`, r = hov ? 6.5 : 5;
    ctx.fillStyle = hov ? pal.select : pal.bg; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.rect(p.x - r, p.y - r, r * 2, r * 2); ctx.fill(); ctx.stroke();
  });
  const hov = hover === "rotate";
  ctx.fillStyle = hov ? pal.select : pal.bg; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(hd.rotate.x, hd.rotate.y, hov ? 7.5 : 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
}

function drawCalib(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, c: NonNullable<Overlay["calib"]>) {
  const b = c.b ?? c.cursor;
  const dot = (p: Vec) => {
    const q = toScreen(cam, p.x, p.y);
    ctx.fillStyle = pal.select; ctx.strokeStyle = pal.bg; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = pal.select; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(q.x - 12, q.y); ctx.lineTo(q.x - 7, q.y); ctx.moveTo(q.x + 7, q.y); ctx.lineTo(q.x + 12, q.y);
    ctx.moveTo(q.x, q.y - 12); ctx.lineTo(q.x, q.y - 7); ctx.moveTo(q.x, q.y + 7); ctx.lineTo(q.x, q.y + 12); ctx.stroke();
  };
  if (c.a && b) {
    const qa = toScreen(cam, c.a.x, c.a.y), qb = toScreen(cam, b.x, b.y);
    ctx.strokeStyle = pal.select; ctx.lineWidth = 2; ctx.setLineDash(c.b ? [] : [6, 4]);
    ctx.beginPath(); ctx.moveTo(qa.x, qa.y); ctx.lineTo(qb.x, qb.y); ctx.stroke(); ctx.setLineDash([]);
    const label = `${Math.hypot(b.x - c.a.x, b.y - c.a.y).toFixed(1)} m`;
    ctx.font = `600 12px ${pal.mono}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width + 12, mx = (qa.x + qb.x) / 2, my = (qa.y + qb.y) / 2;
    ctx.fillStyle = pal.fg; roundRect(ctx, mx + 10, my - 22, tw, 20, 4); ctx.fill();
    ctx.fillStyle = pal.bg; ctx.fillText(label, mx + 16, my - 12);
  }
  if (c.a) dot(c.a);
  if (c.b) dot(c.b);
}

/** "J3 · 24/min · 5 waiting" tags next to junctions */
function drawJunctionTags(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, compiled: Compiled, sim: Sim | null) {
  const refs = junctionRefs(compiled);
  ctx.font = `600 11px ${pal.mono}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  for (const n of compiled.nodes) {
    const ref = refs.get(n.def.id);
    if (!ref) continue;
    const q = toScreen(cam, n.pos.x, n.pos.y);
    if (q.x < -80 || q.y < -40 || q.x > cam.w + 80 || q.y > cam.h + 40) continue;
    let text = ref;
    let hot = false;
    if (sim) {
      const st = sim.junctionStats(n.idx);
      text += ` · ${Math.round(st.perMin)}/min`;
      if (st.waiting) text += ` · ${st.waiting} waiting`;
      hot = st.waiting >= 12;
    }
    const w = ctx.measureText(text).width + 10, x = q.x + 12, y = q.y - 16;
    ctx.fillStyle = hot ? pal.stop : pal.fg; roundRect(ctx, x, y - 9, w, 18, 4); ctx.fill();
    ctx.fillStyle = hot ? "#fff" : pal.bg; ctx.fillText(text, x + 5, y + 0.5);
  }
}

/** zone members in their zone's colour (buildings filled, entry points ringed) and each zone's name */
function drawZones(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, net: Network, only: string | null) {
  const bById = new Map((net.buildings ?? []).map(b => [b.id, b]));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = cam.dpr;
  for (const z of net.zones ?? []) {
    if (only && z.id !== only) continue;
    let sx = 0, sy = 0, n = 0;
    ctx.fillStyle = z.color; ctx.globalAlpha = 0.6;
    for (const m of z.members) {
      if (m.kind !== "building") continue;
      const b = bById.get(m.id); if (!b) continue;
      ctx.beginPath();
      b.pts.forEach((p, i) => { const q = toScreen(cam, p.x, p.y); if (i) ctx.lineTo(q.x * dpr, q.y * dpr); else ctx.moveTo(q.x * dpr, q.y * dpr); sx += q.x; sy += q.y; n++; });
      ctx.closePath(); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.strokeStyle = z.color; ctx.lineWidth = 3 * dpr;
    for (const m of z.members) {
      if (m.kind !== "entry") continue;
      const nd = net.nodes.find(x => x.id === m.id); if (!nd) continue;
      const q = toScreen(cam, nd.x, nd.y);
      ctx.beginPath(); ctx.arc(q.x * dpr, q.y * dpr, 11 * dpr, 0, Math.PI * 2); ctx.stroke();
      sx += q.x; sy += q.y; n++;
    }
    if (n) {
      ctx.font = `600 ${12 * dpr}px ${pal.sans}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      const x = (sx / n) * dpr, y = (sy / n) * dpr, w = ctx.measureText(z.name).width + 12 * dpr;
      ctx.fillStyle = z.color; roundRect(ctx, x - w / 2, y - 10 * dpr, w, 20 * dpr, 5 * dpr); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.fillText(z.name, x, y + 0.5 * dpr);
    }
  }
  ctx.restore();
}

function strokePts(ctx: CanvasRenderingContext2D, q: ArrayLike<number>) {
  ctx.beginPath(); ctx.moveTo(q[0], q[1]);
  for (let k = 2; k < q.length; k += 2) ctx.lineTo(q[k], q[k + 1]);
  ctx.stroke();
}

/** transit flows starting or ending at the selected entry point: dashed arrows with their rate */
function drawFlows(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, net: Network, nodeId: string) {
  const flows = (net.flows ?? []).filter(f => f.from === nodeId || f.to === nodeId);
  if (!flows.length) return;
  const at = (id: string) => { const n = net.nodes.find(x => x.id === id); return n ? toScreen(cam, n.x, n.y) : null; };
  ctx.font = `600 11px ${pal.mono}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  for (const f of flows) {
    const a = at(f.from), b = at(f.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    // bow the line a little so flows in both directions between two points don't overlap
    const bow = Math.min(60, L * 0.15), cx = (a.x + b.x) / 2 - uy * bow, cy = (a.y + b.y) / 2 + ux * bow;
    const out = f.from === nodeId;
    ctx.strokeStyle = out ? pal.primary : pal.slow; ctx.lineWidth = 2; ctx.setLineDash([8, 6]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.quadraticCurveTo(cx, cy, b.x - ux * 8, b.y - uy * 8); ctx.stroke();
    ctx.setLineDash([]);
    // arrowhead along the curve's end tangent
    const tx = b.x - cx, ty = b.y - cy, tl = Math.hypot(tx, ty) || 1, hx = tx / tl, hy = ty / tl;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - hx * 12 - hy * 6, b.y - hy * 12 + hx * 6); ctx.lineTo(b.x - hx * 12 + hy * 6, b.y - hy * 12 - hx * 6); ctx.closePath(); ctx.fill();
    const text = `${f.rate}/h`, w = ctx.measureText(text).width + 10, lx = (a.x + 2 * cx + b.x) / 4, ly = (a.y + 2 * cy + b.y) / 4;
    roundRect(ctx, lx - w / 2, ly - 9, w, 18, 4); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(text, lx - w / 2 + 5, ly + 0.5);
  }
}

/** traffic counters: a marker where vehicles are counted (the middle of the road) and the readings */
function drawCounters(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, net: Network, compiled: Compiled, sim: Sim | null) {
  ctx.font = `600 11px ${pal.mono}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  for (const l of net.links) {
    if (!l.counter) continue;
    const e = compiled.edgeByKey.get(`${l.id}:1`) ?? compiled.edgeByKey.get(`${l.id}:-1`);
    if (!e) continue;
    const p = e.center.at(e.center.len / 2), q = toScreen(cam, p.x, p.y);
    if (q.x < -120 || q.y < -40 || q.x > cam.w + 120 || q.y > cam.h + 40) continue;
    let text = "⇅ counter";
    if (sim) {
      // each direction (by where it heads) and both together: vehicles counted, and per hour
      const f = sim.counter(l.id, 1), b = sim.counter(l.id, -1);
      const total = (f?.total ?? 0) + (b?.total ?? 0), rate = (f?.perHour ?? 0) + (b?.perHour ?? 0);
      const A = compiled.nodeById.get(l.from)?.pos, B = compiled.nodeById.get(l.to)?.pos;
      const head = (dx: number, dy: number) => ["E", "SE", "S", "SW", "W", "NW", "N", "NE"][((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
      const count = (n: number, h: number) => `${n} (${Math.round(h)}/h)`;
      text = l.lanesF > 0 && l.lanesB > 0 && A && B
        ? `${head(B.x - A.x, B.y - A.y)} ${count(f?.total ?? 0, f?.perHour ?? 0)} · ${head(A.x - B.x, A.y - B.y)} ${count(b?.total ?? 0, b?.perHour ?? 0)} · Σ ${count(total, rate)}`
        : `⇅ ${count(total, rate)}`;
    }
    ctx.fillStyle = pal.primary; ctx.beginPath(); ctx.arc(q.x, q.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = pal.bg; ctx.lineWidth = 1.5; ctx.stroke();
    // (below the road's middle: a selected road's id tag sits above it)
    const w = ctx.measureText(text).width + 10, x = q.x + 8, y = q.y + 14;
    ctx.fillStyle = pal.primary; roundRect(ctx, x, y - 9, w, 18, 4); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.fillText(text, x + 5, y + 0.5);
  }
}

/** where a marker's pin head is on screen, from the point it marks (the pin stands up from it) */
export const MARKER_HEAD = { dy: -20, r: 8 };
/** markers on the map (screen space): a pin standing on the point, its label beside the head */
function drawMarkers(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, net: Network, selected: readonly string[]) {
  ctx.font = `600 12px ${pal.sans}`; ctx.textBaseline = "middle"; ctx.textAlign = "left";
  for (const m of net.markers ?? []) {
    const q = toScreen(cam, m.x, m.y);
    if (q.x < -150 || q.y < -40 || q.x > cam.w + 150 || q.y > cam.h + 40) continue;
    const col = m.color ?? DEFAULT_MARKER_COLOR, hx = q.x, hy = q.y + MARKER_HEAD.dy, sel = selected.includes(m.id);
    // the stem and the point it marks
    ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(hx, hy + MARKER_HEAD.r - 1); ctx.stroke();
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(q.x, q.y, 2.5, 0, Math.PI * 2); ctx.fill();
    if (sel) { ctx.strokeStyle = pal.select; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(hx, hy, MARKER_HEAD.r + 4, 0, Math.PI * 2); ctx.stroke(); }
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(hx, hy, MARKER_HEAD.r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(hx, hy, 2.5, 0, Math.PI * 2); ctx.fill();
    if (m.label) {
      const w = ctx.measureText(m.label).width + 12, x = hx + MARKER_HEAD.r + 4;
      ctx.fillStyle = pal.bg; ctx.globalAlpha = 0.92; roundRect(ctx, x, hy - 10, w, 20, 5); ctx.fill(); ctx.globalAlpha = 1;
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; roundRect(ctx, x, hy - 10, w, 20, 5); ctx.stroke();
      ctx.fillStyle = pal.fg; ctx.fillText(m.label, x + 6, hy + 0.5);
    }
  }
}

/**
 * The ID of what is selected, in a tag on the map (screen space): roads at their middle,
 * junctions (with their J number), stops, buildings, vehicles, lanes and lane connectors where they are.
 */
function drawSelectionIds(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, geo: RoadGeo, net: Network, compiled: Compiled, sim: Sim | null, sel: { kind: string; id: string }, also: string[]) {
  const tags: { at: Vec; text: string }[] = [];
  if (sel.kind === "link") for (const id of new Set([sel.id, ...also])) {
    const e = compiled.edgeByKey.get(`${id}:1`) ?? compiled.edgeByKey.get(`${id}:-1`);
    if (e) tags.push({ at: e.center.at(e.center.len / 2), text: id });
  } else if (sel.kind === "node") {
    const n = compiled.nodeById.get(sel.id), ref = n ? junctionRefs(compiled).get(n.def.id) : undefined;
    if (n) tags.push({ at: n.pos, text: ref ? `${ref} · ${sel.id}` : sel.id });
  } else if (sel.kind === "stop") {
    const s = geo.stops.find(x => x.id === sel.id);
    if (s) tags.push({ at: s.p, text: sel.id });
  } else if (sel.kind === "building") {
    const b = net.buildings?.find(x => x.id === sel.id);
    if (b) tags.push({ at: { x: b.pts.reduce((a, p) => a + p.x, 0) / b.pts.length, y: b.pts.reduce((a, p) => a + p.y, 0) / b.pts.length }, text: sel.id });
  } else if (sel.kind === "vehicle" && sim) {
    const v = sim.vehicles.find(x => String(x.id) === sel.id && !x.dead);
    if (v) { const q = sim.pose(v); tags.push({ at: { x: (q.fx + q.rx) / 2, y: (q.fy + q.ry) / 2 }, text: `#${sel.id}` }); }
  } else if (sel.kind === "lane") {
    const [lid, dir, lane] = sel.id.split("|"), lp = compiled.edgeByKey.get(`${lid}:${dir}`)?.lanes[Number(lane)];
    if (lp) tags.push({ at: lp.poly.at(lp.len / 2), text: sel.id });
  } else if (sel.kind === "connector") {
    const c = connectorsOf(compiled).find(x => connectorId(x) === sel.id);
    // (readable: its junction, the lane it leaves and where it goes; the full id is in the inspector)
    if (c) { const k = Math.floor(c.pts.length / 4) * 2, ref = junctionRefs(compiled).get(c.node.def.id) ?? c.node.def.id; tags.push({ at: { x: c.pts[k], y: c.pts[k + 1] }, text: `${ref} · ${c.inLane + 1} → ${c.move.out.link.name || c.move.out.link.id} ${c.outLane + 1}` }); }
  }
  ctx.font = `500 11px ${pal.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const t of tags) {
    const q = toScreen(cam, t.at.x, t.at.y);
    if (q.x < -200 || q.y < -20 || q.x > cam.w + 200 || q.y > cam.h + 20) continue;
    const w = ctx.measureText(t.text).width + 10;
    ctx.fillStyle = pal.select; roundRect(ctx, q.x - w / 2, q.y - 24, w, 17, 4); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.fillText(t.text, q.x, q.y - 15.5);
  }
}

/** with the lanes layer highlighted: each lane's id (as selected: "linkId|dir|lane") at its middle, when zoomed in enough to read */
function drawLaneIds(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, compiled: Compiled) {
  if (cam.scale < 3) return;
  ctx.setTransform(cam.dpr, 0, 0, cam.dpr, 0, 0);
  ctx.font = `500 9.5px ${pal.mono}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // (neighbouring lanes' labels staggered along them; a label that would cover one already placed is left out)
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const e of compiled.edges) for (const lp of e.lanes) {
    if (lp.len < 2) continue;
    const f = e.n > 1 ? 0.3 + (0.4 * lp.lane) / (e.n - 1) : 0.5;
    const text = `${e.link.id}|${e.dir}|${lp.lane}`, w = ctx.measureText(text).width + 6;
    // the first of a few points along the lane that is on screen and free (long lanes are often half off it)
    let q: Vec | null = null, r = { x0: 0, y0: 0, x1: 0, y1: 0 };
    for (const g of [f, 0.15, 0.85, 0.5, 0.05, 0.95, 0.3, 0.7]) {
      const at = lp.poly.at(lp.len * g), p = toScreen(cam, at.x, at.y);
      if (p.x < w / 2 || p.y < 8 || p.x > cam.w - w / 2 || p.y > cam.h - 8) continue;
      const rr = { x0: p.x - w / 2, y0: p.y - 7, x1: p.x + w / 2, y1: p.y + 7 };
      if (placed.some(o => rr.x0 < o.x1 && rr.x1 > o.x0 && rr.y0 < o.y1 && rr.y1 > o.y0)) continue;
      q = p; r = rr; break;
    }
    if (!q) continue;
    placed.push(r);
    ctx.fillStyle = "rgba(14,116,144,0.88)"; roundRect(ctx, r.x0, r.y0, w, 14, 3); ctx.fill();
    ctx.fillStyle = "#ffffff"; ctx.fillText(text, q.x, q.y + 0.5);
  }
}

/** chevrons along every lane of the given links, pointing the way traffic drives */
function drawTravelArrows(ctx: CanvasRenderingContext2D, pal: Palette, compiled: Compiled, linkIds: string[], px: number) {
  const ids = new Set(linkIds);
  const gap = Math.max(9, px * 46), size = Math.min(1.1, Math.max(0.55, px * 5));
  ctx.strokeStyle = pal.select; ctx.lineWidth = Math.max(0.22, px * 2); ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  for (const e of compiled.edges) {
    if (!ids.has(e.link.id)) continue;
    for (const lp of e.lanes) {
      const L = lp.poly.len;
      for (let s = Math.min(gap / 2, L / 2); s < L - 1; s += gap) {
        const p = lp.poly.at(s), t = lp.poly.tangent(s), r = { x: -t.y, y: t.x };
        ctx.moveTo(p.x - t.x * size + r.x * size * 0.8, p.y - t.y * size + r.y * size * 0.8);
        ctx.lineTo(p.x + t.x * size * 0.6, p.y + t.y * size * 0.6);
        ctx.lineTo(p.x - t.x * size - r.x * size * 0.8, p.y - t.y * size - r.y * size * 0.8);
      }
    }
  }
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawGrid(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, ov: Overlay) {
  if (!ov.gridOn) return;
  const tl = toWorld(cam, 0, 0), br = toWorld(cam, cam.w, cam.h);
  const lines = (step: number, color: string, width: number) => {
    if (step * cam.scale < 7) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    for (let x = Math.floor(tl.x / step) * step; x <= br.x; x += step) { const s = toScreen(cam, x, 0).x; ctx.moveTo(Math.round(s) + 0.5, 0); ctx.lineTo(Math.round(s) + 0.5, cam.h); }
    for (let y = Math.floor(tl.y / step) * step; y <= br.y; y += step) { const s = toScreen(cam, 0, y).y; ctx.moveTo(0, Math.round(s) + 0.5); ctx.lineTo(cam.w, Math.round(s) + 0.5); }
    ctx.stroke();
  };
  // over satellite imagery the grid is only a faint guide
  if (ov.satellite) ctx.globalAlpha = 0.18;
  lines(ov.snapStep, pal.grid, 1);
  const major = cam.scale > 1.5 ? 50 : cam.scale > 0.4 ? 100 : 500;
  lines(major, pal.gridMajor, 1);
  ctx.globalAlpha = 1;
}

function drawLinkHandles(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, net: Network, l: LinkDef, hoverHandle: string | null) {
  const A = net.nodes.find(n => n.id === l.from), B = net.nodes.find(n => n.id === l.to);
  if (!A || !B) return;
  const a = toScreen(cam, A.x, A.y), b = toScreen(cam, B.x, B.y);
  ctx.lineWidth = 1; ctx.strokeStyle = pal.select;
  const handle = (p: Vec, id: string, square = false) => {
    const q = toScreen(cam, p.x, p.y), r = hoverHandle === id ? 7 : 5.5;
    ctx.fillStyle = hoverHandle === id ? pal.select : pal.bg; ctx.strokeStyle = pal.select; ctx.lineWidth = 2;
    ctx.beginPath(); if (square) ctx.rect(q.x - r, q.y - r, r * 2, r * 2); else ctx.arc(q.x, q.y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  };
  if (l.c1 && l.c2) {
    const c1 = toScreen(cam, l.c1.x, l.c1.y), c2 = toScreen(cam, l.c2.x, l.c2.y);
    ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c1.x, c1.y); ctx.moveTo(b.x, b.y); ctx.lineTo(c2.x, c2.y); ctx.stroke(); ctx.setLineDash([]);
    handle(l.c1, "c1"); handle(l.c2, "c2");
  } else {
    handle({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }, "bend", true);
  }
  // direction chevron at the middle
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  if (!(l.c1 && l.c2)) { m.x += (b.y - a.y) === 0 && (b.x - a.x) === 0 ? 0 : 0; }
}

function drawVehicles(ctx: CanvasRenderingContext2D, pal: Palette, sim: Sim, bySpeed: boolean, px: number, only?: (v: Vehicle) => boolean, alpha = 1, view?: { minX: number; minY: number; maxX: number; maxY: number }) {
  // blink on wall-clock time so it looks right at any simulation speed
  const blinkOn = Math.floor(performance.now() / 380) % 2 === 0;
  // one path per colour (speed colours in 16 steps), one for windows, one for turn signals: a few
  // fills for the whole fleet instead of several per vehicle
  let bodies = new Map<string, Path2D>(), windows = new Path2D(), signals = new Path2D(), inBatch = 0;
  // (small batches: one huge path is far slower to fill than a few dozen small ones)
  const flush = () => {
    ctx.globalAlpha = alpha;
    for (const [color, p] of bodies) { ctx.fillStyle = color; ctx.fill(p); }
    ctx.fillStyle = "#ffab1a"; ctx.fill(signals);
    ctx.fillStyle = "rgba(20,28,34,0.55)"; ctx.fill(windows);
    ctx.globalAlpha = 1;
    bodies = new Map(); windows = new Path2D(); signals = new Path2D(); inBatch = 0;
  };
  const quad = (p: Path2D, cx: number, cy: number, ux: number, uy: number, x0: number, x1: number, y0: number, y1: number) => {
    // local x along the vehicle, y to its right (the normal (-uy, ux))
    p.moveTo(cx + ux * x0 - uy * y0, cy + uy * x0 + ux * y0); p.lineTo(cx + ux * x1 - uy * y0, cy + uy * x1 + ux * y0);
    p.lineTo(cx + ux * x1 - uy * y1, cy + uy * x1 + ux * y1); p.lineTo(cx + ux * x0 - uy * y1, cy + uy * x0 + ux * y1); p.closePath();
  };
  for (const v of sim.vehicles) {
    if (v.dead || (only && !only(v))) continue;
    const q = sim.pose(v);
    const cx = (q.fx + q.rx) / 2, cy = (q.fy + q.ry) / 2;
    if (view && (cx < view.minX || cx > view.maxX || cy < view.minY || cy > view.maxY)) continue;
    const dx = q.fx - q.rx, dy = q.fy - q.ry, len = Math.hypot(dx, dy) || v.len, ux = len ? dx / len : 1, uy = len ? dy / len : 0;
    const w = Math.max(v.width, px * 3), L = Math.max(len, px * 5), hw = w / 2, hl = L / 2;
    const color = bySpeed ? speedColor(pal, Math.round((v.v / Math.max(1, v.v0)) * 15) / 15) : v.kind === "bus" ? pal.busVeh : v.kind === "truck" ? pal.truck : pal.car;
    let body = bodies.get(color); if (!body) bodies.set(color, (body = new Path2D()));
    // cut corners: rounded-looking at any zoom, 8 points
    const r = v.kind === "car" ? Math.min(0.7, hw) : 0.3;
    const pts: [number, number][] = [[hl - r, -hw], [hl, -hw + r], [hl, hw - r], [hl - r, hw], [-hl + r, hw], [-hl, hw - r], [-hl, -hw + r], [-hl + r, -hw]];
    pts.forEach(([x, y], i) => { const X = cx + ux * x - uy * y, Y = cy + uy * x + ux * y; if (i) body!.lineTo(X, Y); else body!.moveTo(X, Y); });
    body.closePath();
    // turn signals: amber corners on the side the vehicle is heading (local +y = right); 2: hazard lights, both sides
    const bl = blinkOn ? sim.blinker(v) : 0;
    if (bl) {
      const bw = Math.max(0.65, px * 4), bh = Math.max(0.5, px * 3.2);
      for (const sd of bl === 2 ? [1, -1] : [bl]) {
        const y = sd > 0 ? hw - bh * 0.6 : -hw - bh * 0.4;
        quad(signals, cx, cy, ux, uy, hl - bw, hl, y, y + bh); quad(signals, cx, cy, ux, uy, -hl, -hl + bw, y, y + bh);
      }
    }
    if (v.kind === "car") quad(windows, cx, cy, ux, uy, L * 0.08, L * 0.28, -w * 0.38, w * 0.38);
    else if (v.kind === "truck") quad(windows, cx, cy, ux, uy, L * 0.28, L * 0.32, -hw, hw);
    else quad(windows, cx, cy, ux, uy, L * 0.4, L * 0.46, -w * 0.4, w * 0.4);
    if (++inBatch >= 64) flush();
  }
  flush();
}

/** true if the piece is part of the given link (for hit testing vehicles on a road) */
export const pieceLink = (p: Piece) => (p.kind === "lane" ? p.edge.link.id : null);
export type { Vehicle };

/** street names written along the middle of each named road segment, following its curve */
function drawStreetNames(ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, geo: RoadGeo, net: Network) {
  const names = new Map(net.links.filter(l => l.name?.trim()).map(l => [l.id, l.name.trim()]));
  if (!names.size) return;
  const size = Math.round(Math.max(10, Math.min(13, 9 + cam.scale * 0.8)));
  ctx.font = `600 ${size}px ${pal.sans}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.lineJoin = "round"; ctx.lineWidth = 3;
  const m = cam.w * 0.1;
  for (const sf of geo.surfaces) {
    const name = names.get(sf.linkId);
    if (!name) continue;
    const c = sf.center, lenPx = c.len * cam.scale;
    const widths = [...name].map(ch => ctx.measureText(ch).width + 0.4);
    const total = widths.reduce((a, b) => a + b, 0);
    if (lenPx < total + 24) continue; // does not fit on this segment at this zoom
    const mid = c.at(c.len / 2), q = toScreen(cam, mid.x, mid.y);
    if (q.x < -m || q.y < -m || q.x > cam.w + m || q.y > cam.h + m) continue;
    // read left to right: walk the road backwards when it points leftwards on screen
    const t0 = c.tangent(c.len / 2), flip = t0.x < 0;
    let s = c.len / 2 - (flip ? -1 : 1) * (total / 2) / cam.scale;
    const glyphs: { x: number; y: number; a: number; ch: string }[] = [];
    [...name].forEach((ch, i) => {
      const half = widths[i] / 2 / cam.scale;
      s += (flip ? -1 : 1) * half;
      const p = c.at(s), t = c.tangent(s), sp = toScreen(cam, p.x, p.y);
      glyphs.push({ x: sp.x, y: sp.y, a: Math.atan2(t.y, t.x) + (flip ? Math.PI : 0), ch });
      s += (flip ? -1 : 1) * half;
    });
    for (const pass of [0, 1]) for (const g of glyphs) {
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.a);
      if (pass === 0) { ctx.strokeStyle = "rgba(20,24,28,0.85)"; ctx.strokeText(g.ch, 0, 0); }
      else { ctx.fillStyle = "#f4f1e8"; ctx.fillText(g.ch, 0, 0); }
      ctx.restore();
    }
  }
}
