"use client";

import { useEffect, useRef, useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { Crosshair, Eye, Gauge, Orbit, Plane, Swords, Volume2, VolumeX } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildRoadGeo, heightFn, laneSign } from "@/render/geometry";
import { buildBuildings, buildFurniture, buildMarkers, buildRoads, buildingShell, laneSignMaterials, type Furniture } from "@/render/scene3d";
import { satelliteMosaic } from "@/render/satellite";
import { HELI_LAYER, HELI_MODEL_CREDIT, loadHelicopter, type Helicopter } from "@/render/helicopter";
import { RotorSound } from "@/render/rotor-sound";
import { Combat, type World } from "@/render/combat";
import type { BuildingDef } from "@/engine/types";
import { readPalette, speedColor, type Palette } from "@/render/palette";
import { LEVEL_H, linkExtent } from "@/engine/compile";
import { network$, select, ui, underlay$, type LayerId, type UiState, stats$ } from "@/state/store";
import { underlayImg$ } from "@/state/underlay-image";
import { simController } from "@/state/sim-controller";
import { planViewKey, viewCmd$, viewport } from "@/state/commands";
import * as ops from "@/state/ops";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Cockpit, type CockpitApi } from "./heli-cockpit";
import { ReversibleControls, placeReversibleControls } from "./reversible-3d";
import { BreakdownButton } from "./inspector";

const CAR3D = ["#ffffff", "#f1f2ee", "#e2e5e1", "#cdd1cd"];

/** orbit: the usual turntable camera; heli: fly freely; track: the helicopter follows the selected vehicle */
type CamMode = "orbit" | "heli" | "track";
type HeliView = "cockpit" | "outside";
const HELI_MIN = 4, HELI_MAX = 1500;
/** the helicopter's top speed over the ground: 200 km/h */
const HELI_VMAX = 200 / 3.6;
/** free flight takes off at this height; tracking never goes lower */
const HELI_START = 100, TRACK_MIN = 100;
/** pointer steering: the still middle (share of the half width), and the fastest turn (rad/s) */
const STEER_DEAD = 0.3, STEER_RATE = 0.9;

/**
 * Switching between the plan view and 3D keeps the place: leaving 3D writes the ground point in the middle
 * of the view (and a matching zoom) as the plan view's centre, and remembers the 3D camera. Coming back with
 * the plan view not moved since brings that camera back exactly (mode included); otherwise 3D opens over
 * the plan view's centre at a matching distance, looking the way it last did.
 */
type Pose = { pos: number[]; target: number[]; mode: CamMode; yaw: number; pitch: number; chase: { angle: number; dist: number; height: number } };
const left3d = new Map<string, { pose: Pose; wrote: { cx: number; cy: number; wm: number } }>();
type Arrival = { exact: Pose } | { cx: number; cy: number; wm: number; dir: number[] | null } | null;
function arrival(planId: string): Arrival {
  let v: { cx: number; cy: number; wm: number } | null = null;
  if (viewport.planId === planId) v = { cx: viewport.cx, cy: viewport.cy, wm: viewport.wm };
  else {
    try {
      const s = JSON.parse(localStorage.getItem(planViewKey(planId)) ?? "null") as { cx: number; cy: number; scale: number } | null;
      // (metres across: the plan view's width isn't known here, take the window's)
      if (s && [s.cx, s.cy, s.scale].every(Number.isFinite) && s.scale > 0) v = { cx: s.cx, cy: s.cy, wm: window.innerWidth / s.scale };
    } catch { /* no storage */ }
  }
  const was = left3d.get(planId);
  if (was && (!v || (Math.hypot(v.cx - was.wrote.cx, v.cy - was.wrote.cy) < 1 && Math.abs(v.wm / was.wrote.wm - 1) < 0.03))) return { exact: was.pose };
  if (!v) return null;
  const p = was?.pose, d = p ? [p.pos[0] - p.target[0], p.pos[1] - p.target[1], p.pos[2] - p.target[2]] : null, n = d ? Math.hypot(d[0], d[1], d[2]) : 0;
  return { ...v, dir: d && n > 1 && p!.mode === "orbit" ? d.map(c => c / n) : null };
}

