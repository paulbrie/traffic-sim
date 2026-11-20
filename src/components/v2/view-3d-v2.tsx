"use client";

/**
 * The V2 plan in 3D (as V1's view-3d.tsx, in plain three.js): over the plan editor's map while its mode is "3d", the
 * editor staying up underneath (its cars, its state), so the same cars drive here. An orbit camera (drag to turn, right
 * drag to pan, wheel to zoom), arriving over where the plan view was (and eased back there by `home`) and leaving it where the 3D view is; the ground, the
 * satellite imagery where the sketch has a place on Earth, and the reference image. Drawn only while shown and the tab is
 * visible; everything it made is let go when it goes. And V1's helicopter (ticket #129, heli-v2.ts): fly over the plan, or
 * follow the car picked, from the cockpit or from behind; war mode where the user has it on.
 *
 * World axes: x east as on the plan, y up, z the plan's y (south).
 */
import { useEffect, useRef, useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import * as THREE from "three";
import { toast } from "sonner";
import { Crosshair, Eye, Gauge, Keyboard, Orbit, Plane, Plus, Settings, Swords, Volume2, VolumeX } from "lucide-react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { baseLaneId, isTwinId, wayFrom, connectorPts, junctionLevel, shownCarZ, shownZ, laneById, laneLength, outlinePath, pointAt, signalAt, signalPlans, smoothJunction, zAt, edgeGround, groundAt, groundBase, groundUnder, hasHeights, terrainOf, buildingsOf, polygonArea, type JunctionContents, type Piece, type Pt, type SignalController, type Sketch } from "@/lib/lane-sketch";
import { LEVEL_H } from "@/engine/compile";
import { speedColor } from "@/render/palette";
import { buildSketch3D, streetNameRuns, type Sketch3D } from "@/render/sketch3d";
import { buildStreetNames3D, type StreetNames3D } from "@/render/street-names3d";
import { buildZones3D, type Zones3D } from "@/render/zones3d";
import { buildShapes3D, type Shapes3D } from "@/render/shapes3d";
import { buildUtilities3D, type Utilities3D } from "@/render/utilities3d";
import { linesOf as utilityLines, netShown, nodeMap as utilityNodeMap } from "@/lib/sketch-utilities";
import { buildBuildings3D, type Buildings3D } from "@/render/buildings3d";
import { buildingUseLabel, footprintPts, type SketchBuilding } from "@/lib/sketch-buildings";
import type { SketchLayers } from "@/state/sketch-layers";
import type { Underlay } from "@/lib/underlay";
import { isDark, onThemeChange, readPalette } from "@/render/palette";
import { satelliteMosaic, type SatSource } from "@/render/satellite";
import { terrainAt, terrainHeights } from "@/lib/terrain";
import type { SatOptions } from "@/state/sat-options";
import type { EditorUi } from "@/state/sketch-ui";
import type { SketchSim } from "@/lib/lane-sketch-sim";
import { ui } from "@/state/store";
import { heliKeys$ } from "@/state/heli-keys";
import { keyLabel, type HeliAction } from "@/lib/heli-keys";
import { saveWarMode } from "@/server/actions";
import { ENEMY_MAX } from "@/render/enemies";
import { HELI_MODEL_CREDIT } from "@/render/helicopter";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Cockpit, type CockpitApi } from "@/components/workspace/heli-cockpit";
import { HeliKeysDialog } from "@/components/workspace/heli-keys-dialog";
import { HeliRig, type CamMode, type HeliCar, type HeliView } from "./heli-v2";
import { InspectScreenV2, VehicleScreenV2 } from "./heli-screens-v2";
import { SketchHoverCard, type HoverInfo } from "./sketch-hover-card";

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
  /** the cars' turn signals shown (off: none) */
  blinkers: boolean;
  simT: () => number | null; signals: () => SignalController[] | null;
  /** the car picked's way on to the end of its trip (drawn on the road), if it has one */
  carWay?: () => Pt[] | null;
  /** what holds the car picked (T157): where its leader and blocker are, the conflict zone on both paths */
  carWhy?: () => { leader: Pt | null; blocker: Pt | null; zone: { mine: Pt[]; theirs: Pt[] } | null } | null;
  /** what is selected (drawn over the scene at its own height), the car picked (a ring round it) */
  selection: Piece & { unode?: string | null }; car: number | null;
  /** (ticket #280) a utility node or line clicked (its line, and the node if it was one); what one under the pointer is, for its card */
  pickUtility?: (line: string, node: string | null) => void;
  utilityAbout?: (line: string, node: string | null) => HoverInfo | null;
  /** the route traced (orange), and a test car's other way (blue) */
  route: { lanes: Set<string>; conns: Set<string>; driven: { lanes: Set<string>; conns: Set<string> } } | null;
  /** a click on the scene at `p`, on level `level` (the highest first): true if it picked something there (flying, only a
   * car, within `tol` metres: from high up they are small) */
  pickAt: (p: Pt, level: number, flying?: { tol: number }) => boolean;
  /** what is at `p` on level `level`, as the map's hover card says it, a car within `tol` metres (null: nothing there, or not on that level) */
  hoverAt: (p: Pt, level: number, tol: number) => HoverInfo | null;
  /** the car picked, live (its speed, what it does), and what the hover card says of it: the cockpit's screen */
  carInfo: ReturnType<SketchSim["inspect"]>; carAbout: HoverInfo | null;
  /** cars destroyed in war mode: broken down where they are, until towed */
  breakDown: (ids: number[]) => void;
  /** how far up from the bottom the cockpit's display sits (px): above what the editor has there */
  raiseCockpit?: number;
  /** a click on nothing */
  pickNone: () => void;
  /** the canvas, for the bridge's screenshot (with a frame drawn just before it is read) */
  canvasRef: React.MutableRefObject<(() => HTMLCanvasElement | null) | null>;
}

export interface View3DApi { fit: () => void; dolly: (f: number) => void; home: () => void; camera: () => Camera3DUi }
/** where the camera is (as the UI store keeps it) */
export type Camera3DUi = NonNullable<EditorUi["camera"]>;

const FOV = 40, TILT = (55 * Math.PI) / 180;
/** how long a turn signal is lit, then dark (ms; V1's) */
const BLINK_MS = 380;
/** how long the camera takes back to where it arrived (ms) */
const HOME_MS = 700;
/** a car as the editor shows it: its middle, heading, length, speed as a share of what it wants; a truck's trailer; broken down; its level */
export interface Car3D { id?: number; p: { x: number; y: number }; d: { x: number; y: number }; len: number; share: number; trailer?: { p: { x: number; y: number }; d: { x: number; y: number }; len: number }; broken?: boolean; /** its turn signal on: -1 left, 1 right */ blink?: -1 | 1; z?: number;
  /** (ticket #130) the ground's height under it (m; live, from the sim), or where it is (replayed: its edge and how far along it) to work it out */
  g?: number; edge?: string; pos?: number }
