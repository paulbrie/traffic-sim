import * as THREE from "three";
import { loadHelicopter, type Helicopter } from "./helicopter";
import { ROUND_SPEED, type Air, type Combat } from "./combat";

/**
 * War mode's enemy helicopters: they come for the player from a kilometre off, circle round at a few hundred
 * metres, each to its own side, nose on, and fire bursts where the player is going to be. Badly hit, one
 * breaks away for a few seconds before coming back. Shot down, it trails smoke, spins down and blows up on the
 * ground (taking the vehicles there with it). No pathfinding: they fly over the buildings.
 * Same frame as the player's helicopter: metres, y up, yaw as a camera's (0 = nose north, towards −z).
 */
export const ENEMY_MAX = 6;
/** hits taken before going down: rounds count 1, a rocket's blast 12 */
const ENEMY_HP = 12, PLAYER_HP = 40;
/** a bit slower than the player (200 km/h), so one can be outrun; quicker to answer than the player */
const VMAX = 46, RESPONSE = 0.7, CLIMB_MAX = 12;
/** circling distance, the gun's reach, how far off the nose they still fire (rad) */
const STANDOFF = 260, GUN_RANGE = 600, FIRE_CONE = 0.2;
/** never lower than this (except going down), and how far round they reach for the player */
const MIN_ALT = 35;
/** the shape hit by rounds: a sphere round each aircraft */
const ENEMY_R = 5.5, PLAYER_R = 4.5;
const BURST = 6, SHOT_GAP = 0.1, SPREAD = 0.035;

interface Enemy {
  id: string;
  heli: Helicopter | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number; pitch: number; roll: number;
  hp: number;
  /** where round the player it circles (rad), which way it goes round, and how much above the player */
  angle: number; dir: 1 | -1; dy: number;
  state: "attack" | "break" | "down";
  /** (seconds) when breaking away ends; when it may break away again */
  until: number; calmAt: number;
  nextBurst: number; burstLeft: number; nextShot: number;
  spin: number; smokeAt: number;
}

export interface EnemyEvents {
  /** rounds that hit the player this frame */
  playerHits: number;
  /** enemies shot down this frame */
  downed: number;
  /** the player's helicopter has taken its last hit */
  playerDown: boolean;
}

const turnTo = (a: number, b: number, k: number) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
/** the closest point of segment a–b to c, its distance */
function segDist(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z, l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * abx + (c.y - a.y) * aby + (c.z - a.z) * abz) / l2)) : 0;
  return Math.hypot(a.x + abx * t - c.x, a.y + aby * t - c.y, a.z + abz * t - c.z);
}

