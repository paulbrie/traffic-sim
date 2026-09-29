/** Builds three.js meshes for roads, junctions and street furniture from the shared road geometry. */
import * as THREE from "three";
import type { Poly } from "@/engine/geom";
import type { BuildingDef, Vec } from "@/engine/types";
import type { RoadGeo, Strip } from "./geometry";
import { buildingColor, type Palette } from "./palette";

class Batch {
  pos: number[] = [];
  push(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, h: number) {
    this.pos.push(ax, h, ay, bx, h, by, cx, h, cy);
  }
  quad(a: Vec, b: Vec, c: Vec, d: Vec, h: number) { this.push(a.x, a.y, b.x, b.y, c.x, c.y, h); this.push(a.x, a.y, c.x, c.y, d.x, d.y, h); }
  strip(s: Strip, h: number) {
    const L = s.left.pts, R = s.right.pts, n = Math.min(L.length, R.length) / 2;
    for (let k = 0; k < n - 1; k++) {
      this.quad({ x: L[2 * k], y: L[2 * k + 1] }, { x: L[2 * k + 2], y: L[2 * k + 3] }, { x: R[2 * k + 2], y: R[2 * k + 3] }, { x: R[2 * k], y: R[2 * k + 1] }, h);
    }
  }
  polygon(pts: Vec[], h: number) {
    // ear clipping, so rounded (concave) junction outlines fill correctly too
    const contour = pts.map(p => new THREE.Vector2(p.x, p.y));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) this.push(pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[c].x, pts[c].y, h);
  }
  disk(c: Vec, r: number, h: number, seg = 48) {
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
      this.push(c.x, c.y, c.x + Math.cos(a0) * r, c.y + Math.sin(a0) * r, c.x + Math.cos(a1) * r, c.y + Math.sin(a1) * r, h);
    }
  }
  /** thin band along a polyline, optionally dashed */
  line(poly: Poly, width: number, h: number, dash?: [number, number]) {
    const len = poly.len;
    const seg = (s0: number, s1: number) => {
      const steps = Math.max(1, Math.ceil((s1 - s0) / 2));
      for (let k = 0; k < steps; k++) {
        const a = s0 + ((s1 - s0) * k) / steps, b = s0 + ((s1 - s0) * (k + 1)) / steps;
        const pa = poly.at(a), pb = poly.at(b), t = poly.tangent((a + b) / 2), nx = -t.y * width / 2, ny = t.x * width / 2;
        this.quad({ x: pa.x - nx, y: pa.y - ny }, { x: pb.x - nx, y: pb.y - ny }, { x: pb.x + nx, y: pb.y + ny }, { x: pa.x + nx, y: pa.y + ny }, h);
      }
    };
    if (!dash) { seg(0, len); return; }
    for (let s = 0; s < len; s += dash[0] + dash[1]) seg(s, Math.min(len, s + dash[0]));
  }
  mesh(color: string, opts: { transparent?: boolean; opacity?: number } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.computeVertexNormals();
    const m = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, transparent: !!opts.transparent, opacity: opts.opacity ?? 1 });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    return mesh;
  }
}

export interface Furniture {
  group: THREE.Group;
  heads: { mesh: THREE.Mesh; nodeIdx: number; arm: number; lane?: number }[];
  labels: { sprite: THREE.Sprite; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; id: string }[];
}

