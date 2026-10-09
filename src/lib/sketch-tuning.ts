/**
 * The V2 (lane sketch) simulation's settings, as V1's simulation settings (engine/params.ts) but only those
 * the lane sketch's cars have: how drivers speed up, brake and keep their distance, how long they wait at
 * lines and to be let in, the trucks among them, and the pedestrians' timings. Saved with the plan (`sketch.traffic.tune`, only those
 * changed); framework-free.
 */

export type TuneKey = "accel" | "brake" | "headway" | "minGap" | "speedSpread" | "patience" | "yieldGap" | "yieldSpeed" | "pedWalk" | "pedYield" | "pedSpeed"
  | "rerouteAfter" | "truckShare" | "truckLength" | "truckAccel" | "truckHeadway" | "truckSpeed";
export type Tuning = Record<TuneKey, number>;
export type TuneGroup = "Drivers" | "Trucks" | "Junctions" | "Pedestrians";
export interface TuneInfo { key: TuneKey; group: TuneGroup; label: string; unit: string; min: number; max: number; step: number; def: number; help: string }

export const TUNE_GROUPS: TuneGroup[] = ["Drivers", "Trucks", "Junctions", "Pedestrians"];
export const TUNING: TuneInfo[] = [
  { key: "accel", group: "Drivers", label: "Acceleration", unit: "m/s²", min: 1, max: 4, step: 0.1, def: 1.5, help: "How hard cars speed up when the road is clear." },
  { key: "brake", group: "Drivers", label: "Comfortable braking", unit: "m/s²", min: 1, max: 5, step: 0.1, def: 2, help: "How hard cars brake when they see a stop coming (they brake harder if they must)." },
  { key: "headway", group: "Drivers", label: "Time gap to the car ahead", unit: "s", min: 0.8, max: 3, step: 0.1, def: 1.2, help: "The gap in time a driver keeps on the move. Shorter gaps carry more traffic." },
  { key: "minGap", group: "Drivers", label: "Gap when stopped", unit: "m", min: 2, max: 6, step: 0.1, def: 2, help: "Distance kept to the car ahead in a queue (at least 2 m: closer, cars queued on tight bends would touch)." },
  { key: "speedSpread", group: "Drivers", label: "Speeds vary by", unit: "%", min: 0, max: 30, step: 1, def: 0, help: "Each car wants a speed within this much of the speed set (some slower, some faster), so faster ones catch up and overtake." },
  { key: "truckShare", group: "Trucks", label: "Share of trucks", unit: "%", min: 0, max: 50, step: 1, def: 0, help: "Of the vehicles coming in, this many are trucks: longer, slower to speed up, keeping a longer gap." },
  { key: "truckLength", group: "Trucks", label: "Truck length", unit: "m", min: 7, max: 18, step: 0.5, def: 12, help: "How long a truck is (a car is 4.5 m)." },
  { key: "truckAccel", group: "Trucks", label: "Truck acceleration", unit: "m/s²", min: 1, max: 2.5, step: 0.1, def: 1, help: "How hard trucks speed up when the road is clear." },
  { key: "truckHeadway", group: "Trucks", label: "Truck time gap", unit: "s", min: 1, max: 4, step: 0.1, def: 1.8, help: "The gap in time a truck driver keeps to the vehicle ahead." },
  { key: "truckSpeed", group: "Trucks", label: "Truck speed", unit: "%", min: 50, max: 100, step: 5, def: 90, help: "The speed trucks want, as a share of the limit." },
  { key: "patience", group: "Junctions", label: "Let in after waiting", unit: "s", min: 2, max: 30, step: 1, def: 6, help: "A car kept waiting this long to join a queued lane is let in by the next car along (zip merging)." },
  { key: "yieldGap", group: "Junctions", label: "Gap wanted at a give-way line", unit: "s", min: 0.5, max: 5, step: 0.1, def: 1.5, help: "A car at a stop or yield line goes when it would be through this long before the next car gets there." },
  { key: "yieldSpeed", group: "Junctions", label: "Speed up to a yield line", unit: "m/s", min: 1, max: 12, step: 0.5, def: 4, help: "How fast cars come up to a yield line (they go on without stopping if it is clear)." },
  { key: "rerouteAfter", group: "Junctions", label: "Look for another way after", unit: "s", min: 10, max: 300, step: 5, def: 40, help: "A driver kept waiting this long where it turns off looks for another way to where it is going (once at each place)." },
  { key: "pedWalk", group: "Pedestrians", label: "Walk time at a red", unit: "s", min: 3, max: 20, step: 1, def: 8, help: "At lights: seconds at the start of the traffic's red in which people may step onto the crossing." },
  { key: "pedYield", group: "Pedestrians", label: "Gap left for cars at zebras", unit: "s", min: 0, max: 20, step: 1, def: 5, help: "At zebras: after a group crosses, seconds before the next may step out." },
  { key: "pedSpeed", group: "Pedestrians", label: "Walking speed", unit: "m/s", min: 0.6, max: 2, step: 0.1, def: 1.2, help: "How fast people cross." },
];
export const DEFAULT_TUNING: Tuning = Object.fromEntries(TUNING.map(t => [t.key, t.def])) as Tuning;

/** every setting: those changed, the defaults for the rest */
export const resolveTuning = (t?: Partial<Tuning> | null): Tuning => ({ ...DEFAULT_TUNING, ...(t ?? {}) });

/** only the settings that differ from their defaults, each within its range (null: none changed) */
export function sanitizeTuning(raw: unknown): Partial<Tuning> | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>, out: Partial<Tuning> = {};
  for (const t of TUNING) {
    const v = o[t.key];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const x = Math.min(t.max, Math.max(t.min, v));
    if (x !== t.def) out[t.key] = x;
  }
  return Object.keys(out).length ? out : null;
}
