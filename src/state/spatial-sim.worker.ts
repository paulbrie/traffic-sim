/**
 * The spatial driving experiment's own worker (T213): runs its engine (src/lib/experiments/spatial-roundabout) at the speed
 * asked for and posts what the page draws after each go: the cars, the spatial ones' rays and goals, the stats, and the car
 * picked on the page (ticket #59: what it is doing and the path it wants to take). It keeps what the cars did for the replay bar
 * (ticket #69): every step's cars, packed small, the last 10 minutes (less if that would take over REPLAY_BYTES), and answers
 * a moment asked for. Separate from the main engine's worker (sketch-sim.worker.ts), loaded only when the experiment's switch is on.
 */
import { roadOf, type Sketch } from "@/lib/lane-sketch";
import type { ReplayKept } from "@/components/v2/sketch-replay-bar";
import { SpatialSim, type SpatialCarInfo, type SpatialParams, type SpatialStats } from "@/lib/experiments/spatial-roundabout/engine";

export type ToSpatialWorker =
  | { type: "init"; sketch: Sketch; params: SpatialParams }
  | { type: "run"; running: boolean; speed: number }
  | { type: "select"; id: number | null }
  /** the cars at moment `t` of what is kept, and the one picked's path (answered with a SpatialReplay) */
  | { type: "replay"; t: number; picked: number | null };
/** `junction`: the sketch has a junction the experiment drives; `car`: the car picked, as it is now (null: none, or it has left);
 * `kept`: what the replay has */
export type SpatialFrame = { type: "frame"; t: number; poses: ReturnType<SpatialSim["poses"]>; stats: SpatialStats; junction: boolean; car: SpatialCarInfo | null; kept: ReplayKept | null };
/** a car as kept for the replay: its body (middle, direction, length), its speed's share of the limit, and if it was sensing */
export type ReplayPose = { id: number; p: { x: number; y: number }; d: { x: number; y: number }; len: number; share: number; spatial: boolean };
/** (ticket #69) the car picked as kept at that moment: (sensing) its path as planned (a point every 2 m), what held it, how far
 * off its guide it kept, its guide, its way out's start, the junction and the road out (none of those on a lane) */
export type ReplayCar = { id: number; path: { x: number; y: number }[]; limit: string; offset: number; guide: { x: number; y: number }[] | null; goal: { x: number; y: number } | null; zone: string; out: string };
/** the cars at a moment of the replay (`t`: the moment kept nearest the one asked), and the one picked */
export type SpatialReplay = { type: "replay"; t: number; poses: ReplayPose[]; car: ReplayCar | null };
export type FromSpatialWorker = SpatialFrame | SpatialReplay;

let sim: SpatialSim | null = null, running = false, speed = 1, last = performance.now(), owed = 0, timer: ReturnType<typeof setTimeout> | null = null, picked: number | null = null;
const post = (m: FromSpatialWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m);
const frame = () => { if (sim) post({ type: "frame", t: sim.t, poses: sim.poses(), stats: sim.stats(), junction: !!sim.surface, car: picked !== null ? sim.inspect(picked) : null, kept: keptRange() }); };

// ---------------------------------------------------------------- the replay
/** kept: this many seconds back at most, in at most this many bytes; each car a moment in PER numbers */
const REPLAY_SECONDS = 600, REPLAY_BYTES = 48 * 1024 * 1024, PER = 8;
let kept: { t: number; data: Float32Array; sp: Float32Array }[] = [], keptBytes = 0, capped = false, limit = 50, sketch: Sketch | null = null;
/** (ticket #69) each sensing car's guide, way out and junction, kept once when it takes them (its goal changes) */
let guides: { t: number; id: number; pts: Float32Array | null; goal: [number, number] | null; zone: string; out: string }[] = [];
const goalOf = new Map<number, unknown>();
/** what held a sensing car (its `limit`), packed: kind (0 path end, 1 kerb, 2 a car, 3 one coming, 4 a car at its side), metres, which car */
const KINDS = ["path end", "kerb", "car", "coming", "car (its side)"];
function limitCode(s: string | undefined): [number, number, number] {
  const m = /^(path end|kerb|coming|car \(its side\)|car (\d+)) at ([\d.]+) m$/.exec(s ?? "");
  if (!m) return [0, -1, -1];
  return [m[2] ? 2 : KINDS.indexOf(m[1]), Number(m[3]), m[2] ? Number(m[2]) : -1];
}
/** this step's cars, packed: id, middle x y, direction x y, length, share of the limit, sensing 1/0; and (ticket #69) each
 * sensing car's id, what held it (3), its offset, its path's points (a count, then x y every 2 m, the first 30 m) */
