/// <reference lib="webworker" />
/**
 * Runs the open plan's traffic off the page's main thread (see src/state/sim-controller.ts).
 * Owns the Sim, steps it at the chosen speed, and posts snapshots (src/engine/sim/mirror.ts).
 */
import { compile, type Compiled } from "@/engine/compile";
import { DT, Sim } from "@/engine/sim";
import { SnapshotWriter, type Watch } from "@/engine/sim/mirror";
import { Recorder } from "@/engine/sim/recorder";
import type { Network, PlanSettings } from "@/engine/types";

export type ToWorker =
  | { type: "load"; network: Network; settings: PlanSettings; gen: number }
  | { type: "settings"; settings: PlanSettings }
  | { type: "start" }
  | { type: "reset" }
  | { type: "run"; running: boolean; speed: number }
  | { type: "log"; all: boolean; nodes: string[]; links: string[]; vehicles: number[] }
  | { type: "watch"; watch: Watch }
  | { type: "clearEvents" }
  | { type: "test"; from: string; to: string; lane: number | null; req: number }
  | { type: "replay"; tick: number; req: number }
  | { type: "record"; on: boolean };

let compiled: Compiled | null = null, settings: PlanSettings | null = null, sim: Sim | null = null, gen = 0;
let running = false, speed = 3, acc = 0, last = performance.now(), lastPost = 0, dirty = false;
/** the speed actually reached (simulated seconds per real second, smoothed): less than asked when a step is slow */
let rate = 0, rateTicks = 0, rateSince = performance.now();
/** this worker's load, over the last second: share of the time spent working, time per step, heap (Chrome) */
let busyMs = 0, stepMs = 0, stepN = 0, load = { busy: 0, stepMs: 0, heapMB: null as number | null };
const heapMB = () => { const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory; return m ? m.usedJSHeapSize / 1048576 : null; };
let log = { all: false, nodes: [] as string[], links: [] as string[], vehicles: [] as number[] };
let watch: Watch = { vehicle: null, nodes: [], reservations: false };
const writer = new SnapshotWriter();
/** every step kept, for replaying it on the page */
const recorder = new Recorder();
let recording = true;

function applyLog() {
  if (!sim || !compiled) return;
  sim.logAll = log.all;
  sim.logNodes = new Set(log.nodes.map(id => compiled!.nodeById.get(id)?.idx).filter((i): i is number => i !== undefined));
  sim.logLinks = new Set(log.links);
  sim.logVehicles = new Set(log.vehicles);
}
function startSim() {
  if (!compiled || !settings) return;
  sim = new Sim(compiled, settings); acc = 0; writer.reset(); recorder.clear(); applyLog(); dirty = true;
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "load": {
      const had = !!sim;
      // (the simulation doesn't need junction outlines: skip the slow part)
      compiled = compile(m.network, { outlines: false }); settings = m.settings; gen = m.gen; sim = null; recorder.clear();
      if (had) startSim();
      break;
    }
    case "settings": settings = m.settings; if (sim) sim.settings = { ...m.settings }; break;
    case "start": if (!sim) startSim(); break;
    case "reset": sim = null; acc = 0; recorder.clear(); break;
    case "record": recording = m.on; if (!recording) recorder.clear(); dirty = true; break;
    case "replay": {
      // a kept step, shown instead of the live one (the page asks for each step it shows)
      const snap = sim ? recorder.frameAt(m.tick, sim) : null;
      if (snap) self.postMessage({ type: "replayFrame", gen, req: m.req, snap, rec: recorder.info() });
      break;
    }
    case "run": running = m.running; speed = m.speed; break;
    case "log": log = { all: m.all, nodes: m.nodes, links: m.links, vehicles: m.vehicles }; applyLog(); break;
    case "watch": watch = m.watch; dirty = true; break;
    case "clearEvents": if (sim) { sim.events.length = 0; writer.reset(); dirty = true; } break;
    case "test": {
      if (!sim) startSim();
      const result = sim ? sim.sendTest(m.from, m.to, m.lane ?? undefined) : { error: "The simulation isn't ready." };
      self.postMessage({ type: "test", req: m.req, result });
      dirty = true;
      break;
    }
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
      const t0 = performance.now();
      sim.step(); if (recording) recorder.record(sim); acc -= DT; moved = true; rateTicks++;
      stepMs += performance.now() - t0; stepN++;
      if (performance.now() - now > 40) { acc = 0; break; } // can't keep up: run slower, don't pile up a backlog
    }
  }
  if (sim && (moved || dirty) && now - lastPost >= 30) {
    const span = (now - rateSince) / 1000;
    if (span >= 1) {
      const r = running ? (rateTicks * DT) / span : 0; rate = rate ? rate * 0.5 + r * 0.5 : r; rateTicks = 0; rateSince = now;
      load = { busy: Math.min(1, busyMs / (span * 1000)), stepMs: stepN ? stepMs / stepN : 0, heapMB: heapMB() };
      busyMs = 0; stepMs = 0; stepN = 0;
    }
    if (!running) rate = 0;
    const { snap, transfer } = writer.write(sim, watch, now);
    self.postMessage({ type: "snapshot", gen, snap, rate, load, rec: recorder.info() }, transfer);
    lastPost = now; dirty = false;
  }
  busyMs += performance.now() - now;
  setTimeout(loop, 4);
}
loop();
