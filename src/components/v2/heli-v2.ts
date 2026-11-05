/**
 * The helicopter in the V2 plan's 3D view (ticket #129), as V1's (view-3d.tsx): fly freely ("heli") or follow the car
 * picked ("track"), seen from the pilot's seat (the cabin drawn in a second pass, the instruments by heli-cockpit.tsx)
 * or from behind; the rotor's sound; and war mode (the gun, guided rockets, enemy helicopters: render/combat.ts and
 * render/enemies.ts). The view (view-3d-v2.tsx) makes one, steps it every frame and draws with `viewCam()`; it knows
 * the cars only through `HeliHooks.cars` (as drawn now) and gives back the ones destroyed.
 *
 * Keys: the user's own (src/lib/heli-keys.ts), taken before the editor's while flying. Mouse: drag looks around (round
 * the car, tracking); with no button held, the pointer towards a side turns, its height sets where the pilot looks;
 * the wheel climbs and comes down (closer and further, tracking).
 */
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { HELI_LAYER, loadHelicopter, type Helicopter } from "@/render/helicopter";
import { RotorSound } from "@/render/rotor-sound";
import { Combat, type World } from "@/render/combat";
import { Enemies, ENEMY_MAX } from "@/render/enemies";
import { actionOf, type HeliAction } from "@/lib/heli-keys";
import { heliKeys$ } from "@/state/heli-keys";
import type { Flight } from "@/components/workspace/heli-cockpit";

/** orbit: the turntable camera; heli: fly freely; track: the helicopter follows the car picked */
export type CamMode = "orbit" | "heli" | "track";
export type HeliView = "cockpit" | "outside";

const HELI_MIN = 4, HELI_MAX = 1500;
/** the helicopter's top speed over the ground: 200 km/h */
const HELI_VMAX = 200 / 3.6;
/** how quickly the helicopter gathers and loses speed (1/s: some 3 s to 63 % of a change), flying or tracking */
const HELI_RESPONSE = 0.35;
/** tracking: closing speed towards its place behind the car, per metre away (1/s) */
const TRACK_CLOSE = 0.25;
/** free flight takes off at this height; tracking never goes lower */
const HELI_START = 100, TRACK_MIN = 100;
/** pointer steering: the still middle (share of the half width), and the fastest turn (rad/s) */
const STEER_DEAD = 0.3, STEER_RATE = 0.9;
/** where the pilot looks (radians, up +) with the pointer at the top, middle and bottom of the view */
const LOOK_UP = 0.15, LOOK_MID = -0.3, LOOK_DOWN = -1.35;
/** the orbit camera's field of view, and the wider one from the cabin (as a pilot's eyes take in) */
const FOV = 40, CABIN_FOV = 62;

/** a car as the view draws it: its middle (plan x, y), the height of its road (m, world y), heading (plan atan2), length and width */
export interface HeliCar { id: number; x: number; y: number; h: number; heading: number; len: number; width: number }
export interface HeliHooks {
  /** the cars as drawn now (live or replayed) */
  cars(): HeliCar[];
  /** the car picked: the one tracked */
  picked(): number | null;
  /** cars destroyed in war mode: broken down where they are (wrecks in the traffic, until towed) */
  destroy(ids: number[]): void;
  /** the mode changed by the helicopter itself (the car tracked gone: flying freely), or the view by its key */
  modeChanged(m: CamMode): void;
  viewChanged(v: HeliView): void;
  /** a line to show by the controls ("" none) */
  note(text: string): void;
  /** the height and speed, as text (several times a second) */
  hud(text: string): void;
  /** the cockpit's instruments, every frame while flying */
  flight(f: Flight): void;
  /** war: the enemies (in the air, shot down, the player's hull 0…1), and the cars destroyed so far */
  foes(f: { count: number; kills: number; hull: number }): void;
  kills(n: number): void;
  /** war: the player's helicopter hit (the view flashes red) */
  hit(): void;
  /** war: where the enemies' markers go (a box over the view) */
  markers(): HTMLDivElement | null;
}