export function View3D() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLSpanElement>(null);
  const revRef = useRef<HTMLDivElement>(null);
  const [arrive] = useState(() => arrival(ui.getValue().planId));
  const arriveRef = useRef(arrive);
  const [mode, setMode] = useState<CamMode>(arrive && "exact" in arrive ? arrive.exact.mode : "orbit");
  const [note, setNote] = useState("");
  const [selection] = useDeepSubject(ui, "selection");
  const modeApi = useRef<(m: CamMode) => void>(null);
  const cockpitApi = useRef<CockpitApi>(null);
  /** flying, seen from the pilot's seat or from behind the helicopter */
  const [view, setView] = useState<HeliView>("cockpit");
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);
  /** war mode: the helicopter's gun and guided rockets */
  const [war, setWar] = useState(false);
  const warRef = useRef(war);
  useEffect(() => { warRef.current = war; }, [war]);
  const [kills, setKills] = useState(0);
  const [sound, setSound] = useState(true);
  const soundRef = useRef(sound);
  useEffect(() => { soundRef.current = sound; }, [sound]);
  useEffect(() => { modeApi.current?.(mode); }, [mode]);
  const vehicleSelected = selection?.kind === "vehicle";

  useEffect(() => {
    const wrap = wrapRef.current!;
    let pal: Palette = readPalette();
    let u: UiState = ui.getValue();
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    wrap.appendChild(renderer.domElement);
    renderer.domElement.className = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 2, 12000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12; controls.maxPolarAngle = 1.45; controls.screenSpacePanning = false;
    const hemi = new THREE.HemisphereLight(0xffffff, 0x808080, 0.65);
    const sun = new THREE.DirectionalLight(0xffffff, 0.55);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0008; sun.shadow.normalBias = 0.6;
    scene.add(hemi, sun, sun.target);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000), new THREE.MeshLambertMaterial({ color: pal.ground }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    const sigMats = {
      green: new THREE.MeshBasicMaterial({ color: pal.go }), yellow: new THREE.MeshBasicMaterial({ color: pal.slow }),
      red: new THREE.MeshBasicMaterial({ color: pal.stop }), off: new THREE.MeshLambertMaterial({ color: "#555" }),
    };
    const laneMats = laneSignMaterials();
    let roads: THREE.Group | null = null, furniture: Furniture | null = null, markers: THREE.Group | null = null, builtVersion = -1, builtLayers = "";
    /** is this layer on (drawn) */
    const shown = (l: string) => u.layers.includes(l as LayerId);
    const buildingsOn = () => u.display.buildings && shown("buildings");
    // buildings are rebuilt only when the buildings themselves (or the theme) change
    let houses: { mesh: THREE.Mesh; owner: Int32Array; list: BuildingDef[] } | null = null;
    function syncBuildings(force = false) {
      const list = network$.getValue().buildings ?? [];
      if (houses && houses.list === list && !force) { houses.mesh.visible = buildingsOn(); return; }
      if (houses) { scene.remove(houses.mesh); houses.mesh.geometry.dispose(); (houses.mesh.material as THREE.Material).dispose(); houses = null; }
      if (!list.length) return;
      const b = buildBuildings(list, pal);
      houses = { ...b, list };
      houses.mesh.visible = buildingsOn();
      scene.add(houses.mesh);
    }
    const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
    const MAXV = 50000; // body boxes (a truck uses two)
    const body = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0xffffff }), MAXV);
    const glass = new THREE.InstancedMesh(box, new THREE.MeshLambertMaterial({ color: 0x1e2830 }), MAXV);
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < MAXV; i++) body.setColorAt(i, white); // allocate colours while count = MAXV
    for (const m of [body, glass]) { m.castShadow = true; m.frustumCulled = false; m.count = 0; }
    scene.add(body, glass);
    // turn signals: small amber lamps at the front and rear corners
    const lampGeo = new THREE.BoxGeometry(0.28, 0.22, 0.2);
    const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshBasicMaterial({ color: 0xffab1a }), 16000);
    lamps.frustumCulled = false; lamps.count = 0; scene.add(lamps);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: pal.select, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.visible = false; scene.add(ring);
    const hl = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: pal.select, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    scene.add(hl);
    const dummy = new THREE.Object3D(), col = new THREE.Color();

    // reference image on the ground, just above the grass and below the kerbs
    // the grass doesn't write depth, so the image never z-fights it and roads still cover the image
    (ground.material as THREE.MeshLambertMaterial).depthWrite = false; ground.renderOrder = -2;
    const ulMat = new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false });
    const ulMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), ulMat);
    ulMesh.rotation.order = "YXZ"; ulMesh.receiveShadow = true; ulMesh.visible = false;
    scene.add(ulMesh);
    let ulTexFor: HTMLImageElement | null = null;
    function syncUnderlay() {
      const ud = underlay$.getValue(), img = underlayImg$.getValue();
      if (!ud || !img || !ud.visible || !ud.in3d) { ulMesh.visible = false; return; }
      if (ulTexFor !== img) {
        ulMat.map?.dispose();
        // keep within the GPU's texture limit
        const max = Math.min(8192, renderer.capabilities.maxTextureSize);
        let src: TexImageSource = img;
        if (Math.max(img.naturalWidth, img.naturalHeight) > max) {
          const k = max / Math.max(img.naturalWidth, img.naturalHeight), c = document.createElement("canvas");
          c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
          c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
          src = c;
        }
        const tex = new THREE.Texture(src as HTMLImageElement);
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy(); tex.needsUpdate = true;
        ulMat.map = tex; ulMat.needsUpdate = true; ulTexFor = img;
      }
      ulMat.opacity = ud.opacity;
      ulMesh.scale.set(ud.w * ud.mpp, ud.h * ud.mpp, 1);
      // plane lies in XZ; world y (plan) maps to +z, clockwise plan rotation is a negative turn about +y
      ulMesh.rotation.set(-Math.PI / 2, (-ud.rot * Math.PI) / 180, 0);
      ulMesh.position.set(ud.x, 0.005, ud.y);
      ulMesh.visible = true;
    }

    // satellite imagery on the ground, for plans that know where they are
    const satMat = new THREE.MeshLambertMaterial({ depthWrite: false });
    const satMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), satMat);
    satMesh.rotation.x = -Math.PI / 2; satMesh.receiveShadow = true; satMesh.visible = false; satMesh.renderOrder = -1;
    scene.add(satMesh);
    let satKey = "", satGen = 0;
    function syncSatellite() {
      const net = network$.getValue(), geo = net.geo, want = !!geo && u.display.satellite;
      satMesh.visible = want && !!satMat.map;
      satMat.color.setScalar(u.display.satBrightness ?? 1);
      if (!want || !geo) return;
      const b = simController.compiled.bounds, pad = Math.max(150, 0.2 * Math.max(b.maxX - b.minX, b.maxY - b.minY));
      const key = `${geo.lat},${geo.lon}:${Math.round(b.minX / 100)},${Math.round(b.minY / 100)},${Math.round(b.maxX / 100)},${Math.round(b.maxY / 100)}`;
      if (key === satKey) return;
      satKey = key;
      const gen = ++satGen;
      satelliteMosaic(geo, { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad }).then(m => {
        if (!m || gen !== satGen) return;
        satMat.map?.dispose();
        const tex = new THREE.CanvasTexture(m.canvas);
        tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
        satMat.map = tex; satMat.needsUpdate = true;
        satMesh.scale.set(m.rect.maxX - m.rect.minX, m.rect.maxY - m.rect.minY, 1);
        satMesh.position.set((m.rect.minX + m.rect.maxX) / 2, 0.002, (m.rect.minY + m.rect.maxY) / 2);
        satMesh.visible = !!network$.getValue().geo && u.display.satellite;
      });
    }

    function applyTheme() {
      pal = readPalette();
      scene.background = new THREE.Color(pal.sky);
      scene.fog = new THREE.Fog(pal.sky, 1500, 6000);
      (ground.material as THREE.MeshLambertMaterial).color.set(pal.ground);
      sigMats.green.color.set(pal.go); sigMats.yellow.color.set(pal.slow); sigMats.red.color.set(pal.stop);
      (ring.material as THREE.MeshBasicMaterial).color.set(pal.select);
      (hl.material as THREE.MeshBasicMaterial).color.set(pal.select);
      const dark = matchMedia("(prefers-color-scheme: dark)").matches;
      hemi.intensity = dark ? 0.9 : 1.15; sun.intensity = dark ? 1.0 : 1.5;
      builtVersion = -1;
      syncBuildings(true);
    }
    applyTheme();

    function rebuild() {
      if (roads) { scene.remove(roads); roads.traverse(o => { if (o instanceof THREE.Mesh) o.geometry.dispose(); }); }
      if (furniture) { scene.remove(furniture.group); }
      const geo = buildRoadGeo(simController.compiled, network$.getValue()), hf = heightFn(simController.compiled, network$.getValue());
      roads = buildRoads(geo, pal, hf, shown); scene.add(roads);
      furniture = buildFurniture(geo, pal, sigMats, hf, laneMats, shown); scene.add(furniture.group);
      // markers (on the roof of a building they stand on)
      if (markers) { scene.remove(markers); markers.traverse(o => { if (o instanceof THREE.Sprite) o.material.map?.dispose(); }); }
      markers = buildMarkers(network$.getValue(), pal); markers.visible = shown("markers"); scene.add(markers);
      builtLayers = u.layers.join("+");
      syncBuildings();
      syncSatellite();
      builtVersion = simController.version;
      const b = simController.compiled.bounds;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, span = Math.max(200, b.maxX - b.minX, b.maxY - b.minY);
      sun.position.set(cx - span * 0.6, span * 1.1, cz - span * 0.5); sun.target.position.set(cx, 0, cz);
      const sc = sun.shadow.camera; sc.left = -span; sc.right = span; sc.top = span; sc.bottom = -span; sc.near = 10; sc.far = span * 4; sc.updateProjectionMatrix();
    }
    let homed = "";
    function home() {
      const b = simController.compiled.bounds;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minY + b.maxY) / 2, span = Math.max(150, b.maxX - b.minX, b.maxY - b.minY);
      controls.target.set(cx, 0, cz);
      camera.position.set(cx - span * 0.35, span * 0.75, cz + span * 0.85);
      controls.update();
    }
    /** where the view opens: see `arrival` */
    function place() {
      const a = arriveRef.current;
      arriveRef.current = null;
      if (!a) return home();
      if ("exact" in a) {
        const p = a.exact;
        camera.position.fromArray(p.pos); controls.target.fromArray(p.target);
        camMode = p.mode; yaw = p.yaw; pitch = p.pitch; Object.assign(chase, p.chase);
        controls.enabled = camMode === "orbit";
        if (camMode === "orbit") controls.update(); else { camera.rotation.order = "YXZ"; camera.rotation.set(pitch, yaw, 0); }
        renderer.domElement.style.cursor = camMode === "orbit" ? "" : "grab";
        return;
      }
      // as far away as shows the plan view's width; by default from the south, looking north as the plan does
      const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
      const d = Math.max(20, Math.min(8000, a.wm / 2 / Math.tan(half))), dir = a.dir ?? [0, Math.sin(0.9), Math.cos(0.9)];
      controls.target.set(a.cx, 0, a.cy);
      camera.position.set(a.cx + dir[0] * d, Math.max(5, dir[1] * d), a.cy + dir[2] * d);
      controls.update();
    }
    /** on leaving 3D: the ground in the middle of the view becomes the plan view's centre */
    function leave() {
      const planId = u.planId;
      if (!planId || homed !== planId) return;
      let gx: number, gz: number, dist: number;
      if (camMode === "orbit") { gx = controls.target.x; gz = controls.target.z; dist = camera.position.distanceTo(controls.target); }
      else {
        camera.getWorldDirection(dir);
        if (dir.y < -0.02) { const t = Math.min(5000, camera.position.y / -dir.y); gx = camera.position.x + dir.x * t; gz = camera.position.z + dir.z * t; dist = t; }
        else { gx = camera.position.x; gz = camera.position.z; dist = Math.max(100, camera.position.y); }
      }
      const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.aspect);
      const wm = Math.max(20, 2 * dist * Math.tan(half)), w = Math.max(1, wrap.getBoundingClientRect().width);
      try { localStorage.setItem(planViewKey(planId), JSON.stringify({ cx: Math.round(gx * 100) / 100, cy: Math.round(gz * 100) / 100, scale: Math.round((w / wm) * 10000) / 10000 })); } catch { /* not kept */ }
      // what the plan view will show (its width is this view's)
      viewport.cx = Math.round(gx * 100) / 100; viewport.cy = Math.round(gz * 100) / 100; viewport.wm = wm; viewport.planId = planId;
      left3d.set(planId, {
        pose: { pos: camera.position.toArray(), target: controls.target.toArray(), mode: camMode, yaw, pitch, chase: { angle: chase.angle, dist: chase.dist, height: chase.height } },
        wrote: { cx: viewport.cx, cy: viewport.cy, wm },
      });
    }

    const resize = () => {
      const r = wrap.getBoundingClientRect();
      renderer.setSize(Math.max(1, r.width), Math.max(1, r.height));
      camera.aspect = Math.max(1, r.width) / Math.max(1, r.height); camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize); ro.observe(wrap); resize();

    const subs = [
      ui.subscribe("**", () => { u = ui.getValue(); if (houses) houses.mesh.visible = buildingsOn(); syncSatellite(); }),
      underlay$.subscribe(syncUnderlay),
      underlayImg$.subscribe(syncUnderlay),
      viewCmd$.subscribe(c => {
        if (!c) return;
        if (camMode !== "orbit") {
          // fit returns to the orbit camera; north turns the helicopter to face north
          if (c.cmd === "fit") { setMode("orbit"); setCamMode("orbit"); home(); }
          else if (c.cmd === "north") { if (camMode === "heli") yaw = 0; else chase.angle = -Math.PI / 2 - chase.heading; }
          else if (c.cmd === "zoomIn" || c.cmd === "zoomOut") {
            const k = c.cmd === "zoomIn" ? 1 / 1.4 : 1.4;
            if (camMode === "heli") camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, camera.position.y * k));
            else chase.dist = Math.max(8, Math.min(600, chase.dist * k));
          }
          return;
        }
        if (c.cmd === "fit") home();
        else if (c.cmd === "north") {
          // swing the camera round the target so the view faces north (plan −y = world −z)
          controls.enableDamping = false; controls.update(); // drop any leftover spin
          const off = camera.position.clone().sub(controls.target), flat = Math.hypot(off.x, off.z);
          camera.position.set(controls.target.x, camera.position.y, controls.target.z + Math.max(flat, 1));
          controls.update(); controls.enableDamping = true;
        }
        else if (c.cmd === "zoomIn" || c.cmd === "zoomOut") {
          const off = camera.position.clone().sub(controls.target).multiplyScalar(c.cmd === "zoomIn" ? 1 / 1.4 : 1.4);
          camera.position.copy(controls.target).add(off); controls.update();
        }
      }),
    ];
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", applyTheme);

    // helicopter: Z Q S D (French keyboard) or the arrows fly forward, left, back, right; dragging the mouse looks around,
    // E / Page Up climb, A / Page Down descend, the wheel too; Shift goes faster.
    // Tracking keeps the helicopter behind the selected vehicle; drag to circle it, arrows for distance and side.
    let camMode: CamMode = "orbit", yaw = 0, pitch = -0.35, hudText = "";
    // the helicopter itself, loaded the first time it is flown. The camera is always the pilot's eye (the flight
    // moves it). From the seat, the cabin is drawn in a second pass, with a near plane close enough for it;
    // from outside, a whole helicopter is drawn with the rest, seen by a camera following behind.
    const heli: { cabin: Helicopter | null; whole: Helicopter | null } = { cabin: null, whole: null };
    const loading = new Set<string>();
    let disposed = false;
    const cabinCam = new THREE.PerspectiveCamera(60, 1, 0.03, 80);
    cabinCam.layers.set(HELI_LAYER);
    sun.shadow.camera.layers.enable(HELI_LAYER); // the cabin's shadow on the ground
    const outCam = new THREE.PerspectiveCamera(50, 1, 0.5, 12000), outAt = new THREE.Vector3();
    let outFresh = true;
    /** the airframe: heading (as a camera yaw), nose up, roll (right side up) */
    const air = { yaw: 0, pitch: 0, roll: 0 }, eyeOff = new THREE.Vector3();
    const withCabin = () => camMode !== "orbit" && viewRef.current === "cockpit";
    const outside = () => camMode !== "orbit" && viewRef.current === "outside";
    function ensureHeli(kind: "cabin" | "whole") {
      if (heli[kind] || loading.has(kind)) return;
      loading.add(kind);
      loadHelicopter(kind === "cabin" ? undefined : null, kind === "cabin" ? HELI_LAYER : 0).then(h => {
        if (disposed) { h.dispose(); return; }
        heli[kind] = h; h.body.visible = false; scene.add(h.body);
      }).catch(() => setNote("The helicopter couldn't be loaded: flying without it."));
    }
    /** put an airframe round the pilot's eye, and turn its rotor */
    function placeAirframe(h: Helicopter, dt: number) {
      h.body.rotation.order = "YXZ"; h.body.rotation.set(air.pitch, air.yaw, air.roll);
      h.body.position.copy(camera.position).sub(eyeOff.copy(h.eye).applyEuler(h.body.rotation));
      h.spin(dt);
    }
    // the sound: on while flying, unless turned off
    const rotorSound = new RotorSound();
    let soundOn = false;
    // in free flight, with no button held, the pointer towards either side of the view turns the helicopter
    const hover = { on: false, nx: 0 };

    // war mode. Space (held) fires the gun at the sight in the middle of the view, a click fires a burst at that
    // point; R launches a rocket guided onto the vehicle nearest the sight (the tracked one, tracking)
    const combat = new Combat(scene);
    const armed = () => camMode !== "orbit" && warRef.current;
    const gun = { held: false, burst: 0, at: new THREE.Vector3(), next: 0 };
    let rocketAsked = false, lastForget = 0;
    const vehicleById = (id: number) => { const sim = simController.sim; return sim?.vehicles.find(v => v.id === id && !v.dead) ?? null; };
    const world: World = {
      at(id) {
        const v = vehicleById(id), sim = simController.sim;
        if (!v || !sim) return null;
        const q = sim.pose(v), o = followOffset(v);
        return new THREE.Vector3((q.fx + q.rx) / 2 + (o ? follow.ox : 0), v.z * LEVEL_H, (q.fy + q.ry) / 2 + (o ? follow.oz : 0));
      },
      near(p, r) {
        const sim = simController.sim, out: [number, number][] = [];
        if (sim) for (const v of sim.vehicles) {
          if (v.dead) continue;
          const q = sim.pose(v), d = Math.hypot((q.fx + q.rx) / 2 - p.x, (q.fy + q.ry) / 2 - p.z);
          if (d < r + v.len / 2 && Math.abs(v.z * LEVEL_H - p.y) < 6) out.push([v.id, d]);
        }
        return out.sort((a, b) => a[1] - b[1]).map(x => x[0]);
      },
      shape(id) {
        const v = vehicleById(id), sim = simController.sim;
        if (!v || !sim) return null;
        const q = sim.pose(v);
        return { heading: Math.atan2(q.fy - q.ry, q.fx - q.rx), len: v.len, width: v.width };
      },
    };
    const aimRay = new THREE.Raycaster(), aimAt = new THREE.Vector3(), center = new THREE.Vector2(0, 0);
    /** the ground point under the sight (or far ahead, looking above the horizon) */
    function sightPoint(cam: THREE.Camera, out: THREE.Vector3) {
      aimRay.setFromCamera(center, cam);
      if (!aimRay.ray.intersectPlane(plane, out) || out.distanceTo(cam.position) > 3000) out.copy(aimRay.ray.origin).addScaledVector(aimRay.ray.direction, 1500);
      return out;
    }
    /** a point on the airframe (body frame: x right, y up, −z ahead) in the world */
    const hardpoint = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyEuler(new THREE.Euler(air.pitch, air.yaw, air.roll, "YXZ")).add(camera.position);
    function shoot(now: number) {
      if (!armed()) { gun.held = false; gun.burst = 0; rocketAsked = false; return; }
      const cam = outside() ? outCam : camera;
      if ((gun.held || gun.burst > 0) && now >= gun.next) {
        gun.next = now + 85;
        const to = gun.burst > 0 ? gun.at : sightPoint(cam, aimAt);
        if (gun.burst > 0) gun.burst--;
        // the gun hangs under the cabin, on the pilot's side
        combat.fire(hardpoint(0.9, -1.5, 0.2), to);
      }
      if (rocketAsked) {
        rocketAsked = false;
        const to = sightPoint(cam, aimAt).clone(), sel = u.selection;
        // guided onto the tracked vehicle, or the one nearest the sight
        const target = camMode === "track" && sel?.kind === "vehicle" ? Number(sel.id) : world.near(to, 30)[0] ?? null;
        const from = hardpoint(-1.1, -1.4, 0.3);
        combat.launch(from, to.clone().sub(from), target, to);
        setNote(target !== null ? `Rocket away, locked on vehicle #${target}` : "Rocket away (nothing to lock on)");
      }
    }
    const turnTo = (a: number, b: number, k: number) => { const d = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + d * k; };
    const vel = new THREE.Vector3(), held = new Set<string>(), dir = new THREE.Vector3();
    const chase = { angle: 0, dist: 90, height: TRACK_MIN, heading: NaN, id: "" };
    // the simulation moves vehicles in 0.1 s steps (a few times a second on screen), so the tracked one is followed
    // through a smoothed point: it glides at the vehicle's speed and eases back onto each new position.
    // The tracked vehicle is drawn there too (ox, oz: smoothed minus actual), so it sits still in the windscreen.
    const follow = { ok: false, vid: NaN, x: 0, y: 0, z: 0, rawX: NaN, rawZ: NaN, rawAt: 0, ox: 0, oz: 0 };
    const followOffset = (v: { id: number }) => camMode === "track" && follow.ok && v.id === follow.vid;
    // what the cockpit's instruments show; bank leans into the tracked vehicle's turns
    const flight = { alt: 0, speed: 0, vs: 0, heading: 0, pitch: 0, roll: 0, range: NaN }, lastPos = new THREE.Vector3();
    let bank = 0, lastSwing = NaN;
    const lookAt = new THREE.Vector3();
    function fromCamera() {
      camera.getWorldDirection(dir);
      yaw = Math.atan2(-dir.x, -dir.z); pitch = Math.max(-1.5, Math.min(0.5, Math.asin(dir.y)));
      camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, camera.position.y));
    }
    function setCamMode(m: CamMode) {
      if (m === camMode) return;
      const was = camMode;
      camMode = m; vel.set(0, 0, 0); held.clear(); hudText = "";
      if (m === "orbit") {
        // orbit round the ground point the helicopter was looking at (or straight below)
        camera.getWorldDirection(dir);
        if (dir.y < -0.05) {
          const t = Math.min(camera.position.y / -dir.y, 2000);
          controls.target.set(camera.position.x + dir.x * t, 0, camera.position.z + dir.z * t);
        } else {
          const flat = Math.hypot(dir.x, dir.z) || 1, t = Math.max(30, camera.position.y);
          controls.target.set(camera.position.x + (dir.x / flat) * t, 0, camera.position.z + (dir.z / flat) * t);
        }
        controls.enabled = true; controls.update();
      } else {
        controls.enabled = false;
        if (was === "orbit") {
          // take off 300 m short of what the orbit camera looked at, 100 m up, facing it
          // (far enough to look at it over the instrument panel)
          camera.getWorldDirection(dir);
          const l = Math.hypot(dir.x, dir.z), hx = l > 1e-3 ? dir.x / l : 0, hz = l > 1e-3 ? dir.z / l : -1, t = controls.target;
          camera.position.set(t.x - hx * 300, HELI_START, t.z - hz * 300);
          yaw = Math.atan2(-hx, -hz); pitch = -Math.atan2(HELI_START, 300);
          camera.rotation.order = "YXZ"; camera.rotation.set(pitch, yaw, 0);
        }
        if (m === "track") { chase.heading = NaN; chase.id = ""; }
        air.yaw = yaw; air.pitch = 0; air.roll = 0;
        follow.ok = false;
      }
      renderer.domElement.style.cursor = m === "orbit" ? "" : "grab";
    }
    modeApi.current = setCamMode;
    const typing = (e: Event) => !!(e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable],[role=combobox],[role=slider],[role=tablist],[role=menu],[role=listbox]");
    const FLY_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "z", "q", "s", "d", "e", "a", "pageup", "pagedown", "shift"]);
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.type === "keyup") { held.delete(k); if (k === " ") gun.held = false; return; }
      if (camMode === "orbit" || u.view !== "3d" || e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      // C: from the seat or from outside
      if (k === "c" && !e.repeat) { e.preventDefault(); e.stopPropagation(); setView(v => (v === "cockpit" ? "outside" : "cockpit")); return; }
      if (warRef.current && (k === " " || k === "r")) {
        e.preventDefault(); e.stopPropagation();
        if (k === " ") gun.held = true; else if (!e.repeat) rocketAsked = true;
        return;
      }
      if (!FLY_KEYS.has(k)) return;
      // Shift+E / Shift+Q stay layer shortcuts only when not flying; here they mean "faster"
      e.preventDefault(); e.stopPropagation();
      held.add(k);
    };
    const onBlur = () => { held.clear(); gun.held = false; };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    window.addEventListener("blur", onBlur);
    let look: { x: number; y: number; id: number } | null = null;
    const onLookDown = (e: PointerEvent) => {
      if (camMode === "orbit") return;
      look = { x: e.clientX, y: e.clientY, id: e.pointerId };
      renderer.domElement.setPointerCapture(e.pointerId);
      renderer.domElement.style.cursor = "grabbing";
    };
    const onLookMove = (e: PointerEvent) => {
      if (!look && camMode === "heli" && e.buttons === 0) {
        const r = renderer.domElement.getBoundingClientRect();
        hover.on = true; hover.nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
        renderer.domElement.style.cursor = Math.abs(hover.nx) > STEER_DEAD ? (hover.nx < 0 ? "w-resize" : "e-resize") : "grab";
      }
      if (!look || e.pointerId !== look.id || camMode === "orbit") return;
      const dx = e.clientX - look.x, dy = e.clientY - look.y;
      look.x = e.clientX; look.y = e.clientY;
      if (camMode === "heli") { yaw -= dx * 0.004; pitch = Math.max(-1.5, Math.min(0.5, pitch - dy * 0.004)); }
      else { chase.angle -= dx * 0.006; chase.height = Math.max(TRACK_MIN, Math.min(400, chase.height + dy * 0.25)); }
    };
    const onHoverLeave = () => { hover.on = false; };
    const onLookUp = (e: PointerEvent) => {
      if (!look || e.pointerId !== look.id) return;
      look = null;
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId);
      renderer.domElement.style.cursor = camMode === "orbit" ? "" : "grab";
    };
    const onWheel = (e: WheelEvent) => {
      if (camMode === "orbit") return;
      e.preventDefault();
      // like zooming: scroll up comes down closer, scroll down climbs
      const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015)));
      if (camMode === "heli") camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, camera.position.y * k));
      else { chase.dist = Math.max(8, Math.min(600, chase.dist * k)); chase.height = Math.max(TRACK_MIN, Math.min(400, chase.height * k)); }
    };
    renderer.domElement.addEventListener("pointerdown", onLookDown);
    renderer.domElement.addEventListener("pointermove", onLookMove);
    renderer.domElement.addEventListener("pointerleave", onHoverLeave);
    renderer.domElement.addEventListener("pointerup", onLookUp);
    renderer.domElement.addEventListener("pointercancel", onLookUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    function fly(dt: number, now: number, sim: typeof simController.sim) {
      const fast = held.has("shift") ? 3 : 1;
      const axis = (a: string, b: string) => (held.has(a) ? 1 : 0) - (held.has(b) ? 1 : 0);
      const fwd = axis("arrowup", "arrowdown") + axis("z", "s"), side = axis("arrowright", "arrowleft") + axis("d", "q");
      const climb = axis("e", "a") + axis("pageup", "pagedown");
      let speed = 0;
      if (camMode === "heli") {
        // the pointer out towards a side turns that way, faster further out (none while dragging to look)
        const out = hover.on && !look ? (Math.abs(hover.nx) - STEER_DEAD) / (1 - STEER_DEAD) : 0;
        if (out > 0) yaw -= Math.sign(hover.nx) * Math.min(1, out) * STEER_RATE * dt;
        // faster high up, slower near the ground; the helicopter eases in and out of motion
        const cruise = Math.min(HELI_VMAX, Math.max(12, camera.position.y * 0.9) * fast);
        // (diagonally no faster than straight ahead)
        const sy = Math.sin(yaw), cy = Math.cos(yaw), k = cruise / Math.max(1, Math.hypot(fwd, side));
        const want = new THREE.Vector3((-sy * fwd + cy * side) * k, climb * Math.max(6, cruise * 0.5), (-cy * fwd - sy * side) * k);
        // (a helicopter gathers and loses speed slowly: some 3 s to 63 % of the change)
        vel.lerp(want, 1 - Math.exp(-dt * 0.35));
        camera.position.addScaledVector(vel, dt);
        camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, camera.position.y));
        // the airframe faces where the pilot looks, dips its nose to speed up and leans into sideways flight
        const ease = 1 - Math.exp(-dt * 2), vf = -vel.x * sy - vel.z * cy, vside = vel.x * cy - vel.z * sy;
        air.yaw = yaw;
        air.pitch += (-0.13 * Math.max(-1, Math.min(1, vf / HELI_VMAX)) - air.pitch) * ease;
        air.roll += (-0.2 * Math.max(-1, Math.min(1, vside / HELI_VMAX)) - air.roll) * ease;
        camera.rotation.order = "YXZ"; camera.rotation.set(pitch + air.pitch, yaw, air.roll);
        speed = Math.hypot(vel.x, vel.z);
        flight.roll = -air.roll; flight.range = NaN;
      } else if (camMode === "track") {
        const sel = u.selection, v = sel?.kind === "vehicle" && sim ? sim.vehicles.find(x => String(x.id) === sel.id && !x.dead) : undefined;
        if (!v) {
          // the vehicle finished its trip (or the selection moved on): hover where we are
          setNote(sel?.kind === "vehicle" ? (combat.isGone(Number(sel.id)) ? "Target destroyed: flying freely." : "The vehicle left the network: flying freely.") : "Nothing to track: flying freely.");
          setMode("heli"); setCamMode("heli"); fromCamera();
          return;
        }
        if (chase.id !== sel!.id) { chase.id = sel!.id; chase.heading = NaN; follow.ok = false; setNote(""); }
        chase.angle += side * dt * 1.2 * fast;
        chase.dist = Math.max(8, Math.min(600, chase.dist * Math.exp(-fwd * dt * fast)));
        chase.height = Math.max(TRACK_MIN, Math.min(400, chase.height + climb * dt * Math.max(6, chase.height * 0.8) * fast));
        const q = sim!.pose(v), rx = (q.fx + q.rx) / 2, rz = (q.fy + q.ry) / 2;
        const h = Math.atan2(q.fy - q.ry, q.fx - q.rx);
        // metres per real second along the vehicle (0 while paused)
        const ms = v.v * simController.rate, ux = Math.cos(h), uz = Math.sin(h);
        if (rx !== follow.rawX || rz !== follow.rawZ) { follow.rawX = rx; follow.rawZ = rz; follow.rawAt = now; }
        // where the vehicle should be by now, judging from its last position and speed
        const age = Math.min(0.25, (now - follow.rawAt) / 1000), ex = rx + ux * ms * age, ez = rz + uz * ms * age;
        if (!follow.ok || follow.vid !== v.id || Math.hypot(ex - follow.x, ez - follow.z) > 25) {
          follow.ok = true; follow.vid = v.id; follow.x = ex; follow.z = ez; follow.y = v.z * LEVEL_H;
        } else {
          const k = 1 - Math.exp(-dt * 4);
          follow.x += ux * ms * dt; follow.z += uz * ms * dt;
          follow.x += (ex - follow.x) * k; follow.z += (ez - follow.z) * k; follow.y += (v.z * LEVEL_H - follow.y) * k;
        }
        follow.ox = follow.x - rx; follow.oz = follow.z - rz;
        const mx = follow.x, mz = follow.z, y0 = follow.y;
        // smooth the vehicle's heading so the helicopter swings round turns instead of snapping
        if (Number.isNaN(chase.heading)) chase.heading = h;
        else { let d = h - chase.heading; d = Math.atan2(Math.sin(d), Math.cos(d)); chase.heading += d * (1 - Math.exp(-dt * 1.5)); }
        const a = chase.heading + Math.PI + chase.angle;
        const want = new THREE.Vector3(mx + Math.cos(a) * chase.dist, y0 + chase.height, mz + Math.sin(a) * chase.dist);
        const before = camera.position.clone();
        camera.position.lerp(want, 1 - Math.exp(-dt * 3));
        // no faster than its top speed, even when it has a long way to catch up
        const sx = camera.position.x - before.x, sz = camera.position.z - before.z, step = Math.hypot(sx, sz), cap = HELI_VMAX * dt;
        if (step > cap) { camera.position.x = before.x + (sx / step) * cap; camera.position.z = before.z + (sz / step) * cap; }
        speed = before.distanceTo(camera.position) / Math.max(dt, 1e-3);
        lookAt.set(mx, y0 + 1.5, mz);
        camera.lookAt(lookAt);
        // lean into the swing round the vehicle, as a helicopter banks into a turn
        const swing = chase.heading + chase.angle;
        if (!Number.isNaN(lastSwing) && dt > 0) {
          let w = swing - lastSwing; w = Math.atan2(Math.sin(w), Math.cos(w));
          bank += (Math.max(-0.3, Math.min(0.3, (w / dt) * 0.35)) - bank) * (1 - Math.exp(-dt * 2));
        }
        lastSwing = swing;
        camera.rotateZ(-bank);
        // police crews watch from the side: the nose stays some 75° left of the vehicle, seen through the middle
        // of the pilot's door window (the instrument panel would hide it ahead and below)
        const lookYaw = Math.atan2(-(lookAt.x - camera.position.x), -(lookAt.z - camera.position.z));
        air.yaw = turnTo(air.yaw, lookYaw + 1.31, 1 - Math.exp(-dt * 1.5));
        air.pitch += (-0.04 - air.pitch) * (1 - Math.exp(-dt * 2)); air.roll = -bank;
        // (the sights are on the vehicle only from the seat)
        flight.roll = bank; flight.range = outside() ? NaN : camera.position.distanceTo(lookAt);
      }
      if (camMode !== "track") { lastSwing = NaN; bank = 0; }
      if (withCabin()) {
        // the airframe's vibration
        const t = now / 1000;
        camera.rotateX(0.00025 * Math.sin(t * 23) + 0.00012 * Math.sin(t * 61));
        camera.rotateZ(0.0002 * Math.sin(t * 17 + 1));
      }
      const text = `${Math.round(camera.position.y)} m up · ${Math.round(speed * 3.6)} km/h`;
      if (text !== hudText && hudRef.current) { hudText = text; hudRef.current.textContent = text; }
      if (cockpitApi.current && dt > 0) {
        const vs = (camera.position.y - lastPos.y) / dt, ease = 1 - Math.exp(-dt * 4);
        camera.getWorldDirection(dir);
        flight.alt = camera.position.y; flight.vs += (vs - flight.vs) * ease; flight.speed += (speed - flight.speed) * ease;
        flight.heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI; flight.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
        cockpitApi.current.update(flight);
      }
      lastPos.copy(camera.position);
    }

    // picking: select on click (no drag)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) { down = null; return; }
      down = null;
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, outside() ? outCam : camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      // armed, a click fires a burst there
      if (armed()) { gun.at.copy(hit); gun.burst = 5; gun.next = 0; return; }
      const p = { x: hit.x, y: hit.z }, net = network$.getValue();
      const dist = camera.position.distanceTo(hit), flying = camMode !== "orbit";
      // (from the helicopter, high up, vehicles are small: a more forgiving click)
      const tol = Math.max(3, dist * (flying ? 0.025 : 0.012));
      const sim = simController.sim;
      const v = sim?.vehicleNear(p.x, p.y, tol);
      if (v) return select({ kind: "vehicle", id: String(v.id) });
      // flying, only vehicles can be picked; a miss keeps the selection (and what is being tracked)
      if (flying) return;
      const node = net.nodes.find(n => Math.hypot(n.x - p.x, n.y - p.y) < tol * 1.5);
      if (node) return select({ kind: "node", id: node.id });
      if (houses?.mesh.visible) {
        const h = ray.intersectObject(houses.mesh, false)[0];
        if (h && h.faceIndex != null && h.distance < ray.ray.origin.distanceTo(hit)) {
          const b = houses.list[houses.owner[h.faceIndex]];
          if (b) return select({ kind: "building", id: b.id });
        }
      }
      let best: { id: string; d: number } | null = null;
      for (const l of net.links) {
        const A = ops.nodeById(net, l.from), B = ops.nodeById(net, l.to); if (!A || !B) continue;
        const [lo, hi] = linkExtent(l), r2 = ops.nearestT(l, A, B, p);
        if (r2.d < Math.max(-lo, hi) + 1 && (!best || r2.d < best.d)) best = { id: l.id, d: r2.d };
      }
      select(best ? { kind: "link", id: best.id } : null);
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    let raf = 0, hlFor = "", lastHeading = NaN, lastNow = 0;
    const compassEl = () => wrap.parentElement?.querySelector<HTMLElement>("[data-compass]");
    const frame = (now: number) => {
      const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
      lastNow = now;
      if (u.view === "3d") {
        simController.advance();
        if (builtVersion !== simController.version || builtLayers !== u.layers.join("+")) { rebuild(); hlFor = ""; }
        if (homed !== u.planId) { homed = u.planId; place(); }
        const sim = simController.sim, vsim = shown("vehicles") ? sim : null;
        // a wider view from the cabin, as a pilot's eyes take in
        const fov = withCabin() ? 62 : 40;
        if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix(); }
        if (withCabin()) ensureHeli("cabin");
        if (outside()) ensureHeli("whole");
        // the helicopter moves first: drawing the tracked vehicle needs its smoothed position
        if (camMode !== "orbit") fly(dt, now, sim);
        if (heli.cabin) { heli.cabin.body.visible = withCabin(); if (withCabin()) placeAirframe(heli.cabin, dt); }
        if (heli.whole) { heli.whole.body.visible = outside(); if (outside()) placeAirframe(heli.whole, dt); }
        if (outside()) {
          // from behind and above the helicopter, looking where the pilot looks. Tracking, from a little to the
          // left, at a point between the helicopter and the vehicle: both in view, the helicopter not hiding it.
          camera.getWorldDirection(dir);
          const track = camMode === "track", want = eyeOff.copy(camera.position).addScaledVector(dir, track ? -18 : -14);
          want.y += track ? 6 : 3.5;
          if (track) { const l = Math.hypot(dir.x, dir.z) || 1; want.x += (dir.z / l) * 9; want.z -= (dir.x / l) * 9; }
          if (outFresh) outCam.position.copy(want); else outCam.position.lerp(want, 1 - Math.exp(-dt * 4));
          outFresh = false;
          if (track) outAt.copy(camera.position).lerp(lookAt, 0.55); else outAt.copy(camera.position).addScaledVector(dir, 30);
          outCam.lookAt(outAt);
          if (outCam.aspect !== camera.aspect) { outCam.aspect = camera.aspect; outCam.updateProjectionMatrix(); }
        } else outFresh = true;
        // rotor sound while flying (its beat follows the work: speed and climbing)
        const wantSound = camMode !== "orbit" && soundRef.current && !document.hidden;
        if (wantSound !== soundOn) { soundOn = wantSound; if (soundOn) rotorSound.start(); else rotorSound.stop(); }
        // war: fire, move the rounds and rockets, take the destroyed vehicles off the roads
        shoot(now);
        const ev = combat.update(dt, world, outside() ? outCam.position : camera.position);
        // (they stay on the road as wrecks, obstacles in the traffic, until towed)
        if (ev.destroyed.length) { simController.breakDown(ev.destroyed, true); setKills(combat.destroyedCount); }
        if (soundOn) { for (let k = 0; k < Math.min(2, ev.shots); k++) rotorSound.shot(); for (const d of ev.blasts) rotorSound.blast(d); }
        if (now - lastForget > 1000 && sim) { lastForget = now; combat.forget(id => sim.vehicles.some(v => v.id === id && !v.dead)); }
        if (soundOn) rotorSound.set(0.75 * Math.min(1, flight.speed / HELI_VMAX) + 0.25 * Math.max(0, Math.min(1, flight.vs / 8)), outside());
        // vehicles
        let n = 0, ng = 0;
        if (vsim) for (const v of vsim.vehicles) {
          if (v.dead || n + 2 >= MAXV || combat.isGone(v.id)) continue;
          const q = vsim.pose(v), y0 = v.z * LEVEL_H;
          let mx = (q.fx + q.rx) / 2, mz = (q.fy + q.ry) / 2;
          if (followOffset(v)) { mx += follow.ox; mz += follow.oz; }
          const dx = q.fx - q.rx, dz = q.fy - q.ry, m = Math.hypot(dx, dz) || 1, a = Math.atan2(-dz, dx), ux = dx / m, uz = dz / m;
          const sc = u.display.bySpeed ? speedColor(pal, v.v / Math.max(1, v.v0)) : null;
          dummy.rotation.set(0, a, 0);
          if (v.kind === "truck") {
            dummy.position.set(mx - ux * v.len * 0.12, 0.55 + y0, mz - uz * v.len * 0.12); dummy.scale.set(v.len * 0.74, 3, v.width); dummy.updateMatrix();
            body.setMatrixAt(n, dummy.matrix); col.set(sc ?? pal.truck); body.setColorAt(n++, col);
            dummy.position.set(mx + ux * v.len * 0.385, 0.45 + y0, mz + uz * v.len * 0.385); dummy.scale.set(v.len * 0.21, 2.45, v.width * 0.98); dummy.updateMatrix();
            body.setMatrixAt(n, dummy.matrix); col.set(sc ?? CAR3D[1]); body.setColorAt(n++, col);
            dummy.position.set(mx + ux * v.len * 0.47, 1.75 + y0, mz + uz * v.len * 0.47); dummy.scale.set(0.35, 0.8, v.width * 0.9); dummy.updateMatrix();
            glass.setMatrixAt(ng++, dummy.matrix);
            continue;
          }
          const bus = v.kind === "bus";
          dummy.position.set(mx, (bus ? 0.3 : 0.28) + y0, mz); dummy.scale.set(v.len, bus ? 2.9 : 1.0, v.width); dummy.updateMatrix();
          body.setMatrixAt(n, dummy.matrix); col.set(sc ?? (bus ? pal.busVeh : CAR3D[v.tint % 4])); body.setColorAt(n++, col);
          if (bus) { dummy.position.set(mx, 1.75 + y0, mz); dummy.scale.set(v.len * 0.9, 0.85, v.width * 1.03); }
          else { const b = v.len * 0.07; dummy.position.set(mx - ux * b, 1.27 + y0, mz - uz * b); dummy.scale.set(v.len * 0.5, 0.55, v.width * 0.86); }
          dummy.updateMatrix(); glass.setMatrixAt(ng++, dummy.matrix);
        }
        // blinkers
        let nl = 0;
        if (vsim && Math.floor(now / 380) % 2 === 0) for (const v of vsim.vehicles) {
          const b = vsim.blinker(v);
          if (!b || nl + 4 > 16000 || combat.isGone(v.id)) continue;
          const q = vsim.pose(v);
          let mx = (q.fx + q.rx) / 2, mz = (q.fy + q.ry) / 2;
          if (followOffset(v)) { mx += follow.ox; mz += follow.oz; }
          const dx = q.fx - q.rx, dz = q.fy - q.ry, m = Math.hypot(dx, dz) || 1, ux = dx / m, uz = dz / m;
          const half = v.len / 2 - 0.15, side = v.width / 2 + 0.02, h = (v.kind === "car" ? 0.6 : 0.9) + v.z * LEVEL_H;
          dummy.rotation.set(0, Math.atan2(-dz, dx), 0); dummy.scale.set(1, 1, 1);
          // (2: hazard lights, both sides)
          for (const sd of b === 2 ? [1, -1] : [b]) for (const f of [half, -half]) {
            dummy.position.set(mx + ux * f - uz * sd * side, h, mz + uz * f + ux * sd * side); dummy.updateMatrix();
            lamps.setMatrixAt(nl++, dummy.matrix);
          }
        }
        lamps.count = nl; lamps.instanceMatrix.needsUpdate = true;
        body.count = n; glass.count = ng;
        body.instanceMatrix.needsUpdate = true; glass.instanceMatrix.needsUpdate = true;
        if (body.instanceColor) body.instanceColor.needsUpdate = true;
        // signals and stop labels
        if (furniture) {
          for (const h of furniture.heads) h.mesh.material = sim ? sigMats[sim.signalFor(h.nodeIdx, h.arm, h.lane) ?? "red"] : sigMats.off;
          for (const L of furniture.laneSigns) L.mesh.material = laneMats[laneSign(sim?.rev[L.corr]?.state, L.cdir, L.entry, L.rev)];
          for (const L of furniture.labels) {
            const st = simController.compiled.stopById.get(L.id);
            const text = st ? `${st.def.name}${sim ? ` · ${Math.floor(st.waiting)}` : ""}` : "";
            if (L.sprite.userData.text === text) continue;
            L.sprite.userData.text = text;
            const g = L.canvas.getContext("2d")!;
            g.clearRect(0, 0, 256, 64); g.fillStyle = pal.select; g.beginPath(); g.roundRect(4, 8, 248, 48, 10); g.fill();
            g.fillStyle = "#fff"; g.font = `600 26px ${pal.sans}`; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(text, 128, 33);
            L.tex.needsUpdate = true;
          }
        }
        // selection: ring for vehicle/node, translucent overlay for link
        const sel = u.selection, net = network$.getValue();
        ring.visible = false;
        if (sel?.kind === "vehicle" && sim) {
          const v = sim.vehicles.find(x => String(x.id) === sel.id && !x.dead);
          if (v) { const q = sim.pose(v), o = followOffset(v); ring.position.set((q.fx + q.rx) / 2 + (o ? follow.ox : 0), 0.12 + v.z * LEVEL_H, (q.fy + q.ry) / 2 + (o ? follow.oz : 0)); const s = Math.max(3.5, v.len * 0.8); ring.scale.set(s, s, s); ring.visible = true; }
        } else if (sel?.kind === "node") {
          const nd = net.nodes.find(x => x.id === sel.id);
          if (nd) { ring.position.set(nd.x, 0.12, nd.y); ring.scale.set(12, 12, 12); ring.visible = true; }
        }
        const key = sel?.kind === "link" || sel?.kind === "building" ? `${sel.kind}:${sel.id}:${simController.version}` : "";
        if (key !== hlFor) {
          hlFor = key;
          hl.geometry.dispose();
          let geo = new THREE.BufferGeometry();
          const bld = sel?.kind === "building" ? net.buildings?.find(b => b.id === sel.id) : undefined;
          if (bld) geo = buildingShell(bld);
          else if (sel?.kind === "link") {
            const s = buildRoadGeo(simController.compiled, net).surfaces.find(x => x.linkId === sel.id);
            if (s) {
              const L = s.curb.left.pts, R = s.curb.right.pts, pos: number[] = [], hf = heightFn(simController.compiled, net);
              // on top of the road, bridges included
              const z = (x: number, y: number) => 0.25 + hf.at(s.on, x, y);
              for (let k = 0; k < Math.min(L.length, R.length) / 2 - 1; k++) {
                pos.push(L[2 * k], z(L[2 * k], L[2 * k + 1]), L[2 * k + 1], L[2 * k + 2], z(L[2 * k + 2], L[2 * k + 3]), L[2 * k + 3], R[2 * k + 2], z(R[2 * k + 2], R[2 * k + 3]), R[2 * k + 3]);
                pos.push(L[2 * k], z(L[2 * k], L[2 * k + 1]), L[2 * k + 1], R[2 * k + 2], z(R[2 * k + 2], R[2 * k + 3]), R[2 * k + 3], R[2 * k], z(R[2 * k], R[2 * k + 1]), R[2 * k + 1]);
              }
              geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
            }
          }
          hl.geometry = geo;
        }
        if (camMode === "orbit") controls.update();
        const viewCam = outside() ? outCam : camera;
        // compass: heading of the camera's view direction, 0° = looking north
        viewCam.getWorldDirection(dir);
        const heading = Math.round((Math.atan2(dir.x, -dir.z) * 180) / Math.PI * 10) / 10;
        if (heading !== lastHeading) { lastHeading = heading; compassEl()?.style.setProperty("--heading", `${-heading}deg`); }
        // the reversible lanes' switches, over their roads (flying)
        placeReversibleControls(revRef.current, viewCam, renderer.domElement.clientWidth, renderer.domElement.clientHeight, camMode !== "orbit");
        renderer.render(scene, viewCam);
        if (heli.cabin?.body.visible) {
          // the cabin over the view, its own depth (and no sky: the view is already there)
          cabinCam.position.copy(camera.position); cabinCam.quaternion.copy(camera.quaternion);
          if (cabinCam.fov !== camera.fov || cabinCam.aspect !== camera.aspect) { cabinCam.fov = camera.fov; cabinCam.aspect = camera.aspect; cabinCam.updateProjectionMatrix(); }
          const bg = scene.background, fog = scene.fog;
          scene.background = null; scene.fog = null;
          renderer.autoClear = false; renderer.shadowMap.autoUpdate = false;
          renderer.clearDepth(); renderer.render(scene, cabinCam);
          renderer.autoClear = true; renderer.shadowMap.autoUpdate = true;
          scene.background = bg; scene.fog = fog;
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      subs.forEach(s => s.unsubscribe());
      mq.removeEventListener("change", applyTheme);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointerdown", onLookDown);
      renderer.domElement.removeEventListener("pointermove", onLookMove);
      renderer.domElement.removeEventListener("pointerleave", onHoverLeave);
      renderer.domElement.removeEventListener("pointerup", onLookUp);
      renderer.domElement.removeEventListener("pointercancel", onLookUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
      modeApi.current = null;
      leave();
      disposed = true;
      for (const h of [heli.cabin, heli.whole]) if (h) { scene.remove(h.body); h.dispose(); }
      rotorSound.dispose();
      combat.dispose();
      controls.dispose();
      if (houses) { houses.mesh.geometry.dispose(); (houses.mesh.material as THREE.Material).dispose(); }
      ulMat.map?.dispose(); ulMat.dispose(); ulMesh.geometry.dispose();
      for (const m of Object.values(laneMats)) { m.map?.dispose(); m.dispose(); }
      satMat.map?.dispose(); satMat.dispose(); satMesh.geometry.dispose();
      renderer.dispose();
      wrap.removeChild(renderer.domElement);
      compassEl()?.style.setProperty("--heading", "0deg");
    };
  }, []);

  return (
    <>
      <div ref={wrapRef} className="absolute inset-0 overflow-hidden" aria-label="3D view of the street plan" />
      {mode !== "orbit" && <Cockpit apiRef={cockpitApi} tracking={mode === "track"} />}
      <div ref={revRef} className="pointer-events-none absolute inset-0 z-[6] overflow-hidden"><ReversibleControls /></div>
      {mode !== "orbit" && war && (
        // the gunsight, in the middle of the view
        <svg viewBox="-40 -40 80 80" className="pointer-events-none absolute top-1/2 left-1/2 z-[6] size-16 -translate-x-1/2 -translate-y-1/2 text-red-500 drop-shadow-[0_0_3px_rgba(239,68,68,0.7)]" aria-hidden>
          <circle r="18" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M0 -34 V-22 M0 22 V34 M-34 0 H-22 M22 0 H34" stroke="currentColor" strokeWidth="1.8" />
          <circle r="1.8" fill="currentColor" />
        </svg>
      )}
      <div className="absolute top-3 right-3 z-10 flex max-w-72 flex-col items-end gap-1.5">
        <ToggleGroup
          type="single" value={mode} aria-label="Camera"
          onValueChange={v => { if (v) { setNote(""); setMode(v as CamMode); } }}
          className="bg-background/95 shadow-sm backdrop-blur"
        >
          <ToggleGroupItem value="orbit" aria-label="Orbit camera" title="Orbit camera"><Orbit /> Orbit</ToggleGroupItem>
          <ToggleGroupItem value="heli" aria-label="Fly a helicopter" title="Fly a helicopter"><Plane /> Helicopter</ToggleGroupItem>
          <ToggleGroupItem
            value="track" disabled={!vehicleSelected && mode !== "track"} aria-label="Track the selected vehicle"
            title={vehicleSelected ? "The helicopter follows the selected vehicle" : "Click a vehicle first, then track it"}
          ><Crosshair /> Track</ToggleGroupItem>
        </ToggleGroup>
        {mode !== "orbit" && (
          <div className="flex gap-1.5">
            <ToggleGroup type="single" value={view} aria-label="Seen from" onValueChange={v => { if (v) setView(v as HeliView); }} className="bg-background/95 shadow-sm backdrop-blur">
              <ToggleGroupItem value="cockpit" aria-label="From the cockpit" title="From the pilot's seat (C)"><Gauge /> Cockpit</ToggleGroupItem>
              <ToggleGroupItem value="outside" aria-label="From outside" title="From behind the helicopter (C)"><Eye /> Outside</ToggleGroupItem>
            </ToggleGroup>
            <Button size="sm" variant={war ? "destructive" : "outline"} aria-pressed={war} onClick={() => { setWar(w => !w); setNote(""); }}
              title="War mode: the gun (Space, or click) and guided rockets (R)" className={cn("h-8 shadow-sm", !war && "bg-background/95")}><Swords /> War</Button>
            <Button size="icon-sm" variant="outline" aria-pressed={sound} onClick={() => setSound(x => !x)}
              aria-label={sound ? "Turn the rotor sound off" : "Turn the rotor sound on"} title={sound ? "Sound on" : "Sound off"}
              className="size-8 bg-background/95 shadow-sm">{sound ? <Volume2 /> : <VolumeX />}</Button>
          </div>
        )}
        {mode !== "orbit" && (
          <div className="rounded-lg border bg-background/95 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur">
            <div className="mb-1 font-medium text-foreground tabular-nums"><span ref={hudRef} /></div>
            {mode === "heli" ? (
              <>
                <div><Kbd>Z</Kbd> <Kbd>S</Kbd> forward, back · <Kbd>Q</Kbd> <Kbd>D</Kbd> left, right (or arrows)</div>
                <div>Mouse towards a side turns · drag to look around</div>
                <div><Kbd>E</Kbd>/<Kbd>PgUp</Kbd> climb · <Kbd>A</Kbd>/<Kbd>PgDn</Kbd> descend · or scroll</div>
                <div><Kbd>Shift</Kbd> faster · <Kbd>C</Kbd> cockpit / outside · click a vehicle, then Track</div>
              </>
            ) : (
              <>
                <div>Following the selected vehicle; click another to switch</div>
                <div>Drag to circle round it · <Kbd>Q</Kbd> <Kbd>D</Kbd> too</div>
                <div><Kbd>Z</Kbd> <Kbd>S</Kbd> closer, further · scroll zooms</div>
                <div><Kbd>E</Kbd>/<Kbd>A</Kbd> higher, lower · <Kbd>C</Kbd> cockpit / outside</div>
              </>
            )}
          </div>
        )}
        {mode !== "orbit" && war && (
          <div className="rounded-lg border border-red-500/40 bg-background/95 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur">
            <div className="mb-0.5 font-medium text-red-600 dark:text-red-400">War mode · {kills} destroyed</div>
            <div><Kbd>Space</Kbd> gun at the sight · click: a burst there</div>
            <div><Kbd>R</Kbd> rocket, locked on the vehicle nearest the sight{mode === "track" ? " (the tracked one)" : ""}</div>
          </div>
        )}
        {mode !== "orbit" && vehicleSelected && <SelectedVehicleActions id={selection!.id} />}
        {note && <div className="rounded-md bg-background/95 px-2 py-1 text-[11px] shadow-sm">{note}</div>}
        {mode !== "orbit" && (
          // the model's licence asks for its author to be named
          <a href={HELI_MODEL_CREDIT.url} target="_blank" rel="noreferrer" className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
            {HELI_MODEL_CREDIT.title} model by {HELI_MODEL_CREDIT.author} · {HELI_MODEL_CREDIT.license}
          </a>
        )}
      </div>
    </>
  );
}

/** flying: the selected vehicle's state, and its engine failure (or, broken down, towing it away) */
function SelectedVehicleActions({ id }: { id: string }) {
  useSubject(stats$); // live state (~4×/s)
  const v = simController.sim?.vehicles.find(x => String(x.id) === id);
  if (!v) return null;
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background/95 py-1 pr-1 pl-2.5 text-[11px] shadow-sm backdrop-blur">
      <span className="text-muted-foreground">#{v.id} · {v.state}</span>
      <BreakdownButton id={v.id} state={v.state} />
    </div>
  );
}
