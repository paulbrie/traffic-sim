/**
 * What counts as editing the map (T158: the cars pause for it): a change to the network or its geometry, or to
 * a junction's, sign's or light's settings. Not the run's settings, which people change while watching a run:
 * the traffic (rates, speed, seed, tuning), the journeys, and the demand on the ways in and out (a lane's
 * inRate and outWeight). Compared by reference first (an edit keeps what it doesn't touch), so it's cheap.
 */
import type { Sketch, SketchLane } from "./lane-sketch";

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