export class Enemies {
  private list: Enemy[] = [];
  private seq = 0;
  private time = 0;
  private active = false;
  private ev: EnemyEvents = { playerHits: 0, downed: 0, playerDown: false };
  private tmp = new THREE.Vector3();
  private disposed = false;
  /** the player's helicopter: where it is and how it moves (set by the view each frame), and its hits left */
  readonly player = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), hp: PLAYER_HP };
  readonly playerMax = PLAYER_HP;
  /** shot down so far */
  kills = 0;
  readonly air: Air;

  constructor(private scene: THREE.Scene, private combat: Combat) {
    this.air = {
      struck: (a, b, side) => {
        if (side === "enemy") return this.active && this.player.hp > 0 && segDist(a, b, this.player.pos) < PLAYER_R ? "player" : null;
        for (const e of this.list) if (e.state !== "down" && segDist(a, b, e.pos) < ENEMY_R) return e.id;
        return null;
      },
      at: id => (id === "player" ? this.player.pos : this.list.find(e => e.id === id && e.state !== "down")?.pos ?? null),
      within: (p, r, side) => side === "enemy"
        ? (this.player.pos.distanceTo(p) < r + PLAYER_R ? ["player"] : [])
        : this.list.filter(e => e.state !== "down" && e.pos.distanceTo(p) < r + ENEMY_R).map(e => e.id),
      hurt: (id, damage) => this.hurt(id, damage),
    };
    combat.air = this.air;
  }

  /** all of them, going down or not */
  get size() { return this.list.length; }
  /** enemies still flying (not going down) */
  get count() { return this.list.filter(e => e.state !== "down").length; }

  /** a new enemy, a kilometre or so from the player in any direction, coming in a little above it */
  spawn() {
    if (this.count >= ENEMY_MAX) return false;
    const a = Math.random() * Math.PI * 2, d = 1000 + Math.random() * 300, p = this.player.pos;
    const pos = new THREE.Vector3(p.x + Math.cos(a) * d, Math.max(MIN_ALT + 40, p.y + 30 + Math.random() * 40), p.z + Math.sin(a) * d);
    const e: Enemy = {
      id: `e${++this.seq}`, heli: null, pos, vel: new THREE.Vector3(),
      yaw: Math.atan2(-(p.x - pos.x), -(p.z - pos.z)), pitch: 0, roll: 0, hp: ENEMY_HP,
      angle: a, dir: Math.random() < 0.5 ? 1 : -1, dy: -10 + Math.random() * 50,
      state: "attack", until: 0, calmAt: 0, nextBurst: this.time + 2 + Math.random() * 2, burstLeft: 0, nextShot: 0, spin: 0, smokeAt: 0,
    };
    this.list.push(e);
    loadHelicopter("whole", 0, true).then(h => {
      if (this.disposed || !this.list.includes(e)) { h.dispose(); return; }
      e.heli = h; h.body.visible = this.active; this.scene.add(h.body); this.place(e, 0);
    }).catch(() => { /* it flies (and fights) unseen */ });
    return true;
  }

  /** all of them gone at once (war mode off, or the player shot down); the player's helicopter mended */
  clear() {
    for (const e of this.list) this.remove(e);
    this.list = [];
    this.player.hp = PLAYER_HP;
  }

  /** where each enemy is, for the markers on screen */
  positions() { return this.list.filter(e => e.state !== "down").map(e => ({ id: e.id, pos: e.pos, hp: e.hp / ENEMY_HP })); }

  /** the enemy nearest the line of sight (within `cone` radians and `range` metres), for a rocket to lock on */
  lockOn(from: THREE.Vector3, dir: THREE.Vector3, cone = 0.15, range = 2000): string | null {
    let best: string | null = null, bestA = cone;
    for (const e of this.list) {
      if (e.state === "down") continue;
      const to = this.tmp.copy(e.pos).sub(from), d = to.length();
      if (d > range || d < 1) continue;
      const a = Math.acos(Math.max(-1, Math.min(1, to.dot(dir) / d)));
      if (a < bestA) { bestA = a; best = e.id; }
    }
    return best;
  }

  /** move them all on by dt seconds; `active`: in the air and armed (otherwise they wait, unseen) */
  update(dt: number, active: boolean): EnemyEvents {
    this.active = active;
    const ev = this.ev;
    this.ev = { playerHits: 0, downed: 0, playerDown: false };
    for (const e of this.list) if (e.heli) e.heli.body.visible = active;
    if (!active || dt <= 0) return ev;
    this.time += dt;
    const P = this.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (e.state === "down") {
        // spinning down, trailing smoke; a fireball on the ground
        e.vel.y = Math.max(-35, e.vel.y - 9.8 * dt);
        e.vel.x *= 1 - dt * 0.3; e.vel.z *= 1 - dt * 0.3;
        e.pos.addScaledVector(e.vel, dt);
        e.yaw += e.spin * dt; e.roll += (0.5 - e.roll) * dt; e.pitch += (0.3 - e.pitch) * dt;
        if (this.time > e.smokeAt) { e.smokeAt = this.time + 0.05; this.combat.smoke(e.pos, true); }
        if (e.pos.y <= 1) { this.combat.explode(e.pos.setY(1), 6); this.remove(e); this.list.splice(i, 1); continue; }
        this.place(e, dt);
        continue;
      }
      if (e.hp < ENEMY_HP / 2 && this.time > e.smokeAt) { e.smokeAt = this.time + 0.25; this.combat.smoke(e.pos); }
      const to = this.tmp.copy(P.pos).sub(e.pos), dist = to.length(), flat = Math.hypot(to.x, to.z) || 1;
      if (e.state === "break" && this.time > e.until) e.state = "attack";
      const want = new THREE.Vector3();
      if (e.state === "break") {
        // away, across the player's line, climbing
        want.set((-to.z / flat) * e.dir * VMAX, 8, (to.x / flat) * e.dir * VMAX);
      } else if (flat > 700) {
        // far off: straight for the player, high enough to clear the buildings
        want.set((to.x / flat) * VMAX, 0, (to.z / flat) * VMAX);
        want.y = Math.max(-CLIMB_MAX, Math.min(CLIMB_MAX, (Math.max(MIN_ALT + 40, P.pos.y + 30) - e.pos.y) * 0.5));
      } else {
        // close: circle round the player at the stand-off distance, matching its speed
        e.angle += e.dir * 0.22 * dt;
        const tx = P.pos.x + Math.cos(e.angle) * STANDOFF, tz = P.pos.z + Math.sin(e.angle) * STANDOFF;
        const ty = Math.max(MIN_ALT, P.pos.y + e.dy);
        want.set((tx - e.pos.x) * 0.35 + P.vel.x, (ty - e.pos.y) * 0.5, (tz - e.pos.z) * 0.35 + P.vel.z);
      }
      // keep apart from the others
      for (const o of this.list) {
        if (o === e || o.state === "down") continue;
        const dx = e.pos.x - o.pos.x, dy = e.pos.y - o.pos.y, dz = e.pos.z - o.pos.z, d = Math.hypot(dx, dy, dz);
        if (d < 60 && d > 0.1) { const k = ((60 - d) / 60) * 25 / d; want.x += dx * k; want.y += dy * k * 0.5; want.z += dz * k; }
      }
      const h = Math.hypot(want.x, want.z);
      if (h > VMAX) { want.x *= VMAX / h; want.z *= VMAX / h; }
      want.y = Math.max(-CLIMB_MAX, Math.min(CLIMB_MAX, want.y));
      e.vel.lerp(want, 1 - Math.exp(-dt * RESPONSE));
      e.pos.addScaledVector(e.vel, dt);
      e.pos.y = Math.max(MIN_ALT * 0.6, e.pos.y);
      // nose on the player when near enough to shoot, otherwise where it is going
      const sy = Math.sin(e.yaw), cy = Math.cos(e.yaw);
      const faceYaw = e.state === "attack" && dist < 900 ? Math.atan2(-to.x, -to.z) : Math.hypot(e.vel.x, e.vel.z) > 3 ? Math.atan2(-e.vel.x, -e.vel.z) : e.yaw;
      e.yaw = turnTo(e.yaw, faceYaw, 1 - Math.exp(-dt * 1.8));
      const vf = -e.vel.x * sy - e.vel.z * cy, vs = e.vel.x * cy - e.vel.z * sy, ease = 1 - Math.exp(-dt * 2);
      e.pitch += (-0.15 * Math.max(-1, Math.min(1, vf / VMAX)) - e.pitch) * ease;
      e.roll += (-0.25 * Math.max(-1, Math.min(1, vs / VMAX)) - e.roll) * ease;
      // the gun: bursts, when the player is in reach and near enough the nose; aimed where it will be
      const off = Math.abs(Math.atan2(Math.sin(Math.atan2(-to.x, -to.z) - e.yaw), Math.cos(Math.atan2(-to.x, -to.z) - e.yaw)));
      if (e.state === "attack" && P.hp > 0 && dist < GUN_RANGE && off < FIRE_CONE) {
        if (e.burstLeft === 0 && this.time >= e.nextBurst) { e.burstLeft = BURST; e.nextBurst = this.time + 2 + Math.random() * 1.8; }
        if (e.burstLeft > 0 && this.time >= e.nextShot) {
          e.nextShot = this.time + SHOT_GAP; e.burstLeft--;
          const muzzle = new THREE.Vector3(0, -1.5, -1.5).applyEuler(new THREE.Euler(e.pitch, e.yaw, e.roll, "YXZ")).add(e.pos);
          const lead = P.pos.clone().addScaledVector(P.vel, muzzle.distanceTo(P.pos) / ROUND_SPEED);
          const aim = lead.sub(muzzle).normalize();
          // (past the player: a miss flies on)
          this.combat.fire(muzzle, muzzle.clone().addScaledVector(aim, dist + 250), "enemy", SPREAD);
        }
      } else e.burstLeft = 0;
      this.place(e, dt);
    }
    return ev;
  }

  private hurt(id: string, damage: number) {
    if (id === "player") {
      if (this.player.hp <= 0) return;
      this.player.hp = Math.max(0, this.player.hp - damage);
      this.ev.playerHits++;
      if (this.player.hp === 0) this.ev.playerDown = true;
      return;
    }
    const e = this.list.find(x => x.id === id);
    if (!e || e.state === "down") return;
    e.hp -= damage;
    if (e.hp <= 0) {
      e.state = "down"; e.spin = (Math.random() < 0.5 ? -1 : 1) * (2.5 + Math.random() * 2);
      this.kills++; this.ev.downed++;
      this.combat.explode(e.pos, 2);
    } else if (e.hp < ENEMY_HP * 0.4 && this.time > e.calmAt && Math.random() < 0.5) {
      // badly hit: away for a few seconds
      e.state = "break"; e.until = this.time + 3 + Math.random() * 2; e.calmAt = e.until + 10;
    }
  }

  private place(e: Enemy, dt: number) {
    if (!e.heli) return;
    const b = e.heli.body;
    b.position.copy(e.pos);
    b.rotation.order = "YXZ"; b.rotation.set(e.pitch, e.yaw, e.roll);
    e.heli.spin(dt);
  }

  private remove(e: Enemy) {
    if (e.heli) { this.scene.remove(e.heli.body); e.heli.dispose(); e.heli = null; }
  }

  dispose() {
    this.disposed = true;
    for (const e of this.list) this.remove(e);
    this.list = [];
    if (this.combat.air === this.air) this.combat.air = null;
  }
}
