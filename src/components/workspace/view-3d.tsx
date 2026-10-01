"use client";

import { useEffect, useRef, useState } from "react";
import { useDeepSubject } from "subjecto/react";
import { Crosshair, Gauge, Orbit, Plane } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildRoadGeo, heightFn, laneSign } from "@/render/geometry";
import { buildBuildings, buildFurniture, buildMarkers, buildRoads, buildingShell, laneSignMaterials, type Furniture } from "@/render/scene3d";
import { satelliteMosaic } from "@/render/satellite";
import type { BuildingDef } from "@/engine/types";
import { readPalette, speedColor, type Palette } from "@/render/palette";
import { LEVEL_H, linkExtent } from "@/engine/compile";
import { network$, select, ui, underlay$, type LayerId, type UiState } from "@/state/store";
import { underlayImg$ } from "@/state/underlay-image";
import { simController } from "@/state/sim-controller";
import { viewCmd$ } from "@/state/commands";
import * as ops from "@/state/ops";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Kbd } from "@/components/ui/kbd";
import { Button } from "@/components/ui/button";
import { Cockpit, type CockpitApi } from "./heli-cockpit";

const CAR3D = ["#ffffff", "#f1f2ee", "#e2e5e1", "#cdd1cd"];

/** orbit: the usual turntable camera; heli: fly freely; track: the helicopter follows the selected vehicle */
type CamMode = "orbit" | "heli" | "track";
const HELI_MIN = 4, HELI_MAX = 1500;
/** the helicopter's top speed over the ground: 200 km/h */
const HELI_VMAX = 200 / 3.6;

