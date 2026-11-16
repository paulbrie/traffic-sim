/**
 * The V2 plan (a lane sketch) in 3D: three.js meshes made from what the plan view draws (lane-sketch.ts's pure
 * functions): the road surfaces (each lane's band, with its kerb) and the junctions' (drawn outlines, smoothed loops or
 * bands, and the ground they shut in), the links between road ends, the markings, the turn arrows, the stop and yield
 * lines and the zebras; each at its height (bridges and underpasses: `shownZ` levels of LEVEL_H metres, as V1), bridges with
 * their sides and pillars; with heights (terrain, or set by hand: ticket #130) all of it on the ground's, `groundBase` at y = 0. A few merged meshes, made again only when the sketch changes. x east, y up, z the plan's y.
 */
import * as THREE from "three";
import { arrowGlyph } from "@/render/draw2d";
import { mix, type Palette } from "@/render/palette";
import type { SketchLayers } from "@/state/sketch-layers";
import type { NamedRun } from "@/render/street-names3d";
import { LEVEL_H } from "@/engine/compile";
import { junctionSurfaceHoles, nonzeroAreas } from "@/lib/junction-fill";
import { circlePts, deadEndTurnarounds } from "@/lib/dead-ends";
import { looseSurfaces } from "@/lib/loose-surface";
import { bumpShapes } from "@/lib/sketch-bumps";
import {
  bandPolygon, crossingStripes, isFullCircle, junctionBands, junctionLevel, laneLevel, laneLength, linkGeometry,
  outlinePath, densePoints, hasLevels, pointAt, roadMarkings, samples, shownZ, smoothJunction, turnArrows, twoWayOk, twinOf, isTwinId, baseLaneId,
  groundAt, groundBase, groundUnder, hasHeights, laneById, roadMiddle,
  type JunctionContents, type Pt, type Sketch,
} from "@/lib/lane-sketch";

/** heights over the ground (m) the layers lie at, so they don't fight */
const Y = { kerb: 0.04, asphalt: 0.06, paint: 0.09 };
const KERB = 0.6, PAINT_W = 0.16, DECK = 0.8, PARAPET = 0.9;
/** how far (m) a simplified line may stray: lanes and paint; junction outlines */
const TOL = 0.05, TOL_J = 0.1;

