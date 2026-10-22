/**
 * The spatial driving experiment's own worker (T213): runs its engine (src/lib/experiments/spatial-roundabout) at the speed
 * asked for and posts what the page draws after each go: the cars, the spatial ones' rays and goals, the stats, and the car
 * picked on the page (ticket #59: what it is doing and the path it wants to take). Separate
 * from the main engine's worker (sketch-sim.worker.ts), loaded only when the experiment's switch is on.
 */
import type { Sketch } from "@/lib/lane-sketch";
import { SpatialSim, type SpatialCarInfo, type SpatialParams, type SpatialStats } from "@/lib/experiments/spatial-roundabout/engine";

export type ToSpatialWorker =
  | { type: "init"; sketch: Sketch; params: SpatialParams }
  | { type: "run"; running: boolean; speed: number }
  | { type: "select"; id: number | null };
/** `junction`: the sketch has a junction the experiment drives; `car`: the car picked, as it is now (null: none, or it has left) */
export type SpatialFrame = { type: "frame"; t: number; poses: ReturnType<SpatialSim["poses"]>; stats: SpatialStats; junction: boolean; car: SpatialCarInfo | null };

let sim: SpatialSim | null = null, running = false, speed = 1, last = performance.now(), owed = 0, timer: ReturnType<typeof setTimeout> | null = null, picked: number | null = null;
const post = (m: SpatialFrame) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const frame = () => { if (sim) post({ type: "frame", t: sim.t, poses: sim.poses(), stats: sim.stats(), junction: !!sim.surface, car: picked !== null ? sim.inspect(picked) : null }); };

/** one go: the simulated time owed (real time times the speed asked for) stepped in tenths, for at most BUDGET ms */
const BUDGET = 25, STEP = 0.1;
function tick() {
  timer = null;
  if (!sim || !running) return;
  const now = performance.now();
  owed = Math.min(Math.max(1, speed), owed + ((now - last) / 1000) * speed);
  last = now;
  const t0 = sim.t;
  while (owed >= STEP - 1e-9 && performance.now() - now < BUDGET) { sim.step(STEP); owed -= STEP; }
  if (sim.t !== t0) frame();
  timer = setTimeout(tick, owed >= STEP ? 0 : 16);
}

self.onmessage = (e: MessageEvent<ToSpatialWorker>) => {
  const m = e.data;
  if (m.type === "init") { sim = new SpatialSim(m.sketch, m.params); owed = 0; picked = null; frame(); return; }
  if (m.type === "select") { picked = m.id; frame(); return; }
  speed = m.speed;
  if (m.running && !running) { running = true; last = performance.now(); owed = 0; if (!timer) timer = setTimeout(tick, 0); }
  if (!m.running) { running = false; frame(); }
};
