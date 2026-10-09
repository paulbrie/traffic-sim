"use client";

/**
 * The V2 plan in 3D (as V1's view-3d.tsx, in plain three.js): over the plan editor's map while its mode is "3d", the
 * editor staying up underneath (its cars, its state), so the same cars drive here. An orbit camera (drag to turn, right
 * drag to pan, wheel to zoom), arriving over where the plan view was and leaving it where the 3D view is; the ground, the
 * satellite imagery where the sketch has a place on Earth, and the reference image. Drawn only while shown and the tab is
 * visible; everything it made is let go when it goes.
 *
 * World axes: x east as on the plan, y up, z the plan's y (south).
 */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { laneLength, pointAt, type JunctionContents, type Sketch } from "@/lib/lane-sketch";
import { buildSketch3D, type Sketch3D } from "@/render/sketch3d";
import type { SketchLayers } from "@/state/sketch-layers";
import type { Underlay } from "@/lib/underlay";
import { readPalette } from "@/render/palette";
import { satelliteMosaic, type SatSource } from "@/render/satellite";
import type { SatOptions } from "@/state/sat-options";

/** the plan view's place: its middle (m) and zoom (px a metre) */
export interface PlanView { cx: number; cy: number; scale: number }
/** what the editor gives the 3D view */
export interface View3DProps {
  sketch: Sketch; contents: Map<string, JunctionContents>; layers: SketchLayers;
  /** what the editor's keys and buttons ask of the 3D view: the whole sketch in view, closer or further */
  apiRef: React.MutableRefObject<{ fit: () => void; dolly: (f: number) => void } | null>;
  /** the plan view as it is (where 3D arrives) */
  planView: () => PlanView;
  /** where the plan view should be on leaving 3D */
  onLeave: (v: PlanView) => void;
  satellite: boolean; sat: SatOptions;
  underlay: Underlay | null; underlayImg: HTMLImageElement | null; image: boolean;
  /** the canvas, for the bridge's screenshot (with a frame drawn just before it is read) */
  canvasRef: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

const FOV = 40, TILT = (55 * Math.PI) / 180;

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
    // (the whole sketch in view)
    const fit = () => {
      const sk = live.current.sketch;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of sk.lanes) { const L = laneLength(l.shape); for (let s = 0; s <= L; s += Math.max(1, L / 8)) { const p = pointAt(l.shape, s).p; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } }
      if (!Number.isFinite(x0)) return;
      place((x0 + x1) / 2, (y0 + y1) / 2, Math.max(60, (x1 - x0) * 1.15, ((y1 - y0) * 1.15 * (el.clientWidth || 1)) / (el.clientHeight || 1)));
    };
    const dolly = (f: number) => {
      const t = controls.target, d = camera.position.clone().sub(t);
      camera.position.copy(t).add(d.multiplyScalar(Math.min(controls.maxDistance / d.length(), Math.max(controls.minDistance / d.length(), 1 / f))));
      controls.update();
    };
    live.current.apiRef.current = { fit, dolly };

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
      syncRoads();
      draw();
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    const onVisible = () => { if (!document.hidden && !frame && !disposed) frame = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", onVisible);
    const ro = new ResizeObserver(() => size());
    ro.observe(el);
    const onTheme = () => { pal = readPalette(); builtFor = []; scene.background = new THREE.Color(pal.sky); (scene.fog as THREE.Fog).color.set(pal.sky); (ground.material as THREE.MeshLambertMaterial).color.set(pal.ground); };
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
