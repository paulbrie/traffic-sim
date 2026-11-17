/**
 * A V2 sketch's buildings in 3D (ticket #267): each footprint stood up to its height, from a little under the ground's
 * lowest under it (on terrain) to its height over the ground's middle there; walls a shade darker than the roof and
 * darker still at their foot, each building's colour a touch off its neighbours' so a row of them reads as several. One
 * mesh for all; `owner[t]`: the building triangle t is of, for hovering. x east, y up, z the plan's y.
 */
import * as THREE from "three";
import { buildingColor, type Palette } from "./palette";
import type { SketchBuildings } from "@/lib/sketch-buildings";

export interface Buildings3D { mesh: THREE.Mesh; owner: Int32Array; dispose: () => void }

/** a small number from an id, the same each time (-1..1) */
function jitter(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 2001) / 1000 - 1;
}

/** `ground(x, z)`: the ground's y there (none: flat, at 0) */
export function buildBuildings3D(bs: SketchBuildings, pal: Palette, ground?: (x: number, z: number) => number): Buildings3D {
  const pos: number[] = [], col: number[] = [], owner: number[] = [];
  const roof = new THREE.Color(), wall = new THREE.Color(), foot = new THREE.Color();
  const v2: THREE.Vector2[] = [];
  bs.list.forEach((b, bi) => {
    const n = b.xy.length / 2;
    if (n < 3) return;
    let lo = 0, mid = 0;
    if (ground) {
      lo = Infinity;
      for (let i = 0; i < n; i++) { const g = ground(b.xy[2 * i], b.xy[2 * i + 1]); lo = Math.min(lo, g); mid += g / n; }
      lo -= 0.5;
    }
    const y0 = lo, y1 = mid + b.h;
    const k = 1 + jitter(b.id) * 0.05;
    roof.set(buildingColor(pal, b.use ?? "other")).multiplyScalar(k);
    wall.copy(roof).multiplyScalar(0.88); foot.copy(roof).multiplyScalar(0.7);
    const start = pos.length / 9;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, ax = b.xy[2 * i], az = b.xy[2 * i + 1], cx = b.xy[2 * j], cz = b.xy[2 * j + 1];
      pos.push(ax, y0, az, cx, y0, cz, cx, y1, cz, ax, y0, az, cx, y1, cz, ax, y1, az);
      for (const c of [foot, foot, wall, foot, wall, wall]) col.push(c.r, c.g, c.b);
    }
    v2.length = 0;
    for (let i = 0; i < n; i++) v2.push(new THREE.Vector2(b.xy[2 * i], b.xy[2 * i + 1]));
    for (const [i, j, l] of THREE.ShapeUtils.triangulateShape(v2, [])) {
      pos.push(v2[i].x, y1, v2[i].y, v2[j].x, y1, v2[j].y, v2[l].x, y1, v2[l].y);
      for (let q = 0; q < 3; q++) col.push(roof.r, roof.g, roof.b);
    }
    for (let t = start; t < pos.length / 9; t++) owner[t] = bi;
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = "buildings";
  return { mesh, owner: Int32Array.from(owner), dispose: () => { g.dispose(); mat.dispose(); } };
}
