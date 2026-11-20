/**
 * The sketch's marks (ticket #289) in 3D: each a pin standing on the ground where it is (on the terrain if any), a
 * thin pole and a ball in its colour on top; the selected one taller, a ring round its foot. x east, y up, z the
 * plan's y. Made again only when the marks (their layer, the selection, the ground) change.
 */
import * as THREE from "three";
import type { SketchMark } from "@/lib/sketch-marks";

/** metres: the pole's height and radius, the ball's radius */
const POLE = 7, POLE_R = 0.18, HEAD = 1.4;

export interface Marks3D { group: THREE.Group; dispose(): void }

/** `ground`: the ground's height at (x, z) (none: flat, at 0); `sel`: the selected mark */
export function buildMarks3D(marks: SketchMark[], sel: string | null, ground?: (x: number, z: number) => number): Marks3D {
  const group = new THREE.Group(), trash: { dispose(): void }[] = [], g = ground ?? (() => 0);
  const poleGeo = new THREE.CylinderGeometry(POLE_R, POLE_R, 1, 8), headGeo = new THREE.SphereGeometry(HEAD, 18, 12);
  const ringGeo = new THREE.RingGeometry(HEAD * 1.2, HEAD * 1.6, 32).rotateX(-Math.PI / 2);
  const poleMat = new THREE.MeshLambertMaterial({ color: "#f4f4f2" }), ringMat = new THREE.MeshBasicMaterial({ color: "#2563eb", side: THREE.DoubleSide });
  trash.push(poleGeo, headGeo, ringGeo, poleMat, ringMat);
  const mats = new Map<string, THREE.Material>();
  for (const m of marks) {
    const y = g(m.at.x, m.at.y), on = m.id === sel, h = on ? POLE * 1.3 : POLE;
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.scale.y = h; pole.position.set(m.at.x, y + h / 2, m.at.y);
    let mat = mats.get(m.color);
    if (!mat) { mat = new THREE.MeshLambertMaterial({ color: m.color, emissive: m.color, emissiveIntensity: 0.25 }); mats.set(m.color, mat); trash.push(mat); }
    const head = new THREE.Mesh(headGeo, mat);
    head.position.set(m.at.x, y + h + HEAD * 0.8, m.at.y);
    if (on) head.scale.setScalar(1.25);
    group.add(pole, head);
    if (on) { const ring = new THREE.Mesh(ringGeo, ringMat); ring.position.set(m.at.x, y + 0.08, m.at.y); group.add(ring); }
  }
  return { group, dispose: () => trash.forEach(x => x.dispose()) };
}
