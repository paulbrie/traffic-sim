/**
 * The V2 plan's zones (T129) in 3D: each a flat tinted area on the ground, under the roads (which cover it
 * where they cross), with a dashed border in its colour and its name floating over it. x east, y up, z the
 * plan's y. Made again only when the zones (or their layer) change.
 */
import * as THREE from "three";
import { zoneLabelPoint, type SketchZone } from "@/lib/sketch-zones";

/** heights over the ground (m): the tint under the asphalt (0.06), the border on it, the name over the area */
const Y = { fill: 0.02, border: 0.03, label: 6 };
/** the name's height (m); its width follows the text */
const LABEL_H = 3.2;

export interface Zones3D { group: THREE.Group; dispose(): void }

/** a zone's name as a sprite: white bold text on a dark pill, readable over imagery */
function nameSprite(name: string, color: string): { sprite: THREE.Sprite; dispose: () => void } {
  const scale = 4, font = `600 ${16 * scale}px ui-sans-serif, system-ui, sans-serif`;
  const probe = document.createElement("canvas").getContext("2d")!;
  probe.font = font;
  const tw = Math.ceil(probe.measureText(name).width), pad = 10 * scale, h = 28 * scale;
  const c = document.createElement("canvas");
  c.width = tw + 2 * pad; c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(15,23,42,0.78)"; g.beginPath(); g.roundRect(0, 0, c.width, h, h / 2); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(pad * 0.75, h / 2, 4 * scale, 0, Math.PI * 2); g.fill();
  g.font = font; g.fillStyle = "#ffffff"; g.textBaseline = "middle"; g.fillText(name, pad * 1.4, h / 2 + scale);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set((LABEL_H * c.width) / h, LABEL_H, 1);
  return { sprite, dispose: () => { tex.dispose(); mat.dispose(); } };
}

export function buildZones3D(zones: SketchZone[]): Zones3D {
  const group = new THREE.Group();
  const trash: { dispose(): void }[] = [];
  for (const z of zones) {
    if (z.outline.length < 3) continue;
    // the tint: the polygon triangulated, lying on the ground
    const v2 = z.outline.map(p => new THREE.Vector2(p.x, p.y));
    const tris = THREE.ShapeUtils.triangulateShape(v2, []);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(v2.flatMap(p => [p.x, Y.fill, p.y]), 3));
    geo.setIndex(tris.flatMap(t => [t[0], t[2], t[1]]));
    const fill = new THREE.MeshBasicMaterial({ color: z.color, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 });
    group.add(new THREE.Mesh(geo, fill));
    // the border, dashed
    const line = new THREE.BufferGeometry().setFromPoints(z.outline.map(p => new THREE.Vector3(p.x, Y.border, p.y)));
    const dash = new THREE.LineDashedMaterial({ color: z.color, dashSize: 3, gapSize: 2, transparent: true, opacity: 0.9 });
    const loop = new THREE.LineLoop(line, dash);
    loop.computeLineDistances();
    group.add(loop);
    // the name, over where the plan view puts it
    const at = zoneLabelPoint(z.outline), label = nameSprite(z.name, z.color);
    label.sprite.position.set(at.x, Y.label, at.y);
    group.add(label.sprite);
    trash.push(geo, fill, line, dash, { dispose: label.dispose });
  }
  return { group, dispose: () => trash.forEach(x => x.dispose()) };
}
