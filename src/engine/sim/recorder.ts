/**
 * Every simulation step kept in memory, compactly, so the page can replay them (a slider like a video
 * player's). A frame stores per vehicle what drawing it needs — id, front point, heading, length on screen,
 * speed, turn signal, level, height, state — about 21 bytes; what doesn't change (kind, colour, length, width) is kept
 * once per vehicle; per junction its signal phase and stage; per parking bay whether a car is in it (a bit),
 * per crossing drawn by hand its pedestrians (3 bytes). Oldest frames go when over the budget.
 */
import { pieceLevel, pieceZ } from "../compile";
import type { Sim } from "./index";
import type { RevView, Snapshot } from "./mirror";
import { DT, type RevStateCode } from "./base";

/** a reversible lane set by hand, as stored in a frame (0 = not) */
const HOLDS = [null, "closed", "1", "2"] as const;

const KINDS = ["car", "truck", "bus"] as const;
const G = 11;

interface Frame { tick: number; n: number; buf: ArrayBuffer }
interface Fixed { kind: number; tint: number; len: number; width: number }

export interface RecordingInfo { from: number; to: number; frames: number; bytes: number }

export class Recorder {
  private frames: Frame[] = [];
  private head = 0; // index of the oldest kept frame (dropped ones are spliced away in batches)
  private bytes = 0;
  private fixed = new Map<number, Fixed>();
  private stateNames: string[] = [];
  private stateIdx = new Map<string, number>();
  constructor(public budgetBytes = 512 * 1024 * 1024) {}

  clear() { this.frames = []; this.head = 0; this.bytes = 0; this.fixed.clear(); this.seen = new Uint8Array(1024); this.stateNames = []; this.stateIdx.clear(); }

  info(): RecordingInfo {
    const n = this.frames.length - this.head;
    return n ? { from: this.frames[this.head].tick, to: this.frames[this.frames.length - 1].tick, frames: n, bytes: this.bytes } : { from: 0, to: 0, frames: 0, bytes: 0 };
  }

