/**
 * Streets' names in 3D (ticket #262): written on the road, along its middle, letter by letter following it, as the plan
 * view's (street-label.ts): light with a dark halo. Each letter a quad on the road, all of them in one mesh, their shapes
 * from one atlas of the letters used. Each name is laid out both ways along its road; the GPU picks, frame by frame,
 * the one that reads left to right from where the camera is, and fades out the names too small there to read.
 * x east, y up, z the plan's y.
 */
import * as THREE from "three";

interface Pt { x: number; y: number }

/** a street to name: its middle line (plan metres), how wide it is (m), and the road's height (y) `s` metres along that line */
export interface NamedRun { name: string; pts: Pt[]; width: number; y: (s: number) => number }

export interface StreetNames3D {
  group: THREE.Group;
  /** the drawing's height (CSS px), for how big a name looks */
  setViewport: (h: number) => void;
  dispose: () => void;
}

/** over V2's road paint (0.09 m), by default */
const LIFT = 0.12;
/** the letters' size (m, the font's em) for a road's width */
export const nameSize = (width: number) => Math.max(1.8, Math.min(6, width * 0.55));
/** a name again every so many metres on a long road (at least 5 times its length apart) */
const REPEAT = 180;
/** the atlas: letters drawn this big (px), their halo, the gap between cells */
const FONT_PX = 48, HALO = FONT_PX * 0.22, GAP = 4, ATLAS_W = 1024;

interface Glyph { u0: number; v0: number; u1: number; v1: number; adv: number; w: number; h: number }

/** the letters used, each drawn once with its halo; sizes in em */
function atlas(chars: string[], font: string) {
  const probe = document.createElement("canvas").getContext("2d")!;
  const f = `600 ${FONT_PX}px ${font}`;
  probe.font = f;
  const cellH = Math.ceil(FONT_PX * 1.3 + 2 * HALO);
  const cells: { ch: string; w: number; adv: number; x: number; y: number }[] = [];
  let x = 0, y = 0;
  for (const ch of chars) {
    const m = probe.measureText(ch).width, w = Math.ceil(m + 2 * HALO);
    if (x + w > ATLAS_W) { x = 0; y += cellH + GAP; }
    cells.push({ ch, w, adv: m + FONT_PX * 0.035, x, y });
    x += w + GAP;
  }
  const H = Math.max(1, y + cellH);
  const c = document.createElement("canvas");
  c.width = ATLAS_W; c.height = H;
  const g = c.getContext("2d")!;
  g.font = f; g.textAlign = "center"; g.textBaseline = "middle"; g.lineJoin = "round"; g.lineWidth = HALO;
  // (the halo all round first, then the letters: a letter's halo never over its neighbour's letter)
  for (const pass of [0, 1]) for (const k of cells) {
    const cx = k.x + k.w / 2, cy = k.y + cellH / 2;
    if (pass === 0) { g.strokeStyle = "rgba(20,24,28,0.85)"; g.strokeText(k.ch, cx, cy); }
    else { g.fillStyle = "#f4f1e8"; g.fillText(k.ch, cx, cy); }
  }
  const glyphs = new Map<string, Glyph>();
  for (const k of cells) glyphs.set(k.ch, {
    u0: k.x / ATLAS_W, u1: (k.x + k.w) / ATLAS_W, v1: 1 - k.y / H, v0: 1 - (k.y + cellH) / H,
    adv: k.adv / FONT_PX, w: k.w / FONT_PX, h: cellH / FONT_PX,
  });
  return { canvas: c, glyphs };
}

const vertex = /* glsl */ `
  attribute vec3 flipped;
  attribute vec2 dir;
  attribute float em;
  uniform float viewportH;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    // (the way that reads left to right: the road's direction at the name's middle, pointing right on the screen)
    vec3 d = (viewMatrix * vec4(dir.x, 0.0, dir.y, 0.0)).xyz;
    vec4 mv = modelViewMatrix * vec4(d.x < 0.0 ? flipped : position, 1.0);
    gl_Position = projectionMatrix * mv;
    // (how tall the letters look, in px: faded out below 6, gone below 4)
    float px = em * projectionMatrix[1][1] * viewportH * 0.5 / max(0.001, -mv.z);
    vFade = smoothstep(4.0, 7.0, px);
    vUv = uv;
  }
`;
const fragment = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying float vFade;
  void main() {
    vec4 c = texture2D(map, vUv);
    c.a *= vFade;
    if (c.a < 0.02) discard;
    gl_FragColor = c;
  }
