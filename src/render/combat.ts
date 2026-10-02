import * as THREE from "three";

/**
 * War mode's effects in the 3D view: the helicopter's gun (tracer rounds), guided rockets with a smoke
 * trail, explosions, and burning wrecks. It knows nothing of the simulation: the view tells it where
 * vehicles are (`World`) and takes back the ones destroyed, which stay on the road as wrecks (obstacles
 * in the traffic) until towed: each wreck here lasts as long as its vehicle does.
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
export interface CombatEvents {
  /** vehicles destroyed this frame */
  destroyed: number[];
  /** shots fired and blasts this frame (for the sound): blasts with their distance to the listener */
  shots: number;
  blasts: number[];
}

/** rounds that hit a vehicle before it burns */
const HITS_TO_DESTROY = 3;
const ROUND_SPEED = 420, ROUND_SPREAD = 0.006, HIT_RADIUS = 2.4;
const ROCKET_SPEED = 95, ROCKET_TURN = 4.5, ROCKET_LIFE = 9, BLAST_RADIUS = 8;
/** how long a wreck burns (it smoulders a little longer, then just lies there until towed) */
const BURN = 30;

interface Round { mesh: THREE.Mesh; vel: THREE.Vector3; to: THREE.Vector3; left: number }
interface Rocket { mesh: THREE.Group; vel: THREE.Vector3; target: number | null; aim: THREE.Vector3; age: number; puffAt: number }
interface Puff { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; age: number; life: number; grow: number; rise: number; from: number }
interface Wreck { id: number; group: THREE.Group; fire: THREE.Mesh; at: THREE.Vector3; age: number; puffAt: number }

export class Combat {
  private group = new THREE.Group();
  private rounds: Round[] = [];
  private rockets: Rocket[] = [];
  private puffs: Puff[] = [];
  private wrecks: Wreck[] = [];
  private hits = new Map<number, number>();
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

  constructor(private scene: THREE.Scene) { scene.add(this.group); }

  /** vehicles destroyed and not yet gone from the snapshot: not to be drawn */
  isGone(id: number) { return this.gone.has(id); }
  /** forget the destroyed vehicles the simulation no longer has */
  forget(present: (id: number) => boolean) { for (const id of this.gone) if (!present(id)) this.gone.delete(id); }

  /** one round from the gun towards a point */
  fire(from: THREE.Vector3, to: THREE.Vector3) {
    const d = to.clone().sub(from), dist = d.length();
    if (dist < 1) return;
    d.divideScalar(dist);
    d.x += (Math.random() - 0.5) * ROUND_SPREAD * 2; d.y += (Math.random() - 0.5) * ROUND_SPREAD * 2; d.z += (Math.random() - 0.5) * ROUND_SPREAD * 2;
    d.normalize();
    const mesh = new THREE.Mesh(this.geo.round, this.mat.round);
    mesh.position.copy(from);
    mesh.lookAt(from.clone().add(d));
    this.group.add(mesh);
    const hit = from.clone().addScaledVector(d, dist);
    this.rounds.push({ mesh, vel: d.multiplyScalar(ROUND_SPEED), to: hit, left: dist / ROUND_SPEED });
    this.events.shots++;
  }

  /** a rocket, guided onto a vehicle (or flying at a point when there's none) */
  launch(from: THREE.Vector3, dir: THREE.Vector3, target: number | null, aim: THREE.Vector3) {
    const mesh = new THREE.Group();
    const body = new THREE.Mesh(this.geo.rocket, this.mat.rocket), flame = new THREE.Mesh(this.geo.flame, this.mat.flame);
    flame.position.z = 0.95; // behind (the rocket faces −z)
    mesh.add(body, flame);
    mesh.position.copy(from);
    this.group.add(mesh);
    this.rockets.push({ mesh, vel: dir.clone().normalize().multiplyScalar(ROCKET_SPEED * 0.5), target, aim: aim.clone(), age: 0, puffAt: 0 });
    this.events.shots++;
  }

  private events: CombatEvents = { destroyed: [], shots: 0, blasts: [] };

  /** move everything on by dt seconds; what happened */
  update(dt: number, world: World, listener: THREE.Vector3): CombatEvents {
    const ev = this.events;
    // rounds: straight on until they reach where they were aimed
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      r.left -= dt;
      if (r.left > 0) { r.mesh.position.addScaledVector(r.vel, dt); continue; }
      this.group.remove(r.mesh);
      this.rounds.splice(i, 1);
      const id = world.near(r.to, HIT_RADIUS).find(x => !this.gone.has(x));
      if (id === undefined) { this.puff(r.to, 0x9a9384, 0.5, 0.6, 1.8, 0.4); continue; }
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
      const t = k.target !== null && !this.gone.has(k.target) ? world.at(k.target) : null;
      if (t) k.aim.copy(t).setY(t.y + 0.8);
      const want = k.aim.clone().sub(k.mesh.position), dist = want.length();
      const speed = Math.min(ROCKET_SPEED, k.vel.length() + dt * 120);
      k.vel.lerp(want.normalize().multiplyScalar(speed), Math.min(1, dt * ROCKET_TURN)).setLength(speed);
      k.mesh.position.addScaledVector(k.vel, dt);
      k.mesh.lookAt(k.mesh.position.clone().sub(k.vel));
      if (k.age > k.puffAt) { k.puffAt = k.age + 0.025; this.puff(k.mesh.position, 0xd9d6cf, 0.35, 1.6, 2.2, 0.6); }
      if (dist < 2.2 || k.mesh.position.y < 0.3 || k.age > ROCKET_LIFE) {
        this.group.remove(k.mesh);
        this.rockets.splice(i, 1);
        const at = k.mesh.position.clone().setY(Math.max(0.5, k.mesh.position.y));
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
    this.events = { destroyed: [], shots: 0, blasts: [] };
    return ev;
  }

  private destroy(ids: number[], world: World, at: THREE.Vector3, size: number, ev: CombatEvents, listener: THREE.Vector3) {
    // the explosion: a flash, a fireball, a column of smoke
    this.puff(at, 0xfff1c4, 0.95, 0.18, size * 9, 0);
    this.puff(at, 0xff8a2a, 0.9, 0.7, size * 3.2, 2);
    for (let k = 0; k < 6; k++) this.puff(at.clone().add(new THREE.Vector3((Math.random() - 0.5) * size, Math.random() * size * 0.6, (Math.random() - 0.5) * size)), 0x34302b, 0.7, 3 + Math.random() * 2, 2.2, 2.5);
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
    this.scene.remove(this.group);
    for (const p of this.puffs) p.mat.dispose();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const m of Object.values(this.mat)) m.dispose();
  }
}
