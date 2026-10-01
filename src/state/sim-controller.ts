/**
 * The open plan's compiled network and its running simulation. The simulation runs in a Web
 * Worker (src/state/sim.worker.ts) so large plans don't make the page stutter; `sim` is a mirror
 * that answers the renderers' and panels' questions from the worker's latest snapshot.
 * Recompiles whenever the network changes; any edit resets the simulation (vehicles are cleared)
 * because lanes and junctions may have moved.
 */
import { compile, getShape, putShapes, type Compiled, type JunctionShape } from "@/engine/compile";
import { SimMirror, type Snapshot, type Watch } from "@/engine/sim/mirror";
import type { Network } from "@/engine/types";
import { network$, settings$, stats$, ui } from "./store";
import type { ToWorker } from "./sim.worker";
import type { RecordingInfo } from "@/engine/sim/recorder";

export type TestResult = { id: number } | { error: string };

/** a worker's load over the last second: share of time working, time per step, heap in MB (Chrome only) */
export interface WorkerLoad { busy: number; stepMs: number; heapMB: number | null }

class SimController {
  compiled: Compiled = compile({ version: 1, nodes: [], links: [], stops: [], lines: [] });
  sim: SimMirror | null = null;
  /** bumps whenever geometry changes, so renderers can rebuild caches */
  version = 0;
  private worker: Worker | null = null;
  /** network generation: snapshots of an older network are ignored */
  private gen = 0;
  private fresh = false;
  private lastStatsAt = 0;
  /** the simulation speed actually reached (× real time; 0 while paused) */
  rate = 0;
  /** the simulation worker's load (last second) */
  simLoad: WorkerLoad = { busy: 0, stepMs: 0, heapMB: null };
  /** the outline worker: working now, and its last job */
  outlineLoad = { busy: false, lastMs: 0, heapMB: null as number | null };
  private started = false;

  private post(m: ToWorker) { this.worker?.postMessage(m); }
  private pending = new Map<number, (r: TestResult) => void>();
  private req = 0;