export class HeliRig {
  mode: CamMode = "orbit";
  view: HeliView = "cockpit";
  /** war mode on (and allowed): the gun and rockets armed, enemies can come */
  war = false;
  sound = true;
  private yaw = 0; private pitch = -0.35;
  private vel = new THREE.Vector3();
  private held = new Set<string>();
  private dir = new THREE.Vector3();
  private chase = { angle: 0, dist: 90, height: TRACK_MIN, heading: NaN, id: -1 };
  /** the car tracked: where it was drawn last, and its speed over the ground (m/s, plan x and y; from how it moved) */
  private carWas = { id: -1, x: 0, y: 0, vx: 0, vy: 0, ok: false };
  /** the airframe: heading (as a camera yaw), nose up, roll (right side up) */
  private air = { yaw: 0, pitch: 0, roll: 0 };
  private eyeOff = new THREE.Vector3();
  private flightNow: Flight = { alt: 0, speed: 0, vs: 0, heading: 0, pitch: 0, roll: 0, range: NaN };
  private lastPos = new THREE.Vector3();
  private bank = 0; private lastSwing = NaN; private jolt = 0;
  private lookAt = new THREE.Vector3();
  private hudText = "";
  private steer = { on: false, nx: 0, ny: 0 };
  private look: { x: number; y: number; id: number } | null = null;
  // the helicopter itself, loaded the first time it is flown: from the seat its cabin (drawn in a second pass, with a
  // near plane close enough), from outside the whole of it, drawn with the rest and seen by a camera following behind
  private heli: { cabin: Helicopter | null; whole: Helicopter | null } = { cabin: null, whole: null };
  private loading = new Set<string>();
  private cabinCam = new THREE.PerspectiveCamera(CABIN_FOV, 1, 0.03, 80);
  readonly outCam = new THREE.PerspectiveCamera(50, 1, 0.5, 12000);
  private outAt = new THREE.Vector3();
  private outFresh = true;
  private rotor = new RotorSound();
  private soundOn = false;
  // war: Space (held) fires the gun at the sight in the middle of the view, a click a burst at that point; R launches a
  // rocket guided onto the enemy near the sight, else the car nearest it (the tracked one, tracking)
  private combat: Combat;
  private enemies: Enemies;
  private gun = { held: false, burst: 0, at: new THREE.Vector3(), next: 0 };
  private rocketAsked = false;
  private lastForget = 0;
  private aimRay = new THREE.Raycaster();
  private aimAt = new THREE.Vector3();
  private ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private world: World;
  private disposed = false;
  private off: (() => void)[] = [];