/** triangles put together, one material's worth */
class Mesh {
  pos: number[] = []; idx: number[] = [];
  /** a strip along `pts` (their heights `hs`), `w` wide */
  ribbon(pts: Pt[], hs: number[], w: number, y: number, closed = false) {
    const n = pts.length;
    if (n < 2) return;
    const base = this.pos.length / 3, h = w / 2;
    for (let i = 0; i < n; i++) {
      const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
      const dx = b.x - a.x, dz = b.y - a.y, m = Math.hypot(dx, dz) || 1, nx = -dz / m, nz = dx / m, p = pts[i], yy = hs[i] + y;
      this.pos.push(p.x + nx * h, yy, p.y + nz * h, p.x - nx * h, yy, p.y - nz * h);
    }
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) { const a = base + 2 * i, b = base + 2 * ((i + 1) % n); this.idx.push(a, b, a + 1, b, b + 1, a + 1); }
  }
  /**
   * A line `w` wide along `pts` (their heights `hs`), as the plan view's canvas strokes it (butt ends, round joins): a
   * quad on each piece, a fan round each bend; where `ribbon` would pinch or fold over at a sharp turn, this one doesn't
   */
  stroke(pts: Pt[], hs: number[], w: number, y: number, closed = false) {
    const n = pts.length, h = w / 2;
    if (n < 2) return;
    const segs = closed ? n : n - 1, dir = (i: number) => { const a = pts[i], b = pts[(i + 1) % n], m = Math.hypot(b.x - a.x, b.y - a.y); return m > 1e-9 ? { x: (b.x - a.x) / m, y: (b.y - a.y) / m } : null; };
    for (let i = 0; i < segs; i++) {
      const d = dir(i);
      if (!d) continue;
      const a = pts[i], b = pts[(i + 1) % n], ya = hs[i] + y, yb = hs[(i + 1) % n] + y, nx = -d.y * h, nz = d.x * h;
      this.quad([a.x + nx, ya, a.y + nz], [b.x + nx, yb, b.y + nz], [b.x - nx, yb, b.y - nz], [a.x - nx, ya, a.y - nz]);
    }
    // (the joins: a round fan where the line turns, at the bend's own height)
    for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
      const d0 = dir((i - 1 + n) % n), d1 = dir(i);
      if (!d0 || !d1) continue;
      const turn = Math.atan2(d0.x * d1.y - d0.y * d1.x, d0.x * d1.x + d0.y * d1.y);
      if (Math.abs(turn) < 0.02) continue;
      // (on the outside of the bend: from the incoming piece's side to the outgoing one's)
      const p = pts[i], yy = hs[i] + y, sg = turn > 0 ? -1 : 1, a0 = Math.atan2(d0.y, d0.x) + (sg * Math.PI) / 2, k = Math.max(2, Math.ceil(Math.abs(turn) / 0.3));
      const base = this.pos.length / 3;
      this.pos.push(p.x, yy, p.y);
      for (let q = 0; q <= k; q++) { const a = a0 + (turn * q) / k; this.pos.push(p.x + Math.cos(a) * h, yy, p.y + Math.sin(a) * h); }
      for (let q = 0; q < k; q++) this.idx.push(base, base + 1 + q, base + 2 + q);
    }
  }
  /** a polygon (its holes cut out) at height `y`, or at each corner's (on the ground's) */
  polygon(outer: Pt[], holes: Pt[][], y: number | ((p: Pt) => number)) {
    if (outer.length < 3) return;
    const v2 = (ps: Pt[]) => ps.map(p => new THREE.Vector2(p.x, p.y));
    const o = v2(outer), hs = holes.filter(h => h.length >= 3).map(v2);
    const tris = THREE.ShapeUtils.triangulateShape(o, hs), all = [o, ...hs].flat(), base = this.pos.length / 3;
    for (const p of all) this.pos.push(p.x, typeof y === "number" ? y : y({ x: p.x, y: p.y }), p.y);
    for (const t of tris) this.idx.push(base + t[0], base + t[2], base + t[1]);
  }
  /** a quad from four corners (x, y, z) */
  quad(a: number[], b: number[], c: number[], d: number[]) {
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build(mat: THREE.Material, normals: "up" | "computed") {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.idx);
    if (normals === "up") g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(this.pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    else g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }
}

/**
 * A polyline with only the points it needs: none further than `tol` metres from where it ran (Douglas–Peucker; the
 * ends kept). A city's lanes and junction outlines come sampled every metre: most of it straight.
 */
export function simplify(pts: Pt[], tol: number, keep?: (i: number) => boolean): Pt[] {
  const n = pts.length;
  if (n <= 2) return pts;
  const on = new Uint8Array(n); on[0] = on[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!, A = pts[a], B = pts[b], dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy);
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      // (its ends one point, a closed loop's (a ring's: ticket #262, Junction 5): how far from that point; else from the line
      // through them. From the line, every point of a ring was 0 off it, and the ring was left out of the 3D view altogether)
      const d = keep?.(i) ? Infinity : L < 1e-9 ? Math.hypot(pts[i].x - A.x, pts[i].y - A.y) : Math.abs((pts[i].x - A.x) * dy - (pts[i].y - A.y) * dx) / L;
      if (d > fd) { fd = d; far = i; }
    }
    if (far >= 0) { on[far] = 1; stack.push([a, far], [far, b]); }
  }
  return pts.filter((_, i) => on[i]);
}
/**
 * A lane's points (every `step` metres, those it needs), with their heights (`hs`: the ground's, from `base`, and its level's
 * over it) and their levels' alone (`up`: a bridge's sides and pillars where it is up off the ground)
 */
