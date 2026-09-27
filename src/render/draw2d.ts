/** Canvas 2D renderer for the plan view (world units = metres). */
import type { Compiled, Piece } from "@/engine/compile";
import type { Poly } from "@/engine/geom";
import type { Sim, Vehicle } from "@/engine/sim";
import type { LinkDef, Network, Vec } from "@/engine/types";
import type { RoadGeo, Strip } from "./geometry";
import { speedColor, type Palette } from "./palette";
import { underlayCorners, type Underlay } from "@/lib/underlay";
import { junctionRefs } from "@/engine/refs";

export interface Camera { cx: number; cy: number; scale: number; w: number; h: number; dpr: number }
export const toScreen = (c: Camera, x: number, y: number): Vec => ({ x: (x - c.cx) * c.scale + c.w / 2, y: (y - c.cy) * c.scale + c.h / 2 });
export const toWorld = (c: Camera, sx: number, sy: number): Vec => ({ x: (sx - c.w / 2) / c.scale + c.cx, y: (sy - c.h / 2) / c.scale + c.cy });

export interface PathCache {
  curb: Path2D; asphalt: Path2D; island: Path2D; islandEdge: Path2D; bus: Path2D;
  laneDash: Path2D; laneSolid: Path2D; centerDash: Path2D; centerSolid: Path2D;
  stopLine: Path2D; yieldLine: Path2D; arrows: Path2D;
  linkPaths: Map<string, Path2D>;
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
  const c: PathCache = {
    curb: new Path2D(), asphalt: new Path2D(), island: new Path2D(), islandEdge: new Path2D(), bus: new Path2D(),
    laneDash: new Path2D(), laneSolid: new Path2D(), centerDash: new Path2D(), centerSolid: new Path2D(),
    stopLine: new Path2D(), yieldLine: new Path2D(), arrows: new Path2D(), linkPaths: new Map(),
  };
  for (const s of geo.surfaces) {
    stripPath(c.curb, s.curb); stripPath(c.asphalt, s.asphalt);
    const lp = new Path2D(); stripPath(lp, s.curb); c.linkPaths.set(s.linkId, lp);
  }
  for (const j of geo.junctions) {
    if (j.polygon.length >= 3) {
      const poly = (p: Path2D) => { p.moveTo(j.polygon[0].x, j.polygon[0].y); for (const q of j.polygon.slice(1)) p.lineTo(q.x, q.y); p.closePath(); };
      poly(c.asphalt); poly(c.curb);
    }
    if (j.ring) {
      c.asphalt.moveTo(j.ring.c.x + j.ring.r + 2.4, j.ring.c.y); c.asphalt.arc(j.ring.c.x, j.ring.c.y, j.ring.r + 2.4, 0, Math.PI * 2);
      c.curb.moveTo(j.ring.c.x + j.ring.r + 3, j.ring.c.y); c.curb.arc(j.ring.c.x, j.ring.c.y, j.ring.r + 3, 0, Math.PI * 2);
      const ir = Math.max(2, j.ring.r - 2.4);
      c.island.moveTo(j.ring.c.x + ir, j.ring.c.y); c.island.arc(j.ring.c.x, j.ring.c.y, ir, 0, Math.PI * 2);
      c.islandEdge.moveTo(j.ring.c.x + ir, j.ring.c.y); c.islandEdge.arc(j.ring.c.x, j.ring.c.y, ir, 0, Math.PI * 2);
    }
    if (j.deadEnd) {
      c.asphalt.moveTo(j.deadEnd.c.x + j.deadEnd.r, j.deadEnd.c.y); c.asphalt.arc(j.deadEnd.c.x, j.deadEnd.c.y, j.deadEnd.r, 0, Math.PI * 2);
      c.curb.moveTo(j.deadEnd.c.x + j.deadEnd.r + 0.6, j.deadEnd.c.y); c.curb.arc(j.deadEnd.c.x, j.deadEnd.c.y, j.deadEnd.r + 0.6, 0, Math.PI * 2);
    }
  }
  for (const b of geo.busBands) stripPath(c.bus, b);
  for (const l of geo.lines) polyPath(l.kind === "center" ? (l.dashed ? c.centerDash : c.centerSolid) : l.dashed ? c.laneDash : c.laneSolid, l.poly);
  for (const s of geo.stopLines) { const p = s.kind === "yield" ? c.yieldLine : c.stopLine; p.moveTo(s.a.x, s.a.y); p.lineTo(s.b.x, s.b.y); }
  for (const a of geo.arrows) arrowGlyph(c.arrows, a.p, a.dir, a.turns);
  return c;
}