export function View3D() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const hudRef = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<CamMode>("orbit");
  const [note, setNote] = useState("");
  const [selection] = useDeepSubject(ui, "selection");
  const modeApi = useRef<(m: CamMode) => void>(null);
  const cockpitApi = useRef<CockpitApi>(null);
  const [cockpit, setCockpit] = useState(true);
  const cockpitOn = useRef(cockpit);
  useEffect(() => { cockpitOn.current = cockpit; }, [cockpit]);
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
    const vel = new THREE.Vector3(), held = new Set<string>(), dir = new THREE.Vector3();
    const chase = { angle: 0, dist: 45, height: 22, heading: NaN, id: "" };
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
        if (was === "orbit") fromCamera();
        if (m === "track") { chase.heading = NaN; chase.id = ""; }
        follow.ok = false;
      }
      renderer.domElement.style.cursor = m === "orbit" ? "" : "grab";
    }
    modeApi.current = setCamMode;
    const typing = (e: Event) => !!(e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable],[role=combobox],[role=slider],[role=tablist],[role=menu],[role=listbox]");
    const FLY_KEYS = new Set(["arrowup", "arrowdown", "arrowleft", "arrowright", "z", "q", "s", "d", "e", "a", "pageup", "pagedown", "shift"]);
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (e.type === "keyup") { held.delete(k); if (k === "shift") held.delete("shift"); return; }
      if (camMode === "orbit" || u.view !== "3d" || e.metaKey || e.ctrlKey || e.altKey || typing(e) || !FLY_KEYS.has(k)) return;
      // Shift+E / Shift+Q stay layer shortcuts only when not flying; here they mean "faster"
      e.preventDefault(); e.stopPropagation();
      held.add(k);
    };
    const onBlur = () => held.clear();
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
      if (!look || e.pointerId !== look.id || camMode === "orbit") return;
      const dx = e.clientX - look.x, dy = e.clientY - look.y;
      look.x = e.clientX; look.y = e.clientY;
      if (camMode === "heli") { yaw -= dx * 0.004; pitch = Math.max(-1.5, Math.min(0.5, pitch - dy * 0.004)); }
      else { chase.angle -= dx * 0.006; chase.height = Math.max(HELI_MIN, Math.min(400, chase.height + dy * 0.25)); }
    };
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
      else { chase.dist = Math.max(8, Math.min(600, chase.dist * k)); chase.height = Math.max(HELI_MIN, Math.min(400, chase.height * k)); }
    };
    renderer.domElement.addEventListener("pointerdown", onLookDown);
    renderer.domElement.addEventListener("pointermove", onLookMove);
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
        // faster high up, slower near the ground; the helicopter eases in and out of motion
        const cruise = Math.min(HELI_VMAX, Math.max(12, camera.position.y * 0.9) * fast);
        // (diagonally no faster than straight ahead)
        const sy = Math.sin(yaw), cy = Math.cos(yaw), k = cruise / Math.max(1, Math.hypot(fwd, side));
        const want = new THREE.Vector3((-sy * fwd + cy * side) * k, climb * Math.max(6, cruise * 0.5), (-cy * fwd - sy * side) * k);
        vel.lerp(want, 1 - Math.exp(-dt * 2.5));
        camera.position.addScaledVector(vel, dt);
        camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, camera.position.y));
        camera.rotation.order = "YXZ"; camera.rotation.set(pitch, yaw, -0.05 * side * Math.min(1, vel.length() / 20));
        speed = Math.hypot(vel.x, vel.z);
        flight.roll = -camera.rotation.z; flight.range = NaN;
      } else if (camMode === "track") {
        const sel = u.selection, v = sel?.kind === "vehicle" && sim ? sim.vehicles.find(x => String(x.id) === sel.id && !x.dead) : undefined;
        if (!v) {
          // the vehicle finished its trip (or the selection moved on): hover where we are
          setNote(sel?.kind === "vehicle" ? "The vehicle left the network: flying freely." : "Nothing to track: flying freely.");
          setMode("heli"); setCamMode("heli"); fromCamera();
          return;
        }
        if (chase.id !== sel!.id) { chase.id = sel!.id; chase.heading = NaN; follow.ok = false; setNote(""); }
        chase.angle += side * dt * 1.2 * fast;
        chase.dist = Math.max(8, Math.min(600, chase.dist * Math.exp(-fwd * dt * fast)));
        chase.height = Math.max(HELI_MIN, Math.min(400, chase.height + climb * dt * Math.max(6, chase.height * 0.8) * fast));
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
        flight.roll = bank; flight.range = camera.position.distanceTo(lookAt);
      }
      if (camMode !== "track") { lastSwing = NaN; bank = 0; }
      if (cockpitOn.current) {
        // the airframe's vibration
        const t = now / 1000;
        camera.rotateX(0.0011 * Math.sin(t * 23) + 0.0006 * Math.sin(t * 61));
        camera.rotateZ(0.0009 * Math.sin(t * 17 + 1));
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
      ray.setFromCamera(ndc, camera);
      if (!ray.ray.intersectPlane(plane, hit)) return;
      const p = { x: hit.x, y: hit.z }, net = network$.getValue();
      const dist = camera.position.distanceTo(hit), tol = Math.max(3, dist * 0.012);
      const sim = simController.sim;
      const v = sim?.vehicleNear(p.x, p.y, tol);
      if (v) return select({ kind: "vehicle", id: String(v.id) });
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
        if (homed !== u.planId) { homed = u.planId; home(); }
        const sim = simController.sim, vsim = shown("vehicles") ? sim : null;
        // the helicopter moves first: drawing the tracked vehicle needs its smoothed position
        if (camMode !== "orbit") fly(dt, now, sim);
        // vehicles
        let n = 0, ng = 0;
        if (vsim) for (const v of vsim.vehicles) {
          if (v.dead || n + 2 >= MAXV) continue;
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
          if (!b || nl + 2 > 16000) continue;
          const q = vsim.pose(v);
          let mx = (q.fx + q.rx) / 2, mz = (q.fy + q.ry) / 2;
          if (followOffset(v)) { mx += follow.ox; mz += follow.oz; }
          const dx = q.fx - q.rx, dz = q.fy - q.ry, m = Math.hypot(dx, dz) || 1, ux = dx / m, uz = dz / m;
          const nx = -uz * b, nz = ux * b, half = v.len / 2 - 0.15, side = v.width / 2 + 0.02, h = (v.kind === "car" ? 0.6 : 0.9) + v.z * LEVEL_H;
          dummy.rotation.set(0, Math.atan2(-dz, dx), 0); dummy.scale.set(1, 1, 1);
          for (const f of [half, -half]) {
            dummy.position.set(mx + ux * f + nx * side, h, mz + uz * f + nz * side); dummy.updateMatrix();
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
        // compass: heading of the camera's view direction, 0° = looking north
        camera.getWorldDirection(dir);
        const heading = Math.round((Math.atan2(dir.x, -dir.z) * 180) / Math.PI * 10) / 10;
        if (heading !== lastHeading) { lastHeading = heading; compassEl()?.style.setProperty("--heading", `${-heading}deg`); }
        renderer.render(scene, camera);
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
      renderer.domElement.removeEventListener("pointerup", onLookUp);
      renderer.domElement.removeEventListener("pointercancel", onLookUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
      window.removeEventListener("blur", onBlur);
      modeApi.current = null;
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
      {mode !== "orbit" && cockpit && <Cockpit apiRef={cockpitApi} tracking={mode === "track"} />}
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
          <Button size="sm" variant={cockpit ? "default" : "outline"} aria-pressed={cockpit} onClick={() => setCockpit(c => !c)}
            title="Show or hide the cockpit" className="h-8 shadow-sm"><Gauge /> Cockpit</Button>
        )}
        {mode !== "orbit" && (
          <div className="rounded-lg border bg-background/95 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur">
            <div className="mb-1 font-medium text-foreground tabular-nums"><span ref={hudRef} /></div>
            {mode === "heli" ? (
              <>
                <div><Kbd>Z</Kbd> <Kbd>S</Kbd> forward, back · <Kbd>Q</Kbd> <Kbd>D</Kbd> left, right (or arrows)</div>
                <div>Drag the mouse to look around</div>
                <div><Kbd>E</Kbd>/<Kbd>PgUp</Kbd> climb · <Kbd>A</Kbd>/<Kbd>PgDn</Kbd> descend · or scroll</div>
                <div><Kbd>Shift</Kbd> faster · click a vehicle, then Track</div>
              </>
            ) : (
              <>
                <div>Following the selected vehicle; click another to switch</div>
                <div>Drag to circle round it · <Kbd>Q</Kbd> <Kbd>D</Kbd> too</div>
                <div><Kbd>Z</Kbd> <Kbd>S</Kbd> closer, further · scroll zooms</div>
                <div><Kbd>E</Kbd>/<Kbd>A</Kbd> higher, lower</div>
              </>
            )}
          </div>
        )}
        {note && <div className="rounded-md bg-background/95 px-2 py-1 text-[11px] shadow-sm">{note}</div>}
      </div>
    </>
  );
}