function laneLine(sk: Sketch, id: string, shape: Parameters<typeof samples>[0], step: number, base: number) {
  // (with levels or heights, a straight run cut up too, so a ramp or a hill on it is one; else its points as they are, all at 0)
  const heights = hasHeights(sk), dense = hasLevels(sk) || heights ? densePoints(shape, heights ? Math.max(step, 2) : step) : samples(shape, step).map(p => ({ p, s: 0 }));
  const all = dense.map(x => x.p), up = dense.map(x => shownZ(sk, id, x.s) * LEVEL_H), ha = dense.map((x, i) => up[i] + (heights ? groundAt(sk, id, x.s) - base : 0));
  // (where its height changes, every point kept: a ramp stays a ramp; a hill to within 2 cm)
  const keep = (i: number) => i > 0 && i < all.length - 1 && Math.abs(ha[i + 1] - 2 * ha[i] + ha[i - 1]) > (heights ? 0.02 : 1e-4);
  const kept = simplify(all.map((p, i) => ({ ...p, i })), TOL, keep) as (Pt & { i: number })[];
  return { pts: kept.map(p => ({ x: p.x, y: p.y })), hs: kept.map(p => ha[p.i]), up: kept.map(p => up[p.i]) };
}
/** dashes along a polyline: `on` metres drawn, `off` left (its points' heights `h`, if they have them, carried along) */
function dashes<P extends Pt & { h?: number }>(pts: P[], on: number, off: number): P[][] {
  const out: P[][] = [];
  let cur: P[] = [], phase = 0, drawing = true;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let left = Math.hypot(b.x - a.x, b.y - a.y);
    while (left > 1e-6) {
      const room = (drawing ? on : off) - phase, step = Math.min(room, left), t = step / left;
      const q = { ...a, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ...(a.h !== undefined ? { h: a.h + (b.h! - a.h) * t } : {}) };
      if (drawing) { if (!cur.length) cur.push(a); cur.push(q); }
      phase += step; left -= step; a = q;
      if (phase >= (drawing ? on : off) - 1e-9) { if (drawing && cur.length > 1) out.push(cur); cur = []; drawing = !drawing; phase = 0; }
    }
  }
  if (drawing && cur.length > 1) out.push(cur);
  return out;
}
/** the polylines of a turn arrow (as the plan view draws it) */
function arrowLines(at: Pt, d: Pt, turns: string): Pt[][] {
  const lines: Pt[][] = [];
  const rec = { moveTo: (x: number, y: number) => lines.push([{ x, y }]), lineTo: (x: number, y: number) => lines[lines.length - 1].push({ x, y }) };
  arrowGlyph(rec as unknown as Path2D, at, d, turns);
  return lines;
}

export interface Sketch3D { group: THREE.Group; dispose: () => void }