export interface Overlay {
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

export function drawScene(
  ctx: CanvasRenderingContext2D, cam: Camera, pal: Palette, geo: RoadGeo, paths: PathCache,
  net: Network, compiled: Compiled, sim: Sim | null, ov: Overlay,
) {
  const { w, h, dpr, scale } = cam;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = pal.ground;
  ctx.fillRect(0, 0, w, h);
  drawGrid(ctx, cam, pal, ov);

  // world transform
  ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * (w / 2 - cam.cx * scale), dpr * (h / 2 - cam.cy * scale));
  const px = 1 / scale; // one screen pixel in metres

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

  ctx.fillStyle = pal.curb; ctx.fill(paths.curb, "nonzero");
  ctx.fillStyle = pal.asphalt; ctx.fill(paths.asphalt, "nonzero");
  ctx.fillStyle = pal.bus; ctx.fill(paths.bus);
  ctx.fillStyle = pal.island; ctx.fill(paths.island);
  ctx.strokeStyle = pal.curb; ctx.lineWidth = 0.6; ctx.stroke(paths.islandEdge);

  ctx.lineCap = "butt";
  ctx.strokeStyle = pal.mark; ctx.lineWidth = Math.max(0.15, px * 1); ctx.setLineDash([3, 4]); ctx.stroke(paths.laneDash);
  ctx.setLineDash([]); ctx.lineWidth = Math.max(0.2, px * 1.2); ctx.stroke(paths.laneSolid);
  ctx.strokeStyle = pal.divider; ctx.lineWidth = Math.max(0.15, px * 1); ctx.setLineDash([3, 4]); ctx.stroke(paths.centerDash);
  ctx.setLineDash([]); ctx.stroke(paths.centerSolid);
  ctx.strokeStyle = pal.mark; ctx.lineWidth = 0.5; ctx.stroke(paths.stopLine);
  ctx.setLineDash([0.9, 0.7]); ctx.stroke(paths.yieldLine); ctx.setLineDash([]);
  if (scale > 2.2) { ctx.lineWidth = 0.22; ctx.lineJoin = "round"; ctx.stroke(paths.arrows); }

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

