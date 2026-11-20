/**
 * The sketch's utility networks (ticket #280) in 3D: each line's pipes or cables as tubes through its nodes at their
 * heights (z over the ground there: buried ones under it, overhead cables up on poles), side by side as many as it has;
 * a ball at each node where lines join; a pole down to the ground under each node above it (2 m up or more). Buried
 * lines (and nodes below the ground) are seen through what is over them: see-through and drawn after everything, so
 * they show from above as on a utility map (the plain ground hides nothing: it writes no depth, the asphalt does). x east, y up, z the plan's y. Made again only when the lines (their layers, the ground) change.
 */
import * as THREE from "three";
import type { Pt, Sketch } from "@/lib/lane-sketch";
import { bendable, linePath, linesOf, NET_INFO, netShown, nodeKind, nodeMap, offsetPolyline, strandOffsets, strandWidth, type UtilityLayer } from "@/lib/sketch-utilities";

export interface Utilities3D { group: THREE.Group; dispose(): void }

/** a polyline as a curve whose `t` goes evenly from point to point (not by length), so a tube of n − 1 segments has a ring at each point */
class Through extends THREE.Curve<THREE.Vector3> {
  constructor(private pts: THREE.Vector3[]) { super(); }
  getPoint(t: number, out = new THREE.Vector3()) {
    const f = Math.min(1, Math.max(0, t)) * (this.pts.length - 1), i = Math.min(this.pts.length - 2, Math.floor(f));
    return out.lerpVectors(this.pts[i], this.pts[i + 1], f - i);
  }
  getPointAt(u: number, out?: THREE.Vector3) { return this.getPoint(u, out); }
  /** at a point, the way halfway between the segments either side (the ring square to the bend's middle) */
  getTangent(t: number, out = new THREE.Vector3()) {
    const n = this.pts.length - 1, f = Math.min(1, Math.max(0, t)) * n, i = Math.round(f);
    const a = this.pts[Math.max(0, Math.abs(f - i) < 1e-6 ? i - 1 : Math.floor(f))], b = this.pts[Math.min(n, Math.abs(f - i) < 1e-6 ? i + 1 : Math.floor(f) + 1)];
    return out.subVectors(b, a).normalize();
  }
  getTangentAt(u: number, out?: THREE.Vector3) { return this.getTangent(u, out); }
}

/** thinnest a tube is drawn (m): a cable's real 3 cm would vanish a few metres off */
const MIN_RADIUS = 0.08;
/** poles: under nodes this high (m) or more, this thick */
const POLE_FROM = 2, POLE_RADIUS = 0.15;

/**
 * `layers`: the networks shown; `ground`: the ground's height at a point of the plan (none: flat, at 0); `sel`: the
 * lines selected, a little brighter and thicker; `picked`: the node picked, bigger and in `selColor`
 */
export function buildUtilities3D(sk: Sketch, layers: Partial<Record<UtilityLayer, boolean>>, ground?: (p: Pt) => number, sel: string[] = [], picked: string | null = null, selColor = "#2563eb"): Utilities3D {
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
    // (its path as laid: round its waypoints, ticket #280)
    const path3 = linePath(sk, l, map), plan = path3.map(q => ({ x: q.x, y: q.y })), heights = path3.map(q => g(q) + q.z);
    const look = l.buried ? ghost(l.net, on) : solid(l.net, on);
    for (const off of strandOffsets(l)) {
      const pts = offsetPolyline(plan, off).map((p, i) => new THREE.Vector3(p.x, heights[i], p.y));
      const kept = pts.filter((q, i) => i === 0 || q.distanceToSquared(pts[i - 1]) > 1e-6);
      if (kept.length < 2) continue;
      // (a ring at each of its points exactly: sampled evenly along its length, as a CurvePath is, the rings miss the
      // corners and the tube pinches there)
      const geo = new THREE.TubeGeometry(new Through(kept), kept.length - 1, r, 8, false);
      trash.push(geo);
      const m = new THREE.Mesh(geo, look);
      if (l.buried) m.renderOrder = 10;
      group.add(m);
    }
  }
  // the nodes: a ball at each (bigger where lines join and at a line's ends), a box at a building connector, a pole under
  // those above the ground; the one picked bigger, in the selection's colour
  const ball = new THREE.SphereGeometry(1, 12, 8), box = new THREE.BoxGeometry(1, 1, 1), pole = new THREE.CylinderGeometry(POLE_RADIUS, POLE_RADIUS * 1.3, 1, 8);
  trash.push(ball, box, pole);
  const poleMat = mat("pole", () => new THREE.MeshLambertMaterial({ color: "#7c6a55" }));
  const pickedMat = mat("picked", () => new THREE.MeshBasicMaterial({ color: selColor, depthTest: false, depthWrite: false, transparent: true, opacity: 0.95 }));
  // (the waypoints a pipe bends round are off it: no marker, but the one picked)
  const rounded = new Set(linesOf(sk).filter(l => netShown(layers, l.net)).flatMap(l => [...bendable(sk, l, map)]));
  const ends = new Set(linesOf(sk).filter(l => netShown(layers, l.net)).flatMap(l => [l.nodes[0], l.nodes[l.nodes.length - 1]]));
  for (const [id, k] of used) {
    const n = map.get(id);
    if (!n || (rounded.has(id) && id !== picked && n.z < POLE_FROM)) continue;
    const base = g(n), y = base + n.z, kind = nodeKind(n), on = id === picked;
    const lw = Math.max(...linesOf(sk).filter(l => l.nodes.includes(id)).map(l => Math.max(MIN_RADIUS, strandWidth(l) / 2)));
    const look = on ? pickedMat : n.z < 0 ? ghost(n.net, false) : solid(n.net, false);
    // (a building connector: a box 0.8 m a side, or wider than its pipe; the others a ball, a plain bend smaller)
    const m = new THREE.Mesh(kind === "building" ? box : ball, look);
    const size = kind === "building" ? Math.max(0.8, lw * 3) : (k > 1 || ends.has(id) || kind !== "joint" ? lw * 1.8 : lw * 1.3) * (kind !== "joint" ? 1.5 : 1);
    m.scale.setScalar(size * (on ? 1.6 : 1)); m.position.set(n.x, y, n.y);
    if (n.z < 0 || on) m.renderOrder = on ? 11 : 10;
    group.add(m);
    if (n.z >= POLE_FROM) {
      const p = new THREE.Mesh(pole, poleMat);
      p.scale.set(1, n.z + 0.4, 1); p.position.set(n.x, base + (n.z + 0.4) / 2, n.y);
      group.add(p);
    }
  }
  return { group, dispose: () => trash.forEach(x => x.dispose()) };
}
