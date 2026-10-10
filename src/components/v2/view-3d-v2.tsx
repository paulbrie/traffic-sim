"use client";

/**
 * The V2 plan in 3D (as V1's view-3d.tsx, in plain three.js): over the plan editor's map while its mode is "3d", the
 * editor staying up underneath (its cars, its state), so the same cars drive here. An orbit camera (drag to turn, right
 * drag to pan, wheel to zoom), arriving over where the plan view was (and eased back there by `home`) and leaving it where the 3D view is; the ground, the
 * satellite imagery where the sketch has a place on Earth, and the reference image. Drawn only while shown and the tab is
 * visible; everything it made is let go when it goes.
 *
 * World axes: x east as on the plan, y up, z the plan's y (south).
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { connectorPts, junctionLevel, laneById, laneLength, outlinePath, pointAt, signalAt, signalPlans, smoothJunction, zAt, type JunctionContents, type Piece, type Pt, type SignalController, type Sketch } from "@/lib/lane-sketch";
import { LEVEL_H } from "@/engine/compile";
import { speedColor } from "@/render/palette";
import { buildSketch3D, type Sketch3D } from "@/render/sketch3d";
import type { SketchLayers } from "@/state/sketch-layers";
import type { Underlay } from "@/lib/underlay";
import { readPalette } from "@/render/palette";
import { satelliteMosaic, type SatSource } from "@/render/satellite";
import type { SatOptions } from "@/state/sat-options";
import type { EditorUi } from "@/state/sketch-ui";

/** the plan view's place: its middle (m) and zoom (px a metre) */
export interface PlanView { cx: number; cy: number; scale: number }
/** what the editor gives the 3D view */
export interface View3DProps {
  sketch: Sketch; contents: Map<string, JunctionContents>; layers: SketchLayers;
  /** what the editor's keys and buttons ask of the 3D view: the whole sketch in view, closer or further, back where it arrived; where the camera is */
  apiRef: React.MutableRefObject<View3DApi | null>;
  /** the camera moved (for the UI store's copy of it) */
  onMove: () => void;
  /** the plan view as it is (where 3D arrives) */
  planView: () => PlanView;
  /** where the plan view should be on leaving 3D */
  onLeave: (v: PlanView) => void;
  satellite: boolean; sat: SatOptions;
  underlay: Underlay | null; underlayImg: HTMLImageElement | null; image: boolean;
  /** the cars as shown now (live, or the moment replayed), coloured by their speed or not, and the lights' state */
  cars: () => Car3D[] | null; bySpeed: boolean;
  simT: () => number | null; signals: () => SignalController[] | null;
  /** what is selected (drawn over the scene at its own height), the car picked (a ring round it) */
  selection: Piece; car: number | null;
  /** the route traced (orange), and a test car's other way (blue) */
  route: { lanes: Set<string>; conns: Set<string>; driven: { lanes: Set<string>; conns: Set<string> } } | null;
  /** a click on the scene at `p`, on level `level` (the highest first): true if it picked something there */
  pickAt: (p: Pt, level: number) => boolean;
  /** a click on nothing */
  pickNone: () => void;
  /** the canvas, for the bridge's screenshot (with a frame drawn just before it is read) */
  canvasRef: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

export interface View3DApi { fit: () => void; dolly: (f: number) => void; home: () => void; camera: () => Camera3DUi }
/** where the camera is (as the UI store keeps it) */
export type Camera3DUi = NonNullable<EditorUi["camera"]>;

const FOV = 40, TILT = (55 * Math.PI) / 180;
/** how long the camera takes back to where it arrived (ms) */
const HOME_MS = 700;
/** a car as the editor shows it: its middle, heading, length, speed as a share of what it wants; a truck's trailer; broken down; its level */
export interface Car3D { p: { x: number; y: number }; d: { x: number; y: number }; len: number; share: number; trailer?: { p: { x: number; y: number }; d: { x: number; y: number }; len: number }; broken?: boolean; z?: number }
/** instances at most: bodies (a truck's cab and trailer two), their glass, hazard lamps */
const MAXV = 24000, MAXL = 4000;
/** how high a car's body is, and a truck's */
const CAR_H = 1.35, CAR_W = 1.8, TRUCK_H = 2.6, TRUCK_W = 2.4, TRAILER_H = 3.2;

export function View3DV2(props: View3DProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  useEffect(() => { live.current = props; });

  useEffect(() => {
    const el = wrap.current!;
    let pal = readPalette();
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    el.appendChild(renderer.domElement);
    renderer.domElement.className = "block size-full";
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(pal.sky);
    scene.fog = new THREE.Fog(pal.sky, 1500, 6000);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 1, 12000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.maxPolarAngle = 1.45; controls.screenSpacePanning = false;
    controls.minDistance = 8; controls.maxDistance = 6000;
    scene.add(new THREE.HemisphereLight(0xffffff, 0x808080, 0.75));
    const sun = new THREE.DirectionalLight(0xffffff, 0.6); sun.position.set(-300, 600, 200); scene.add(sun);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshLambertMaterial({ color: pal.ground }));
    ground.rotation.x = -Math.PI / 2; scene.add(ground);

    // (where the view looks from: over the plan view's middle, as far as shows what it showed across)
    const place = (cx: number, cy: number, across: number) => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1, fitW = across / 2 / Math.tan(((FOV * Math.PI) / 180) / 2) / (w / h);
      const d = Math.max(20, Math.min(5000, fitW));
      controls.target.set(cx, 0, cy);
      camera.position.set(cx, d * Math.sin(TILT), cy + d * Math.cos(TILT));
      controls.update();
    };
    const size = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    size();
    { const v = live.current.planView(), w = el.clientWidth || 1; place(v.cx, v.cy, w / v.scale); }
    // (where it arrived: Escape, with nothing else to do, eases it back there; a drag or the wheel stops that)
    const homeAt = { target: controls.target.clone(), offset: new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)) };
    let homing: { t0: number; target: THREE.Vector3; offset: THREE.Spherical } | null = null;
    const home = () => { homing = { t0: performance.now(), target: controls.target.clone(), offset: new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)) }; };
    const stepHome = (now: number) => {
      if (!homing) return;
      const u = Math.min(1, (now - homing.t0) / HOME_MS), k = u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2, a = homing.offset, b = homeAt.offset;
      // (turning the shorter way round, the distance by its ratio)
      let dt = (b.theta - a.theta) % (2 * Math.PI);
      if (dt > Math.PI) dt -= 2 * Math.PI; else if (dt < -Math.PI) dt += 2 * Math.PI;
      const o = new THREE.Spherical(a.radius * (b.radius / a.radius) ** k, a.phi + (b.phi - a.phi) * k, a.theta + dt * k);
      controls.target.lerpVectors(homing.target, homeAt.target, k);
      camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(o));
      if (u >= 1) homing = null;
    };
    const onStart = () => { homing = null; };
    controls.addEventListener("start", onStart);
    const onChange = () => live.current.onMove();
    controls.addEventListener("change", onChange);
    const cameraNow = (): Camera3DUi => {
      const t = controls.target, r = (x: number) => Math.round(x * 10) / 10;
      return { x: r(t.x), y: r(t.z), distance: r(camera.position.distanceTo(t)), heading: r((((-controls.getAzimuthalAngle() * 180) / Math.PI) % 360 + 360) % 360), tilt: r((controls.getPolarAngle() * 180) / Math.PI) };
    };
    // (the whole sketch in view)
    const fit = () => {
      const sk = live.current.sketch;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of sk.lanes) { const L = laneLength(l.shape); for (let s = 0; s <= L; s += Math.max(1, L / 8)) { const p = pointAt(l.shape, s).p; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } }
      if (!Number.isFinite(x0)) return;
      homing = null;
      place((x0 + x1) / 2, (y0 + y1) / 2, Math.max(60, (x1 - x0) * 1.15, ((y1 - y0) * 1.15 * (el.clientWidth || 1)) / (el.clientHeight || 1)));
    };
    const dolly = (f: number) => {
      homing = null;
      const t = controls.target, d = camera.position.clone().sub(t);
      camera.position.copy(t).add(d.multiplyScalar(Math.min(controls.maxDistance / d.length(), Math.max(controls.minDistance / d.length(), 1 / f))));
      controls.update();
    };
    live.current.apiRef.current = { fit, dolly, home, camera: cameraNow };

    // the roads, junctions and what is painted on them: made again when the sketch (or what shows) changes
    let built: Sketch3D | null = null, builtFor: unknown[] = [];
    const syncRoads = () => {
      const p = live.current, key = [p.sketch, p.contents, p.layers.surfaces, p.layers.markings, p.layers.signs, pal];
      if (built && key.every((x, i) => x === builtFor[i])) return;
      builtFor = key;
      if (built) { scene.remove(built.group); built.dispose(); }
      built = buildSketch3D(p.sketch, p.contents, pal, p.layers);
      scene.add(built.group);
    };

    // the satellite imagery under the sketch (where it has a place on Earth), and the reference image
    const satMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const satMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), satMat);
    satMesh.rotation.x = -Math.PI / 2; satMesh.visible = false; scene.add(satMesh);
    let satKey = "", satGen = 0;
    const syncSat = () => {
      const p = live.current, geo = p.sketch.geo;
      satMesh.visible = !!geo && p.satellite && !!satMat.map;
      if (!geo || !p.satellite) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of p.sketch.lanes) for (const s of [0, laneLength(l.shape)]) { const q = pointAt(l.shape, s).p; x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
      if (!Number.isFinite(x0)) { x0 = y0 = -200; x1 = y1 = 200; }
      const pad = 300, area = { minX: x0 - pad, minY: y0 - pad, maxX: x1 + pad, maxY: y1 + pad }, source: SatSource = p.sat.source;
      const key = `${geo.lat},${geo.lon}:${Math.round(area.minX / 50)},${Math.round(area.minY / 50)},${Math.round(area.maxX / 50)},${Math.round(area.maxY / 50)}:${source}`;
      satMat.color.setScalar(p.sat.brightness);
      if (key === satKey) return;
      satKey = key;
      const gen = ++satGen;
      void satelliteMosaic(geo, area, 4096, source).then(m => {
        if (!m || gen !== satGen || disposed) return;
        satMat.map?.dispose();
        const tex = new THREE.CanvasTexture(m.canvas);
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        satMat.map = tex; satMat.needsUpdate = true;
        satMesh.scale.set(m.rect.maxX - m.rect.minX, m.rect.maxY - m.rect.minY, 1);
        satMesh.position.set((m.rect.minX + m.rect.maxX) / 2, 0.02, (m.rect.minY + m.rect.maxY) / 2);
        satMesh.visible = live.current.satellite;
      });
    };
    const ulMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
    const ulMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ulMat);
    ulMesh.rotation.x = -Math.PI / 2; ulMesh.visible = false; scene.add(ulMesh);
    let ulFor: HTMLImageElement | null = null;
    const syncUnderlay = () => {
      const { underlay: u, underlayImg: img, image } = live.current;
      ulMesh.visible = !!u && !!img && image && u.visible;
      if (!u || !img || !ulMesh.visible) return;
      if (img !== ulFor) { ulMat.map?.dispose(); const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; ulMat.map = t; ulMat.needsUpdate = true; ulFor = img; }
      ulMat.opacity = u.opacity;
      ulMesh.scale.set(u.w * u.mpp, u.h * u.mpp, 1);
      ulMesh.position.set(u.x, 0.04, u.y);
      ulMesh.rotation.z = -(u.rot * Math.PI) / 180;
    };

    // the cars: boxes, one instance each (a truck's cab and its trailer two), a darker box of glass on each car,
    // hazard lamps flashing on those broken down
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const bodies = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXV);
    const glass = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0x1e2830 }), MAXV);
    const lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.22, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffab1a }), MAXL);
    for (const m of [bodies, glass, lamps]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.count = 0; m.frustumCulled = false; scene.add(m); }
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), S = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), C = new THREE.Color();
    const colors = new Map<string, THREE.Color>();
    const colorOf = (css: string) => { let c = colors.get(css); if (!c) colors.set(css, (c = new THREE.Color(css))); return c; };
    const put = (m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, yaw: number, l: number, h: number, w: number) => {
      Q.setFromAxisAngle(UP, yaw); P.set(x, y, z); S.set(l, h, w); M.compose(P, Q, S); m.setMatrixAt(i, M);
    };
    const syncCars = (now: number) => {
      const p = live.current, cars = p.cars() ?? [], flash = Math.floor(now / 400) % 2 === 0;
      let nb = 0, ng = 0, nl = 0;
      for (const c of cars) {
        if (nb + 2 > MAXV) break;
        const y = (c.z ?? 0) * LEVEL_H + 0.06, yaw = -Math.atan2(c.d.y, c.d.x), truck = !!c.trailer;
        const col = p.bySpeed ? speedColor(pal, Math.round(Math.min(1, c.share) * 15) / 15) : truck ? pal.truck : pal.car;
        put(bodies, nb, c.p.x, y + 0.25, c.p.y, yaw, c.len, truck ? TRUCK_H : CAR_H, truck ? TRUCK_W : CAR_W); bodies.setColorAt(nb++, colorOf(col));
        if (c.trailer) { const t = c.trailer; put(bodies, nb, t.p.x, y + 0.5, t.p.y, -Math.atan2(t.d.y, t.d.x), t.len, TRAILER_H, TRUCK_W); bodies.setColorAt(nb++, colorOf("#e9e6dd")); }
        else { put(glass, ng++, c.p.x - c.d.x * c.len * 0.05, y + 0.25 + CAR_H * 0.55, c.p.y - c.d.y * c.len * 0.05, yaw, c.len * 0.5, CAR_H * 0.5, CAR_W * 0.92); }
        if (c.broken && flash && nl + 4 <= MAXL) {
          const n = { x: -c.d.y, y: c.d.x }, hl = c.len / 2, hw = (truck ? TRUCK_W : CAR_W) / 2 + 0.05;
          for (const [f, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { P.set(c.p.x + c.d.x * hl * f + n.x * hw * s2, y + 0.9, c.p.y + c.d.y * hl * f + n.y * hw * s2); M.makeTranslation(P.x, P.y, P.z); lamps.setMatrixAt(nl++, M); }
        }
      }
      bodies.count = nb; glass.count = ng; lamps.count = nl;
      bodies.instanceMatrix.needsUpdate = true; glass.instanceMatrix.needsUpdate = true; lamps.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    };

    // the traffic lights: a pole and a head beside each lane held by them, at its end, lit as the cars see them
    const poleGeo = new THREE.CylinderGeometry(0.08, 0.08, 1, 6); poleGeo.translate(0, 0.5, 0);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshLambertMaterial({ color: 0x4b5563 }), 2000);
    const heads = new THREE.InstancedMesh(box, new THREE.MeshBasicMaterial({ color: 0xffffff }), 2000);
    for (const m of [poles, heads]) { m.count = 0; m.frustumCulled = false; scene.add(m); }
    let lights: { junction: string; lane: string; conns: string[] }[] = [], lightsFor: unknown = null;
    const syncLights = () => {
      const sk = live.current.sketch;
      if (lightsFor !== sk) {
        lightsFor = sk; lights = [];
        let n = 0;
        for (const plan of signalPlans(sk)) {
          const held = new Map<string, string[]>();
          for (const id of plan.controlled) { const c = sk.connectors.find(x => x.id === id); if (c) held.set(c.from.lane, [...(held.get(c.from.lane) ?? []), id]); }
          for (const [lane, conns] of held) {
            const l = laneById(sk, lane);
            if (!l || n >= 2000) continue;
            const L = laneLength(l.shape), e = pointAt(l.shape, L), r = { x: e.d.y, y: -e.d.x }, o = l.width / 2 + 0.6, h = zAt(sk, lane, L) * LEVEL_H;
            const x = e.p.x + r.x * o, z = e.p.y + r.y * o;
            P.set(x, h, z); S.set(1, 4.2, 1); M.compose(P, Q.identity(), S); poles.setMatrixAt(n, M);
            put(heads, n, x, h + 4.2, z, -Math.atan2(e.d.y, e.d.x), 0.35, 0.9, 0.35);
            lights.push({ junction: plan.junction, lane, conns }); n++;
          }
        }
        poles.count = heads.count = n; poles.instanceMatrix.needsUpdate = heads.instanceMatrix.needsUpdate = true;
      }
      if (!lights.length) return;
      const t = live.current.simT(), ctls = live.current.signals(), plans = signalPlans(sk);
      lights.forEach((x, i) => {
        let st: string | null = null;
        if (t !== null) {
          const ctl = ctls?.find(c => c.plan.junction === x.junction);
          if (ctl) { const ss = x.conns.map(id => ctl.stateAt(id, t)); st = ss.includes("green") ? "green" : ss.includes("amber") ? "amber" : ss.length ? "red" : null; }
          else { const plan = plans.find(p2 => p2.junction === x.junction); st = plan ? signalAt(plan, x.lane, t) : null; }
        }
        heads.setColorAt(i, C.set(st === "green" ? pal.go : st === "amber" ? pal.slow : st === "red" ? pal.stop : "#3f3f46"));
      });
      if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
    };

    // what is selected, drawn over the scene at its own height (a bridge's lane on the bridge), and a ring round the car picked
    const selMat = new THREE.MeshBasicMaterial({ color: pal.select, transparent: true, opacity: 0.5, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -8, polygonOffsetUnits: -8, side: THREE.DoubleSide });
    let overlay: THREE.Mesh | null = null, overlayFor: unknown[] = [];
    const routeMats = [new THREE.MeshBasicMaterial({ color: "#f97316", transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7, side: THREE.DoubleSide }), new THREE.MeshBasicMaterial({ color: "#2563eb", transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7, side: THREE.DoubleSide })];
    let routeMeshes: THREE.Mesh[] = [], routeFor: unknown[] = [];
    const syncRoute = () => {
      const p = live.current, key = [p.route, p.sketch];
      if (key.every((x, i) => x === routeFor[i])) return;
      routeFor = key;
      for (const m of routeMeshes) { scene.remove(m); m.geometry.dispose(); }
      routeMeshes = [];
      if (!p.route) return;
      [{ lanes: [...p.route.lanes], connectors: [...p.route.conns], junctions: [] }, { lanes: [...p.route.driven.lanes], connectors: [...p.route.driven.conns], junctions: [] }].forEach((pc, i) => {
        const g = overlayGeo(pc);
        if (g) { const m = new THREE.Mesh(g, routeMats[i]); m.renderOrder = 1; scene.add(m); routeMeshes.push(m); }
      });
    };
    const syncSelection = () => {
      const p = live.current, key = [p.selection, p.sketch];
      if (key.every((x, i) => x === overlayFor[i])) return;
      overlayFor = key;
      if (overlay) { scene.remove(overlay); overlay.geometry.dispose(); overlay = null; }
      const g = overlayGeo(p.selection);
      if (g) { overlay = new THREE.Mesh(g, selMat); overlay.renderOrder = 2; scene.add(overlay); }
    };
    /** lanes, connectors and junctions as flat shapes just over them, each at its own height */
    const overlayGeo = (sel: Piece): THREE.BufferGeometry | null => {
      const p = live.current, sk = p.sketch, pos: number[] = [], idx: number[] = [];
      const ribbon = (pts: Pt[], hs: number[], w: number) => {
        const base = pos.length / 3, n = pts.length;
        for (let i = 0; i < n; i++) {
          const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)], dx = b.x - a.x, dz = b.y - a.y, m = Math.hypot(dx, dz) || 1, nx = (-dz / m) * w / 2, nz = (dx / m) * w / 2;
          pos.push(pts[i].x + nx, hs[i] + 0.15, pts[i].y + nz, pts[i].x - nx, hs[i] + 0.15, pts[i].y - nz);
        }
        for (let i = 0; i < n - 1; i++) { const a = base + 2 * i, b = a + 2; idx.push(a, b, a + 1, b, b + 1, a + 1); }
      };
      const flat = (loop: Pt[], h: number) => {
        if (loop.length < 3) return;
        const tris = THREE.ShapeUtils.triangulateShape(loop.map(q => new THREE.Vector2(q.x, q.y)), []), base = pos.length / 3;
        for (const q of loop) pos.push(q.x, h + 0.15, q.y);
        for (const t of tris) idx.push(base + t[0], base + t[2], base + t[1]);
      };
      for (const id of sel.lanes) {
        const l = laneById(sk, id);
        if (!l) continue;
        const L = laneLength(l.shape), pts: Pt[] = [], hs: number[] = [];
        for (let s2 = 0; s2 <= L + 1e-6; s2 += Math.max(0.5, Math.min(2, L / 40))) { pts.push(pointAt(l.shape, Math.min(s2, L)).p); hs.push(zAt(sk, id, Math.min(s2, L)) * LEVEL_H); }
        ribbon(pts, hs, l.width);
      }
      for (const id of sel.connectors) {
        const c = sk.connectors.find(x => x.id === id), pts = c && connectorPts(sk, c);
        if (!c || !pts) continue;
        const h0 = zAt(sk, c.from.lane, c.from.s) * LEVEL_H, h1 = zAt(sk, c.to.lane, c.to.s) * LEVEL_H;
        ribbon(pts, pts.map((_, i) => h0 + ((h1 - h0) * i) / Math.max(1, pts.length - 1)), 1.2);
      }
      for (const id of sel.junctions) {
        const j = sk.junctions.find(x => x.id === id), c = p.contents.get(id);
        if (!j || !c) continue;
        const h = junctionLevel(sk, c) * LEVEL_H;
        if (j.shape === "auto" && j.smooth) for (const loop of smoothJunction(sk, j, c).slice(0, 1)) flat(loop, h);
        else flat(outlinePath(j), h);
      }
      if (!idx.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
      return g;
    };
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.08, 6, 40), new THREE.MeshBasicMaterial({ color: pal.select }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false; scene.add(ring);
    const syncRing = () => {
      const p = live.current, id = p.car;
      ring.visible = false;
      if (id === null) return;
      const c = (p.cars() ?? []).find(x => (x as Car3D & { id?: number }).id === id);
      if (!c) return;
      const s2 = Math.max(3.2, c.len * 0.8);
      ring.position.set(c.p.x, (c.z ?? 0) * LEVEL_H + 0.2, c.p.y); ring.scale.set(s2, s2, s2); ring.visible = true;
    };
    // a click (not a drag) picks what is under it: the highest level first (a bridge before the road under it)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { if (e.button === 0) downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) { downAt = null; return; }
      downAt = null;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      const sk = live.current.sketch, levels = [...new Set([0, ...sk.lanes.map(l => l.level ?? 0)])].sort((a, b) => b - a);
      for (const lv of levels) {
        plane.constant = -(lv * LEVEL_H + 0.06);
        if (!ray.ray.intersectPlane(plane, hitP)) continue;
        if (live.current.pickAt({ x: hitP.x, y: hitP.z }, lv)) return;
      }
      live.current.pickNone();
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    // drawn while shown and the tab is visible
    let disposed = false, frame = 0, lastSync = 0;
    const draw = () => {
      controls.update();
      // (the haze far off, further the further out the view is: a whole city seen from above stays clear)
      const d = camera.position.distanceTo(controls.target), fog = scene.fog as THREE.Fog;
      fog.near = Math.max(1500, d * 1.5); fog.far = Math.max(6000, d * 4); camera.far = Math.max(12000, d * 5); camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };
    const tick = (now: number) => {
      frame = 0;
      if (disposed) return;
      if (now - lastSync > 500) { lastSync = now; syncSat(); syncUnderlay(); }
      syncRoads(); syncCars(now); syncLights(); syncSelection(); syncRoute(); syncRing();
      stepHome(now);
      draw();
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    const onVisible = () => { if (!document.hidden && !frame && !disposed) frame = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", onVisible);
    const ro = new ResizeObserver(() => size());
    ro.observe(el);
    const onTheme = () => { pal = readPalette(); builtFor = []; selMat.color.set(pal.select); (ring.material as THREE.MeshBasicMaterial).color.set(pal.select); scene.background = new THREE.Color(pal.sky); (scene.fog as THREE.Fog).color.set(pal.sky); (ground.material as THREE.MeshLambertMaterial).color.set(pal.ground); };
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    frame = requestAnimationFrame(tick);
    // (the bridge's screenshot: a frame drawn just before it is read)
    live.current.canvasRef.current = () => { if (disposed) return null; draw(); return renderer.domElement; };

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisible);
      ro.disconnect(); mo.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown); renderer.domElement.removeEventListener("pointerup", onUp);
      controls.removeEventListener("start", onStart); controls.removeEventListener("change", onChange);
      // (the plan view to where the 3D view looks: its middle, and a zoom showing as much across)
      const t = controls.target, d = camera.position.distanceTo(t), across = 2 * d * Math.tan(((FOV * Math.PI) / 180) / 2) * camera.aspect;
      live.current.onLeave({ cx: t.x, cy: t.z, scale: Math.min(80, Math.max(0.3, (el.clientWidth || 1) / Math.max(1, across))) });
      live.current.canvasRef.current = null; live.current.apiRef.current = null;
      if (built) { scene.remove(built.group); built.dispose(); }
      controls.dispose();
      scene.traverse(o => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) { (mat as THREE.MeshBasicMaterial).map?.dispose(); mat.dispose(); }
      });
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <div className="absolute inset-0 z-[5]">
      <div ref={wrap} className="size-full" aria-label="3D view" role="img" />
    </div>
  );
}