export function buildRoads(geo: RoadGeo, pal: Palette): THREE.Group {
  const g = new THREE.Group();
  const curb = new Batch(), asphalt = new Batch(), bus = new Batch(), mark = new Batch(), yellow = new Batch();
  for (const s of geo.surfaces) { curb.strip(s.curb, 0.04); asphalt.strip(s.asphalt, 0.1); }
  for (const j of geo.junctions) {
    if (j.polygon.length >= 3) { curb.polygon(j.polygon, 0.045); asphalt.polygon(j.polygon, 0.105); }
    if (j.ring) { asphalt.disk(j.ring.c, j.ring.r + 2.4, 0.107); curb.disk(j.ring.c, j.ring.r + 3, 0.047); }
    if (j.deadEnd) { asphalt.disk(j.deadEnd.c, j.deadEnd.r, 0.107); curb.disk(j.deadEnd.c, j.deadEnd.r + 0.6, 0.047); }
  }
  for (const b of geo.busBands) bus.strip(b, 0.16);
  for (const l of geo.lines) {
    if (l.kind === "center") yellow.line(l.poly, 0.16, 0.2, l.dashed ? [3, 4] : undefined);
    else mark.line(l.poly, l.kind === "bus" ? 0.22 : 0.15, 0.2, l.dashed ? [3, 4] : undefined);
  }
  for (const s of geo.stopLines) {
    const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, L = Math.hypot(dx, dy) || 1, tx = -dy / L * 0.25, ty = dx / L * 0.25;
    if (s.kind === "yield") {
      for (let f = 0; f < 1; f += 0.25) {
        const a = { x: s.a.x + dx * f, y: s.a.y + dy * f }, b = { x: s.a.x + dx * (f + 0.14), y: s.a.y + dy * (f + 0.14) };
        mark.quad({ x: a.x - tx, y: a.y - ty }, { x: b.x - tx, y: b.y - ty }, { x: b.x + tx, y: b.y + ty }, { x: a.x + tx, y: a.y + ty }, 0.2);
      }
    } else {
      mark.quad({ x: s.a.x - tx, y: s.a.y - ty }, { x: s.b.x - tx, y: s.b.y - ty }, { x: s.b.x + tx, y: s.b.y + ty }, { x: s.a.x + tx, y: s.a.y + ty }, 0.2);
    }
  }
  g.add(curb.mesh(pal.curb), asphalt.mesh(pal.asphalt), bus.mesh(pal.bus), mark.mesh(pal.mark), yellow.mesh(pal.divider));
  for (const j of geo.junctions) if (j.ring) {
    const ir = Math.max(2, j.ring.r - 2.4);
    const isl = new THREE.Mesh(new THREE.CylinderGeometry(ir, ir + 0.2, 0.35, 40), new THREE.MeshLambertMaterial({ color: pal.island }));
    isl.position.set(j.ring.c.x, 0.18, j.ring.c.y); isl.receiveShadow = true; g.add(isl);
    const crown = new THREE.Mesh(new THREE.SphereGeometry(Math.min(2.2, ir * 0.5), 14, 10), new THREE.MeshLambertMaterial({ color: pal.island }));
    crown.position.set(j.ring.c.x, 3, j.ring.c.y); crown.castShadow = true; g.add(crown);
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 2, 8), new THREE.MeshLambertMaterial({ color: "#6b5a44" }));
    trunk.position.set(j.ring.c.x, 1.2, j.ring.c.y); g.add(trunk);
  }
  return g;
}