/** instances at most: bodies (a truck's cab and trailer two), their glass, hazard lamps */
const MAXV = 24000, MAXL = 4000;
/** how high a car's body is, and a truck's */
const CAR_H = 1.35, CAR_W = 1.8, TRUCK_H = 2.6, TRUCK_W = 2.4, TRAILER_H = 3.2;

export function View3DV2(props: View3DProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const live = useRef(props);
  useEffect(() => { live.current = props; });
  // (ticket #129) the helicopter: the camera's mode, seen from where, war mode (where the user has it on in the
  // settings), its sound; what the overlay shows of the flight, and what the pointer is over
  const [mode, setMode] = useState<CamMode>("orbit");
  const [view, setView] = useState<HeliView>("cockpit");
  const [warMode] = useDeepSubject(ui, "warMode");
  const [armedOn, setArmed] = useState(false);
  const war = armedOn && warMode;
  const [sound, setSound] = useState(true);
  const [note, setNote] = useState("");
  const [foes, setFoes] = useState({ count: 0, kills: 0, hull: 1 });
  const [kills, setKills] = useState(0);
  const [hover, setHover] = useState<{ info: HoverInfo; x: number; y: number } | null>(null);
  const rig = useRef<HeliRig | null>(null);
  const hudRef = useRef<HTMLSpanElement>(null), cockpitApi = useRef<CockpitApi>(null), markersRef = useRef<HTMLDivElement>(null), flashRef = useRef<HTMLDivElement>(null);
  useEffect(() => { rig.current?.setMode(mode); }, [mode]);
  useEffect(() => { rig.current?.setView(view); }, [view]);
  useEffect(() => { if (rig.current) rig.current.war = war; }, [war]);
  useEffect(() => { if (rig.current) rig.current.sound = sound; }, [sound]);

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
    // (the grass, then the imagery on it, drawn first and writing no depth, as V1's: looked at from far off and low down
    // (from the helicopter, ticket #129) they would otherwise fight over which is in front, and the grass won)
    (ground.material as THREE.MeshLambertMaterial).depthWrite = false; ground.renderOrder = -2;
    // heights (ticket #130): everything on the ground's height, the lowest (`groundBase`) at y = 0; none, all at 0 as before
    let hFor: Sketch | null = null, hOn = false, hBase = 0;
    const heights = () => { const sk = live.current.sketch; if (sk !== hFor) { hFor = sk; hOn = hasHeights(sk); hBase = groundBase(sk); } return hOn; };
    /** the ground's y along a lane, under a point (the nearest lane's, else the terrain's), and fast (the terrain's alone, if any: for rays) */
    const gLane = (lane: string, s: number) => (heights() ? groundAt(live.current.sketch, lane, s) - hBase : 0);
    const gUnder = (p: Pt) => (heights() ? groundUnder(live.current.sketch, p) - hBase : 0);
    const gFast = (x: number, z: number) => {
      if (!heights()) return 0;
      const t = terrainOf(live.current.sketch);
      return (t ? terrainAt(t, x, z) : groundUnder(live.current.sketch, { x, y: z })) - hBase;
    };
    /** a car's road's y: the ground under it (the sim's, or worked out from where it is), and its level over it */
    const carY = (c: Car3D) => {
      const sk = live.current.sketch, lv = shownCarZ(sk, c.p, c.z ?? 0) * LEVEL_H;
      if (!heights()) return lv;
      return lv + (c.g ?? (c.edge ? edgeGround(sk, c.edge, c.pos ?? 0) : groundUnder(sk, c.p))) - hBase;
    };
    // the helicopter (its cars: those drawn now, worked out once a frame when it asks)
    let heliCars: HeliCar[] | null = null;
    const carsForHeli = () => {
      if (heliCars) return heliCars;
      const p = live.current;
      return (heliCars = (p.cars() ?? []).flatMap(c => (c.id === undefined ? [] : [{
        id: c.id, x: c.p.x, y: c.p.y, h: carY(c), heading: Math.atan2(c.d.y, c.d.x), len: c.len, width: c.trailer ? TRUCK_W : CAR_W,
      }])));
    };
    const heli = new HeliRig(scene, camera, controls, renderer.domElement, {
      cars: carsForHeli, picked: () => live.current.car, groundAt: (x, z) => gFast(x, z), destroy: ids => live.current.breakDown(ids),
      modeChanged: setMode, viewChanged: setView, note: setNote,
      hud: t => { if (hudRef.current) hudRef.current.textContent = t; },
      flight: f => cockpitApi.current?.update(f), foes: setFoes, kills: setKills,
      hit: () => flashRef.current?.animate([{ opacity: 0.5 }, { opacity: 0 }], { duration: 450, easing: "ease-out" }),
      markers: () => markersRef.current,
    });
    rig.current = heli;
    // (flying, Esc and F land back on the orbit camera, over where the helicopter looks)
    const land = () => { heli.setMode("orbit"); setMode("orbit"); };

    // (where the view looks from: over the plan view's middle, as far as shows what it showed across)
    const place = (cx: number, cy: number, across: number) => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1, fitW = across / 2 / Math.tan(((FOV * Math.PI) / 180) / 2) / (w / h);
      const d = Math.max(20, Math.min(5000, fitW));
      const g = gFast(cx, cy);
      controls.target.set(cx, g, cy);
      camera.position.set(cx, g + d * Math.sin(TILT), cy + d * Math.cos(TILT));
      controls.update();
    };
    // (the view's width as last laid out: on leaving, React has already taken the element off the page, 0 wide)
    let shownW = el.clientWidth || 1;
    const size = () => {
      const w = el.clientWidth || 1, h = el.clientHeight || 1;
      // (hidden for a moment, it keeps the size it had)
      if (el.clientWidth && el.clientHeight) { shownW = w; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    };
    size();
    { const v = live.current.planView(), w = el.clientWidth || 1; place(v.cx, v.cy, w / v.scale); }
    // (where it arrived: Escape, with nothing else to do, eases it back there; a drag or the wheel stops that)
    const homeAt = { target: controls.target.clone(), offset: new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)) };
    let homing: { t0: number; target: THREE.Vector3; offset: THREE.Spherical } | null = null;
    const home = () => { if (heli.flying) { land(); return; } homing = { t0: performance.now(), target: controls.target.clone(), offset: new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)) }; };
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
      if (heli.flying) {
        // (flying: the ground it looks at, the way it looks)
        const g = heli.groundAhead(), d = camera.getWorldDirection(new THREE.Vector3());
        return { x: r(g.x), y: r(g.z), distance: r(g.dist), heading: r((((Math.atan2(d.x, -d.z) * 180) / Math.PI) % 360 + 360) % 360), tilt: r((Math.acos(Math.max(-1, Math.min(1, -d.y))) * 180) / Math.PI) };
      }
      return { x: r(t.x), y: r(t.z), distance: r(camera.position.distanceTo(t)), heading: r((((-controls.getAzimuthalAngle() * 180) / Math.PI) % 360 + 360) % 360), tilt: r((controls.getPolarAngle() * 180) / Math.PI) };
    };
    // (the whole sketch in view)
    const fit = () => {
      if (heli.flying) land();
      const sk = live.current.sketch;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of sk.lanes) { const L = laneLength(l.shape); for (let s = 0; s <= L; s += Math.max(1, L / 8)) { const p = pointAt(l.shape, s).p; x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); } }
      if (!Number.isFinite(x0)) return;
      homing = null;
      place((x0 + x1) / 2, (y0 + y1) / 2, Math.max(60, (x1 - x0) * 1.15, ((y1 - y0) * 1.15 * (el.clientWidth || 1)) / (el.clientHeight || 1)));
    };
    const dolly = (f: number) => {
      if (heli.flying) { heli.zoom(1 / f); return; }
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
    // the streets' names (ticket #262), written on the roads: made again when the sketch (or the names layer) changes
    let namesBuilt: StreetNames3D | null = null, namesFor: unknown[] = [];
    const syncNames = () => {
      const p = live.current, key = [p.sketch, p.layers.names, pal];
      // (how tall the view is, for how big a name looks: cheap, each frame)
      namesBuilt?.setViewport(el.clientHeight || 1);
      if (key.every((x, i) => x === namesFor[i])) return;
      namesFor = key;
      if (namesBuilt) { scene.remove(namesBuilt.group); namesBuilt.dispose(); namesBuilt = null; }
      if (!p.layers.names) return;
      namesBuilt = buildStreetNames3D(streetNameRuns(p.sketch), pal.sans, renderer.capabilities.getMaxAnisotropy());
      namesBuilt.setViewport(el.clientHeight || 1);
      scene.add(namesBuilt.group);
    };
    // the zones (T129): tinted areas on the ground with their names, made again when they (or their layer) change
    let zonesBuilt: Zones3D | null = null, zonesFor: unknown[] = [];
    const syncZones = () => {
      const p = live.current, key = [p.sketch.zones, p.layers.zones];
      if (key.every((x, i) => x === zonesFor[i])) return;
      zonesFor = key;
      if (zonesBuilt) { scene.remove(zonesBuilt.group); zonesBuilt.dispose(); zonesBuilt = null; }
      if (!p.layers.zones || !p.sketch.zones?.length) return;
      zonesBuilt = buildZones3D(p.sketch.zones);
      scene.add(zonesBuilt.group);
    };
    // the shapes (ticket #268): filled outlines on the ground, under the roads, on the terrain if any; made again when they (their
    // layer, the terrain) change
    let shapesBuilt: Shapes3D | null = null, shapesFor: unknown[] = [];
    const syncShapes = () => {
      const p = live.current, t = terrainOf(p.sketch);
      heights();
      const key = [p.sketch.shapes, p.layers.shapes, t, hBase];
      if (key.every((x, i) => x === shapesFor[i])) return;
      shapesFor = key;
      if (shapesBuilt) { scene.remove(shapesBuilt.group); shapesBuilt.dispose(); shapesBuilt = null; }
      if (!p.layers.shapes || !p.sketch.shapes?.length) return;
      shapesBuilt = buildShapes3D(p.sketch.shapes, t ? (x, z) => terrainAt(t, x, z) - hBase : undefined);
      scene.add(shapesBuilt.group);
    };
    // the utility networks (ticket #280): their pipes and cables as tubes at their nodes' heights over the ground (buried ones
    // seen through it), poles under those up in the air; made again when they (their layers, the selection, the ground) change
    let utilBuilt: Utilities3D | null = null, utilFor: unknown[] = [];
    const syncUtilities = () => {
      const p = live.current;
      heights();
      const key = [p.sketch.utilityLines, p.sketch.utilityNodes, p.layers.water, p.layers.gas, p.layers.power, p.selection.utilities, p.selection.unode, hOn, hBase];
      if (key.every((x, i) => x === utilFor[i])) return;
      utilFor = key;
      if (utilBuilt) { scene.remove(utilBuilt.group); utilBuilt.dispose(); utilBuilt = null; }
      if (!p.sketch.utilityLines?.length || !(p.layers.water || p.layers.gas || p.layers.power)) return;
      utilBuilt = buildUtilities3D(p.sketch, p.layers, gUnder, p.selection.utilities ?? [], p.selection.unode ?? null);
      scene.add(utilBuilt.group);
    };
    // the buildings (ticket #267), OpenStreetMap's, fetched for where the sketch is: made again when they (their layer, the
    // terrain they stand on) change
    let bldBuilt: Buildings3D | null = null, bldFor: unknown[] = [];
    const syncBuildings = () => {
      const p = live.current, bs = buildingsOf(p.sketch), t = terrainOf(p.sketch);
      heights();
      const key = [bs, p.layers.buildings, pal, t, hBase];
      if (key.every((x, i) => x === bldFor[i])) return;
      bldFor = key;
      if (bldBuilt) { scene.remove(bldBuilt.mesh); bldBuilt.dispose(); bldBuilt = null; }
      if (!p.layers.buildings || !bs?.list.length) return;
      bldBuilt = buildBuildings3D(bs, pal, t ? (x, z) => terrainAt(t, x, z) - hBase : undefined);
      scene.add(bldBuilt.mesh);
    };
    /** the building under the pointer, if one is nearer than `before` (m along the ray) */
    const buildingHit = (before: number): SketchBuilding | null => {
      const bs = buildingsOf(live.current.sketch);
      if (!bldBuilt || !bs) return null;
      const hit = ray.intersectObject(bldBuilt.mesh, false)[0];
      return hit && hit.faceIndex != null && hit.distance < before ? bs.list[bldBuilt.owner[hit.faceIndex]] ?? null : null;
    };

    // the satellite imagery under the sketch (where it has a place on Earth), and the reference image
    const satMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false });
    const satMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), satMat);
    satMesh.rotation.x = -Math.PI / 2; satMesh.visible = false; satMesh.renderOrder = -1; scene.add(satMesh);
    let satKey = "", satGen = 0;
    const syncSat = () => {
      const p = live.current, geo = p.sketch.geo;
      satMesh.visible = !!geo && p.satellite && !!satMat.map && !terrainMesh;
      syncTerrain();
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
        satMesh.visible = live.current.satellite && !terrainMesh;
        satRect = m.rect; drapeFor = null; syncTerrain();
      });
    };
    // the terrain (ticket #130): its grid as a surface, from the lowest point (y = 0) up, a little under the roads (which follow
    // the lanes' heights, eased); the satellite imagery on it while shown, else the grass's colour, shaded by the slopes
    const terrainMat = new THREE.MeshLambertMaterial({ color: pal.ground, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
    let terrainMesh: THREE.Mesh | null = null, terrainFor: unknown = null, satRect: { minX: number; minY: number; maxX: number; maxY: number } | null = null, drapeFor: unknown[] | null = null;
    const syncTerrain = () => {
      const p = live.current, t = terrainOf(p.sketch);
      if (t !== terrainFor) {
        terrainFor = t; drapeFor = null;
        if (terrainMesh) { scene.remove(terrainMesh); terrainMesh.geometry.dispose(); terrainMesh = null; }
        if (t) {
          const H = terrainHeights(t), pos = new Float32Array(t.cols * t.rows * 3), idx: number[] = [];
          for (let j = 0; j < t.rows; j++) for (let i = 0; i < t.cols; i++) { const k = j * t.cols + i; pos[3 * k] = t.x0 + i * t.cell; pos[3 * k + 1] = H[k] - t.base - 0.3; pos[3 * k + 2] = t.y0 + j * t.cell; }
          for (let j = 0; j < t.rows - 1; j++) for (let i = 0; i < t.cols - 1; i++) { const a = j * t.cols + i, b = a + 1, c = a + t.cols, d = c + 1; idx.push(a, c, b, b, c, d); }
          const g = new THREE.BufferGeometry();
          g.setAttribute("position", new THREE.BufferAttribute(pos, 3)); g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(t.cols * t.rows * 2), 2)); g.setIndex(idx); g.computeVertexNormals();
          terrainMesh = new THREE.Mesh(g, terrainMat); terrainMesh.name = "terrain"; scene.add(terrainMesh);
        }
        satMesh.visible = !!p.sketch.geo && p.satellite && !!satMat.map && !terrainMesh;
      }
      if (!terrainMesh || !t) return;
      const on = p.satellite && !!satMat.map && !!satRect, key = [on, satMat.map, satRect, p.sat.brightness, pal.ground];
      if (drapeFor && key.every((x, i) => x === drapeFor![i])) return;
      drapeFor = key;
      if (on) {
        // (each point of the grid where it is in the imagery)
        const r = satRect!, uv = terrainMesh.geometry.getAttribute("uv") as THREE.BufferAttribute;
        for (let j = 0; j < t.rows; j++) for (let i = 0; i < t.cols; i++) uv.setXY(j * t.cols + i, (t.x0 + i * t.cell - r.minX) / (r.maxX - r.minX), 1 - (t.y0 + j * t.cell - r.minY) / (r.maxY - r.minY));
        uv.needsUpdate = true;
        satMat.map!.wrapS = satMat.map!.wrapT = THREE.ClampToEdgeWrapping;
        terrainMat.map = satMat.map; terrainMat.color.setScalar(p.sat.brightness);
      } else { terrainMat.map = null; terrainMat.color.set(pal.ground); }
      terrainMat.needsUpdate = true;
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
      // (over hills, ticket #130: a grid on the ground, each point at its height (the plane's own z, stood up, is the world's y))
      const key = [hFor, heights(), u.x, u.y, u.w, u.h, u.mpp, u.rot];
      if (ulKey && key.every((x, i) => x === ulKey![i])) return;
      ulKey = key;
      ulMesh.geometry.dispose();
      ulMesh.geometry = new THREE.PlaneGeometry(1, 1, hOn ? 64 : 1, hOn ? 64 : 1);
      if (!hOn) return;
      ulMesh.updateMatrixWorld(true);
      const pos = ulMesh.geometry.getAttribute("position") as THREE.BufferAttribute, w = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) { w.set(pos.getX(i), pos.getY(i), 0); ulMesh.localToWorld(w); pos.setZ(i, gFast(w.x, w.z)); }
      pos.needsUpdate = true;
    };
    let ulKey: unknown[] | null = null;

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
      const p = live.current, cars = p.cars() ?? [], flash = Math.floor(now / 400) % 2 === 0, blinkOn = Math.floor(now / BLINK_MS) % 2 === 0;
      let nb = 0, ng = 0, nl = 0;
      for (const c of cars) {
        if (nb + 2 > MAXV) break;
        // (destroyed in war mode: its wreck is drawn instead)
        if (c.id !== undefined && heli.isGone(c.id)) continue;
        const y = carY(c) + 0.06, yaw = -Math.atan2(c.d.y, c.d.x), truck = !!c.trailer;
        const col = p.bySpeed ? speedColor(pal, Math.round(Math.min(1, c.share) * 15) / 15) : truck ? pal.truck : pal.car;
        put(bodies, nb, c.p.x, y + 0.25, c.p.y, yaw, c.len, truck ? TRUCK_H : CAR_H, truck ? TRUCK_W : CAR_W); bodies.setColorAt(nb++, colorOf(col));
        if (c.trailer) { const t = c.trailer; put(bodies, nb, t.p.x, y + 0.5, t.p.y, -Math.atan2(t.d.y, t.d.x), t.len, TRAILER_H, TRUCK_W); bodies.setColorAt(nb++, colorOf("#e9e6dd")); }
        else { put(glass, ng++, c.p.x - c.d.x * c.len * 0.05, y + 0.25 + CAR_H * 0.55, c.p.y - c.d.y * c.len * 0.05, yaw, c.len * 0.5, CAR_H * 0.5, CAR_W * 0.92); }
        if (c.broken && flash && nl + 4 <= MAXL) {
          const n = { x: -c.d.y, y: c.d.x }, hl = c.len / 2, hw = (truck ? TRUCK_W : CAR_W) / 2 + 0.05;
          for (const [f, s2] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { P.set(c.p.x + c.d.x * hl * f + n.x * hw * s2, y + 0.9, c.p.y + c.d.y * hl * f + n.y * hw * s2); M.makeTranslation(P.x, P.y, P.z); lamps.setMatrixAt(nl++, M); }
        } else if (c.blink && p.blinkers && blinkOn && nl + 2 <= MAXL) {
          // (its turn signal: on that side, at the front and the back (a truck's trailer's), as V1's)
          const hw = (truck ? TRUCK_W : CAR_W) / 2 + 0.05, b = c.trailer ?? c;
          for (const [q, dd, k] of [[c.p, c.d, c.len / 2], [b.p, b.d, -b.len / 2]] as const) {
            P.set(q.x + dd.x * k - dd.y * hw * c.blink, y + 0.9, q.y + dd.y * k + dd.x * hw * c.blink); M.makeTranslation(P.x, P.y, P.z); lamps.setMatrixAt(nl++, M);
          }
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
          // (a lane both ways' way back by its own id, its pole at the lane's start: ticket #53)
          for (const id of plan.controlled) { const c = sk.connectors.find(x => x.id === id), w = c && wayFrom(sk, c).lane; if (w) held.set(w, [...(held.get(w) ?? []), id]); }
          for (const [lane, conns] of held) {
            const l = laneById(sk, lane);
            if (!l || n >= 2000) continue;
            const L = laneLength(l.shape), e = pointAt(l.shape, L), r = { x: e.d.y, y: -e.d.x }, o = l.width / 2 + 0.6, h = isTwinId(lane) ? shownZ(sk, baseLaneId(lane), 0) * LEVEL_H + gLane(baseLaneId(lane), 0) : shownZ(sk, lane, L) * LEVEL_H + gLane(lane, L);
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
        for (const q of loop) pos.push(q.x, h + gUnder(q) + 0.15, q.y);
        for (const t of tris) idx.push(base + t[0], base + t[2], base + t[1]);
      };
      for (const id of sel.lanes) {
        const l = laneById(sk, id);
        if (!l) continue;
        const L = laneLength(l.shape), pts: Pt[] = [], hs: number[] = [];
        for (let s2 = 0; s2 <= L + 1e-6; s2 += Math.max(0.5, Math.min(2, L / 40))) { pts.push(pointAt(l.shape, Math.min(s2, L)).p); hs.push(shownZ(sk, id, Math.min(s2, L)) * LEVEL_H + gLane(id, Math.min(s2, L))); }
        ribbon(pts, hs, l.width);
      }
      for (const id of sel.connectors) {
        const c = sk.connectors.find(x => x.id === id), pts = c && connectorPts(sk, c);
        if (!c || !pts) continue;
        const h0 = zAt(sk, c.from.lane, c.from.s) * LEVEL_H + gLane(c.from.lane, c.from.s), h1 = zAt(sk, c.to.lane, c.to.s) * LEVEL_H + gLane(c.to.lane, c.to.s);
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
      ring.position.set(c.p.x, carY(c) + 0.2, c.p.y); ring.scale.set(s2, s2, s2); ring.visible = true;
    };
    // the car picked: its way on to the end of its trip, a ribbon on the road in the selection's colour (made again at most 4 times a second)
    // (the blue the map draws it in, the selection's there: the 3D view's own green is lost on the asphalt)
    const wayBlue = () => (isDark() ? "#60a5fa" : "#2563eb");
    const wayMat = new THREE.MeshBasicMaterial({ color: wayBlue(), transparent: true, opacity: 0.9, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10, side: THREE.DoubleSide });
    const wayLine = new THREE.Mesh(new THREE.BufferGeometry(), wayMat);
    wayLine.renderOrder = 5; wayLine.frustumCulled = false; wayLine.visible = false; scene.add(wayLine);
    let wayAt = 0;
    const syncWay = (now: number) => {
      if (now - wayAt < 250) return;
      wayAt = now;
      const p = live.current, pts = p.car !== null ? p.carWay?.() ?? null : null;
      wayLine.visible = !!pts && pts.length > 1;
      if (!wayLine.visible) return;
      const c = (p.cars() ?? []).find(x => (x as Car3D & { id?: number }).id === p.car), y = (c ? carY(c) : 0) + 0.3;
      setRibbon(wayLine, pts!, y, 1.2, heights() ? q => gUnder(q) + (c ? carY(c) - gUnder(c.p) : 0) + 0.3 : undefined);
    };
    /** `mesh` made a ribbon `hw` either side of `pts` at height `y` (or each point's, `yAt`: over hills): a quad a piece */
    const setRibbon = (mesh: THREE.Mesh, pts: Pt[], y: number, hw: number, yAt?: (p: Pt) => number) => {
      const pos: number[] = [];
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], l = Math.hypot(b.x - a.x, b.y - a.y);
        if (l < 1e-3) continue;
        const nx = (-(b.y - a.y) / l) * hw, ny = ((b.x - a.x) / l) * hw, ya = yAt ? yAt(a) : y, yb = yAt ? yAt(b) : y;
        pos.push(a.x + nx, ya, a.y + ny, b.x + nx, yb, b.y + ny, b.x - nx, yb, b.y - ny, a.x + nx, ya, a.y + ny, b.x - nx, yb, b.y - ny, a.x - nx, ya, a.y - ny);
      }
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BufferGeometry();
      mesh.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    };
    // the car picked, why it does what it does (T157): the conflict zone on its path (amber) and the other's (red), a thin
    // ribbon to the car ahead and a red one to the car holding it (as the map draws them; at most 4 times a second)
    const whyMat = (color: string, opacity: number) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10, side: THREE.DoubleSide });
    const whyMeshes = [whyMat("#f59e0b", 0.75), whyMat("#ef4444", 0.75), whyMat("#0ea5e9", 0.9), whyMat("#ef4444", 0.95)].map(m => {
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), m);
      mesh.renderOrder = 6; mesh.frustumCulled = false; mesh.visible = false; scene.add(mesh);
      return mesh;
    });
    let whyAt = 0;
    const syncWhy = (now: number) => {
      if (now - whyAt < 250) return;
      whyAt = now;
      const p = live.current, w = p.car !== null ? p.carWhy?.() ?? null : null;
      const c = w ? (p.cars() ?? []).find(x => (x as Car3D & { id?: number }).id === p.car) : null, y = (c ? carY(c) : 0) + 0.35;
      // (a zone shorter than the 1 m its points are apart: a small square where it is)
      const zone = (pts: Pt[] | undefined) => (!pts?.length ? null : pts.length > 1 ? pts : [{ x: pts[0].x - 1.6, y: pts[0].y }, { x: pts[0].x + 1.6, y: pts[0].y }]);
      const lines: [Pt[] | null, number][] = [[zone(w?.zone?.mine), 1.6], [zone(w?.zone?.theirs), 1.6], [c && w?.leader ? [c.p, w.leader] : null, 0.15], [c && w?.blocker ? [c.p, w.blocker] : null, 0.3]];
      // (over hills: each point at the ground's under it, as high over it as the car's road)
      const over = c ? carY(c) - gUnder(c.p) : 0;
      lines.forEach(([pts, hw], i) => { const m = whyMeshes[i]; m.visible = !!pts && pts.length > 1; if (m.visible) setRibbon(m, pts!, y + i * 0.02, hw, heights() ? q => gUnder(q) + over + 0.35 + i * 0.02 : undefined); });
    };
    // a click (not a drag) picks what is under it: the highest level first (a bridge before the road under it)
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hitP = new THREE.Vector3();
    let downAt: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => { if (e.button === 0) downAt = { x: e.clientX, y: e.clientY }; };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0 || !downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) { downAt = null; return; }
      downAt = null;
      const levels = levelsAt(e);
      // armed, a click fires a burst there; flying, only cars are picked (more forgivingly: from high up they are
      // small), and a miss keeps the pick (and what is tracked)
      if (heli.armed) { if (levels.length) { const q = levels[levels.length - 1].p; heli.burstAt(new THREE.Vector3(q.x, gFast(q.x, q.y), q.y)); } return; }
      // (a utility node or line under the pointer, as drawn (buried ones seen through the ground): before the roads, ticket #280)
      const u = heli.flying ? null : utilityAt(e);
      if (u && live.current.pickUtility) { live.current.pickUtility(u.line, u.node); return; }
      for (const { p, lv, dist } of levels) if (live.current.pickAt(p, lv, heli.flying ? { tol: Math.max(3, dist * 0.025) } : undefined)) return;
      if (!heli.flying) live.current.pickNone();
    };
    /**
     * The utility node within 10 px of the pointer on the screen, else the line within 6 px (ticket #280): where they are
     * drawn, at their heights (a pipe is a few cm thick: a ray would hardly ever hit it), the nearest; null if none. A node
     * on several lines: the selected one's, else the first's
     */
    const utilityAt = (e: { clientX: number; clientY: number }): { line: string; node: string | null } | null => {
      const p = live.current, sk = p.sketch;
      if (!sk.utilityLines?.length || !utilBuilt) return null;
      const r = renderer.domElement.getBoundingClientRect(), cam = heli.viewCam(), v = new THREE.Vector3(), map = utilityNodeMap(sk);
      const mx = e.clientX - r.left, my = e.clientY - r.top, screen = new Map<string, { x: number; y: number } | null>();
      const at = (id: string) => {
        if (screen.has(id)) return screen.get(id)!;
        const n = map.get(id);
        v.set(n?.x ?? 0, n ? gUnder(n) + n.z : 0, n?.y ?? 0).project(cam);
        const q = n && v.z < 1 ? { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height } : null;
        screen.set(id, q);
        return q;
      };
      const lines = utilityLines(sk).filter(l => netShown(p.layers, l.net)), mine = p.selection.utilities ?? [];
      let node: string | null = null, nd = 10;
      for (const l of lines) for (const id of l.nodes) { const q = at(id); const d = q ? Math.hypot(q.x - mx, q.y - my) : Infinity; if (d <= nd) { nd = d; node = id; } }
      if (node) { const on = lines.filter(l => l.nodes.includes(node!)); return { line: (on.find(l => mine.includes(l.id)) ?? on[0]).id, node }; }
      let line: string | null = null, ld = 6;
      for (const l of lines) for (let i = 1; i < l.nodes.length; i++) {
        const a = at(l.nodes[i - 1]), b = at(l.nodes[i]);
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy, t = L ? Math.min(1, Math.max(0, ((mx - a.x) * dx + (my - a.y) * dy) / L)) : 0;
        const d = Math.hypot(a.x + dx * t - mx, a.y + dy * t - my);
        if (d <= ld) { ld = d; line = l.id; }
      }
      return line ? { line, node: null } : null;
    };
    /** where the ray under the pointer meets each level the lanes are on, the highest first */
    const levelsAt = (e: { clientX: number; clientY: number }) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, heli.viewCam());
      const sk = live.current.sketch, out: { p: Pt; lv: number; dist: number }[] = [];
      for (const lv of [...new Set([0, ...sk.lanes.map(l => l.level ?? 0)])].sort((a, b) => b - a)) {
        if (heights()) {
          // (over hills: where the ray comes down to the ground's height, that level up)
          const t = surfaceHit(ray.ray, lv * LEVEL_H + 0.06);
          if (t !== null) { ray.ray.at(t, hitP); out.push({ p: { x: hitP.x, y: hitP.z }, lv, dist: t }); }
          continue;
        }
        plane.constant = -(lv * LEVEL_H + 0.06);
        if (ray.ray.intersectPlane(plane, hitP)) out.push({ p: { x: hitP.x, y: hitP.z }, lv, dist: ray.ray.origin.distanceTo(hitP) });
      }
      return out;
    };
    /** how far along a ray it comes down to `up` metres over the ground (null: not within 12 km) */
    const surfaceHit = (r: THREE.Ray, up: number): number | null => {
      const o = r.origin, d = r.direction, below = (t: number) => o.y + d.y * t <= gFast(o.x + d.x * t, o.z + d.z * t) + up;
      if (below(0)) return 0;
      for (let t = 0, t0 = 0; t < 12000; t0 = t) {
        t = Math.min(12000, t + Math.max(1, t * 0.01));
        if (below(t)) {
          let a = t0, b = t;
          for (let i = 0; i < 24; i++) { const m = (a + b) / 2; if (below(m)) b = m; else a = m; }
          return b;
        }
      }
      return null;
    };
    // what the pointer is over (no button held): in a card by it, flying on the cockpit's screen; a few times a second,
    // and again while it rests (the cars move on)
    let hoverWas: { clientX: number; clientY: number } | null = null, hoverAt = 0;
    const hoverNow = (e: { clientX: number; clientY: number }) => {
      hoverWas = { clientX: e.clientX, clientY: e.clientY };
      const r = renderer.domElement.getBoundingClientRect();
      let info: HoverInfo | null = null;
      const levels = levelsAt(e);
      // (a utility node or line under the pointer, ticket #280; else a building in front of the ground there: what it is)
      const u = heli.flying ? null : utilityAt(e), b = u ? null : buildingHit(levels.length ? levels[levels.length - 1].dist - 0.5 : Infinity);
      if (u) info = live.current.utilityAbout?.(u.line, u.node) ?? null;
      else if (b) {
        const tall = `${b.h.toFixed(b.h < 10 ? 1 : 0)} m`;
        info = { title: b.name ?? buildingUseLabel(b), sub: b.name ? buildingUseLabel(b) : "OpenStreetMap building", rows: [
          ["Height", b.tagged ? tall : `about ${tall} (guessed from its kind and size)`],
          ["Footprint", `${Math.round(polygonArea(footprintPts(b)))} m²`],
        ] };
      } else for (const { p, lv, dist } of levels) if ((info = live.current.hoverAt(p, lv, Math.max(1.5, dist * (heli.flying ? 0.025 : 0.012))))) break;
      setHover(h => (!info ? (h ? null : h) : { info, x: e.clientX - r.left, y: e.clientY - r.top }));
    };
    const onHover = (e: PointerEvent) => {
      if (e.buttons !== 0 || e.timeStamp - hoverAt < 80) return;
      hoverAt = e.timeStamp;
      hoverNow(e);
    };
    const onHoverOut = () => { hoverWas = null; setHover(null); };
    renderer.domElement.addEventListener("pointermove", onHover);
    renderer.domElement.addEventListener("pointerleave", onHoverOut);
    renderer.domElement.addEventListener("pointerdown", onHoverOut);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    // drawn while shown and the tab is visible
    let disposed = false, frame = 0, lastSync = 0, lastNow = 0, movedAt = 0;
    const draw = () => {
      // (flying, the helicopter moves the camera: the orbit's controls let be)
      if (!heli.flying) controls.update();
      // (the haze far off, further the further out the view is: a whole city seen from above stays clear)
      const cam = heli.viewCam(), d = heli.flying ? Math.max(300, camera.position.y * 4) : camera.position.distanceTo(controls.target), fog = scene.fog as THREE.Fog;
      fog.near = Math.max(1500, d * 1.5); fog.far = Math.max(6000, d * 4); cam.far = Math.max(12000, d * 5); cam.updateProjectionMatrix();
      renderer.render(scene, cam);
      heli.drawCabin(renderer);
    };
    const tick = (now: number) => {
      frame = 0;
      if (disposed) return;
      const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
      lastNow = now; heliCars = null;
      if (now - lastSync > 500) { lastSync = now; syncSat(); syncUnderlay(); }
      // (the helicopter moves first: the car tracked is drawn where it flies to)
      heli.step(dt, now);
      if (heli.flying && now - movedAt > 250) { movedAt = now; live.current.onMove(); }
      if (hoverWas && now - hoverAt > 300) { hoverAt = now; hoverNow(hoverWas); }
      syncRoads(); syncNames(); syncZones(); syncShapes(); syncUtilities(); syncBuildings(); syncCars(now); syncLights(); syncSelection(); syncRoute(); syncRing(); syncWay(now); syncWhy(now);
      stepHome(now);
      draw();
      if (!document.hidden) frame = requestAnimationFrame(tick);
    };
    const onVisible = () => { if (!document.hidden && !frame && !disposed) frame = requestAnimationFrame(tick); };
    document.addEventListener("visibilitychange", onVisible);
    const ro = new ResizeObserver(() => size());
    ro.observe(el);
    const onTheme = () => { pal = readPalette(); builtFor = []; selMat.color.set(pal.select); (ring.material as THREE.MeshBasicMaterial).color.set(pal.select); wayMat.color.set(wayBlue()); scene.background = new THREE.Color(pal.sky); (scene.fog as THREE.Fog).color.set(pal.sky); (ground.material as THREE.MeshLambertMaterial).color.set(pal.ground); };
    const mo = new MutationObserver(onTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    // (and the system switching between day and night: the colours read again)
    const offTheme = onThemeChange(onTheme);
    frame = requestAnimationFrame(tick);
    // (the bridge's screenshot: a frame drawn just before it is read)
    live.current.canvasRef.current = () => { if (disposed) return null; draw(); return renderer.domElement; };

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisible);
      ro.disconnect(); mo.disconnect(); offTheme();
      renderer.domElement.removeEventListener("pointerdown", onDown); renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onHover); renderer.domElement.removeEventListener("pointerleave", onHoverOut); renderer.domElement.removeEventListener("pointerdown", onHoverOut);
      controls.removeEventListener("start", onStart); controls.removeEventListener("change", onChange);
      // (the plan view to where the 3D view looks: its middle, and a zoom showing as much across, by the width it had
      // (ticket #288: read off the element, gone by now, it was 0 and the plan came back zoomed all the way out); flying,
      // the ground the helicopter looks at)
      const g = heli.flying ? heli.groundAhead() : { x: controls.target.x, z: controls.target.z, dist: camera.position.distanceTo(controls.target) };
      const across = 2 * g.dist * Math.tan(((FOV * Math.PI) / 180) / 2) * camera.aspect;
      live.current.onLeave({ cx: g.x, cy: g.z, scale: Math.min(80, Math.max(0.3, shownW / Math.max(1, across))) });
      heli.dispose(); rig.current = null;
      live.current.canvasRef.current = null; live.current.apiRef.current = null;
      if (built) { scene.remove(built.group); built.dispose(); }
      if (zonesBuilt) { scene.remove(zonesBuilt.group); zonesBuilt.dispose(); }
      if (shapesBuilt) { scene.remove(shapesBuilt.group); shapesBuilt.dispose(); }
      if (utilBuilt) { scene.remove(utilBuilt.group); utilBuilt.dispose(); }
      if (bldBuilt) { scene.remove(bldBuilt.mesh); bldBuilt.dispose(); }
      if (namesBuilt) { scene.remove(namesBuilt.group); namesBuilt.dispose(); }
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

  const flying = mode !== "orbit";
  return (
    <div className="absolute inset-0 z-[5]">
      <div ref={wrap} className="size-full" aria-label="3D view" role="img" />
      {flying
        ? <Cockpit apiRef={cockpitApi} tracking={mode === "track"} raise={props.raiseCockpit}
          inspect={<InspectScreenV2 info={hover?.info ?? null} />} vehicle={<VehicleScreenV2 id={props.car} info={props.carInfo} about={props.carAbout} tracking={mode === "track"} />} />
        : (
          <div className="pointer-events-none absolute top-2 left-2 z-[6] max-w-[calc(100%-24rem)] rounded bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
            <span className="font-medium text-foreground">3D:</span> drag turns and tilts (up towards the horizon, down to straight down) · right-drag or Shift-drag pans · scroll zooms · click picks · F the whole sketch · Esc back where it arrived
          </div>
        )}
      {/* (flying, it shows on the cockpit's screen instead) */}
      {hover && !flying && <SketchHoverCard info={hover.info} x={hover.x} y={hover.y} />}
      {flying && war && (
        <>
          {/* red at the edges when hit; the enemies' markers; the gunsight in the middle of the view */}
          <div ref={flashRef} className="pointer-events-none absolute inset-0 z-[5] opacity-0 shadow-[inset_0_0_140px_40px_rgba(220,38,38,0.85)]" aria-hidden />
          <div ref={markersRef} className="pointer-events-none absolute inset-0 z-[6] overflow-hidden" aria-hidden />
          <svg viewBox="-40 -40 80 80" className="pointer-events-none absolute top-1/2 left-1/2 z-[6] size-16 -translate-x-1/2 -translate-y-1/2 text-red-500 drop-shadow-[0_0_3px_rgba(239,68,68,0.7)]" aria-hidden>
            <circle r="18" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M0 -34 V-22 M0 22 V34 M-34 0 H-22 M22 0 H34" stroke="currentColor" strokeWidth="1.8" />
            <circle r="1.8" fill="currentColor" />
          </svg>
        </>
      )}
      <HeliControls mode={mode} setMode={m => { setNote(""); setMode(m); }} canTrack={props.car !== null} view={view} setView={setView}
        warMode={warMode} war={war} setWar={on => { setArmed(on); setNote(""); }} sound={sound} setSound={setSound} hudRef={hudRef}
        foes={foes} kills={kills} onEnemy={() => rig.current?.spawnEnemy()} onClear={() => rig.current?.clearEnemies()} note={note} />
    </div>
  );
}