  /** keep the current step */
  record(sim: Sim) {
    const vs = sim.vehicles, N = sim.net.nodes.length, C = sim.net.corridors.length, X = sim.net.crossings.length;
    const parked = sim.net.parking.length ? sim.parkedFlags() : null, PB = parked ? Math.ceil(parked.length / 8) : 0;
    let n = 0;
    for (let i = 0; i < vs.length; i++) if (!vs[i].dead) n++;
    // (heights only matter on plans with bridges or tunnels)
    if (this.flat === null || this.flatNet !== sim.net) { this.flatNet = sim.net; this.flat = sim.net.nodes.every(nd => nd.level === 0) && sim.net.edges.every(e => !e.link.level); }
    // layout: 4-byte fields, then 2-byte, then 1-byte (so every view is aligned)
    // (reversible corridors: the tick their state began; then state + set by hand, vehicles in the lane, density each way)
    // (then the parking bays, a bit each, and the crossings drawn by hand: waiting, crossing, how far across)
    const size = n * 4 + n * 8 + C * 4 + n * 2 + N * 2 + n * 7 + N + C * 4 + PB + X * 3;
    const buf = new ArrayBuffer(Math.ceil(size / 4) * 4);
    let o = 0;
    const ids = new Int32Array(buf, o, n); o += n * 4;
    const xy = new Float32Array(buf, o, n * 2); o += n * 8;
    const rs = new Int32Array(buf, o, C); o += C * 4;
    const hd = new Int16Array(buf, o, n); o += n * 2;
    const ph = new Int16Array(buf, o, N); o += N * 2;
    const vv = new Uint8Array(buf, o, n); o += n;
    const v0 = new Uint8Array(buf, o, n); o += n;
    const bl = new Int8Array(buf, o, n); o += n;
    const lv = new Int8Array(buf, o, n); o += n;
    const zz = new Int8Array(buf, o, n); o += n;
    const st = new Uint8Array(buf, o, n); o += n;
    const cl = new Uint8Array(buf, o, n); o += n;
    const sg = new Int8Array(buf, o, N); o += N;
    const rv = new Uint8Array(buf, o, C * 4); o += C * 4;
    const pk = new Uint8Array(buf, o, PB); o += PB;
    const xp = new Uint8Array(buf, o, X * 3);
    if (parked) for (let i = 0; i < parked.length; i++) if (parked[i]) pk[i >> 3] |= 1 << (i & 7);
    for (let k = 0; k < X; k++) {
      const c = sim.crossingStats(k);
      if (c) { xp[k * 3] = Math.min(255, c.waiting); xp[k * 3 + 1] = Math.min(255, c.crossing); xp[k * 3 + 2] = Math.round(c.progress * 255); }
    }
    for (let k = 0; k < C; k++) {
      const r = sim.reversibleState(k)!;
      rs[k] = Math.round(sim.tick - r.t / DT);
      rv[k * 4] = r.state | (HOLDS.indexOf(r.hold) << 4); rv[k * 4 + 1] = Math.min(255, r.inside);
      rv[k * 4 + 2] = Math.min(255, Math.round(r.density[0])); rv[k * 4 + 3] = Math.min(255, Math.round(r.density[1]));
    }
    const flat = this.flat;
    for (let j = 0, i = 0; j < vs.length; j++) {
      const v = vs[j];
      if (v.dead) continue;
      ids[i] = v.id;
      if (v.id >= this.seen.length) { const g = new Uint8Array(Math.max(v.id + 1, this.seen.length * 2)); g.set(this.seen); this.seen = g; }
      if (!this.seen[v.id]) { this.seen[v.id] = 1; this.fixed.set(v.id, { kind: KINDS.indexOf(v.kind), tint: v.tint, len: v.len, width: v.width }); }
      const p = sim.pose(v), dx = p.fx - p.rx, dy = p.fy - p.ry;
      xy[i * 2] = p.fx; xy[i * 2 + 1] = p.fy;
      hd[i] = Math.round((Math.atan2(dy, dx) / Math.PI) * 32767);
      // (front to rear in a straight line: shorter than the vehicle on a curve, or just after it appears)
      cl[i] = Math.min(255, Math.round(Math.sqrt(dx * dx + dy * dy) * 10));
      vv[i] = Math.min(255, Math.round(v.v * 4)); v0[i] = Math.min(255, Math.round(v.v0 * 4));
      bl[i] = sim.blinker(v);
      if (!flat) { lv[i] = pieceLevel(v.piece); zz[i] = Math.max(-127, Math.min(127, Math.round(pieceZ(sim.net, v.piece, v.s) * 20))); }
      let si = this.stateIdx.get(v.state);
      if (si === undefined) { si = this.stateNames.length; this.stateNames.push(v.state); this.stateIdx.set(v.state, si); }
      st[i] = si;
      i++;
    }
    for (let k = 0; k < N; k++) { if (!sim.net.nodes[k].phases.length) continue; const s = sim.nodeState(k); ph[k] = s.phase; sg[k] = s.stage; }
    this.frames.push({ tick: sim.tick, n, buf });
    this.bytes += buf.byteLength;
    // over the budget: the oldest go (spliced in batches, so dropping stays cheap)
    while (this.bytes > this.budgetBytes && this.head < this.frames.length - 1) { this.bytes -= this.frames[this.head].buf.byteLength; this.head++; }
    if (this.head > 1024) { this.frames.splice(0, this.head); this.head = 0; }
  }
  private flat: boolean | null = null;
  /** vehicles whose fixed details are kept already (by id) */
  private seen = new Uint8Array(1024);
  private flatNet: unknown = null;