/** the sketch's roads, junctions and what is painted on them, in 3D */
export function buildSketch3D(sk: Sketch, contents: Map<string, JunctionContents>, pal: Palette, layers: SketchLayers): Sketch3D {
  const group = new THREE.Group();
  const kerb = new Mesh(), asphalt = new Mesh(), paint = new Mesh(), yellow = new Mesh(), concrete = new Mesh();
  const red = new Mesh(), bike = new Mesh();
  const cOf = (id: string) => contents.get(id) ?? { lanes: [], connectors: [], roads: [] };
  // (heights, ticket #130: the ground's under a point and along a lane, from the lowest (y = 0); none: 0 everywhere, as before)
  const base = groundBase(sk), heights = hasHeights(sk);
  const G = (p: Pt) => (heights ? groundUnder(sk, p) - base : 0), GL = (lane: string, s: number) => (heights ? groundAt(sk, lane, s) - base : 0);
  const on = (y: number) => (heights ? (p: Pt) => y + G(p) : y);
  if (layers.surfaces) {
    // each lane's band, on its kerb; a bridge's sides and pillars where it is up
    for (const l of sk.lanes) {
      if (laneLength(l.shape) < 0.3) continue;
      const ring = isFullCircle(l.shape), { pts, hs, up } = laneLine(sk, l.id, l.shape, 1, base);
      kerb.ribbon(pts, hs, l.width + KERB, Y.kerb, ring);
      // (a bike lane: its asphalt in the 2D tint's green)
      (l.bike ? bike : asphalt).ribbon(pts, hs, l.width, Y.asphalt, ring);
      if (up.some(h => h > 0.5)) {
        const hw = (l.width + KERB) / 2;
        let since = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], ha = hs[i - 1], hb = hs[i], ga = ha - up[i - 1];
          since += Math.hypot(b.x - a.x, b.y - a.y);
          if (up[i - 1] < 0.5 && up[i] < 0.5) continue;
          const dx = b.x - a.x, dz = b.y - a.y, m = Math.hypot(dx, dz) || 1, nx = (-dz / m) * hw, nz = (dx / m) * hw;
          for (const sgn of [1, -1]) {
            const ax = a.x + nx * sgn, az = a.y + nz * sgn, bx = b.x + nx * sgn, bz = b.y + nz * sgn;
            // (the deck's edge below, the parapet above)
            concrete.quad([ax, ha - DECK, az], [bx, hb - DECK, bz], [bx, hb + PARAPET, bz], [ax, ha + PARAPET, az]);
            concrete.quad([ax, ha + PARAPET, az], [bx, hb + PARAPET, bz], [bx, hb - DECK, bz], [ax, ha - DECK, az]);
          }
          // (its underside)
          concrete.quad([a.x - nx, ha - DECK, a.y - nz], [b.x - nx, hb - DECK, b.y - nz], [b.x + nx, hb - DECK, b.y + nz], [a.x + nx, ha - DECK, a.y + nz]);
          if (since >= 25 && up[i - 1] > 3) {
            since = 0;
            const s2 = 0.5;
            for (const [cx, cz] of [[a.x, a.y]]) {
              // (from the ground under it, the terrain's where there is terrain, up to the deck)
              const top = ha - DECK, g = heights ? G({ x: cx, y: cz }) : ga, P = (x: number, z: number, y: number) => [cx + x, y, cz + z];
              concrete.quad(P(-s2, -s2, g), P(s2, -s2, g), P(s2, -s2, top), P(-s2, -s2, top));
              concrete.quad(P(s2, s2, g), P(-s2, s2, g), P(-s2, s2, top), P(s2, s2, top));
              concrete.quad(P(s2, -s2, g), P(s2, s2, g), P(s2, s2, top), P(s2, -s2, top));
              concrete.quad(P(-s2, s2, g), P(-s2, -s2, g), P(-s2, -s2, top), P(-s2, s2, top));
            }
          }
        }
      }
    }
    // the junctions: drawn outlines, smoothed loops, or their bands; and the ground they shut in
    for (const j of sk.junctions) {
      if (j.outline.length < 3) continue;
      const c = cOf(j.id), h = junctionLevel(sk, c) * LEVEL_H;
      const loop = (ps: Pt[]) => simplify(ps, TOL_J);
      if (j.shape !== "auto") { asphalt.polygon(loop(outlinePath(j)), [], on(h + Y.asphalt)); continue; }
      if (j.smooth) { const [outer, ...holes] = smoothJunction(sk, j, c); if (outer) asphalt.polygon(loop(outer), holes.map(loop), on(h + Y.asphalt)); }
      else for (const b of junctionBands(sk, c)) {
        if (b.w1 !== undefined) asphalt.polygon(loop(bandPolygon(b)), [], on(h + Y.asphalt));
        // (stroked as the plan view strokes them, round at their bends)
        else { const ps = b.closed ? b.pts : simplify(b.pts, TOL); asphalt.stroke(ps, ps.map(p => h + G(p)), b.width, Y.asphalt, b.closed); }
      }
      // (the ground it shuts in, and with "Fill holes" its whole inside)
      // (painted as the plan view does, all at once by the nonzero rule: the ground shut in inside the whole inside filled, paved too)
      for (const p of nonzeroAreas(junctionSurfaceHoles(sk, j, c))) asphalt.polygon(loop(p.outer), p.holes.map(loop), on(h + Y.asphalt));
    }
    for (const k of sk.links ?? []) { const g = linkGeometry(sk, k); if (g) asphalt.polygon(g.outline, [], on(Y.asphalt)); }
    // (ticket #111: the connectors on no junction, and the slivers between those leaving or joining a lane's end)
    for (const x of looseSurfaces(sk, contents)) {
      const h = x.level * LEVEL_H;
      for (const b of x.bands) {
        if (b.w1 !== undefined) asphalt.polygon(simplify(bandPolygon(b), TOL_J), [], on(h + Y.asphalt));
        else { const ps = simplify(b.pts, TOL); asphalt.stroke(ps, ps.map(p => h + G(p)), b.width, Y.asphalt, false); }
      }
      for (const p of nonzeroAreas(x.fill)) asphalt.polygon(simplify(p.outer, TOL_J), p.holes.map(q => simplify(q, TOL_J)), on(h + Y.asphalt));
    }
    // (a dead end with a turnaround: a turning circle of road, on its kerb, under the U-turn; drawn only)
    for (const d of deadEndTurnarounds(sk)) {
      const h = d.level * LEVEL_H;
      kerb.polygon(circlePts(d.c, d.r + KERB / 2), [], on(h + Y.kerb));
      asphalt.polygon(circlePts(d.c, d.r), [], on(h + Y.asphalt));
    }
  }
  if (layers.surfaces && layers.markings) {
    // the lines between lanes (dashed or not), the centre line in its yellow
    for (const m of roadMarkings(sk)) {
      const to = m.kind === "center" ? yellow : paint;
      // (beside a lane off the ground: at its height point by point, down its ramps)
      if (m.lane && m.at) {
        const hs = m.at.map(s => shownZ(sk, m.lane!, s) * LEVEL_H + GL(m.lane!, s)), line = m.pts.map((p, i) => ({ ...p, h: hs[i] }));
        for (const part of m.dashed ? dashes(line, 3, 4) : [line]) to.ribbon(part, part.map(p => p.h), PAINT_W, Y.paint);
        continue;
      }
      const h = (m.level ?? 0) * LEVEL_H, line = simplify(m.pts, TOL);
      for (const part of m.dashed ? dashes(line, 3, 4) : [line]) to.ribbon(part, part.map(p => h + G(p)), PAINT_W, Y.paint);
    }
    for (const a of turnArrows(sk)) { const g = G(a.p); for (const line of arrowLines(a.p, a.d, a.turns)) paint.ribbon(line, line.map(() => a.level * LEVEL_H + g), 0.18, Y.paint); }
    // speed bumps: their bodies raised by their height (red), their markings on top (white, or a short bump's yellow), on the ground
    for (const x of sk.bumps ?? []) {
      const sh = bumpShapes(x), top = Y.asphalt + x.height / 100;
      for (const b of sh.body) red.polygon(b, [], on(top));
      for (const m of sh.marks) (sh.markColor === "#ffffff" ? paint : yellow).polygon(m, [], on(top + 0.01));
    }
    // zebras: stripes along the traffic (or turned as it says), across the road, cut to its shape (on a table: on top of it)
    for (const x of sk.crossings ?? []) {
      const on2 = on, table = (sk.bumps ?? []).find(b => b.kind === "table" && Math.hypot((x.a.x + x.b.x) / 2 - (b.a.x + b.b.x) / 2, (x.a.y + x.b.y) / 2 - (b.a.y + b.b.y) / 2) < b.length / 2);
      for (const bar of crossingStripes(x)) paint.polygon(bar, [], on2(Y.paint + (table ? table.height / 100 : 0)));
    }
  }
  if (layers.signs) {
    // a stop line across a lane's end, a yield its row of triangles
    // (a lane both ways' way back's too, at the lane's start, ticket #53)
    for (const l of sk.lanes.flatMap(x => (twoWayOk(x) ? [x, twinOf(x)] : [x]))) {
      if (!l.control || isFullCircle(l.shape)) continue;
      const L = laneLength(l.shape), { p, d } = pointAt(l.shape, L), n = { x: -d.y, y: d.x }, hw = l.width / 2, h = (isTwinId(l.id) ? shownZ(sk, baseLaneId(l.id), 0) * LEVEL_H + GL(baseLaneId(l.id), 0) : shownZ(sk, l.id, L) * LEVEL_H + GL(l.id, L)) + Y.paint;
      if (l.control === "stop") {
        const A = { x: p.x - d.x * 0.5, y: p.y - d.y * 0.5 };
        paint.polygon([{ x: A.x + n.x * hw, y: A.y + n.y * hw }, { x: p.x + n.x * hw, y: p.y + n.y * hw }, { x: p.x - n.x * hw, y: p.y - n.y * hw }, { x: A.x - n.x * hw, y: A.y - n.y * hw }], [], h);
      } else {
        const k = Math.max(2, Math.round(l.width / 0.9)), tw = l.width / k;
        for (let i = 0; i < k; i++) {
          const o = -hw + tw * (i + 0.5), b = { x: p.x + n.x * o, y: p.y + n.y * o };
          paint.polygon([{ x: b.x + n.x * tw * 0.4, y: b.y + n.y * tw * 0.4 }, { x: b.x - d.x * tw * 0.9, y: b.y - d.y * tw * 0.9 }, { x: b.x - n.x * tw * 0.4, y: b.y - n.y * tw * 0.4 }], [], h);
        }
      }
    }
  }
  const lambert = (color: string, offset: number, side: THREE.Side = THREE.FrontSide) => new THREE.MeshLambertMaterial({ color, polygonOffset: true, polygonOffsetFactor: offset, polygonOffsetUnits: offset, side });
  const mats = [lambert(pal.curb, -1, THREE.DoubleSide), lambert(pal.asphalt, -2, THREE.DoubleSide), lambert(pal.mark, -4, THREE.DoubleSide), lambert(pal.divider, -4, THREE.DoubleSide), lambert("#b9b5ab", 0, THREE.DoubleSide), lambert("#dc2626", -4), lambert(mix(pal.asphalt, pal.bike, 0.55), -3, THREE.DoubleSide)];
  const parts: [Mesh, number, "up" | "computed"][] = [[kerb, 0, "up"], [asphalt, 1, "up"], [paint, 2, "up"], [yellow, 3, "up"], [concrete, 4, "computed"], [red, 5, "up"], [bike, 6, "up"]];
  for (const [m, i, nrm] of parts) if (m.idx.length) { const mesh = m.build(mats[i], nrm); mesh.name = ["kerb", "asphalt", "paint", "yellow", "concrete", "red", "bike"][i]; group.add(mesh); }
  return {
    group,
    dispose: () => { for (const o of group.children) (o as THREE.Mesh).geometry.dispose(); for (const m of mats) m.dispose(); },
  };
}

