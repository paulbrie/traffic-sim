/**
 * The open plan's compiled network and its running simulation. The simulation runs in a Web
 * Worker (src/state/sim.worker.ts) so large plans don't make the page stutter; `sim` is a mirror
 * that answers the renderers' and panels' questions from the worker's latest snapshot.
 * Recompiles whenever the network changes; any edit resets the simulation (vehicles are cleared)
 * because lanes and junctions may have moved.
 */
import { compile, type Compiled } from "@/engine/compile";
import { SimMirror, type Snapshot, type Watch } from "@/engine/sim/mirror";
import type { Network } from "@/engine/types";
import { network$, settings$, stats$, ui } from "./store";
import type { ToWorker } from "./sim.worker";

export type TestResult = { id: number } | { error: string };

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
    this.worker.onmessage = (e: MessageEvent<{ type: "snapshot"; gen: number; snap: Snapshot } | { type: "test"; req: number; result: TestResult }>) => {
      if (e.data.type === "test") { const cb = this.pending.get(e.data.req); this.pending.delete(e.data.req); cb?.(e.data.result); return; }
      if (e.data.gen !== this.gen || !this.sim) return;
      this.sim.apply(e.data.snap);
      this.fresh = true;
      const now = performance.now();
      if (now - this.lastStatsAt > 250) { this.lastStatsAt = now; stats$.next(this.sim.stats); }
    };
    network$.subscribe(net => this.rebuild(net));
    settings$.subscribe(s => this.post({ type: "settings", settings: { ...s } }));
    ui.subscribe("sim/epoch", () => this.reset());
    ui.subscribe("eventLog", () => this.applyLog());
    ui.subscribe("sim", () => { const s = ui.getValue().sim; this.post({ type: "run", running: s.running, speed: s.speed }); });
    for (const path of ["selection", "display", "view"] as const) ui.subscribe(path, () => this.applyWatch());
    const s = ui.getValue().sim;
    this.post({ type: "run", running: s.running, speed: s.speed });
    this.applyLog(); this.applyWatch();
  }

  private rebuild(net: Network) {
    this.compiled = compile(net);
    this.version++;
    this.gen++;
    this.post({ type: "load", network: net, settings: settings$.getValue(), gen: this.gen });
    if (this.sim) this.sim = new SimMirror(this.compiled);
    stats$.next(null);
    this.applyWatch();
  }

  /** push the event-log choice from the UI into the running simulation */
  applyLog() {
    const cfg = ui.getValue().eventLog;
    this.post({ type: "log", all: cfg.all, nodes: [...cfg.nodes], links: [...(cfg.links ?? [])] });
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

  reset() {
    this.sim = null;
    this.post({ type: "reset" });
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