export function buildFurniture(geo: RoadGeo, pal: Palette, sigMats: Record<"green" | "yellow" | "red" | "off", THREE.Material>): Furniture {
  const group = new THREE.Group();
  const heads: Furniture["heads"] = [];
  const labels: Furniture["labels"] = [];
  const pole = new THREE.MeshLambertMaterial({ color: "#3e444b" });
  const masts = new Set<string>();
  for (const s of geo.signals) {
    if (s.kind === "lights" && s.lane !== undefined && s.pole) {
      // mast at the kerb with an arm over the lanes; one head above each lane
      const key = `${s.nodeIdx}:${s.arm}`;
      if (!masts.has(key)) {
        masts.add(key);
        const lanes = geo.signals.filter(x => x.nodeIdx === s.nodeIdx && x.arm === s.arm && x.lane !== undefined);
        const far = lanes.reduce((a, x) => (Math.hypot(x.p.x - s.pole!.x, x.p.y - s.pole!.y) > Math.hypot(a.p.x - s.pole!.x, a.p.y - s.pole!.y) ? x : a), s);
        const p = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 6.2, 6), pole); p.position.set(s.pole.x, 3.1, s.pole.y); p.castShadow = true;
        const dx = far.p.x - s.pole.x, dy = far.p.y - s.pole.y, len = Math.hypot(dx, dy) + 0.6;
        const bar = new THREE.Mesh(new THREE.BoxGeometry(len, 0.16, 0.16), pole);
        bar.position.set(s.pole.x + dx / 2, 6.1, s.pole.y + dy / 2); bar.rotation.y = -Math.atan2(dy, dx); bar.castShadow = true;
        group.add(p, bar);
      }
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.3, 0.6), pole); box.position.set(s.p.x, 5.35, s.p.y); box.castShadow = true;
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.42, 0.66), sigMats.off); lamp.position.set(s.p.x, 5.45, s.p.y);
      group.add(box, lamp);
      heads.push({ mesh: lamp, nodeIdx: s.nodeIdx, arm: s.arm, lane: s.lane });
      continue;
    }
    if (s.kind === "lights") {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 5, 6), pole); p.position.set(s.p.x, 2.5, s.p.y); p.castShadow = true;
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.7), pole); box.position.set(s.p.x, 5.2, s.p.y); box.castShadow = true;
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.55, 0.76), sigMats.off); lamp.position.set(s.p.x, 5.35, s.p.y);
      group.add(p, box, lamp);
      heads.push({ mesh: lamp, nodeIdx: s.nodeIdx, arm: s.arm });
    } else {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.3, 6), pole); p.position.set(s.p.x, 1.15, s.p.y);
      const yieldSign = s.kind === "yield";
      // octagon for stop, point-down triangle for give way
      const sg = new THREE.CylinderGeometry(yieldSign ? 0.7 : 0.55, yieldSign ? 0.7 : 0.55, 0.06, yieldSign ? 3 : 8); sg.rotateX(Math.PI / 2); sg.rotateZ(yieldSign ? Math.PI / 2 : Math.PI / 8);
      const sign = new THREE.Mesh(sg, new THREE.MeshLambertMaterial({ color: yieldSign ? "#f4f4f2" : pal.stop })); sign.position.set(s.p.x, 2.5, s.p.y);
      sign.lookAt(s.p.x - s.dir.x, 2.5, s.p.y - s.dir.y);
      group.add(p, sign);
    }
  }
  for (const s of geo.stops) {
    const ang = Math.atan2(s.dir.y, s.dir.x);
    const shelter = new THREE.Group();
    const roof = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.12, 1.5), pole); roof.position.y = 2.5; roof.castShadow = true;
    const back = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.3, 0.08), new THREE.MeshLambertMaterial({ color: s.color, transparent: true, opacity: 0.85 }));
    back.position.set(0, 1.2, 0.65);
    shelter.add(roof, back);
    shelter.position.set(s.p.x, 0, s.p.y); shelter.rotation.y = -ang;
    group.add(shelter);
    const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 64;
    const tex = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    sprite.position.set(s.p.x, 5.5, s.p.y); sprite.scale.set(9, 2.25, 1);
    group.add(sprite);
    labels.push({ sprite, canvas, tex, id: s.id });
  }
  return { group, heads, labels };
}

/** walls and roof of one footprint, as triangles (x, height, y) */
function extrude(b: BuildingDef, pos: number[], lift = 0, grow = 0) {
  let pts = b.pts;
  if (grow) {
    const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length, cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    pts = pts.map(p => { const d = Math.hypot(p.x - cx, p.y - cy) || 1; return { x: p.x + ((p.x - cx) / d) * grow, y: p.y + ((p.y - cy) / d) * grow }; });
  }
  const h = b.height + lift, n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], c = pts[(i + 1) % n];
    pos.push(a.x, 0, a.y, c.x, 0, c.y, c.x, h, c.y, a.x, 0, a.y, c.x, h, c.y, a.x, h, a.y);
  }
  const tris = THREE.ShapeUtils.triangulateShape(pts.map(p => new THREE.Vector2(p.x, p.y)), []);
  for (const [i, j, k] of tris) pos.push(pts[i].x, h, pts[i].y, pts[j].x, h, pts[j].y, pts[k].x, h, pts[k].y);
  return 2 * n + tris.length;
}

/**
 * All buildings as one mesh (walls a shade darker than roofs). `owner[t]` is the index of the
 * building triangle t belongs to, for picking.
 */
export function buildBuildings(list: BuildingDef[], pal: Palette): { mesh: THREE.Mesh; owner: Int32Array } {
  const pos: number[] = [], col: number[] = [], owner: number[] = [];
  const roof = new THREE.Color(), wall = new THREE.Color();
  list.forEach((b, bi) => {
    const start = pos.length / 9;
    const nWallTris = 2 * b.pts.length;
    const tris = extrude(b, pos);
    roof.set(buildingColor(pal, b.use)); wall.copy(roof).multiplyScalar(0.86);
    for (let t = 0; t < tris; t++) {
      const c = t < nWallTris ? wall : roof;
      col.push(c.r, c.g, c.b, c.r, c.g, c.b, c.r, c.g, c.b);
      owner[start + t] = bi;
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  mesh.castShadow = true; mesh.receiveShadow = true;
  return { mesh, owner: Int32Array.from(owner) };
}

/** slightly larger shell around one building, for the selection highlight */
export function buildingShell(b: BuildingDef): THREE.BufferGeometry {
  const pos: number[] = [];
  extrude(b, pos, 0.4, 0.4);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
