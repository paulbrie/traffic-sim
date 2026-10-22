/**
 * The spatial driving experiment's own worker (T213): runs its engine (src/lib/experiments/spatial-roundabout) at the speed
 * asked for and posts what the page draws after each go: the cars, the spatial ones' rays and goals, the stats, and the car
 * picked on the page (ticket #59: what it is doing and the path it wants to take). It keeps what the cars did for the replay bar
 * (ticket #69): every step's cars, packed small, the last 10 minutes (less if that would take over REPLAY_BYTES), and answers
 * a moment asked for. Separate from the main engine's worker (sketch-sim.worker.ts), loaded only when the experiment's switch is on.
 */
import type { Sketch } from "@/lib/lane-sketch";
import type { ReplayKept } from "@/components/v2/sketch-replay-bar";
import { SpatialSim, type SpatialCarInfo, type SpatialParams, type SpatialStats } from "@/lib/experiments/spatial-roundabout/engine";

export type ToSpatialWorker =
  | { type: "init"; sketch: Sketch; params: SpatialParams }
  | { type: "run"; running: boolean; speed: number }
  | { type: "select"; id: number | null }
  /** the cars at moment `t` of what is kept (answered with a SpatialReplay) */
  | { type: "replay"; t: number };
/** `junction`: the sketch has a junction the experiment drives; `car`: the car picked, as it is now (null: none, or it has left);
 * `kept`: what the replay has */
export type SpatialFrame = { type: "frame"; t: number; poses: ReturnType<SpatialSim["poses"]>; stats: SpatialStats; junction: boolean; car: SpatialCarInfo | null; kept: ReplayKept | null };
/** a car as kept for the replay: its body (middle, direction, length), its speed's share of the limit, and if it was sensing */
export type ReplayPose = { id: number; p: { x: number; y: number }; d: { x: number; y: number }; len: number; share: number; spatial: boolean };
/** the cars at a moment of the replay (`t`: the moment kept nearest the one asked) */
export type SpatialReplay = { type: "replay"; t: number; poses: ReplayPose[] };
export type FromSpatialWorker = SpatialFrame | SpatialReplay;

let sim: SpatialSim | null = null, running = false, speed = 1, last = performance.now(), owed = 0, timer: ReturnType<typeof setTimeout> | null = null, picked: number | null = null;
const post = (m: FromSpatialWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const frame = () => { if (sim) post({ type: "frame", t: sim.t, poses: sim.poses(), stats: sim.stats(), junction: !!sim.surface, car: picked !== null ? sim.inspect(picked) : null, kept: keptRange() }); };

// ---------------------------------------------------------------- the replay
/** kept: this many seconds back at most, in at most this many bytes; each car a moment in PER numbers */
const REPLAY_SECONDS = 600, REPLAY_BYTES = 48 * 1024 * 1024, PER = 8;
let kept: { t: number; data: Float32Array }[] = [], keptBytes = 0, capped = false, limit = 50;
/** this step's cars, packed: id, middle x y, direction x y, length, share of the limit, sensing 1/0 */
function keep() {
  if (!sim) return;
  // (from the cars' bodies, not poses(): those carry every sensing car's rays)
  const vs = sim.vehicles, data = new Float32Array(vs.length * PER), vmax = Math.max(1, (limit || 50) / 3.6);
  vs.forEach((v, i) => { const b = sim!.body(v); data.set([v.id, b.c.x, b.c.y, b.d.x, b.d.y, b.len, v.v / vmax, v.mode === "spatial" ? 1 : 0], i * PER); });
  kept.push({ t: sim.t, data }); keptBytes += data.byteLength;
  // (the oldest dropped: past the time kept, or over the memory it may take (then it says so))
  let drop = 0;
  while (drop < kept.length - 1 && (sim.t - kept[drop].t > REPLAY_SECONDS || keptBytes > REPLAY_BYTES)) { if (keptBytes > REPLAY_BYTES) capped = true; keptBytes -= kept[drop].data.byteLength; drop++; }
  if (drop) kept = kept.slice(drop);
}
const keptRange = (): ReplayKept | null => (kept.length ? { from: kept[0].t, to: kept[kept.length - 1].t, frames: kept.length, bytes: keptBytes, ...(capped ? { capped: true } : {}) } : null);
/** the cars kept nearest moment `t` */
function replayAt(t: number): SpatialReplay | null {
  if (!kept.length) return null;
  let lo = 0, hi = kept.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (kept[mid].t < t) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(kept[lo - 1].t - t) < Math.abs(kept[lo].t - t)) lo--;
  const { t: at, data } = kept[lo], poses: ReplayPose[] = [];
  for (let i = 0; i < data.length; i += PER) poses.push({ id: data[i], p: { x: data[i + 1], y: data[i + 2] }, d: { x: data[i + 3], y: data[i + 4] }, len: data[i + 5], share: data[i + 6], spatial: data[i + 7] === 1 });
  return { type: "replay", t: at, poses };
}

/** one go: the simulated time owed (real time times the speed asked for) stepped in tenths, for at most BUDGET ms */
const BUDGET = 25, STEP = 0.1;
function tick() {
  timer = null;
  if (!sim || !running) return;
  const now = performance.now();
  owed = Math.min(Math.max(1, speed), owed + ((now - last) / 1000) * speed);
  last = now;
  const t0 = sim.t;
  while (owed >= STEP - 1e-9 && performance.now() - now < BUDGET) { sim.step(STEP); keep(); owed -= STEP; }
  if (sim.t !== t0) frame();
  timer = setTimeout(tick, owed >= STEP ? 0 : 16);
}

self.onmessage = (e: MessageEvent<ToSpatialWorker>) => {
  const m = e.data;
  if (m.type === "init") { sim = new SpatialSim(m.sketch, m.params); limit = m.params.speed; owed = 0; picked = null; kept = []; keptBytes = 0; capped = false; keep(); frame(); return; }
  if (m.type === "select") { picked = m.id; frame(); return; }
  if (m.type === "replay") { const r = replayAt(m.t); if (r) post(r); return; }
  speed = m.speed;
  if (m.running && !running) { running = true; last = performance.now(); owed = 0; if (!timer) timer = setTimeout(tick, 0); }
  if (!m.running) { running = false; frame(); }
};