  // reservations and selected vehicle route
  if (sim) {
    if (ov.reservations) {
      ctx.strokeStyle = pal.select; ctx.globalAlpha = 0.5; ctx.lineWidth = 1.1; ctx.lineCap = "round";
      for (const c of sim.reservations()) strokePoly(ctx, c.poly);
      ctx.globalAlpha = 1;
    }
    const sv = ov.selection?.kind === "vehicle" ? sim.vehicles.find(v => String(v.id) === ov.selection!.id && !v.dead) : null;
    if (sv) {
      const pts = sim.routeAhead(sv, 800);
      ctx.strokeStyle = pal.select; ctx.lineWidth = Math.max(0.6, px * 2); ctx.setLineDash([2, 1.5]);
      ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawVehicles(ctx, pal, sim, ov.bySpeed, px);
    if (sv) {
      const q = sim.pose(sv);
      ctx.strokeStyle = pal.select; ctx.lineWidth = px * 2;
      ctx.beginPath(); ctx.arc((q.fx + q.rx) / 2, (q.fy + q.ry) / 2, Math.max(sv.len * 0.8, px * 12), 0, Math.PI * 2); ctx.stroke();
    }
  }

  // signals & stop signs
  for (const s of geo.signals) {
    if (s.kind === "lights") {
      const st = sim ? sim.signalFor(s.nodeIdx, s.arm) : null;
      ctx.fillStyle = pal.asphalt; ctx.beginPath(); ctx.arc(s.p.x, s.p.y, 1.25, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = st === "green" ? pal.go : st === "yellow" ? pal.slow : st === "red" ? pal.stop : pal.muted;
      ctx.beginPath(); ctx.arc(s.p.x, s.p.y, 0.85, 0, Math.PI * 2); ctx.fill();
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

  // bus stops
  for (const s of geo.stops) {
    const sel = ov.selection?.kind === "stop" && ov.selection.id === s.id;
    ctx.save(); ctx.translate(s.p.x, s.p.y); ctx.rotate(Math.atan2(s.dir.y, s.dir.x));
    ctx.fillStyle = s.color; ctx.fillRect(-2.2, -0.9, 4.4, 1.8);
    if (sel) { ctx.strokeStyle = pal.select; ctx.lineWidth = px * 2.5; ctx.strokeRect(-2.6, -1.3, 5.2, 2.6); }
    ctx.restore();
  }

  // ---- screen-space overlays ----
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (ul && (ul.editing || (ul.u.visible && !ul.img))) drawUnderlayFrame(ctx, cam, pal, ul.u, ul.editing && !ul.u.locked, ul.hover);
  if (ov.junctions) drawJunctionTags(ctx, cam, pal, compiled, sim);
  if (ov.labels && scale > 0.35) drawStreetNames(ctx, cam, pal, geo, net);
  if (ov.labels && scale > 1.1) {
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

function strokePoly(ctx: CanvasRenderingContext2D, poly: Poly) {
  const a = poly.pts; ctx.beginPath(); ctx.moveTo(a[0], a[1]); for (let k = 2; k < a.length; k += 2) ctx.lineTo(a[k], a[k + 1]); ctx.stroke();
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
  lines(ov.snapStep, pal.grid, 1);
  const major = cam.scale > 1.5 ? 50 : cam.scale > 0.4 ? 100 : 500;
  lines(major, pal.gridMajor, 1);
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

function drawVehicles(ctx: CanvasRenderingContext2D, pal: Palette, sim: Sim, bySpeed: boolean, px: number) {
  // blink on wall-clock time so it looks right at any simulation speed
  const blinkOn = Math.floor(performance.now() / 380) % 2 === 0;
  for (const v of sim.vehicles) {
    if (v.dead) continue;
    const q = sim.pose(v);
    const dx = q.fx - q.rx, dy = q.fy - q.ry, len = Math.hypot(dx, dy) || v.len;
    const ang = Math.atan2(dy, dx);
    ctx.save();
    ctx.translate((q.fx + q.rx) / 2, (q.fy + q.ry) / 2);
    ctx.rotate(ang);
    const w = Math.max(v.width, px * 3), L = Math.max(len, px * 5);
    ctx.fillStyle = bySpeed ? speedColor(pal, v.v / Math.max(1, v.v0)) : v.kind === "bus" ? pal.busVeh : v.kind === "truck" ? pal.truck : pal.car;
    ctx.beginPath();
    const r = v.kind === "car" ? Math.min(0.7, w / 2) : 0.3;
    ctx.moveTo(-L / 2 + r, -w / 2); ctx.lineTo(L / 2 - r, -w / 2); ctx.quadraticCurveTo(L / 2, -w / 2, L / 2, -w / 2 + r);
    ctx.lineTo(L / 2, w / 2 - r); ctx.quadraticCurveTo(L / 2, w / 2, L / 2 - r, w / 2); ctx.lineTo(-L / 2 + r, w / 2);
    ctx.quadraticCurveTo(-L / 2, w / 2, -L / 2, w / 2 - r); ctx.lineTo(-L / 2, -w / 2 + r); ctx.quadraticCurveTo(-L / 2, -w / 2, -L / 2 + r, -w / 2);
    ctx.fill();
    // turn signals: amber corners on the side the vehicle is heading (local +y = right)
    const bl = blinkOn ? sim.blinker(v) : 0;
    if (bl) {
      ctx.fillStyle = "#ffab1a";
      const bw = Math.max(0.65, px * 4), bh = Math.max(0.5, px * 3.2), y = bl > 0 ? w / 2 - bh * 0.6 : -w / 2 - bh * 0.4;
      ctx.fillRect(L / 2 - bw, y, bw, bh); ctx.fillRect(-L / 2, y, bw, bh);
    }
    ctx.fillStyle = "rgba(20,28,34,0.55)";
    if (v.kind === "car") ctx.fillRect(L * 0.08, -w * 0.38, L * 0.2, w * 0.76);
    else if (v.kind === "truck") ctx.fillRect(L * 0.28, -w / 2, L * 0.04, w);
    else ctx.fillRect(L * 0.4, -w * 0.4, L * 0.06, w * 0.8);
    ctx.restore();
  }
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
