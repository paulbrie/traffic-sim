/**
 * The sketch's shapes (ticket #268) in 3D: each its outline filled in its colour (and opacity) on the ground, under
 * the roads (which cover it where they cross), with its border if it has one. x east, y up, z the plan's y. With
 * terrain, each point at the ground's height there. Made again only when the shapes (their layer, the ground) change.
 */
import * as THREE from "three";
import { shapeOpacity, type SketchShape } from "@/lib/sketch-shapes";

/** heights over the ground (m): under the asphalt (0.06), above the zones' tint (0.02); later shapes over earlier ones */
const Y = { fill: 0.03, step: 0.0005, border: 0.045 };

export interface Shapes3D { group: THREE.Group; dispose(): void }

/** `ground`: the ground's height at (x, z) (none: flat, at 0) */
export function buildShapes3D(shapes: SketchShape[], ground?: (x: number, z: number) => number): Shapes3D {
  const group = new THREE.Group(), trash: { dispose(): void }[] = [], g = ground ?? (() => 0);
  shapes.forEach((s, k) => {
    if (s.outline.length < 3) return;
    const v2 = s.outline.map(p => new THREE.Vector2(p.x, p.y)), tris = THREE.ShapeUtils.triangulateShape(v2, []);
    if (!tris.length) return;
    const y = Y.fill + k * Y.step, geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(v2.flatMap(p => [p.x, g(p.x, p.y) + y, p.y]), 3));
    geo.setIndex(tris.flatMap(t => [t[0], t[2], t[1]]));
    const a = shapeOpacity(s), see = a < 1;
    const fill = new THREE.MeshBasicMaterial({ color: s.color, transparent: see, opacity: a, depthWrite: !see, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
    const mesh = new THREE.Mesh(geo, fill);
    // (drawn in their order, the later over the earlier, as in 2D)
    mesh.renderOrder = k;
    group.add(mesh);
    trash.push(geo, fill);
    if (s.border) {
      // (a band of its width along the outline, centred on it, lying on the ground)
      const n = s.outline.length, w = s.border.width / 2, pos: number[] = [], idx: number[] = [];
      for (let i = 0; i < n; i++) {
        const a0 = s.outline[(i + n - 1) % n], p = s.outline[i], b = s.outline[(i + 1) % n];
        const d1 = norm(p.x - a0.x, p.y - a0.y), d2 = norm(b.x - p.x, b.y - p.y);
        // (the mitre at the corner, not longer than 3 half widths)
        let mx = -(d1.y + d2.y), my = d1.x + d2.x;
        const ml = Math.hypot(mx, my) || 1;
        mx /= ml; my /= ml;
        const cos = Math.max(1 / 3, mx * -d2.y + my * d2.x), r = w / cos, yb = g(p.x, p.y) + Y.border + k * Y.step;
        pos.push(p.x + mx * r, yb, p.y + my * r, p.x - mx * r, yb, p.y - my * r);
        const j = (i + 1) % n;
        idx.push(2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1);
      }
      const bg = new THREE.BufferGeometry();
      bg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      bg.setIndex(idx);
      const bm = new THREE.MeshBasicMaterial({ color: s.border.color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const band = new THREE.Mesh(bg, bm);
      band.renderOrder = k;
      group.add(band);
      trash.push(bg, bm);
    }
  });
  return { group, dispose: () => trash.forEach(x => x.dispose()) };
}

const norm = (x: number, y: number) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
