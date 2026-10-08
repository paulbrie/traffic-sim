/**
 * The lane sketch's cars as the page sees them, run in a worker (sketch-sim.worker.ts): the same
 * things the editor asked a SketchSim for, answered from what the worker last sent (the cars, the
 * stats, the lights, the car watched, the replay range), so drawing never waits for the cars. The
 * replay's frames are asked for and kept as they come; the report and a car's last 10 s are asked
 * for when wanted.
 */
import { signalPlans, SignalController, type Pt, type Sketch } from "@/lib/lane-sketch";
import type { SimParams, SimStats, SketchSim } from "@/lib/lane-sketch-sim";
import type { FromSimWorker, SimFrame, ToSimWorker } from "./sketch-sim.worker";

/** a message without its request number (each kind of message on its own) */
type WithoutReq<T> = T extends unknown ? Omit<T, "req"> : never;

/** half a car's width and its length (as the sim has them), to find the car under a point */
const HALF_W = 0.9;

export class SketchSimClient {
  private worker: Worker;
  t = 0;
  /** simulated seconds per real second reached while running */
  rate = 0;
  /** frames the worker sent a second (how often the cars' places are known) */
  updates = 0;
  private counted = 0;
  private countSince = performance.now();
  /** the traffic lights, as the worker last said they are (with what they were, for the replay) */
  signals: SignalController[] = [];
  private last: SimFrame | null = null;
  // (the frame before, and when each came: the cars are drawn on their way from one to the other)
  private prevPoses = new Map<number, SimFrame["poses"][number]>();
  private prevAt = 0;
  private lastAt = 0;
  private running = false;
  private lastStats: SimStats | null = null;
  private watching: number | null = null;
  private watched: { id: number; info: ReturnType<SketchSim["inspect"]> } | null = null;
  private replays = new Map<number, ReturnType<SketchSim["replayAt"]>>();
  private replayAsked = new Set<number>();
  private lastReplay: ReturnType<SketchSim["replayAt"]> = null;
  private req = 0;
  private waiting = new Map<number, (m: FromSimWorker) => void>();