/**
 * The helicopter's controls over the 3D view (top right, as V1's): the camera (Orbit, Helicopter, Track the car picked),
 * the settings (the keys, war mode); flying, from the seat or outside, war, the sound, its height and speed and the keys;
 * war mode's panel; a line of news; the model's credit.
 */
function HeliControls({ mode, setMode, canTrack, view, setView, warMode, war, setWar, sound, setSound, hudRef, foes, kills, onEnemy, onClear, note }: {
  mode: CamMode; setMode: (m: CamMode) => void; canTrack: boolean; view: HeliView; setView: (v: HeliView) => void;
  warMode: boolean; war: boolean; setWar: (on: boolean) => void; sound: boolean; setSound: (on: boolean) => void;
  hudRef: React.RefObject<HTMLSpanElement | null>; foes: { count: number; kills: number; hull: number }; kills: number; onEnemy: () => void; onClear: () => void; note: string;
}) {
  const [keys] = useSubject(heliKeys$);
  const [keysOpen, setKeysOpen] = useState(false);
  const flying = mode !== "orbit";
  /** an action's keys, as the help shows them (e.g. Z/↑) */
  const keysOf = (a: HeliAction) => keys[a].length
    ? <span className="whitespace-nowrap">{keys[a].map((k, i) => <span key={k}>{i > 0 && "/"}<Kbd>{keyLabel(k)}</Kbd></span>)}</span>
    : <span className="italic">(no key)</span>;
  // (saved with the user's account; turned back if that fails)
  const toggleWarMode = async (on: boolean) => {
    ui.getValue().warMode = on;
    const res = await saveWarMode(on).catch(() => ({ ok: false as const, error: "Couldn't save war mode." }));
    if (!res.ok) { ui.getValue().warMode = !on; toast.error(res.error); }
  };
  const keep = (e: Event) => e.preventDefault();
  return (
    <div className="absolute top-2 right-2 z-10 flex max-w-80 flex-col items-end gap-1.5">
      <HeliKeysDialog open={keysOpen} onOpenChange={setKeysOpen} />
      <div className="flex gap-1.5">
        <ToggleGroup type="single" value={mode} aria-label="Camera" onValueChange={v => v && setMode(v as CamMode)} className="bg-background/95 shadow-sm backdrop-blur">
          <ToggleGroupItem value="orbit" aria-label="Orbit camera" title="Orbit camera" className="h-8 px-2 text-xs"><Orbit /> Orbit</ToggleGroupItem>
          <ToggleGroupItem value="heli" aria-label="Fly a helicopter" title="Fly a helicopter over the plan" className="h-8 px-2 text-xs"><Plane /> Helicopter</ToggleGroupItem>
          <ToggleGroupItem value="track" disabled={!canTrack && mode !== "track"} aria-label="Track the car picked" className="h-8 px-2 text-xs"
            title={canTrack ? "The helicopter follows the car picked" : "Click a car first, then track it"}><Crosshair /> Track</ToggleGroupItem>
        </ToggleGroup>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="outline" className="size-8 bg-background/95 shadow-sm" aria-label="Helicopter settings" title="Helicopter settings: its keys, war mode"><Settings /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={() => setKeysOpen(true)}><Keyboard /> Helicopter keys…</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem checked={warMode} onCheckedChange={v => void toggleWarMode(!!v)} onSelect={keep}>War mode</DropdownMenuCheckboxItem>
            <DropdownMenuLabel className="pt-0 text-[10px] font-normal text-muted-foreground">Arms the helicopter: a War button appears while flying, for its gun and guided rockets. Saved with your account (V1 plans too).</DropdownMenuLabel>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {flying && (
        <div className="flex gap-1.5">
          <ToggleGroup type="single" value={view} aria-label="Seen from" onValueChange={v => v && setView(v as HeliView)} className="bg-background/95 shadow-sm backdrop-blur">
            <ToggleGroupItem value="cockpit" aria-label="From the cockpit" title={`From the pilot's seat (${keys.view.map(keyLabel).join(" or ") || "no key"})`} className="h-8 px-2 text-xs"><Gauge /> Cockpit</ToggleGroupItem>
            <ToggleGroupItem value="outside" aria-label="From outside" title={`From behind the helicopter (${keys.view.map(keyLabel).join(" or ") || "no key"})`} className="h-8 px-2 text-xs"><Eye /> Outside</ToggleGroupItem>
          </ToggleGroup>
          {warMode && (
            <Button size="sm" variant={war ? "destructive" : "outline"} aria-pressed={war} onClick={e => { setWar(!war); e.currentTarget.blur(); }}
              title="War mode: the gun (Space, or click) and guided rockets (R)" className={cn("h-8 shadow-sm", !war && "bg-background/95")}><Swords /> War</Button>
          )}
          <Button size="icon-sm" variant="outline" aria-pressed={sound} onClick={e => { setSound(!sound); e.currentTarget.blur(); }}
            aria-label={sound ? "Turn the rotor sound off" : "Turn the rotor sound on"} title={sound ? "Sound on" : "Sound off"}
            className="size-8 bg-background/95 shadow-sm">{sound ? <Volume2 /> : <VolumeX />}</Button>
        </div>
      )}
      {flying && (
        <div className="rounded-lg border bg-background/95 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur">
          <div className="mb-1 font-medium text-foreground tabular-nums"><span ref={hudRef} /></div>
          {mode === "heli" ? (
            <>
              <div>{keysOf("forward")} {keysOf("back")} forward, back · {keysOf("left")} {keysOf("right")} left, right</div>
              <div>Mouse left / right turns · up / down looks far ahead or below</div>
              <div>{keysOf("climb")} climb · {keysOf("descend")} descend · or scroll</div>
              <div>{keysOf("faster")} faster · {keysOf("view")} cockpit / outside · click a car, then Track</div>
              <div><Kbd>Esc</Kbd> or <Kbd>F</Kbd> back to the orbit camera</div>
            </>
          ) : (
            <>
              <div>Following the car picked; click another to switch</div>
              <div>Drag to circle round it · {keysOf("left")} {keysOf("right")} too</div>
              <div>{keysOf("forward")} {keysOf("back")} closer, further · scroll zooms</div>
              <div>{keysOf("climb")} {keysOf("descend")} higher, lower · {keysOf("view")} cockpit / outside</div>
            </>
          )}
        </div>
      )}
      {flying && war && (
        <div className="rounded-lg border border-red-500/40 bg-background/95 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur">
          <div className="mb-0.5 font-medium text-red-600 dark:text-red-400">War mode · {kills} destroyed</div>
          <div><Kbd>Space</Kbd> gun at the sight · click: a burst there</div>
          <div><Kbd>R</Kbd> rocket, locked on the enemy or car nearest the sight{mode === "track" ? " (the tracked one)" : ""}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <span>Hull</span>
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted" role="meter" aria-label="Hull" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(foes.hull * 100)}>
              <div className={cn("h-full transition-[width]", foes.hull > 0.5 ? "bg-emerald-500" : foes.hull > 0.25 ? "bg-amber-500" : "bg-red-500")} style={{ width: `${foes.hull * 100}%` }} />
            </div>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            {/* (blurred after a click: Space, the gun, mustn't press it again) */}
            <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={foes.count >= ENEMY_MAX}
              onClick={e => { onEnemy(); e.currentTarget.blur(); }} title="An enemy helicopter, a kilometre off, coming for you"><Plus /> Enemy</Button>
            {foes.count > 0 && <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={e => { onClear(); e.currentTarget.blur(); }}>Clear</Button>}
            <span className="ml-auto tabular-nums">{foes.count} up · {foes.kills} down</span>
          </div>
        </div>
      )}
      {note && <div className="rounded-md bg-background/95 px-2 py-1 text-[11px] shadow-sm">{note}</div>}
      {flying && (
        // the model's licence asks for its author to be named
        <a href={HELI_MODEL_CREDIT.url} target="_blank" rel="noreferrer" className="rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
          {HELI_MODEL_CREDIT.title} model by {HELI_MODEL_CREDIT.author} · {HELI_MODEL_CREDIT.license}
        </a>
      )}
    </div>
  );
}