  constructor(private scene: THREE.Scene, private camera: THREE.PerspectiveCamera, private controls: OrbitControls, private dom: HTMLCanvasElement, private hooks: HeliHooks) {
    this.cabinCam.layers.set(HELI_LAYER);
    this.combat = new Combat(scene);
    this.enemies = new Enemies(scene, this.combat);
    const carOf = (id: number) => hooks.cars().find(c => c.id === id) ?? null;
    this.world = {
      at: id => { const c = carOf(id); return c ? new THREE.Vector3(c.x, c.h, c.y) : null; },
      near: (p, r) => hooks.cars().map(c => [c.id, Math.hypot(c.x - p.x, c.y - p.z), c] as const)
        .filter(([, d, c]) => d < r + c.len / 2 && Math.abs(c.h - p.y) < 6).sort((a, b) => a[1] - b[1]).map(x => x[0]),
      shape: id => { const c = carOf(id); return c ? { heading: c.heading, len: c.len, width: c.width } : null; },
    };
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K, f: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions | boolean) => {
      el.addEventListener(type, f as EventListener, opts); this.off.push(() => el.removeEventListener(type, f as EventListener, opts));
    };
    on(window, "keydown", e => this.onKey(e), true);
    on(window, "keyup", e => this.onKey(e), true);
    on(window, "blur", () => { this.held.clear(); this.gun.held = false; });
    on(dom, "pointerdown", e => this.onLookDown(e));
    on(dom, "pointermove", e => this.onLookMove(e));
    on(dom, "pointerleave", () => { this.steer.on = false; });
    on(dom, "pointerup", e => this.onLookUp(e));
    on(dom, "pointercancel", e => this.onLookUp(e));
    on(dom, "wheel", e => this.onWheel(e), { passive: false });
  }

  get flying() { return this.mode !== "orbit"; }
  /** the gun and rockets ready: flying, war mode on */
  get armed() { return this.flying && this.war; }
  private get withCabin() { return this.flying && this.view === "cockpit"; }
  private get outside() { return this.flying && this.view === "outside"; }
  /** the camera the scene is drawn with: the pilot's eye, or (outside) the one following the helicopter */
  viewCam(): THREE.PerspectiveCamera { return this.outside ? this.outCam : this.camera; }

  setMode(m: CamMode) {
    if (m === this.mode) return;
    const was = this.mode, camera = this.camera, dir = this.dir;
    // (flying on from one mode to the other keeps the helicopter's speed: no sudden stop)
    if (m === "orbit" || was === "orbit") this.vel.set(0, 0, 0);
    this.mode = m; this.held.clear(); this.hudText = "";
    if (m === "orbit") {
      // orbit round the ground point the helicopter was looking at (or straight below)
      camera.getWorldDirection(dir);
      if (dir.y < -0.05) {
        const t = Math.min(camera.position.y / -dir.y, 2000);
        this.controls.target.set(camera.position.x + dir.x * t, 0, camera.position.z + dir.z * t);
      } else {
        const flat = Math.hypot(dir.x, dir.z) || 1, t = Math.max(30, camera.position.y);
        this.controls.target.set(camera.position.x + (dir.x / flat) * t, 0, camera.position.z + (dir.z / flat) * t);
      }
      this.controls.enabled = true; this.controls.update();
      this.hooks.note("");
    } else {
      this.controls.enabled = false;
      if (was === "orbit") {
        // take off 300 m short of what the orbit camera looked at, 100 m up, facing it (far enough to look at it over
        // the instrument panel)
        camera.getWorldDirection(dir);
        const l = Math.hypot(dir.x, dir.z), hx = l > 1e-3 ? dir.x / l : 0, hz = l > 1e-3 ? dir.z / l : -1, t = this.controls.target;
        camera.position.set(t.x - hx * 300, HELI_START, t.z - hz * 300);
        this.yaw = Math.atan2(-hx, -hz); this.pitch = -Math.atan2(HELI_START, 300);
        camera.rotation.order = "YXZ"; camera.rotation.set(this.pitch, this.yaw, 0);
      }
      if (m === "track") { this.chase.heading = NaN; this.chase.id = -1; }
      this.air.yaw = this.yaw; this.air.pitch = 0; this.air.roll = 0;
      this.carWas.ok = false;
    }
    this.dom.style.cursor = m === "orbit" ? "" : "grab";
    this.syncFov();
  }
  setView(v: HeliView) { this.view = v; this.syncFov(); }
  private syncFov() {
    const fov = this.withCabin ? CABIN_FOV : FOV;
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
  }

  /** zoom keys and buttons while flying: lower or higher (closer or further, tracking) */
  zoom(k: number) {
    if (this.mode === "heli") this.camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, this.camera.position.y * k));
    else if (this.mode === "track") this.chase.dist = Math.max(8, Math.min(600, this.chase.dist * k));
  }
  /** facing north (flying), or the view swung round behind the car to face it (tracking) */
  north() { if (this.mode === "heli") this.yaw = 0; else if (this.mode === "track") this.chase.angle = -Math.PI / 2 - this.chase.heading; }
  /** the ground point the view looks at (straight below, looking above the horizon) and how far it is */
  groundAhead(): { x: number; z: number; dist: number } {
    const camera = this.camera, dir = this.dir;
    camera.getWorldDirection(dir);
    if (dir.y < -0.02) { const t = Math.min(5000, camera.position.y / -dir.y); return { x: camera.position.x + dir.x * t, z: camera.position.z + dir.z * t, dist: t }; }
    return { x: camera.position.x, z: camera.position.z, dist: Math.max(100, camera.position.y) };
  }
  /** war: a burst of the gun at a point (a click) */
  burstAt(p: THREE.Vector3) { this.gun.at.copy(p); this.gun.burst = 5; this.gun.next = 0; }
  spawnEnemy() {
    this.enemies.player.pos.copy(this.camera.position);
    if (!this.enemies.spawn()) this.hooks.note(`At most ${ENEMY_MAX} enemies at once.`);
    this.foesNow();
  }
  clearEnemies() { this.enemies.clear(); this.foesNow(); }
  /** a car destroyed: not drawn (its wreck is) */
  isGone(id: number) { return this.combat.isGone(id); }
  private foesNow() { this.hooks.foes({ count: this.enemies.count, kills: this.enemies.kills, hull: this.enemies.player.hp / this.enemies.playerMax }); }

  // (in a field, a menu or a dialog the keys are theirs)
  private typing = (e: Event) => !!(e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable],[role=combobox],[role=slider],[role=menu],[role=listbox],[role=dialog]");
  private onKey(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (e.type === "keyup") { this.held.delete(k); if (k === " ") this.gun.held = false; return; }
    if (!this.flying || e.metaKey || e.ctrlKey || e.altKey || this.typing(e)) return;
    const act = actionOf(heliKeys$.getValue(), k);
    // from the seat or from outside
    if (act === "view") { e.preventDefault(); e.stopPropagation(); if (!e.repeat) { this.setView(this.view === "cockpit" ? "outside" : "cockpit"); this.hooks.viewChanged(this.view); } return; }
    if (this.war && (k === " " || k === "r")) {
      e.preventDefault(); e.stopPropagation();
      if (k === " ") this.gun.held = true; else if (!e.repeat) this.rocketAsked = true;
      return;
    }
    if (!act) return;
    // (taken before the editor's: its Q / E / D / arrows are the helicopter's while flying)
    e.preventDefault(); e.stopPropagation();
    this.held.add(k);
  }
  private onLookDown(e: PointerEvent) {
    if (!this.flying) return;
    this.look = { x: e.clientX, y: e.clientY, id: e.pointerId };
    this.dom.setPointerCapture(e.pointerId);
    this.dom.style.cursor = "grabbing";
  }
  private onLookMove(e: PointerEvent) {
    if (!this.look && this.mode === "heli" && e.buttons === 0) {
      const r = this.dom.getBoundingClientRect(), s = this.steer;
      s.on = true; s.nx = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1; s.ny = ((e.clientY - r.top) / Math.max(1, r.height)) * 2 - 1;
      this.dom.style.cursor = Math.abs(s.nx) > STEER_DEAD ? (s.nx < 0 ? "w-resize" : "e-resize") : "grab";
    }
    const look = this.look;
    if (!look || e.pointerId !== look.id || !this.flying) return;
    const dx = e.clientX - look.x, dy = e.clientY - look.y;
    look.x = e.clientX; look.y = e.clientY;
    if (this.mode === "heli") { this.yaw -= dx * 0.004; this.pitch = Math.max(-1.5, Math.min(0.5, this.pitch - dy * 0.004)); }
    else { this.chase.angle -= dx * 0.006; this.chase.height = Math.max(TRACK_MIN, Math.min(400, this.chase.height + dy * 0.25)); }
  }
  private onLookUp(e: PointerEvent) {
    if (!this.look || e.pointerId !== this.look.id) return;
    this.look = null;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    this.dom.style.cursor = this.flying ? "grab" : "";
  }
  private onWheel(e: WheelEvent) {
    if (!this.flying) return;
    e.preventDefault();
    // like zooming: scroll up comes down closer, scroll down climbs
    const k = Math.exp(Math.max(-1, Math.min(1, e.deltaY * 0.0015)));
    if (this.mode === "heli") this.camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, this.camera.position.y * k));
    else { this.chase.dist = Math.max(8, Math.min(600, this.chase.dist * k)); this.chase.height = Math.max(TRACK_MIN, Math.min(400, this.chase.height * k)); }
  }

  private ensureHeli(kind: "cabin" | "whole") {
    if (this.heli[kind] || this.loading.has(kind)) return;
    this.loading.add(kind);
    loadHelicopter(kind, kind === "cabin" ? HELI_LAYER : 0).then(h => {
      if (this.disposed) { h.dispose(); return; }
      this.heli[kind] = h; h.body.visible = false; this.scene.add(h.body);
    }).catch(() => this.hooks.note("The helicopter couldn't be loaded: flying without it."));
  }
  /** an airframe round the pilot's eye, its rotor turning */
  private placeAirframe(h: Helicopter, dt: number) {
    h.body.rotation.order = "YXZ"; h.body.rotation.set(this.air.pitch, this.air.yaw, this.air.roll);
    h.body.position.copy(this.camera.position).sub(this.eyeOff.copy(h.eye).applyEuler(h.body.rotation));
    h.spin(dt);
  }

  /** a frame: the flight, the airframe, the camera outside, the sound, the war */
  step(dt: number, now: number) {
    const camera = this.camera, dir = this.dir;
    if (this.withCabin) this.ensureHeli("cabin");
    if (this.outside) this.ensureHeli("whole");
    if (this.flying) this.fly(dt, now);
    const { cabin, whole } = this.heli;
    if (cabin) { cabin.body.visible = this.withCabin; if (this.withCabin) this.placeAirframe(cabin, dt); }
    if (whole) { whole.body.visible = this.outside; if (this.outside) this.placeAirframe(whole, dt); }
    if (this.outside) {
      // from behind and above the helicopter, looking where the pilot looks. Tracking, from a little to the left, at a
      // point between the helicopter and the car: both in view, the helicopter not hiding it.
      camera.getWorldDirection(dir);
      const track = this.mode === "track", want = this.eyeOff.copy(camera.position).addScaledVector(dir, track ? -18 : -14);
      want.y += track ? 6 : 3.5;
      if (track) { const l = Math.hypot(dir.x, dir.z) || 1; want.x += (dir.z / l) * 9; want.z -= (dir.x / l) * 9; }
      if (this.outFresh) this.outCam.position.copy(want); else this.outCam.position.lerp(want, 1 - Math.exp(-dt * 4));
      this.outFresh = false;
      if (track) this.outAt.copy(camera.position).lerp(this.lookAt, 0.55); else this.outAt.copy(camera.position).addScaledVector(dir, 30);
      this.outCam.lookAt(this.outAt);
      if (this.outCam.aspect !== camera.aspect) { this.outCam.aspect = camera.aspect; this.outCam.updateProjectionMatrix(); }
    } else this.outFresh = true;
    // the rotor's sound while flying (its beat follows the work: speed and climbing)
    const wantSound = this.flying && this.sound && !document.hidden;
    if (wantSound !== this.soundOn) { this.soundOn = wantSound; if (wantSound) this.rotor.start(); else this.rotor.stop(); }
    this.fight(dt, now);
    if (this.soundOn) this.rotor.set(0.75 * Math.min(1, this.flightNow.speed / HELI_VMAX) + 0.25 * Math.max(0, Math.min(1, this.flightNow.vs / 8)), this.outside);
    this.placeMarkers();
  }

  private fly(dt: number, now: number) {
    const camera = this.camera, dir = this.dir, keys = heliKeys$.getValue(), on = (a: HeliAction) => (keys[a].some(k => this.held.has(k)) ? 1 : 0);
    const fast = on("faster") ? 3 : 1;
    const fwd = on("forward") - on("back"), side = on("right") - on("left"), climb = on("climb") - on("descend");
    let speed = 0;
    const flight = this.flightNow, air = this.air, vel = this.vel;
    if (this.mode === "heli") {
      // the pointer out towards a side turns that way, faster further out (none while dragging to look)
      const s = this.steer, out = s.on && !this.look ? (Math.abs(s.nx) - STEER_DEAD) / (1 - STEER_DEAD) : 0;
      if (out > 0) this.yaw -= Math.sign(s.nx) * Math.min(1, out) * STEER_RATE * dt;
      if (s.on && !this.look) {
        // top: just above the horizon; middle: a little down ahead; bottom: nearly straight down
        const t = Math.max(-1, Math.min(1, s.ny)), want = LOOK_MID + Math.abs(t) * ((t < 0 ? LOOK_UP : LOOK_DOWN) - LOOK_MID);
        this.pitch += (want - this.pitch) * (1 - Math.exp(-dt * 3));
      }
      // faster high up, slower near the ground; the helicopter eases in and out of motion
      const cruise = Math.min(HELI_VMAX, Math.max(12, camera.position.y * 0.9) * fast);
      // (diagonally no faster than straight ahead)
      const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), k = cruise / Math.max(1, Math.hypot(fwd, side));
      const want = new THREE.Vector3((-sy * fwd + cy * side) * k, climb * Math.max(6, cruise * 0.5), (-cy * fwd - sy * side) * k);
      // (a helicopter gathers and loses speed slowly: some 3 s to 63 % of the change)
      vel.lerp(want, 1 - Math.exp(-dt * HELI_RESPONSE));
      camera.position.addScaledVector(vel, dt);
      camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, camera.position.y));
      // the airframe faces where the pilot looks, dips its nose to speed up and leans into sideways flight
      const ease = 1 - Math.exp(-dt * 2), vf = -vel.x * sy - vel.z * cy, vside = vel.x * cy - vel.z * sy;
      air.yaw = this.yaw;
      air.pitch += (-0.13 * Math.max(-1, Math.min(1, vf / HELI_VMAX)) - air.pitch) * ease;
      air.roll += (-0.2 * Math.max(-1, Math.min(1, vside / HELI_VMAX)) - air.roll) * ease;
      camera.rotation.order = "YXZ"; camera.rotation.set(this.pitch + air.pitch, this.yaw, air.roll);
      speed = Math.hypot(vel.x, vel.z);
      flight.roll = -air.roll; flight.range = NaN;
    } else if (this.mode === "track") {
      const id = this.hooks.picked(), c = id !== null ? this.hooks.cars().find(x => x.id === id) : undefined;
      if (!c) {
        // the car finished its trip (or the pick moved off it): hover where it is
        this.hooks.note(id !== null ? (this.combat.isGone(id) ? "Target destroyed: flying freely." : "The car left the sketch: flying freely.") : "Nothing to track: flying freely.");
        this.setMode("heli"); this.hooks.modeChanged("heli");
        this.fromCamera();
        return;
      }
      const ch = this.chase, cw = this.carWas;
      if (ch.id !== c.id) { ch.id = c.id; ch.heading = NaN; cw.ok = false; this.hooks.note(""); }
      ch.angle += side * dt * 1.2 * fast;
      ch.dist = Math.max(8, Math.min(600, ch.dist * Math.exp(-fwd * dt * fast)));
      ch.height = Math.max(TRACK_MIN, Math.min(400, ch.height + climb * dt * Math.max(6, ch.height * 0.8) * fast));
      // the car's speed over the ground, from how it moves as drawn (0 while paused); a jump (the replay moved) starts again
      if (!cw.ok || cw.id !== c.id || Math.hypot(c.x - cw.x, c.y - cw.y) > 30) { cw.ok = true; cw.id = c.id; cw.vx = 0; cw.vy = 0; }
      else if (dt > 0) { const k = 1 - Math.exp(-dt * 3); cw.vx += ((c.x - cw.x) / dt - cw.vx) * k; cw.vy += ((c.y - cw.y) / dt - cw.vy) * k; }
      cw.x = c.x; cw.y = c.y;
      // the car's heading smoothed: the helicopter swings round turns instead of snapping
      if (Number.isNaN(ch.heading)) ch.heading = c.heading;
      else { let d = c.heading - ch.heading; d = Math.atan2(Math.sin(d), Math.cos(d)); ch.heading += d * (1 - Math.exp(-dt * 1.5)); }
      const a = ch.heading + Math.PI + ch.angle;
      const want = new THREE.Vector3(c.x + Math.cos(a) * ch.dist, c.h + ch.height, c.y + Math.sin(a) * ch.dist);
      // it flies to its place behind the car as in free flight: the car's own speed plus a gentle closing speed, no more
      // than its top speed, gathered and lost just as slowly (another car picked: a flight across, not a jump)
      const aim = want.sub(camera.position).multiplyScalar(TRACK_CLOSE).add(new THREE.Vector3(cw.vx, 0, cw.vy));
      const flat = Math.hypot(aim.x, aim.z);
      if (flat > HELI_VMAX) { aim.x *= HELI_VMAX / flat; aim.z *= HELI_VMAX / flat; }
      vel.lerp(aim, 1 - Math.exp(-dt * HELI_RESPONSE));
      camera.position.addScaledVector(vel, dt);
      camera.position.y = Math.max(HELI_MIN, camera.position.y);
      speed = Math.hypot(vel.x, vel.z);
      this.lookAt.set(c.x, c.h + 1.5, c.y);
      camera.lookAt(this.lookAt);
      // lean into the swing round the car, as a helicopter banks into a turn
      const swing = ch.heading + ch.angle;
      if (!Number.isNaN(this.lastSwing) && dt > 0) {
        let w = swing - this.lastSwing; w = Math.atan2(Math.sin(w), Math.cos(w));
        this.bank += (Math.max(-0.3, Math.min(0.3, (w / dt) * 0.35)) - this.bank) * (1 - Math.exp(-dt * 2));
      }
      this.lastSwing = swing;
      camera.rotateZ(-this.bank);
      // the nose towards the car: seen ahead, through the windscreen
      const lookYaw = Math.atan2(-(this.lookAt.x - camera.position.x), -(this.lookAt.z - camera.position.z));
      const d = Math.atan2(Math.sin(lookYaw - air.yaw), Math.cos(lookYaw - air.yaw));
      air.yaw += d * (1 - Math.exp(-dt * 1.5));
      air.pitch += (-0.04 - air.pitch) * (1 - Math.exp(-dt * 2)); air.roll = -this.bank;
      // (the sights are on the car only from the seat)
      flight.roll = this.bank; flight.range = this.outside ? NaN : camera.position.distanceTo(this.lookAt);
    }
    if (this.mode !== "track") { this.lastSwing = NaN; this.bank = 0; }
    if (this.withCabin) {
      // the airframe's vibration, and a jolt when rounds strike it
      const t = now / 1000;
      camera.rotateX(0.00025 * Math.sin(t * 23) + 0.00012 * Math.sin(t * 61) + (Math.random() - 0.5) * 0.014 * this.jolt);
      camera.rotateZ(0.0002 * Math.sin(t * 17 + 1) + (Math.random() - 0.5) * 0.014 * this.jolt);
    }
    this.jolt = Math.max(0, this.jolt - dt * 4);
    const text = `${Math.round(camera.position.y)} m up · ${Math.round(speed * 3.6)} km/h`;
    if (text !== this.hudText) { this.hudText = text; this.hooks.hud(text); }
    if (dt > 0) {
      const vs = (camera.position.y - this.lastPos.y) / dt, ease = 1 - Math.exp(-dt * 4);
      camera.getWorldDirection(dir);
      flight.alt = camera.position.y; flight.vs += (vs - flight.vs) * ease; flight.speed += (speed - flight.speed) * ease;
      flight.heading = (Math.atan2(dir.x, -dir.z) * 180) / Math.PI; flight.pitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
      this.hooks.flight(flight);
    }
    this.lastPos.copy(camera.position);
  }
  /** free flight from where the camera is, looking where it looks */
  private fromCamera() {
    this.camera.getWorldDirection(this.dir);
    this.yaw = Math.atan2(-this.dir.x, -this.dir.z); this.pitch = Math.max(-1.5, Math.min(0.5, Math.asin(this.dir.y)));
    this.camera.position.y = Math.max(HELI_MIN, Math.min(HELI_MAX, this.camera.position.y));
  }

  /** the ground point under the sight (or far ahead, looking above the horizon) */
  private sightPoint(cam: THREE.Camera, out: THREE.Vector3) {
    this.aimRay.setFromCamera(new THREE.Vector2(0, 0), cam);
    if (!this.aimRay.ray.intersectPlane(this.ground, out) || out.distanceTo(cam.position) > 3000) out.copy(this.aimRay.ray.origin).addScaledVector(this.aimRay.ray.direction, 1500);
    return out;
  }
  /** a point on the airframe (body frame: x right, y up, −z ahead) in the world */
  private hardpoint(x: number, y: number, z: number) { return new THREE.Vector3(x, y, z).applyEuler(new THREE.Euler(this.air.pitch, this.air.yaw, this.air.roll, "YXZ")).add(this.camera.position); }
  /** war: fire, the rounds and rockets on their way, the enemies, the cars destroyed taken off */
  private fight(dt: number, now: number) {
    const gun = this.gun, enemies = this.enemies, combat = this.combat, camera = this.camera;
    if (!this.armed) { gun.held = false; gun.burst = 0; this.rocketAsked = false; }
    else {
      const cam = this.viewCam();
      if ((gun.held || gun.burst > 0) && now >= gun.next) {
        gun.next = now + 85;
        const to = gun.burst > 0 ? gun.at : this.sightPoint(cam, this.aimAt);
        if (gun.burst > 0) gun.burst--;
        // the gun hangs under the cabin, on the pilot's side
        combat.fire(this.hardpoint(0.9, -1.5, 0.2), to);
      }
      if (this.rocketAsked) {
        this.rocketAsked = false;
        const to = this.sightPoint(cam, this.aimAt).clone(), from = this.hardpoint(-1.1, -1.4, 0.3);
        // an enemy helicopter near the sight first
        const foe = enemies.lockOn(cam.position, cam.getWorldDirection(new THREE.Vector3())), foeAt = foe ? enemies.air.at(foe) : null;
        if (foe && foeAt) { combat.launch(from, foeAt.clone().sub(from), null, foeAt, foe); this.hooks.note("Rocket away, locked on an enemy helicopter"); }
        else {
          // guided onto the tracked car, or the one nearest the sight
          const picked = this.hooks.picked(), target = this.mode === "track" && picked !== null ? picked : this.world.near(to, 30)[0] ?? null;
          combat.launch(from, to.clone().sub(from), target, to);
          this.hooks.note(target !== null ? `Rocket away, locked on car ${target}` : "Rocket away (nothing to lock on)");
        }
      }
    }
    // the enemies: after the player's helicopter (where it is now); war mode off sends them away
    if (!this.war && enemies.size) { enemies.clear(); this.foesNow(); }
    enemies.player.pos.copy(camera.position); enemies.player.vel.copy(this.vel);
    const fe = enemies.update(dt, this.armed);
    if (fe.playerHits) {
      this.hooks.hit();
      if (this.soundOn) for (let k = 0; k < Math.min(3, fe.playerHits); k++) this.rotor.hit();
      this.jolt = Math.min(1, this.jolt + 0.45 * fe.playerHits);
    }
    if (fe.playerDown) {
      combat.explode(camera.position, 4);
      this.hooks.note(`Shot down! ${enemies.kills} enemy helicopter${enemies.kills === 1 ? "" : "s"} destroyed; the others have gone. Back in the air, repaired.`);
      enemies.clear();
    }
    if (fe.playerHits || fe.downed || fe.playerDown) this.foesNow();
    const listener = this.viewCam().position, ev = combat.update(dt, this.world, listener);
    // (they stay on the road as wrecks, obstacles in the traffic, until towed)
    if (ev.destroyed.length) { this.hooks.destroy(ev.destroyed); this.hooks.kills(combat.destroyedCount); }
    if (this.soundOn) {
      for (let k = 0; k < Math.min(2, ev.shots); k++) this.rotor.shot();
      for (const at of ev.enemyShots.slice(0, 2)) this.rotor.shot(Math.max(0.02, Math.min(0.7, 50 / Math.max(1, at.distanceTo(listener)))));
      for (const d of ev.blasts) this.rotor.blast(d);
    }
    if (now - this.lastForget > 1000) { this.lastForget = now; const ids = new Set(this.hooks.cars().map(c => c.id)); combat.forget(id => ids.has(id)); }
  }
  // the enemies on screen: a box round each with its distance; off screen (or behind), a mark at the edge towards it
  private mk = new THREE.Vector3();
  private placeMarkers() {
    const box = this.hooks.markers();
    if (!box) return;
    const cam = this.viewCam(), list = this.armed ? this.enemies.positions() : [], w = box.clientWidth, h = box.clientHeight;
    while (box.children.length < list.length) {
      const d = document.createElement("div");
      d.className = "absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center text-[10px] font-semibold text-red-500 tabular-nums drop-shadow-[0_0_2px_rgba(0,0,0,0.8)]";
      d.innerHTML = '<div class="size-5 rounded-sm border-[1.5px] border-current"></div><span></span>';
      box.appendChild(d);
    }
    for (let i = 0; i < box.children.length; i++) {
      const el = box.children[i] as HTMLDivElement, f = list[i];
      if (!f) { el.style.display = "none"; continue; }
      el.style.display = "";
      this.mk.copy(f.pos).project(cam);
      let x = this.mk.x, y = this.mk.y;
      const behind = this.mk.z > 1;
      if (behind) { x = -x; y = -y; }
      const edge = behind || Math.abs(x) > 0.94 || Math.abs(y) > 0.9;
      if (edge) { const k = Math.max(Math.abs(x) / 0.94, Math.abs(y) / 0.9, 1e-6); x /= k; y /= k; }
      el.style.left = `${((x + 1) / 2) * w}px`; el.style.top = `${((1 - y) / 2) * h}px`;
      (el.firstChild as HTMLElement).style.transform = edge ? "rotate(45deg) scale(0.6)" : "";
      (el.lastChild as HTMLElement).textContent = `${Math.round(f.pos.distanceTo(this.camera.position))} m`;
    }
  }

  /** from the seat: the cabin over the view, with its own depth (and no sky: the view is already there) */
  drawCabin(renderer: THREE.WebGLRenderer) {
    if (!this.heli.cabin?.body.visible) return;
    const camera = this.camera, cc = this.cabinCam, scene = this.scene;
    cc.position.copy(camera.position); cc.quaternion.copy(camera.quaternion);
    if (cc.fov !== camera.fov || cc.aspect !== camera.aspect) { cc.fov = camera.fov; cc.aspect = camera.aspect; cc.updateProjectionMatrix(); }
    const bg = scene.background, fog = scene.fog;
    scene.background = null; scene.fog = null;
    renderer.autoClear = false;
    renderer.clearDepth(); renderer.render(scene, cc);
    renderer.autoClear = true;
    scene.background = bg; scene.fog = fog;
  }

  dispose() {
    this.disposed = true;
    for (const f of this.off) f();
    for (const h of [this.heli.cabin, this.heli.whole]) if (h) { this.scene.remove(h.body); h.dispose(); }
    this.rotor.dispose();
    this.enemies.dispose();
    this.combat.dispose();
  }
}
