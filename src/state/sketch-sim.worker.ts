/// <reference lib="webworker" />
/**
 * The lane sketch's cars off the page's main thread (see sketch-sim-client.ts): owns the SketchSim,
 * steps it at the speed asked for, and posts what the page draws and shows after every step: the cars,
 * the stats, the traffic lights, the car watched, the replay's range. Asked, it answers with the
 * cars as they were at a time (replay), the report to copy, a moment to copy, a car's last 10 s.
 */
import { SketchSim, type SimParams } from "@/lib/lane-sketch-sim";
import type { Sketch } from "@/lib/lane-sketch";

export type ToSimWorker =
  | { type: "init"; sketch: Sketch; params: SimParams }
  | { type: "sketch"; sketch: Sketch }
  | { type: "params"; params: SimParams }
  | { type: "reset" }
  | { type: "run"; running: boolean; speed: number }
  | { type: "watch"; id: number | null }
  | { type: "replay"; t: number; req: number }
  | { type: "report"; req: number }
  | { type: "moment"; t: number; box: Parameters<SketchSim["moment"]>[1]; req: number }
  | { type: "car"; id: number; req: number };

export interface SimFrame {
  type: "frame";
  t: number;
  poses: ReturnType<SketchSim["poses"]>;
  /** every quarter of a second (and on changes): the stats (they take a while on big sketches) */
  stats: ReturnType<SketchSim["stats"]> | null;
  replayRange: ReturnType<SketchSim["replayRange"]>;
  signals: { junction: string; phase: number; stage: "green" | "amber" | "allRed" }[];
  /** the car watched, as `inspect` gives it (null: gone, or none watched) */
  watched: { id: number; info: ReturnType<SketchSim["inspect"]> } | null;
  /** simulated seconds per real second reached (less than asked when steps are slow) */
  rate: number;
}
export type FromSimWorker =
  | SimFrame
  | { type: "replay"; req: number; frame: ReturnType<SketchSim["replayAt"]> }
  | { type: "report"; req: number; report: ReturnType<SketchSim["report"]> }
  | { type: "moment"; req: number; moment: ReturnType<SketchSim["moment"]> | null }
  | { type: "car"; req: number; frames: ReturnType<SketchSim["carFrames"]>; events: SketchSim["log"] };

let sim: SketchSim | null = null, running = false, speed = 1, watch: number | null = null;
let last = performance.now(), lastStats = 0, timer: ReturnType<typeof setTimeout> | null = null;
let rate = 0, rateSim = 0, rateSince = performance.now();

const post = (m: FromSimWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);

function frame(withStats: boolean) {
  if (!sim) return;
  const now = performance.now();
  const stats = withStats || now - lastStats > 250 ? sim.stats() : null;
  if (stats) lastStats = now;
  post({
    type: "frame", t: sim.t, poses: sim.poses(), stats, replayRange: sim.replayRange(),
    signals: sim.signals.map(c => ({ junction: c.plan.junction, phase: c.phase, stage: c.stage })),
    watched: watch !== null ? { id: watch, info: sim.inspect(watch) } : null, rate,
  });
}

/**
 * One go: the simulated time owed since the last (the real time passed, times the speed asked for) stepped
 * in tenths, for at most `BUDGET` ms, then a frame posted, so frames keep coming however slow a step is.
 * What a go can't step stays owed (up to a second of it: a sim slower than asked falls behind, the page doesn't).
 */
const BUDGET = 25;
let owed = 0;
function tick() {
  timer = null;
  if (!sim || !running) return;
  const now = performance.now();
  owed = Math.min(Math.max(1, speed), owed + ((now - last) / 1000) * speed);
  last = now;
  const t0 = sim.t;
  while (owed > 1e-6 && performance.now() - now < BUDGET) { const h = Math.min(0.1, owed); sim.step(h); owed -= h; }
  rateSim += sim.t - t0;
  if (now - rateSince > 1000) { rate = rateSim / ((now - rateSince) / 1000); rateSim = 0; rateSince = now; }
  frame(false);
  timer = setTimeout(tick, owed > 0.1 ? 0 : 16);
}

self.onmessage = (e: MessageEvent<ToSimWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "init": sim = new SketchSim(m.sketch, m.params); frame(true); break;
    case "sketch": sim?.setSketch(m.sketch); frame(true); break;
    case "params": sim?.setParams(m.params); frame(true); break;
    case "reset": sim?.reset(); frame(true); break;
    case "run":
      speed = m.speed;
      if (m.running && !running) { running = true; last = performance.now(); owed = 0; rateSince = last; rateSim = 0; if (!timer) timer = setTimeout(tick, 0); }
      if (!m.running) { running = false; rate = 0; frame(true); }
      break;
    case "watch": watch = m.id; frame(false); break;
    case "replay": post({ type: "replay", req: m.req, frame: sim?.replayAt(m.t) ?? null }); break;
    case "report": if (sim) post({ type: "report", req: m.req, report: sim.report() }); break;
    case "moment": post({ type: "moment", req: m.req, moment: sim?.moment(m.t, m.box) ?? null }); break;
    case "car": if (sim) post({ type: "car", req: m.req, frames: sim.carFrames(m.id), events: sim.log.filter(x => x.car === m.id || x.with === m.id).slice(-60) }); break;
  }
};
