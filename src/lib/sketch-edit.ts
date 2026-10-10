/**
 * What counts as editing the map (T158: the cars pause for it): a change to the network or its geometry, or to
 * a junction's, sign's or light's settings. Not the run's settings, which people change while watching a run:
 * the traffic (rates, speed, seed, tuning), the journeys, and the demand on the ways in and out (a lane's
 * inRate and outWeight). Compared by reference first (an edit keeps what it doesn't touch), so it's cheap.
 * The same split decides what undo and redo keep as it is (T160: stepBack).
 */
import type { Sketch, SketchLane } from "./lane-sketch";
import { dropDangling } from "./road-lanes";

/** the sketch's top-level fields that are the run's, not the map's */
const RUN_FIELDS = new Set(["traffic", "journeys"]);
/** a lane's fields that are the run's (the demand on a way in or out) */
const RUN_LANE_FIELDS = new Set(["inRate", "outWeight"]);

/** two lanes the same but for their demand */
function sameLaneMap(a: SketchLane, b: SketchLane): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (RUN_LANE_FIELDS.has(k)) continue;
    if ((a as unknown as Record<string, unknown>)[k] !== (b as unknown as Record<string, unknown>)[k]) return false;
  }
  return true;
}

/** has the map changed from `a` to `b` (anything but the run's settings) */
export function mapChanged(a: Sketch, b: Sketch): boolean {
  if (a === b) return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (RUN_FIELDS.has(k)) continue;
    const x = (a as unknown as Record<string, unknown>)[k], y = (b as unknown as Record<string, unknown>)[k];
    if (x === y) continue;
    if (k === "lanes" && Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((l, i) => sameLaneMap(l as SketchLane, y[i] as SketchLane))) continue;
    return true;
  }
  return false;
}

const field = (o: object, k: string) => (o as Record<string, unknown>)[k];
/** `o` with `k` set to `v` (taken off when undefined) */
function withField<T extends object>(o: T, k: string, v: unknown): T {
  const out = { ...o } as Record<string, unknown>;
  if (v === undefined) delete out[k]; else out[k] = v;
  return out as T;
}

/**
 * An undo or redo (T160): back to `target`, a step that had left the sketch as `from`, with `now` the sketch
 * as it is. The map is `target`'s; each of the run's settings (the same split as mapChanged) is `target`'s too
 * unless it changed since `from`: set after the step, it stays as it is now. So undoing a lane moved keeps the
 * traffic set since, and undoing a change of the demand itself (an undoable step) still takes it back. What
 * then names a lane that isn't there (a journey kept from now) lets go.
 */
export function stepBack(target: Sketch, from: Sketch, now: Sketch): Sketch {
  if (now === from) return target;
  let out = target, kept = false;
  for (const k of RUN_FIELDS) if (field(now, k) !== field(from, k)) { out = withField(out, k, field(now, k)); kept ||= k === "journeys"; }
  const nowLane = new Map(now.lanes.map(l => [l.id, l])), fromLane = new Map(from.lanes.map(l => [l.id, l]));
  const lanes = out.lanes.map(l => {
    const n = nowLane.get(l.id), f = fromLane.get(l.id);
    if (!n || n === f) return l;
    let m = l;
    for (const k of RUN_LANE_FIELDS) if (field(n, k) !== (f && field(f, k)) && field(n, k) !== field(m, k)) m = withField(m, k, field(n, k));
    return m;
  });
  if (lanes.some((l, i) => l !== out.lanes[i])) out = { ...out, lanes };
  return kept ? dropDangling(out) : out;
}