  /** the kept step at or just before `tick`, as a snapshot the page's mirror can show (vehicles and lights) */
  frameAt(tick: number, sim: Sim): Snapshot | null {
    if (this.frames.length - this.head === 0) return null;
    let lo = this.head, hi = this.frames.length - 1;
    if (tick <= this.frames[lo].tick) hi = lo;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.frames[m].tick <= tick) lo = m; else hi = m - 1; }
    const f = this.frames[lo], n = f.n, N = sim.net.nodes.length, C = sim.net.corridors.length, X = sim.net.crossings.length, buf = f.buf;
    const B = sim.net.parking.reduce((k, p) => k + p.bays.length, 0), PB = Math.ceil(B / 8);
    let o = 0;
    const ids = new Int32Array(buf, o, n); o += n * 4;
    const xy = new Float32Array(buf, o, n * 2); o += n * 8;
    const rs = new Int32Array(buf, o, C); o += C * 4;
    const hd = new Int16Array(buf, o, n); o += n * 2;
    const ph = new Int16Array(buf, o, N); o += N * 2;
    const vv = new Uint8Array(buf, o, n); o += n;
    const v0 = new Uint8Array(buf, o, n); o += n;
    const bl = new Int8Array(buf, o, n); o += n;
    const lv = new Int8Array(buf, o, n); o += n;
    const zz = new Int8Array(buf, o, n); o += n;
    const st = new Uint8Array(buf, o, n); o += n;
    const cl = new Uint8Array(buf, o, n); o += n;
    const sg = new Int8Array(buf, o, N); o += N;
    const rv = new Uint8Array(buf, o, C * 4); o += C * 4;
    const pk = new Uint8Array(buf, o, PB); o += PB;
    const xp = new Uint8Array(buf, o, X * 3);
    const parked = B ? Uint8Array.from({ length: B }, (_, i) => (pk[i >> 3] >> (i & 7)) & 1) : undefined;
    const crossPeds = X ? Float32Array.from({ length: X * 3 }, (_, i) => (i % 3 === 2 ? xp[i] / 255 : xp[i])) : undefined;
    const rev: RevView[] = Array.from({ length: C }, (_, k) => ({
      state: (rv[k * 4] & 15) as RevStateCode, hold: HOLDS[rv[k * 4] >> 4] ?? null, t: (f.tick - rs[k]) * DT,
      inside: rv[k * 4 + 1], density: [rv[k * 4 + 2], rv[k * 4 + 3]] as [number, number],
    }));
    const outIds = Int32Array.from(ids), kinds = new Uint8Array(n), tints = new Uint8Array(n), states = Uint16Array.from(st), geo = new Float32Array(n * G);
    let cars = 0, trucks = 0, buses = 0;
    for (let i = 0; i < n; i++) {
      const fx = this.fixed.get(ids[i]) ?? { kind: 0, tint: 0, len: 4.6, width: 1.9 }, a = (hd[i] / 32767) * Math.PI, g = i * G;
      kinds[i] = fx.kind; tints[i] = fx.tint;
      if (fx.kind === 0) cars++; else if (fx.kind === 1) trucks++; else buses++;
      const chord = cl[i] / 10;
      geo[g] = xy[i * 2]; geo[g + 1] = xy[i * 2 + 1]; geo[g + 2] = xy[i * 2] - Math.cos(a) * chord; geo[g + 3] = xy[i * 2 + 1] - Math.sin(a) * chord;
      geo[g + 4] = vv[i] / 4; geo[g + 5] = v0[i] / 4; geo[g + 6] = fx.len; geo[g + 7] = fx.width; geo[g + 8] = bl[i]; geo[g + 9] = lv[i]; geo[g + 10] = zz[i] / 20;
    }
    let sp = 0, stopped = 0; for (let i = 0; i < n; i++) { sp += vv[i] / 4; if (vv[i] < 2) stopped++; }
    return {
      tick: f.tick,
      stats: { ...sim.stats, history: sim.stats.history.slice(), count: n, cars, trucks, buses, avgSpeed: n ? (sp / n) * 3.6 : 0, stopped: n ? stopped / n : 0 },
      ids: outIds, kinds, tints, states, stateNames: this.stateNames.slice(), geo,
      phase: Int16Array.from(ph), stage: Int8Array.from(sg), stageT: new Float32Array(N), occupied: new Int16Array(N), cycleAt: new Float32Array(N).fill(NaN),
      waiting: Float32Array.from(sim.net.stops, s => s.waiting), events: [], resetEvents: false, peds: [],
      ...(C ? { rev } : {}),
      ...(parked ? { parked } : {}), ...(crossPeds ? { crossPeds } : {}),
    };
  }
}