function keep() {
  if (!sim) return;
  // (from the cars' bodies, not poses(): those carry every sensing car's rays)
  const vs = sim.vehicles, data = new Float32Array(vs.length * PER), vmax = Math.max(1, (limit || 50) / 3.6), sp: number[] = [];
  vs.forEach((v, i) => {
    const b = sim!.body(v);
    data.set([v.id, b.c.x, b.c.y, b.d.x, b.d.y, b.len, v.v / vmax, v.mode === "spatial" ? 1 : 0], i * PER);
    if (v.mode !== "spatial") return;
    const path = v.pathPts ?? [], pts: number[] = [];
    for (let k = 0; k < path.length && k <= 60; k += 4) pts.push(path[k].x, path[k].y);
    sp.push(v.id, ...limitCode(v.limit), v.offset ?? 0, pts.length / 2, ...pts);
    if (goalOf.get(v.id) !== v.goal) {
      goalOf.set(v.id, v.goal);
      const g = v.guide?.pts, gp = g ? new Float32Array(Math.ceil(g.length / 2) * 2) : null;
      if (g && gp) for (let k = 0, j = 0; k < g.length; k += 2, j += 2) { gp[j] = g[k].x; gp[j + 1] = g[k].y; }
      const out = v.goal ? (sketch ? roadOf(sketch, v.goal.lane.id)?.name : undefined) ?? `lane ${v.goal.lane.id}` : "";
      guides.push({ t: sim!.t, id: v.id, pts: gp, goal: v.goal ? [v.goal.p.x, v.goal.p.y] : null, zone: v.zone?.name ?? "a junction", out });
      keptBytes += gp?.byteLength ?? 0;
    }
  });
  const spa = Float32Array.from(sp);
  kept.push({ t: sim.t, data, sp: spa }); keptBytes += data.byteLength + spa.byteLength;
  // (the oldest dropped: past the time kept, or over the memory it may take (then it says so))
  let drop = 0;
  while (drop < kept.length - 1 && (sim.t - kept[drop].t > REPLAY_SECONDS || keptBytes > REPLAY_BYTES)) { if (keptBytes > REPLAY_BYTES) capped = true; keptBytes -= kept[drop].data.byteLength + kept[drop].sp.byteLength; drop++; }
  if (drop) kept = kept.slice(drop);
  // (guides of cars gone before what is kept: dropped now and then, each car's newest kept)
  if (drop && Math.round(sim.t * 10) % 600 === 0) {
    const from = kept[0].t, newest = new Map(guides.map((g, i) => [g.id, i]));
    guides = guides.filter((g, i) => { const keep = g.t >= from || newest.get(g.id) === i; if (!keep) keptBytes -= g.pts?.byteLength ?? 0; return keep; });
    const live = new Set(sim.vehicles.map(v => v.id));
    for (const id of goalOf.keys()) if (!live.has(id)) goalOf.delete(id);
  }
}
const keptRange = (): ReplayKept | null => (kept.length ? { from: kept[0].t, to: kept[kept.length - 1].t, frames: kept.length, bytes: keptBytes, ...(capped ? { capped: true } : {}) } : null);
/** the cars kept nearest moment `t`, and car `picked` there */
function replayAt(t: number, picked: number | null): SpatialReplay | null {
  if (!kept.length) return null;
  let lo = 0, hi = kept.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (kept[mid].t < t) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(kept[lo - 1].t - t) < Math.abs(kept[lo].t - t)) lo--;
  const { t: at, data, sp } = kept[lo], poses: ReplayPose[] = [];
  for (let i = 0; i < data.length; i += PER) poses.push({ id: data[i], p: { x: data[i + 1], y: data[i + 2] }, d: { x: data[i + 3], y: data[i + 4] }, len: data[i + 5], share: data[i + 6], spatial: data[i + 7] === 1 });
  let car: ReplayCar | null = null;
  if (picked !== null) for (let i = 0; i < sp.length;) {
    const id = sp[i], n = sp[i + 5];
    if (id === picked) {
      const path = Array.from({ length: n }, (_, k) => ({ x: sp[i + 6 + 2 * k], y: sp[i + 7 + 2 * k] }));
      const kind = sp[i + 1], d = sp[i + 2], by = sp[i + 3], lim = d < 0 ? "" : `${kind === 2 ? `car ${by}` : KINDS[kind]} at ${d.toFixed(1)} m`;
      // (its guide, way out and junction: the newest taken by then)
      let g: (typeof guides)[number] | null = null;
      for (const x of guides) if (x.id === picked && x.t <= at + 1e-6 && (!g || x.t >= g.t)) g = x;
      const gp = g?.pts ? Array.from({ length: g.pts.length / 2 }, (_, k) => ({ x: g!.pts![2 * k], y: g!.pts![2 * k + 1] })) : null;
      car = { id, path, limit: lim, offset: sp[i + 4], guide: gp, goal: g?.goal ? { x: g.goal[0], y: g.goal[1] } : null, zone: g?.zone ?? "a junction", out: g?.out ?? "" };
      break;
    }
    i += 6 + 2 * n;
  }
  return { type: "replay", t: at, poses, car };
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
  if (m.type === "init") { sim = new SpatialSim(m.sketch, m.params); sketch = m.sketch; limit = m.params.speed; owed = 0; picked = null; kept = []; guides = []; goalOf.clear(); keptBytes = 0; capped = false; keep(); frame(); return; }
  if (m.type === "select") { picked = m.id; frame(); return; }
  if (m.type === "replay") { const r = replayAt(m.t, m.picked); if (r) post(r); return; }
  speed = m.speed;
  if (m.running && !running) { running = true; last = performance.now(); owed = 0; if (!timer) timer = setTimeout(tick, 0); }
  if (!m.running) { running = false; frame(); }
};
