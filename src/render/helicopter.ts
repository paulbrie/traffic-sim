import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { basePath } from "@/lib/base-path";

/**
 * The helicopter flown in the 3D view: an MD 500 ("Md 500 war thunder" by torreylee070,
 * https://sketchfab.com/3d-models/md-500-war-thunder-1b21240fb6fb4d228e0dd6847e044b50, CC BY 4.0),
 * compressed with gltf-transform (meshopt geometry, WebP textures at 2048 px), its rocket pods left out.
 *
 * Body frame: metres, y up, the nose towards −z, so a body yaw means what a camera yaw does
 * (0 = facing north). From the pilot's seat the cabin lives on its own layer, drawn in a second pass with
 * a near plane close enough for it; seen from outside, the whole helicopter is drawn with the rest.
 */
export const HELI_MODEL_CREDIT = { title: "MD 500", author: "torreylee070", license: "CC BY 4.0", url: "https://sketchfab.com/3d-models/md-500-war-thunder-1b21240fb6fb4d228e0dd6847e044b50" };
export const HELI_LAYER = 1;
// the right-hand front seat (model x −0.3, half a turn round: +0.3), the eye a little higher and further
// forward than a seated pilot's, to see more over the nose
const EYE = new THREE.Vector3(0.3, 0.45, -1.05);

// parts of the model, by node name: the main rotor's blades and head, the weapons (not on a police helicopter)
const BLADES = "Object_8", HEAD = "Object_20", WEAPONS = ["Object_40", "Object_42", "Object_44", "Object_46"];

export interface Helicopter {
  body: THREE.Group;
  /** the pilot's eye (right-hand seat) in the body frame */
  eye: THREE.Vector3;
  /** turn the main rotor */
  spin(dt: number): void;
  dispose(): void;
}

let pending: Promise<THREE.Group> | null = null;
function loadModel(): Promise<THREE.Group> {
  pending ??= new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`${basePath}/models/md500.glb`).then(g => g.scene);
  return pending;
}

/**
 * Seen from the pilot's seat, the cabin ahead below this height is cut away (instrument panel, the nose's
 * inner wall, controls, pedals) and the clear glass is left out, leaving the bubble's frame: the roof and the
 * posts round the windscreen, so the view ahead and down through the nose stays open.
 * Body frame (nose towards −z): ahead of `z`, under `y`.
 */
export const CABIN_CUT = { y: 0.32, z: -0.55 };

/** `cut`: the cabin as seen from the pilot's seat (see CABIN_CUT); null: the whole helicopter, seen from outside */
export async function loadHelicopter(cut: { y: number; z: number } | null = CABIN_CUT, layer = HELI_LAYER): Promise<Helicopter> {
  const model = (await loadModel()).clone(true);
  // the model has its nose towards +z: half a turn puts it towards −z
  model.rotation.y = Math.PI;
  const body = new THREE.Group();
  body.add(model);
  body.updateMatrixWorld(true);
  for (const name of WEAPONS) { const o = model.getObjectByName(name); if (o) o.visible = false; }
  model.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !cut) return;
    // the clear glass goes too (cut through, its big panes would leave jagged edges): the frame keeps the bubble's shape
    const mat = m.material as THREE.Material;
    if (mat.transparent && mat.opacity < 0.5) m.visible = false;
    else if (m.name !== BLADES && m.name !== HEAD) m.geometry = trimmed(m.geometry, m.matrixWorld, cut);
  });

  // the rotor turns round the middle of its blades (five alike: their mean point is on the mast)
  const blades = model.getObjectByName(BLADES) as THREE.Mesh | undefined, head = model.getObjectByName(HEAD);
  const rotor = new THREE.Group();
  if (blades) {
    const pos = blades.geometry.getAttribute("position"), v = new THREE.Vector3(), sum = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) sum.add(v.fromBufferAttribute(pos, i).applyMatrix4(blades.matrixWorld));
    rotor.position.copy(sum.divideScalar(Math.max(1, pos.count)));
    body.add(rotor);
    rotor.updateMatrixWorld(true);
    rotor.attach(blades);
    if (head) rotor.attach(head);
    // what a camera catches of blades turning faster than it can see: a faint disc
    const r = new THREE.Box3().setFromObject(blades).getSize(v).x / 2;
    const disc = new THREE.Mesh(new THREE.CircleGeometry(r, 64), new THREE.MeshBasicMaterial({ color: 0x0b0c0d, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    rotor.add(disc);
  }
  body.traverse(o => {
    o.layers.set(layer);
    if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; }
  });
  return {
    body,
    eye: EYE.clone(),
    // the real rotor turns about 8 times a second; this slower turn reads as turning on screen instead of strobing
    spin(dt) { rotor.rotation.y -= dt * 1.4 * 2 * Math.PI; },
    dispose() {
      body.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry.type === "CircleGeometry") { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      });
    },
  };
}

/** a copy of the geometry without its triangles ahead of and under the cut (worked out in the body frame) */
function trimmed(geo: THREE.BufferGeometry, toBody: THREE.Matrix4, cut: { y: number; z: number }): THREE.BufferGeometry {
  const pos = geo.getAttribute("position"), index = geo.getIndex();
  const n = index ? index.count : pos.count, at = (i: number) => (index ? index.getX(i) : i);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), keep: number[] = [];
  for (let t = 0; t < n; t += 3) {
    const i = at(t), j = at(t + 1), k = at(t + 2);
    a.fromBufferAttribute(pos, i).applyMatrix4(toBody); b.fromBufferAttribute(pos, j).applyMatrix4(toBody); c.fromBufferAttribute(pos, k).applyMatrix4(toBody);
    const y = (a.y + b.y + c.y) / 3, z = (a.z + b.z + c.z) / 3;
    if (!(z < cut.z && y < cut.y)) keep.push(i, j, k);
  }
  if (keep.length === n) return geo;
  const out = geo.clone();
  out.setIndex(keep);
  return out;
}