  /** `onFrame`: something new came in (draw again, update what is shown) */
  constructor(sketch: Sketch, public params: SimParams, public onFrame: () => void) {
    this.worker = new Worker(new URL("./sketch-sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<FromSimWorker>) => this.receive(e.data);
    this.lights(sketch);
    this.send({ type: "init", sketch, params });
  }
  private send(m: ToSimWorker) { this.worker.postMessage(m); }
  /** the lights' controllers, made from the sketch (the worker says which phase each is in) */
  private lights(sk: Sketch) { const old = this.signals; this.signals = signalPlans(sk).map(p => new SignalController(p, old.find(o => o.plan.junction === p.junction))); }

  private receive(m: FromSimWorker) {
    if (m.type === "frame") {
      if (this.last) { this.prevPoses = new Map(this.last.poses.map(c => [c.id, c])); this.prevAt = this.lastAt; }
      this.lastAt = performance.now();
      this.counted++;
      if (this.lastAt - this.countSince >= 1000) { this.updates = (this.counted * 1000) / (this.lastAt - this.countSince); this.counted = 0; this.countSince = this.lastAt; }
      this.last = m; this.t = m.t; this.rate = m.rate;
      if (m.stats) this.lastStats = m.stats;
      if (m.watched) this.watched = m.watched;
      for (const s of m.signals) {
        const c = this.signals.find(x => x.plan.junction === s.junction);
        if (!c || (c.phase === s.phase && c.stage === s.stage)) continue;
        c.phase = s.phase; c.stage = s.stage; c.into = 0;
        c.history.push({ t: m.t, phase: s.phase, stage: s.stage });
        if (c.history.length > 5000) c.history.splice(0, c.history.length - 5000);
      }
      this.onFrame();
      return;
    }
    const done = this.waiting.get(m.req);
    if (done) { this.waiting.delete(m.req); done(m); }
  }
  private ask<T extends FromSimWorker>(m: WithoutReq<Extract<ToSimWorker, { req: number }>>): Promise<T> {
    const req = ++this.req;
    return new Promise(res => { this.waiting.set(req, x => res(x as T)); this.send({ ...m, req } as ToSimWorker); });
  }

  // ---- what the editor asks, as of a SketchSim
  setSketch(sk: Sketch) { this.lights(sk); this.send({ type: "sketch", sketch: sk }); }
  setParams(p: SimParams) { this.params = p; this.send({ type: "params", params: p }); }
  reset() { this.replays.clear(); this.replayAsked.clear(); this.lastReplay = null; for (const c of this.signals) c.reset(); this.send({ type: "reset" }); }
  /** run (at `speed` simulated seconds per real second) or pause */
  run(running: boolean, speed: number) { this.running = running; this.send({ type: "run", running, speed }); }
  /**
   * The cars to draw: while running, each on its way from where it was in the frame before to where it
   * is in the last, as far along as the time since the last frame came is of the time between the two
   * (so they move smoothly at the page's frame rate however often frames come; drawn one frame behind).
   */
  poses(): SimFrame["poses"] {
    const L = this.last;
    if (!L) return [];
    const span = this.lastAt - this.prevAt;
    if (!this.running || !this.prevPoses.size || span <= 0 || span > 2000) return L.poses;
    const k = Math.min(1, (performance.now() - this.lastAt) / span);
    return L.poses.map(c => {
      const a = this.prevPoses.get(c.id);
      if (!a || Math.hypot(c.p.x - a.p.x, c.p.y - a.p.y) > 30) return c;
      const dx = a.d.x + (c.d.x - a.d.x) * k, dy = a.d.y + (c.d.y - a.d.y) * k, n = Math.hypot(dx, dy) || 1;
      return { ...c, p: { x: a.p.x + (c.p.x - a.p.x) * k, y: a.p.y + (c.p.y - a.p.y) * k }, d: { x: dx / n, y: dy / n } };
    });
  }
  stats(): SimStats | null { return this.lastStats; }
  /** the zebras' pedestrians, as the worker last said they are */
  peds(): SimFrame["peds"] { return this.last?.peds ?? []; }
  replayRange() { return this.last?.replayRange ?? null; }
  /** a car to follow: what `inspect` answers for it comes with every frame */
  inspect(id: number): ReturnType<SketchSim["inspect"]> {
    if (this.watching !== id) { this.watching = id; this.send({ type: "watch", id }); return null; }
    return this.watched?.id === id ? this.watched.info : null;
  }
  unwatch() { if (this.watching !== null) { this.watching = null; this.watched = null; this.send({ type: "watch", id: null }); } }
  /** the car under `p` (on its body, or within `tol` metres), from the cars last sent */
  carAt(p: Pt, tol: number): number | null {
    let best: number | null = null, bd = Infinity;
    for (const c of this.poses()) {
      const dx = p.x - c.p.x, dy = p.y - c.p.y, along = Math.abs(dx * c.d.x + dy * c.d.y), side = Math.abs(dx * c.d.y - dy * c.d.x);
      if (along > c.len / 2 + tol || side > HALF_W + tol) continue;
      const dd = Math.hypot(dx, dy);
      if (dd < bd) { bd = dd; best = c.id; }
    }
    return best;
  }
  /** the cars as they were at `t`: kept when asked for before; asked for now otherwise (the last ones had meanwhile) */
  replayAt(t: number): ReturnType<SketchSim["replayAt"]> {
    const k = Math.round(t * 10) / 10;
    if (this.replays.has(k)) return (this.lastReplay = this.replays.get(k)!);
    if (!this.replayAsked.has(k)) {
      this.replayAsked.add(k);
      void this.ask<Extract<FromSimWorker, { type: "replay" }>>({ type: "replay", t }).then(r => {
        this.replays.set(k, r.frame);
        if (this.replays.size > 600) this.replays.delete(this.replays.keys().next().value!);
        this.replayAsked.delete(k);
        this.onFrame();
      });
    }
    return this.lastReplay;
  }
  /** the recorded car under `p` at `t` (from the replay frame kept) */
  replayCarAt(t: number, p: Pt, tol: number): number | null {
    let best: number | null = null, bd = Infinity;
    for (const c of this.replayAt(t)?.cars ?? []) {
      const dx = p.x - c.p.x, dy = p.y - c.p.y, along = Math.abs(dx * c.d.x + dy * c.d.y), side = Math.abs(dx * c.d.y - dy * c.d.x);
      if (along > c.len / 2 + tol || side > HALF_W + tol) continue;
      const dd = Math.hypot(dx, dy);
      if (dd < bd) { bd = dd; best = c.id; }
    }
    return best;
  }
  report() { return this.ask<Extract<FromSimWorker, { type: "report" }>>({ type: "report" }).then(r => r.report); }
  /** the moment `t` as it was, to copy: the cars in `box` (the view), the lights and the events a minute either side */
  moment(t: number, box: Parameters<SketchSim["moment"]>[1]) { return this.ask<Extract<FromSimWorker, { type: "moment" }>>({ type: "moment", t, box }).then(r => r.moment); }
  /** a car's last 10 s and what happened to it */
  car(id: number) { return this.ask<Extract<FromSimWorker, { type: "car" }>>({ type: "car", id }).then(r => ({ frames: r.frames, events: r.events })); }
  terminate() { this.worker.terminate(); }
}