  /** send one test vehicle from an entry point to an exit (starts the simulation if needed) */
  sendTest(from: string, to: string, lane: number | null): Promise<TestResult> {
    this.ensureSim();
    const req = ++this.req;
    return new Promise(res => { this.pending.set(req, res); this.post({ type: "test", from, to, lane, req }); });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e: MessageEvent<{ type: "snapshot"; gen: number; snap: Snapshot; rate?: number; load?: WorkerLoad; rec?: RecordingInfo } | { type: "replayFrame"; gen: number; req: number; snap: Snapshot; rec: RecordingInfo } | { type: "test"; req: number; result: TestResult }>) => {
      if (e.data.type === "test") { const cb = this.pending.get(e.data.req); this.pending.delete(e.data.req); cb?.(e.data.result); return; }
      if (e.data.gen !== this.gen || !this.sim) return;
      if (e.data.rec) this.rec = e.data.rec;
      if (e.data.type === "replayFrame") {
        // a kept step, while replaying (the newest asked for wins)
        if (this.replay && e.data.req === this.replayReq) { this.sim.apply(e.data.snap); this.replay.tick = e.data.snap.tick; this.replayBusy = false; this.fresh = true; stats$.next(this.sim.stats); }
        return;
      }
      // (while replaying, the live steps aren't shown)
      if (this.replay) { this.rate = e.data.rate ?? 0; return; }
      this.sim.apply(e.data.snap);
      this.rate = e.data.rate ?? 0;
      if (e.data.load) this.simLoad = e.data.load;
      this.fresh = true;
      const now = performance.now();
      if (now - this.lastStatsAt > 250) { this.lastStatsAt = now; stats$.next(this.sim.stats); }
    };
    network$.subscribe(net => this.rebuild(net));
    settings$.subscribe(s => this.post({ type: "settings", settings: { ...s } }));
    ui.subscribe("sim/epoch", () => this.reset());
    ui.subscribe("eventLog", () => this.applyLog());
    ui.subscribe("record", () => { const on = ui.getValue().record; this.post({ type: "record", on }); if (!on && this.replay) this.goLive(); });
    ui.subscribe("sim", () => {
      const s = ui.getValue().sim;
      if (s.running && this.replay) this.goLive(); // (running again: back to the live simulation)
      this.post({ type: "run", running: s.running, speed: s.speed });
    });
    for (const path of ["selection", "display", "view"] as const) ui.subscribe(path, () => this.applyWatch());
    const s = ui.getValue().sim;
    this.post({ type: "run", running: s.running, speed: s.speed });
    this.applyLog(); this.applyWatch();
    this.post({ type: "record", on: ui.getValue().record });
  }

  private outlineWorker: Worker | null = null;
  private shapeReq = 0;
  /** junction outlines the page doesn't have yet: worked out by a worker, then patched in */
  private requestShapes(net: Network) {
    const pending = this.compiled.pendingShapes;
    if (!pending.length || typeof Worker === "undefined") return;
    if (!this.outlineWorker) {
      this.outlineWorker = new Worker(new URL("./outline.worker.ts", import.meta.url), { type: "module" });
      this.outlineWorker.onmessage = (e: MessageEvent<{ req: number; shapes: [string, JunctionShape][]; ms: number; heapMB: number | null }>) => {
        this.outlineLoad = { busy: e.data.req !== this.shapeReq, lastMs: e.data.ms, heapMB: e.data.heapMB };
        putShapes(e.data.shapes);
        if (e.data.req !== this.shapeReq) return; // the plan has changed since: the next answer patches it
        let changed = false;
        for (const p of this.compiled.pendingShapes) {
          const shape = getShape(p.key), n = this.compiled.nodes[p.node];
          if (shape && n) { n.polygon = shape.polygon; n.surface = shape.surface; changed = true; }
        }
        this.compiled.pendingShapes = [];
        if (changed) this.version++; // (the canvases redraw when the version changes)
      };
    }
    this.outlineLoad = { ...this.outlineLoad, busy: true };
    this.outlineWorker.postMessage({ req: ++this.shapeReq, network: net, keys: pending.map(p => p.key) });
  }

  private rebuild(net: Network) {
    // junction outlines already worked out are used; the others are drawn simply until a worker has them
    this.compiled = compile(net, { outlines: "cached" });
    this.requestShapes(net);
    this.version++;
    this.gen++;
    this.post({ type: "load", network: net, settings: settings$.getValue(), gen: this.gen });
    this.forgetLoggedVehicles();
    if (this.sim) this.sim = new SimMirror(this.compiled);
    stats$.next(null);
    this.applyWatch();
  }

  /** push the event-log choice from the UI into the running simulation */
  applyLog() {
    const cfg = ui.getValue().eventLog;
    this.post({ type: "log", all: cfg.all, nodes: [...cfg.nodes], links: [...(cfg.links ?? [])], vehicles: [...(cfg.vehicles ?? [])] });
  }

  /** vehicle numbers start again with new traffic: stop recording the old ones */
  private forgetLoggedVehicles() {
    const cfg = ui.getValue().eventLog;
    if (cfg.vehicles?.length) cfg.vehicles = [];
  }

  /** tell the worker what the page shows in detail: the selected vehicle, the selected junction */
  private applyWatch() {
    const u = ui.getValue(), sel = u.selection;
    const node = sel?.kind === "node" ? this.compiled.nodeById.get(sel.id)?.idx : undefined;
    const watch: Watch = {
      vehicle: sel?.kind === "vehicle" ? Number(sel.id) : null,
      nodes: node !== undefined ? [node] : [],
      reservations: u.display.reservations && u.view === "2d",
    };
    this.post({ type: "watch", watch });
  }

  /** the steps kept in memory, for replaying them (ticks from..to) */
  rec: RecordingInfo = { from: 0, to: 0, frames: 0, bytes: 0 };
  /** replaying: the step shown (null = live) */
  replay: { tick: number } | null = null;
  private replayReq = 0;
  private replayBusy = false;
  /** show the kept step at `tick` (pauses the live simulation; one request at a time, the newest wins) */
  replayAt(tick: number) {
    if (!this.replay) { this.replay = { tick }; ui.getValue().sim.running = false; }
    this.replay.tick = tick;
    this.replayBusy = true;
    this.post({ type: "replay", tick, req: ++this.replayReq });
  }
  /** is a replayed step still on its way */
  get replayPending() { return this.replayBusy; }
  /** back to the live simulation (where it was: replaying doesn't change it) */
  goLive() {
    this.replay = null; this.replayBusy = false;
    this.applyWatch(); // (asks for a fresh live snapshot)
  }

  reset() {
    this.replay = null; this.replayBusy = false; this.rec = { from: 0, to: 0, frames: 0, bytes: 0 };
    this.sim = null;
    this.post({ type: "reset" });
    this.forgetLoggedVehicles();
    stats$.next(null);
  }

  ensureSim(): SimMirror {
    if (!this.sim) { this.sim = new SimMirror(this.compiled); this.post({ type: "start" }); }
    return this.sim;
  }

  clearEvents() {
    if (this.sim) this.sim.events = [];
    this.post({ type: "clearEvents" });
  }

  /** called every animation frame: returns true if a new snapshot arrived since the last call */
  advance(): boolean {
    if (ui.getValue().sim.running) this.ensureSim();
    const f = this.fresh;
    this.fresh = false;
    return f;
  }
}

export const simController = new SimController();
