/**
 * The sketch's utility networks (ticket #280) in 3D: each line's pipes or cables as tubes through its nodes at their
 * heights (z over the ground there: buried ones under it, overhead cables up on poles), side by side as many as it has;
 * a ball at each node where lines join; a pole down to the ground under each node above it (2 m up or more). Buried
 * lines (and nodes below the ground) are seen through what is over them: see-through and drawn after everything, so
 * they show from above as on a utility map (the plain ground hides nothing: it writes no depth, the asphalt does). x east, y up, z the plan's y. Made again only when the lines (their layers, the ground) change.
 */
import * as THREE from "three";
import type { Pt, Sketch } from "@/lib/lane-sketch";
import { linePts, linesOf, NET_INFO, netShown, nodeMap, offsetPolyline, strandOffsets, strandWidth, type UtilityLayer } from "@/lib/sketch-utilities";

export interface Utilities3D { group: THREE.Group; dispose(): void }

/** thinnest a tube is drawn (m): a cable's real 3 cm would vanish a few metres off */
const MIN_RADIUS = 0.08;
/** poles: under nodes this high (m) or more, this thick */
const POLE_FROM = 2, POLE_RADIUS = 0.15;

/**
 * `layers`: the networks shown; `ground`: the ground's height at a point of the plan (none: flat, at 0); `sel`: the
 * lines selected, a little brighter and thicker
 */
export function buildUtilities3D(sk: Sketch, layers: Partial<Record<UtilityLayer, boolean>>, ground?: (p: Pt) => number, sel: string[] = []): Utilities3D {
  const group = new THREE.Group(), trash: { dispose(): void }[] = [], g = ground ?? (() => 0), map = nodeMap(sk);
  const mats = new Map<string, THREE.Material>();
  const mat = (key: string, make: () => THREE.Material) => { let x = mats.get(key); if (!x) { x = make(); mats.set(key, x); trash.push(x); } return x; };
  const solid = (net: keyof typeof NET_INFO, on: boolean) => mat(`${net}:${on}`, () => new THREE.MeshLambertMaterial({ color: NET_INFO[net].color, emissive: on ? new THREE.Color(NET_INFO[net].color).multiplyScalar(0.45) : new THREE.Color(0) }));
  const ghost = (net: keyof typeof NET_INFO, on: boolean) => mat(`${net}:ghost:${on}`, () => new THREE.MeshBasicMaterial({ color: NET_INFO[net].color, transparent: true, opacity: on ? 0.85 : 0.55, depthTest: false, depthWrite: false }));
  const used = new Map<string, number>();
  for (const l of linesOf(sk)) {
    if (!netShown(layers, l.net)) continue;
    for (const n of new Set(l.nodes)) used.set(n, (used.get(n) ?? 0) + 1);
    const ns = l.nodes.map(id => map.get(id)).filter(n => !!n);
    if (ns.length < 2) continue;
    const on = sel.includes(l.id), r = Math.max(MIN_RADIUS, strandWidth(l) / 2) * (on ? 1.6 : 1);
    const plan = linePts(sk, l, map), heights = ns.map(n => g(n) + n.z);
    const look = l.buried ? ghost(l.net, on) : solid(l.net, on);
    for (const off of strandOffsets(l)) {
      const pts = offsetPolyline(plan, off).map((p, i) => new THREE.Vector3(p.x, heights[i], p.y));
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 1; i < pts.length; i++) if (pts[i].distanceToSquared(pts[i - 1]) > 1e-6) path.add(new THREE.LineCurve3(pts[i - 1], pts[i]));
      if (!path.curves.length) continue;
      const geo = new THREE.TubeGeometry(path, Math.max(1, path.curves.length * 2), r, 8, false);
      trash.push(geo);
      const m = new THREE.Mesh(geo, look);
      if (l.buried) m.renderOrder = 10;
      group.add(m);
    }
  }
  // the nodes: a ball where lines join (and at a line's ends), a pole under those above the ground
  const ball = new THREE.SphereGeometry(1, 12, 8), pole = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS * 1.3, 1, 8);
  trash.push(ball, pole);
  const poleMat = mat("pole", () => new THREE.MeshLambertMaterial({ color: "#7c6a55" }));
  const ends = new Set(linesOf(sk).filter(l => netShown(layers, l.net)).flatMap(l => [l.nodes[0], l.nodes[l.nodes.length - 1]]));
  for (const [id, k] of used) {
    const n = map.get(id);
    if (!n) continue;
    const base = g(n), y = base + n.z;
    if (k > 1 || ends.has(id)) {
      const lw = Math.max(...linesOf(sk).filter(l => l.nodes.includes(id)).map(l => Math.max(MIN_RADIUS, strandWidth(l) / 2)));
      const b = new THREE.Mesh(ball, n.z < 0 ? ghost(n.net, false) : solid(n.net, false));
      b.scale.setScalar(lw * 1.8); b.position.set(n.x, y, n.y);
      if (n.z < 0) b.renderOrder = 10;
      group.add(b);
    }
    if (n.z >= POLE_FROM) {
      const p = new THREE.Mesh(pole, poleMat);
      p.scale.set(1, n.z + 0.4, 1); p.position.set(n.x, base + (n.z + 0.4) / 2, n.y);
      group.add(p);
    }
  }
  return { group, dispose: () => trash.forEach(x => x.dispose()) };
}
