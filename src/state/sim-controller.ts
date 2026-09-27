/**
 * Owns the compiled network and the running simulation for the open plan.
 * Recompiles whenever the network changes; any edit resets the simulation
 * (vehicles are cleared) because lanes and junctions may have moved.
 */
import { compile, type Compiled } from "@/engine/compile";
import { DT, Sim } from "@/engine/sim";
import type { Network } from "@/engine/types";
import { network$, settings$, stats$, ui } from "./store";

class SimController {
  compiled: Compiled = compile({ version: 1, nodes: [], links: [], stops: [], lines: [] });
  sim: Sim | null = null;
  /** bumps whenever geometry changes, so renderers can rebuild caches */
  version = 0;
  private acc = 0;
  private lastStatsAt = 0;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    network$.subscribe(net => this.rebuild(net));
    settings$.subscribe(s => { if (this.sim) this.sim.settings = { ...s }; });
    ui.subscribe("sim/epoch", () => this.reset());
    ui.subscribe("eventLog", () => this.applyLog());
  }

  private rebuild(net: Network) {
    this.compiled = compile(net);
    this.version++;
    if (this.sim) { this.sim = new Sim(this.compiled, settings$.getValue()); this.applyLog(); }
    stats$.next(this.sim ? this.sim.stats : null);
  }

  /** push the event-log choice from the UI into the running simulation */
  applyLog() {
    const sim = this.sim;
    if (!sim) return;
    const cfg = ui.getValue().eventLog;
    sim.logAll = cfg.all;
    sim.logNodes = new Set(cfg.nodes.map(id => this.compiled.nodeById.get(id)?.idx).filter((i): i is number => i !== undefined));
  }

  reset() {
    this.sim = null;
    this.acc = 0;
    stats$.next(null);
  }

  ensureSim(): Sim {
    if (!this.sim) { this.sim = new Sim(this.compiled, settings$.getValue()); this.applyLog(); }
    return this.sim;
  }

  /** advance by real-time dt (s) at the configured speed; returns true if anything moved */
  advance(dt: number): boolean {
    const u = ui.getValue();
    if (!u.sim.running) return false;
    const sim = this.ensureSim();
    this.acc += Math.min(0.1, dt) * u.sim.speed;
    let n = 0;
    while (this.acc >= DT && n < 600) { sim.step(); this.acc -= DT; n++; }
    if (n === 600) this.acc = 0;
    const now = performance.now();
    if (now - this.lastStatsAt > 250) { this.lastStatsAt = now; stats$.next({ ...sim.stats, history: sim.stats.history.slice() }); }
    return n > 0;
  }
}

export const simController = new SimController();
