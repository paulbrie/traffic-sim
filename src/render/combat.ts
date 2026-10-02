import * as THREE from "three";
import { basePath } from "@/lib/base-path";

/**
 * War mode's effects in the 3D view: the helicopter's gun (tracer rounds), guided rockets with a smoke
 * trail, explosions, and burning wrecks. It knows nothing of the simulation: the view tells it where
 * vehicles are (`World`) and takes back the ones destroyed, which stay on the road as wrecks (obstacles
 * in the traffic) until towed: each wreck here lasts as long as its vehicle does. Aircraft (the player's
 * helicopter, the enemies') are another matter, told of by `air`: rounds and rockets hit them on the way.
 * World frame: metres, y up (plan x → x, plan y → z).
 */
export interface World {
  /** where a vehicle is now (null: it has gone) */
  at(id: number): THREE.Vector3 | null;
  /** the vehicles within r metres of a point, nearest first */
  near(p: THREE.Vector3, r: number): number[];
  /** how a vehicle sits, for its wreck: heading (radians, as plan atan2), length, width */
  shape(id: number): { heading: number; len: number; width: number } | null;
}
/** who fired: the player's rounds don't hit the player, nor an enemy's the enemies */
export type Side = "player" | "enemy";
/** the aircraft in the air, by id ("player", or an enemy's) */
export interface Air {
  /** the first aircraft (not of the shooter's side) the path from a to b passes through, or null */
  struck(a: THREE.Vector3, b: THREE.Vector3, side: Side): string | null;
  /** where an aircraft is now (null: gone, or going down) */
  at(id: string): THREE.Vector3 | null;
  /** the aircraft (not of `side`) within r metres of a point */
  within(p: THREE.Vector3, r: number, side: Side): string[];
  /** damage taken (a round: 1, a rocket's blast: more) */
  hurt(id: string, damage: number): void;
}
export interface CombatEvents {
  /** vehicles destroyed this frame */
  destroyed: number[];
  /** the player's shots and blasts this frame (for the sound): blasts with their distance to the listener */
  shots: number;
  blasts: number[];
  /** where the enemies fired from this frame */
  enemyShots: THREE.Vector3[];
}

/** rounds that hit a vehicle before it burns */
const HITS_TO_DESTROY = 3;
export const ROUND_SPEED = 420;
const ROUND_SPREAD = 0.006, HIT_RADIUS = 2.4;
const ROCKET_SPEED = 95, ROCKET_TURN = 4.5, ROCKET_LIFE = 9, BLAST_RADIUS = 8;
/** an aircraft's hits: a round, a rocket's blast */
const ROUND_DAMAGE = 1, ROCKET_DAMAGE = 12;
/**
 * Explosions are filmed ones: flipbooks of 5 × 5 frames, a fireball turning to rolling smoke (Unity Labs'
 * "Explosion02" and "Explosion00", rendered in Houdini, CC0: https://unity.com/blog/engine-platform/free-vfx-image-sequences-flipbooks),
 * played on a billboard, each frame fading into the next. Until they have loaded, balls of colour stand in.
 */
const FLIPBOOKS = ["explosion02", "explosion00"], FB_GRID = 5, FB_FRAMES = FB_GRID * FB_GRID;
/** how long a wreck burns (it smoulders a little longer, then just lies there until towed) */
const BURN = 30;

interface Round { mesh: THREE.Mesh; vel: THREE.Vector3; to: THREE.Vector3; left: number; side: Side }
interface Rocket { mesh: THREE.Group; vel: THREE.Vector3; target: number | null; air: string | null; aim: THREE.Vector3; age: number; puffAt: number; side: Side }
interface Puff { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; grow: number; rise: number; from: number }
interface Blast { a: THREE.Sprite; b: THREE.Sprite; age: number; life: number; rise: number }
interface Debris { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; smokeAt: number; trail: boolean }
interface Wreck { id: number; group: THREE.Group; fire: THREE.Mesh; at: THREE.Vector3; age: number; puffAt: number }

