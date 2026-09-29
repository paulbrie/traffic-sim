/// <reference lib="webworker" />
/**
 * Runs the open plan's traffic off the page's main thread (see src/state/sim-controller.ts).
 * Owns the Sim, steps it at the chosen speed, and posts snapshots (src/engine/sim/mirror.ts).
 */
import { compile, type Compiled } from "@/engine/compile";
import { DT, Sim } from "@/engine/sim";
import { SnapshotWriter, type Watch } from "@/engine/sim/mirror";
import type { Network, PlanSettings } from "@/engine/types";

export type ToWorker =
  | { type: "load"; network: Network; settings: PlanSettings; gen: number }
  | { type: "settings"; settings: PlanSettings }
  | { type: "start" }
  | { type: "reset" }
  | { type: "run"; running: boolean; speed: number }
  | { type: "log"; all: boolean; nodes: string[] }
  | { type: "watch"; watch: Watch }
  | { type: "clearEvents" };

let compiled: Compiled | null = null, settings: PlanSettings | null = null, sim: Sim | null = null, gen = 0;
let running = false, speed = 3, acc = 0, last = performance.now(), lastPost = 0, dirty = false;
let log = { all: false, nodes: [] as string[] };
let watch: Watch = { vehicle: null, nodes: [], reservations: false };
const writer = new SnapshotWriter();

function applyLog() {
  if (!sim || !compiled) return;
  sim.logAll = log.all;
  sim.logNodes = new Set(log.nodes.map(id => compiled!.nodeById.get(id)?.idx).filter((i): i is number => i !== undefined));
}
function startSim() {
  if (!compiled || !settings) return;
  sim = new Sim(compiled, settings); acc = 0; writer.reset(); applyLog(); dirty = true;
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "load": {
      const had = !!sim;
      compiled = compile(m.network); settings = m.settings; gen = m.gen; sim = null;
      if (had) startSim();
      break;
    }
    case "settings": settings = m.settings; if (sim) sim.settings = { ...m.settings }; break;
    case "start": if (!sim) startSim(); break;
    case "reset": sim = null; acc = 0; break;
    case "run": running = m.running; speed = m.speed; break;
    case "log": log = { all: m.all, nodes: m.nodes }; applyLog(); break;
    case "watch": watch = m.watch; dirty = true; break;
    case "clearEvents": if (sim) { sim.events.length = 0; writer.reset(); dirty = true; } break;
  }
};

/** step the simulation at the chosen speed (at most ~40 ms of work per slice) and post snapshots */
function loop() {
  const now = performance.now(), dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  let moved = false;
  if (sim && running) {
    acc += dt * speed;
    while (acc >= DT) {
      sim.step(); acc -= DT; moved = true;
      if (performance.now() - now > 40) { acc = 0; break; } // can't keep up: run slower, don't pile up a backlog
    }
  }
  if (sim && (moved || dirty) && now - lastPost >= 30) {
    const { snap, transfer } = writer.write(sim, watch, now);
    self.postMessage({ type: "snapshot", gen, snap }, transfer);
    lastPost = now; dirty = false;
  }
  setTimeout(loop, 4);
}
loop();