/**
 * The roads with names, to write on them (ticket #262): each along its middle, as wide as its lanes, at its lead
 * lane's height (a point on the middle `s` metres along it as far along the lane, in proportion)
 */
export function streetNameRuns(sk: Sketch): NamedRun[] {
  // (whether there are levels and heights, worked out once: per letter, `laneHeight` would look over every lane each time)
  const levels = hasLevels(sk), heights = hasHeights(sk), base = heights ? groundBase(sk) : 0;
  return sk.roads.flatMap(r => {
    const lead = laneById(sk, r.lanes[0] ?? ""), pts = r.name?.trim() && lead ? roadMiddle(sk, r) : null;
    if (!lead || !pts || pts.length < 2) return [];
    let Lm = 0;
    for (let i = 1; i < pts.length; i++) Lm += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const Ll = laneLength(lead.shape), f = Lm > 0 ? Ll / Lm : 1;
    const width = r.lanes.reduce((a, id) => a + (laneById(sk, id)?.width ?? 0), 0);
    const y = (s: number) => {
      const sl = Math.max(0, Math.min(Ll, s * f));
      return (levels ? shownZ(sk, lead.id, sl) * LEVEL_H : 0) + (heights ? groundAt(sk, lead.id, sl) - base : 0);
    };
    return [{ name: r.name, pts, width, y: levels || heights ? y : () => 0 }];
  });
}

/** a lane's height (m) at `s` metres along it, from the 3D view's ground (`groundBase`) */
export const laneHeight = (sk: Sketch, lane: string, s: number) => shownZ(sk, lane, s) * LEVEL_H + (hasHeights(sk) ? groundAt(sk, lane, s) - groundBase(sk) : 0);
export { laneLevel };