export class Combat {
  private group = new THREE.Group();
  private rounds: Round[] = [];
  private rockets: Rocket[] = [];
  private puffs: Puff[] = [];
  private wrecks: Wreck[] = [];
  private blasts: Blast[] = [];
  private debris: Debris[] = [];
  private books: THREE.Texture[] = [];
  /** the explosions' light on the ground and the buildings round them: one light, kept (adding lights recompiles every material) */
  private flash = new THREE.PointLight(0xffa04a, 0, 0, 2);
  private flashLeft = 0;
  private flashPeak = 0;
  private disposed = false;
  private hits = new Map<number, number>();
  private tmp = new THREE.Vector3();
  private gone = new Set<number>();
  private geo = {
    // (tracers drawn bigger than a round: seen from 100 m and more, they still read as streaks of light)
    round: new THREE.BoxGeometry(0.35, 0.35, 9),
    ball: new THREE.SphereGeometry(1, 12, 8),
    rocket: new THREE.CylinderGeometry(0.07, 0.07, 1.3, 8).rotateX(Math.PI / 2),
    flame: new THREE.ConeGeometry(0.12, 0.7, 8).rotateX(-Math.PI / 2),
    box: new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0),
  };
  private mat = {
    round: new THREE.MeshBasicMaterial({ color: 0xffd36b, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
    rocket: new THREE.MeshBasicMaterial({ color: 0x5a6150 }),
    flame: new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    wreck: new THREE.MeshLambertMaterial({ color: 0x1b1a19 }),
    fire: new THREE.MeshBasicMaterial({ color: 0xff7a1a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
  };
  /** how many vehicles were destroyed so far */
  destroyedCount = 0;
  /** the aircraft rounds and rockets can hit (none: only vehicles) */
  air: Air | null = null;
  private pendingBlasts: { at: THREE.Vector3; size: number }[] = [];

  constructor(private scene: THREE.Scene) {
    scene.add(this.group);
    this.group.add(this.flash);
    // (in a browser only: the textures load as images)
    if (typeof document === "undefined") return;
    const loader = new THREE.TextureLoader();
    for (const n of FLIPBOOKS) loader.load(`${basePath}/textures/${n}.webp`, t => {
      if (this.disposed) { t.dispose(); return; }
      t.colorSpace = THREE.SRGBColorSpace;
      t.repeat.set(1 / FB_GRID, 1 / FB_GRID);
      this.books.push(t);
    });
  }

  /** vehicles destroyed and not yet gone from the snapshot: not to be drawn */
  isGone(id: number) { return this.gone.has(id); }
  /** forget the destroyed vehicles the simulation no longer has */
  forget(present: (id: number) => boolean) { for (const id of this.gone) if (!present(id)) this.gone.delete(id); }

  /** one round from the gun towards a point (an enemy's guns spray wider) */
  fire(from: THREE.Vector3, to: THREE.Vector3, side: Side = "player", spread = ROUND_SPREAD) {
    const d = to.clone().sub(from), dist = d.length();
    if (dist < 1) return;
    d.divideScalar(dist);
    d.x += (Math.random() - 0.5) * spread * 2; d.y += (Math.random() - 0.5) * spread * 2; d.z += (Math.random() - 0.5) * spread * 2;
    d.normalize();
    const mesh = new THREE.Mesh(this.geo.round, this.mat.round);
    mesh.position.copy(from);
    mesh.lookAt(from.clone().add(d));
    this.group.add(mesh);
    const hit = from.clone().addScaledVector(d, dist);
    this.rounds.push({ mesh, vel: d.multiplyScalar(ROUND_SPEED), to: hit, left: dist / ROUND_SPEED, side });
    if (side === "player") this.events.shots++; else this.events.enemyShots.push(from.clone());
  }

  /** a rocket, guided onto a vehicle or an aircraft (`air`), or flying at a point when there's neither */
  launch(from: THREE.Vector3, dir: THREE.Vector3, target: number | null, aim: THREE.Vector3, air: string | null = null) {
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(this.geo.rocket, this.mat.rocket), flame = new THREE.Mesh(this.geo.flame, this.mat.flame);
    flame.position.z = 0.95; // behind (the rocket faces −z)
    mesh.add(body, flame);
    mesh.position.copy(from);
    this.group.add(mesh);
    this.rockets.push({ mesh, vel: dir.clone().normalize().multiplyScalar(ROCKET_SPEED * 0.5), target, air, aim: aim.clone(), age: 0, puffAt: 0, side: "player" });
    this.events.shots++;
  }

  /** an explosion (an aircraft hitting the ground): it takes the vehicles round it with it */
  explode(at: THREE.Vector3, size: number) { this.pendingBlasts.push({ at: at.clone(), size }); }
  /** a puff of black smoke (from a damaged aircraft) */
  smoke(at: THREE.Vector3, heavy = false) { this.puff(at, 0x2a2724, heavy ? 0.7 : 0.45, heavy ? 3 : 2, heavy ? 2.4 : 1.6, 1); }
  /** sparks where a round hits */
  spark(at: THREE.Vector3) { this.puff(at, 0xffc266, 0.35, 0.25, 1.4, 0, true); }

  private events: CombatEvents = { destroyed: [], shots: 0, blasts: [], enemyShots: [] };

  /** move everything on by dt seconds; what happened */
  update(dt: number, world: World, listener: THREE.Vector3): CombatEvents {
    const ev = this.events, air = this.air;
    for (const b of this.pendingBlasts) this.destroy(world.near(b.at, b.size * 1.5).filter(x => !this.gone.has(x)), world, b.at, b.size, ev, listener);
    this.pendingBlasts = [];
    // rounds: straight on until they reach where they were aimed, unless an aircraft is in the way
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      const step = Math.min(dt, Math.max(0, r.left)), next = this.tmp.copy(r.mesh.position).addScaledVector(r.vel, step);
      const craft = air?.struck(r.mesh.position, next, r.side) ?? null;
      if (craft !== null) {
        this.spark(next);
        air!.hurt(craft, ROUND_DAMAGE);
        this.group.remove(r.mesh);
        this.rounds.splice(i, 1);
        continue;
      }
      r.left -= dt;
      if (r.left > 0) { r.mesh.position.copy(next); continue; }
      this.group.remove(r.mesh);
      this.rounds.splice(i, 1);
      const id = world.near(r.to, HIT_RADIUS).find(x => !this.gone.has(x));
      // (a miss in the air just flies on out of sight)
      if (id === undefined) { if (r.to.y < 3) this.puff(r.to, 0x9a9384, 0.5, 0.6, 1.8, 0.4); continue; }
      // a hit: sparks, and the third one sets it alight
      this.puff(r.to, 0xffc266, 0.35, 0.25, 1.4, 0, true);
      const n = (this.hits.get(id) ?? 0) + 1;
      this.hits.set(id, n);
      if (n >= HITS_TO_DESTROY) this.destroy([id], world, r.to, 3, ev, listener);
    }
    // rockets: steer towards the target's position now (proportional turn), speeding up; burst on arrival
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const k = this.rockets[i];
      k.age += dt;
      const t = k.air !== null ? air?.at(k.air) ?? null : k.target !== null && !this.gone.has(k.target) ? world.at(k.target) : null;
      if (t) k.aim.copy(t).setY(t.y + (k.air !== null ? 0 : 0.8));
      const want = k.aim.clone().sub(k.mesh.position), dist = want.length();
      const speed = Math.min(ROCKET_SPEED, k.vel.length() + dt * 120);
      k.vel.lerp(want.normalize().multiplyScalar(speed), Math.min(1, dt * ROCKET_TURN)).setLength(speed);
      k.mesh.position.addScaledVector(k.vel, dt);
      k.mesh.lookAt(k.mesh.position.clone().sub(k.vel));
      if (k.age > k.puffAt) { k.puffAt = k.age + 0.025; this.puff(k.mesh.position, 0xd9d6cf, 0.35, 1.6, 2.2, 0.6); }
      const close = k.air !== null && t ? 4 : 2.2;
      if (dist < close || k.mesh.position.y < 0.3 || k.age > ROCKET_LIFE) {
        this.group.remove(k.mesh);
        this.rockets.splice(i, 1);
        const at = k.mesh.position.clone().setY(Math.max(0.5, k.mesh.position.y));
        if (air) for (const id of air.within(at, BLAST_RADIUS + 3, k.side)) air.hurt(id, ROCKET_DAMAGE);
        this.destroy(world.near(at, BLAST_RADIUS).filter(x => !this.gone.has(x)), world, at, 7, ev, listener);
      }
    }
    // smoke, dust, sparks, fireballs: grow, rise and fade
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.age += dt;
      const f = p.age / p.life;
      if (f >= 1) { this.group.remove(p.mesh); p.mat.dispose(); this.puffs.splice(i, 1); continue; }
      p.mesh.scale.setScalar(p.mesh.scale.x + p.grow * dt);
      p.mesh.position.y += p.rise * dt;
      p.mat.opacity = p.from * (1 - f) * (1 - f);
    }
    // explosions: the flipbook plays, frame fading into frame; the flash's light dies away
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.age += dt;
      const f = b.age / b.life;
      if (f >= 1) { this.removeBlast(b); this.blasts.splice(i, 1); continue; }
      const x = f * (FB_FRAMES - 1), n = Math.floor(x), t = x - n, fade = f > 0.8 ? (1 - f) / 0.2 : 1;
      this.frame(b.a, n); this.frame(b.b, Math.min(FB_FRAMES - 1, n + 1));
      (b.a.material as THREE.SpriteMaterial).opacity = (1 - t) * fade;
      (b.b.material as THREE.SpriteMaterial).opacity = t * fade;
      b.a.position.y += b.rise * dt; b.b.position.y = b.a.position.y;
    }
    if (this.flashLeft > 0) { this.flashLeft = Math.max(0, this.flashLeft - dt); this.flash.intensity = this.flashPeak * (this.flashLeft / 0.4) ** 2; }
    // debris: thrown out, falling, tumbling; gone in a little dust where it lands
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i];
      d.vel.y -= 9.8 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt; d.mesh.rotation.y += d.spin.y * dt; d.mesh.rotation.z += d.spin.z * dt;
      d.smokeAt -= dt;
      if (d.trail && d.smokeAt <= 0) { d.smokeAt = 0.05; this.puff(d.mesh.position, 0x3a3631, 0.45, 0.9, 1.2, 0.3); }
      if (d.mesh.position.y <= 0.1 && d.vel.y < 0) {
        this.puff(d.mesh.position, 0x9a9384, 0.4, 0.6, 1.5, 0.3);
        this.group.remove(d.mesh); this.debris.splice(i, 1);
      }
    }
    // wrecks burn and smoke, then lie there until towed away (their vehicle gone from the traffic)
    for (let i = this.wrecks.length - 1; i >= 0; i--) {
      const w = this.wrecks[i];
      w.age += dt;
      if (!world.at(w.id)) { this.group.remove(w.group); this.wrecks.splice(i, 1); continue; }
      const s = 0.8 + Math.random() * 0.5, fade = Math.max(0, 1 - w.age / BURN);
      w.fire.visible = fade > 0;
      w.fire.scale.set(s * fade, (1 + Math.random() * 0.6) * fade, s * fade);
      if (w.age > w.puffAt && w.age < BURN * 1.5) { w.puffAt = w.age + (fade > 0 ? 0.18 : 0.6); this.puff(w.at.clone().setY(w.at.y + 1.5), 0x2a2724, fade > 0 ? 0.55 : 0.25, 4, 1.4, 3.5); }
    }
    this.events = { destroyed: [], shots: 0, blasts: [], enemyShots: [] };
    return ev;
  }

  private destroy(ids: number[], world: World, at: THREE.Vector3, size: number, ev: CombatEvents, listener: THREE.Vector3) {
    // the explosion: a flash (and its light round about), the fireball turning to smoke, debris thrown out
    this.puff(at, 0xfff1c4, 0.8, 0.12, size * 6, 0);
    this.flash.position.copy(at).setY(at.y + size * 0.8);
    this.flashPeak = Math.max(this.flashLeft > 0 ? this.flash.intensity : 0, 50 * size);
    this.flash.distance = size * 30; this.flashLeft = 0.4;
    if (this.books.length) this.blast(at, size);
    else {
      this.puff(at, 0xff8a2a, 0.9, 0.7, size * 3.2, 2);
      for (let k = 0; k < 6; k++) this.puff(at.clone().add(new THREE.Vector3((Math.random() - 0.5) * size, Math.random() * size * 0.6, (Math.random() - 0.5) * size)), 0x34302b, 0.7, 3 + Math.random() * 2, 2.2, 2.5);
    }
    const chunks = Math.min(14, Math.round(size * 1.6));
    for (let k = 0; k < chunks && this.debris.length < 120; k++) {
      const mesh = new THREE.Mesh(this.geo.box, this.mat.wreck);
      const s = 0.15 + Math.random() * 0.35 * Math.sqrt(size / 3);
      mesh.scale.set(s * (1 + Math.random()), s * 0.5, s * (0.6 + Math.random()));
      mesh.position.copy(at).setY(at.y + 0.5);
      const a = Math.random() * Math.PI * 2, up = 0.4 + Math.random() * 0.6, sp = (6 + Math.random() * 10) * Math.sqrt(size / 3);
      this.group.add(mesh);
      this.debris.push({
        mesh, vel: new THREE.Vector3(Math.cos(a) * sp * (1 - up * 0.5), sp * up, Math.sin(a) * sp * (1 - up * 0.5)),
        spin: new THREE.Vector3(Math.random() * 12 - 6, Math.random() * 12 - 6, Math.random() * 12 - 6), smokeAt: 0, trail: k < 3,
      });
    }
    ev.blasts.push(listener.distanceTo(at));
    for (const id of ids) {
      const p = world.at(id), sh = world.shape(id);
      if (!p) continue;
      this.gone.add(id); this.hits.delete(id);
      this.destroyedCount++;
      ev.destroyed.push(id);
      this.wreck(id, p, sh);
    }
  }

  private wreck(id: number, p: THREE.Vector3, sh: { heading: number; len: number; width: number } | null) {
    const group = new THREE.Group();
    const hull = new THREE.Mesh(this.geo.box, this.mat.wreck);
    hull.scale.set(sh?.len ?? 4.4, 1.1, sh?.width ?? 1.8);
    hull.rotation.y = -(sh?.heading ?? 0);
    hull.castShadow = true;
    const fire = new THREE.Mesh(this.geo.ball, this.mat.fire);
    fire.position.y = 1.4;
    group.add(hull, fire);
    group.position.copy(p).setY(p.y);
    this.group.add(group);
    this.wrecks.push({ id, group, fire, at: p.clone(), age: 0, puffAt: 0 });
  }

  /** a filmed explosion of about `size` (a car's: 3, a rocket's: 7), on a pair of billboards (frame and next frame) */
  private blast(at: THREE.Vector3, size: number) {
    const book = this.books[Math.floor(Math.random() * this.books.length)], scale = size * 5.5, rot = (Math.random() - 0.5) * 0.6;
    const flip = Math.random() < 0.5;
    const make = () => {
      const map = book.clone();
      if (flip) { map.repeat.x = -1 / FB_GRID; }
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, rotation: rot, opacity: 0 }));
      s.scale.set(scale, scale, 1);
      // (on the ground, raised so its lower half doesn't sink into the road)
      s.position.copy(at).setY(at.y < 3 ? at.y + scale * 0.28 : at.y);
      s.renderOrder = 2;
      this.group.add(s);
      return s;
    };
    this.blasts.push({ a: make(), b: make(), age: 0, life: 2.2 + size * 0.12, rise: 0.8 + size * 0.15 });
  }

  /** show frame n of the flipbook on a billboard (frames read left to right, top to bottom) */
  private frame(s: THREE.Sprite, n: number) {
    const map = (s.material as THREE.SpriteMaterial).map!, col = n % FB_GRID, row = Math.floor(n / FB_GRID);
    map.offset.set(map.repeat.x < 0 ? (col + 1) / FB_GRID : col / FB_GRID, 1 - (row + 1) / FB_GRID);
  }

  private removeBlast(b: Blast) {
    for (const s of [b.a, b.b]) { this.group.remove(s); const m = s.material as THREE.SpriteMaterial; m.map?.dispose(); m.dispose(); }
  }

  /** a ball that grows, rises and fades: smoke, dust, sparks or fire */
  private puff(at: THREE.Vector3, color: number, opacity: number, life: number, grow: number, rise: number, glow = false) {
    if (this.puffs.length > 600) return;
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: glow || color === 0xff8a2a || color === 0xfff1c4 ? THREE.AdditiveBlending : THREE.NormalBlending });
    const mesh = new THREE.Mesh(this.geo.ball, mat);
    mesh.position.copy(at);
    mesh.scale.setScalar(0.3);
    this.group.add(mesh);
    this.puffs.push({ mesh, mat, age: 0, life, grow, rise, from: opacity });
  }

  dispose() {
    this.disposed = true;
    this.scene.remove(this.group);
    for (const b of this.blasts) this.removeBlast(b);
    for (const t of this.books) t.dispose();
    for (const p of this.puffs) p.mat.dispose();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
  }
}
