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
 * `cabin`: the helicopter as seen from the pilot's seat: only its rotor turning overhead, nothing else in the
 * way of the view ahead and below.
 * `whole`: the whole helicopter, seen from outside.
 */
export async function loadHelicopter(view: "cabin" | "whole" = "cabin", layer = HELI_LAYER): Promise<Helicopter> {
  const model = (await loadModel()).clone(true);
  // the model has its nose towards +z: half a turn puts it towards −z
  model.rotation.y = Math.PI;
  const body = new THREE.Group();
  body.add(model);
  body.updateMatrixWorld(true);
  for (const name of WEAPONS) { const o = model.getObjectByName(name); if (o) o.visible = false; }
  if (view === "cabin") {
    model.traverse(o => { if ((o as THREE.Mesh).isMesh && o.name !== BLADES && o.name !== HEAD) o.visible = false; });
  }

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
        // (what was made here: the rotor's disc; the model's own parts are shared)
        if (m.isMesh && m.geometry.type === "CircleGeometry") { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
      });
    },
  };
}
