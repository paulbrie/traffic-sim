/**
 * The V2 plan (a lane sketch) in 3D: three.js meshes made from what the plan view draws (lane-sketch.ts's pure
 * functions): the road surfaces (each lane's band, with its kerb) and the junctions' (drawn outlines, smoothed loops or
 * bands, and the ground they shut in), the links between road ends, the markings, the turn arrows, the stop and yield
 * lines and the zebras; each at its height (bridges and underpasses: `zAt` levels of LEVEL_H metres, as V1), bridges with
 * their sides and pillars. A few merged meshes, made again only when the sketch changes. x east, y up, z the plan's y.
 */
import * as THREE from "three";
import { arrowGlyph } from "@/render/draw2d";
import type { Palette } from "@/render/palette";
import type { SketchLayers } from "@/state/sketch-layers";
import { LEVEL_H } from "@/engine/compile";
import {
  bandPolygon, crossingFrame, isFullCircle, junctionBands, junctionHoles, junctionLevel, laneLevel, laneLength, linkGeometry,
  outlinePath, pointAt, roadMarkings, samples, smoothJunction, turnArrows, zAt,
  type JunctionContents, type Pt, type Sketch,
} from "@/lib/lane-sketch";

/** heights over the ground (m) the layers lie at, so they don't fight */
const Y = { kerb: 0.04, asphalt: 0.06, paint: 0.09 };
const KERB = 0.6, PAINT_W = 0.16, DECK = 0.8, PARAPET = 0.9;

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
  /** a flat polygon (its holes cut out) at height `y` */
  polygon(outer: Pt[], holes: Pt[][], y: number) {
    if (outer.length < 3) return;
    const v2 = (ps: Pt[]) => ps.map(p => new THREE.Vector2(p.x, p.y));
    const o = v2(outer), hs = holes.filter(h => h.length >= 3).map(v2);
    const tris = THREE.ShapeUtils.triangulateShape(o, hs), all = [o, ...hs].flat(), base = this.pos.length / 3;
    for (const p of all) this.pos.push(p.x, y, p.y);
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

/** a lane's points every `step` metres, with their heights */
function laneLine(sk: Sketch, id: string, shape: Parameters<typeof samples>[0], step: number) {
  const pts = samples(shape, step), hs: number[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) { if (i) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); hs.push(zAt(sk, id, s) * LEVEL_H); }
  return { pts, hs };
}
/** dashes along a polyline: `on` metres drawn, `off` left */
function dashes(pts: Pt[], on: number, off: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [], phase = 0, drawing = true;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let left = Math.hypot(b.x - a.x, b.y - a.y);
    while (left > 1e-6) {
      const room = (drawing ? on : off) - phase, step = Math.min(room, left), t = step / left;
      const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
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
  const red = new Mesh();
  const cOf = (id: string) => contents.get(id) ?? { lanes: [], connectors: [], roads: [] };
  if (layers.surfaces) {
    // each lane's band, on its kerb; a bridge's sides and pillars where it is up
    for (const l of sk.lanes) {
      if (laneLength(l.shape) < 0.3) continue;
      const ring = isFullCircle(l.shape), { pts, hs } = laneLine(sk, l.id, l.shape, 1);
      kerb.ribbon(pts, hs, l.width + KERB, Y.kerb, ring);
      asphalt.ribbon(pts, hs, l.width, Y.asphalt, ring);
      if (hs.some(h => h > 0.5)) {
        const hw = (l.width + KERB) / 2;
        let since = 0;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], ha = hs[i - 1], hb = hs[i];
          since += Math.hypot(b.x - a.x, b.y - a.y);
          if (ha < 0.5 && hb < 0.5) continue;
          const dx = b.x - a.x, dz = b.y - a.y, m = Math.hypot(dx, dz) || 1, nx = (-dz / m) * hw, nz = (dx / m) * hw;
          for (const sgn of [1, -1]) {
            const ax = a.x + nx * sgn, az = a.y + nz * sgn, bx = b.x + nx * sgn, bz = b.y + nz * sgn;
            // (the deck's edge below, the parapet above)
            concrete.quad([ax, ha - DECK, az], [bx, hb - DECK, bz], [bx, hb + PARAPET, bz], [ax, ha + PARAPET, az]);
            concrete.quad([ax, ha + PARAPET, az], [bx, hb + PARAPET, bz], [bx, hb - DECK, bz], [ax, ha - DECK, az]);
          }
          // (its underside)
          concrete.quad([a.x - nx, ha - DECK, a.y - nz], [b.x - nx, hb - DECK, b.y - nz], [b.x + nx, hb - DECK, b.y + nz], [a.x + nx, ha - DECK, a.y + nz]);
          if (since >= 25 && ha > 3) {
            since = 0;
            const s2 = 0.5;
            for (const [cx, cz] of [[a.x, a.y]]) {
              const top = ha - DECK, P = (x: number, z: number, y: number) => [cx + x, y, cz + z];
              concrete.quad(P(-s2, -s2, 0), P(s2, -s2, 0), P(s2, -s2, top), P(-s2, -s2, top));
              concrete.quad(P(s2, s2, 0), P(-s2, s2, 0), P(-s2, s2, top), P(s2, s2, top));
              concrete.quad(P(s2, -s2, 0), P(s2, s2, 0), P(s2, s2, top), P(s2, -s2, top));
              concrete.quad(P(-s2, s2, 0), P(-s2, -s2, 0), P(-s2, -s2, top), P(-s2, s2, top));
            }
          }
        }
      }
    }
    // the junctions: drawn outlines, smoothed loops, or their bands; and the ground they shut in
    for (const j of sk.junctions) {
      if (j.outline.length < 3) continue;
      const c = cOf(j.id), h = junctionLevel(sk, c) * LEVEL_H;
      if (j.shape !== "auto") { asphalt.polygon(outlinePath(j), [], h + Y.asphalt); continue; }
      if (j.smooth) { const [outer, ...holes] = smoothJunction(sk, j, c); if (outer) asphalt.polygon(outer, holes, h + Y.asphalt); }
      else for (const b of junctionBands(sk, c)) {
        if (b.w1 !== undefined) asphalt.polygon(bandPolygon(b), [], h + Y.asphalt);
        else asphalt.ribbon(b.pts, b.pts.map(() => h), b.width, Y.asphalt, b.closed);
      }
      for (const hole of junctionHoles(sk, c)) asphalt.polygon(hole, [], h + Y.asphalt);
    }
    for (const k of sk.links ?? []) { const g = linkGeometry(sk, k); if (g) asphalt.polygon(g.outline, [], Y.asphalt); }
  }
  if (layers.surfaces && layers.markings) {
    // the lines between lanes (dashed or not), the centre line in its yellow
    for (const m of roadMarkings(sk)) {
      const h = (m.level ?? 0) * LEVEL_H, to = m.kind === "center" ? yellow : paint;
      for (const part of m.dashed ? dashes(m.pts, 3, 4) : [m.pts]) to.ribbon(part, part.map(() => h), PAINT_W, Y.paint);
    }
    for (const a of turnArrows(sk)) for (const line of arrowLines(a.p, a.d, a.turns)) paint.ribbon(line, line.map(() => a.level * LEVEL_H), 0.18, Y.paint);
    // zebras: stripes along the traffic, across the road
    for (const x of sk.crossings ?? []) {
      const f = crossingFrame(x), hw = x.width / 2;
      for (let t = 0.3; t + 0.5 <= f.len; t += 1) {
        const P = (s: number, o: number) => ({ x: x.a.x + f.u.x * s + f.v.x * o, y: x.a.y + f.u.y * s + f.v.y * o });
        paint.polygon([P(t, -hw), P(t + 0.5, -hw), P(t + 0.5, hw), P(t, hw)], [], Y.paint);
      }
    }
  }
  if (layers.signs) {
    // a stop line across a lane's end, a yield its row of triangles
    for (const l of sk.lanes) {
      if (!l.control || isFullCircle(l.shape)) continue;
      const L = laneLength(l.shape), { p, d } = pointAt(l.shape, L), n = { x: -d.y, y: d.x }, hw = l.width / 2, h = zAt(sk, l.id, L) * LEVEL_H + Y.paint;
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
  const mats = [lambert(pal.curb, -1, THREE.DoubleSide), lambert(pal.asphalt, -2, THREE.DoubleSide), lambert(pal.mark, -4, THREE.DoubleSide), lambert(pal.divider, -4, THREE.DoubleSide), lambert("#b9b5ab", 0, THREE.DoubleSide), lambert("#dc2626", -4)];
  const parts: [Mesh, number, "up" | "computed"][] = [[kerb, 0, "up"], [asphalt, 1, "up"], [paint, 2, "up"], [yellow, 3, "up"], [concrete, 4, "computed"], [red, 5, "up"]];
  for (const [m, i, nrm] of parts) if (m.idx.length) { const mesh = m.build(mats[i], nrm); mesh.name = ["kerb", "asphalt", "paint", "yellow", "concrete", "red"][i]; group.add(mesh); }
  return {
    group,
    dispose: () => { for (const o of group.children) (o as THREE.Mesh).geometry.dispose(); for (const m of mats) m.dispose(); },
  };
}

/** a lane's height (m) at `s` metres along it */
export const laneHeight = (sk: Sketch, lane: string, s: number) => zAt(sk, lane, s) * LEVEL_H;
export { laneLevel };