`;

/**
 * The names of `runs`, in `font` (a CSS family); `anisotropy`: the renderer's most, for names seen low down; `lift`: how
 * far over the road (m), over its paint
 */
export function buildStreetNames3D(runs: NamedRun[], font: string, anisotropy = 1, lift = LIFT): StreetNames3D {
  const group = new THREE.Group();
  const chars = [...new Set(runs.flatMap(r => [...r.name]))].filter(ch => ch.trim());
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: null }, viewportH: { value: 800 } }, vertexShader: vertex, fragmentShader: fragment,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
  });
  let tex: THREE.CanvasTexture | null = null, geo: THREE.BufferGeometry | null = null;
  const dispose = () => { tex?.dispose(); geo?.dispose(); material.dispose(); };
  const setViewport = (h: number) => { material.uniforms.viewportH.value = Math.max(1, h); };
  if (!chars.length) return { group, setViewport, dispose };
  const { canvas, glyphs } = atlas(chars, font);
  tex = new THREE.CanvasTexture(canvas);
  tex.anisotropy = anisotropy;
  material.uniforms.map.value = tex;

  const pos: number[] = [], flip: number[] = [], uv: number[] = [], dir: number[] = [], ems: number[] = [], idx: number[] = [];
  for (const r of runs) {
    const pts = r.pts, name = r.name.trim();
    if (pts.length < 2 || !name) continue;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const L = cum[cum.length - 1], em = nameSize(r.width), cs = [...name];
    const advs = cs.map(ch => (glyphs.get(ch)?.adv ?? 0.3) * em), total = advs.reduce((a, b) => a + b, 0);
    if (L < total + 2 * (2 + em)) continue;
    // (a point on the line and its direction there, `s` metres along)
    let k = 1;
    const at = (s: number) => {
      s = Math.max(0, Math.min(L, s));
      while (k < pts.length - 1 && cum[k] < s) k++;
      while (k > 1 && cum[k - 1] > s) k--;
      const a = pts[k - 1], b = pts[k], d = cum[k] - cum[k - 1] || 1, f = (s - cum[k - 1]) / d;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, tx: (b.x - a.x) / d, ty: (b.y - a.y) / d };
    };
    const n = Math.max(1, Math.floor(L / Math.max(REPEAT, total * 5)));
    for (let m = 0; m < n; m++) {
      const mid = (L * (m + 0.5)) / n, c = at(mid);
      // (each letter's four corners, laid out walking `sg` along the line: forwards, or backwards turned round)
      const layout = (sg: 1 | -1) => {
        let s = mid - (sg * total) / 2;
        const out: number[][] = [];
        cs.forEach((ch, i) => {
          s += (sg * advs[i]) / 2;
          const g = glyphs.get(ch), p = at(s), tx = p.tx * sg, ty = p.ty * sg;
          if (g) {
            // (the letter's top: to the left of the way it reads, on the plan as on the screen with y down)
            const hw = (g.w * em) / 2, hh = (g.h * em) / 2, ux = ty, uy = -tx;
            const yl = r.y(s - sg * hw) + lift, yr = r.y(s + sg * hw) + lift;
            out.push(
              [p.x - tx * hw + ux * hh, yl, p.y - ty * hw + uy * hh], [p.x + tx * hw + ux * hh, yr, p.y + ty * hw + uy * hh],
              [p.x + tx * hw - ux * hh, yr, p.y + ty * hw - uy * hh], [p.x - tx * hw - ux * hh, yl, p.y - ty * hw - uy * hh],
            );
          }
          s += (sg * advs[i]) / 2;
        });
        return out;
      };
      const fw = layout(1), bw = layout(-1);
      let gi = 0;
      for (const ch of cs) {
        const g = glyphs.get(ch);
        if (!g) continue;
        const base = pos.length / 3;
        for (let q = 0; q < 4; q++) { pos.push(...fw[gi * 4 + q]); flip.push(...bw[gi * 4 + q]); dir.push(c.tx, c.ty); ems.push(em); }
        uv.push(g.u0, g.v1, g.u1, g.v1, g.u1, g.v0, g.u0, g.v0);
        idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
        gi++;
      }
    }
  }
  if (!idx.length) return { group, setViewport, dispose };
  geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("flipped", new THREE.Float32BufferAttribute(flip, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("dir", new THREE.Float32BufferAttribute(dir, 2));
  geo.setAttribute("em", new THREE.Float32BufferAttribute(ems, 1));
  geo.setIndex(idx);
  // (the bounds over both layouts: culled only when neither is in view)
  geo.computeBoundingSphere();
  const fb = new THREE.Box3().setFromBufferAttribute(geo.getAttribute("flipped") as THREE.BufferAttribute);
  const box = new THREE.Box3().setFromBufferAttribute(geo.getAttribute("position") as THREE.BufferAttribute).union(fb);
  geo.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = "street-names"; mesh.renderOrder = 2;
  group.add(mesh);
  return { group, setViewport, dispose };
}
