/**
 * Tunable simulation parameters. The defaults are the values the engine has always used, so a plan
 * without any `settings.params` runs exactly as before. The settings menu is built from PARAMS.
 */
export interface SimParams {
  // drivers (cars)
  carAccel: number;
  carBrake: number;
  carHeadway: number;
  carMinGap: number;
  speedPref: number;
  politeness: number;
  /** share of cars driven by aggressive drivers (%) who go over the limit, and by up to how much (%) */
  aggressiveShare: number;
  aggressiveExcess: number;
  // trucks
  truckAccel: number;
  truckHeadway: number;
  // lane changes
  laneChangeGain: number;
  laneChangeCooldown: number;
  // junctions
  junctionSpeed: number;
  requestDist: number;
  priorityHorizon: number;
  ringGap: number;
  freeQueue: number;
  zipHeadway: number;
  // pedestrians
  pedWalk: number;
  pedYield: number;
  // stuck vehicles
  rerouteAfter: number;
  towAfter: number;
}

export type ParamGroup = "Drivers" | "Trucks" | "Lane changes" | "Junctions" | "Pedestrians" | "Stuck vehicles";

export interface ParamInfo {
  key: keyof SimParams;
  group: ParamGroup;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  def: number;
  help: string;
}

export const PARAMS: ParamInfo[] = [
  { key: "carAccel", group: "Drivers", label: "Acceleration", unit: "m/s²", min: 0.5, max: 4, step: 0.1, def: 2.0, help: "How quickly cars pick up speed (each driver adds up to 0.5 more)." },
  { key: "carBrake", group: "Drivers", label: "Comfortable braking", unit: "m/s²", min: 1, max: 5, step: 0.1, def: 2.4, help: "How hard drivers are willing to brake in normal driving." },
  { key: "carHeadway", group: "Drivers", label: "Time gap to the car ahead", unit: "s", min: 0.5, max: 3, step: 0.05, def: 0.9, help: "Following distance in seconds (each driver adds up to 0.4 more). Shorter = more cars per lane." },
  { key: "carMinGap", group: "Drivers", label: "Gap when stopped", unit: "m", min: 0.5, max: 5, step: 0.1, def: 1.6, help: "Distance kept to the vehicle ahead in a queue." },
  { key: "speedPref", group: "Drivers", label: "Speed vs the limit", unit: "×", min: 0.6, max: 1.3, step: 0.01, def: 0.88, help: "Lowest wished speed as a share of the limit (each driver adds up to 0.22 more)." },
  { key: "politeness", group: "Drivers", label: "Politeness", unit: "", min: 0, max: 1, step: 0.05, def: 0.1, help: "How much drivers care about slowing others when changing lanes (each adds up to 0.4 more)." },
  { key: "aggressiveShare", group: "Drivers", label: "Aggressive drivers", unit: "%", min: 0, max: 100, step: 1, def: 0, help: "Share of cars whose drivers want to go faster than the limit (by up to the amount below). The others never go over it." },
  { key: "aggressiveExcess", group: "Drivers", label: "Aggressive drivers: over the limit by up to", unit: "%", min: 0, max: 50, step: 1, def: 25, help: "How far over the limit an aggressive driver wants to go: each one between a fifth of this and all of it. They still slow for bends and junctions." },
  { key: "truckAccel", group: "Trucks", label: "Acceleration", unit: "m/s²", min: 0.3, max: 2, step: 0.05, def: 0.75, help: "How quickly trucks pick up speed (each adds up to 0.2 more)." },
  { key: "truckHeadway", group: "Trucks", label: "Time gap to the vehicle ahead", unit: "s", min: 0.8, max: 3.5, step: 0.05, def: 1.6, help: "Trucks' following distance in seconds (each adds up to 0.3 more)." },
  { key: "laneChangeGain", group: "Lane changes", label: "Advantage needed", unit: "m/s²", min: 0, max: 1.5, step: 0.05, def: 0.3, help: "How much better the next lane must be before a driver moves over by choice. Lower = more lane changes." },
  { key: "laneChangeCooldown", group: "Lane changes", label: "Pause between changes", unit: "s", min: 1, max: 10, step: 0.5, def: 3.5, help: "Minimum time between two lane changes by choice." },
  { key: "junctionSpeed", group: "Junctions", label: "Speed through junctions", unit: "×", min: 0.5, max: 2, step: 0.05, def: 1, help: "Scales the speed allowed on turning paths and roundabout rings. Higher = junctions clear faster." },
  { key: "requestDist", group: "Junctions", label: "Asks to cross from", unit: "m", min: 15, max: 80, step: 1, def: 42, help: "How far before the line a driver asks the junction for its path." },
  { key: "priorityHorizon", group: "Junctions", label: "Give way to traffic arriving within", unit: "s", min: 2, max: 8, step: 0.1, def: 4.5, help: "At give-way and stop signs: priority traffic this close in time keeps side-road traffic waiting." },
  { key: "ringGap", group: "Junctions", label: "Roundabout gap accepted", unit: "s", min: 1.5, max: 6, step: 0.1, def: 3.2, help: "Smallest time gap in the ring a driver joins." },
  { key: "freeQueue", group: "Junctions", label: "Free junction: waiting zone", unit: "m", min: 4, max: 30, step: 1, def: 12, help: "At junctions without signs, drivers this close to the line go in arrival order." },
  { key: "zipHeadway", group: "Junctions", label: "Free junction: zip gap", unit: "s", min: 0.3, max: 3, step: 0.1, def: 1.5, help: "Time gap to the car ahead needed to follow it into the same exit lane." },
  { key: "pedWalk", group: "Pedestrians", label: "Walk time at a red", unit: "s", min: 3, max: 20, step: 1, def: 8, help: "At lights: seconds at the start of a red in which people may step onto the crossing." },
  { key: "pedYield", group: "Pedestrians", label: "Gap left for cars at zebras", unit: "s", min: 0, max: 20, step: 1, def: 5, help: "At zebras: after a group crosses, seconds before the next may step out." },
  { key: "rerouteAfter", group: "Stuck vehicles", label: "Look for another way after", unit: "s", min: 10, max: 300, step: 5, def: 40, help: "A driver waiting this long at a junction looks for another route." },
  { key: "towAfter", group: "Stuck vehicles", label: "Tow away after", unit: "s", min: 30, max: 900, step: 10, def: 150, help: "A vehicle stuck this long is removed (counted as towed)." },
];

export const PARAM_GROUPS: ParamGroup[] = ["Drivers", "Trucks", "Lane changes", "Junctions", "Pedestrians", "Stuck vehicles"];

export const DEFAULT_PARAMS: SimParams = Object.fromEntries(PARAMS.map(p => [p.key, p.def])) as unknown as SimParams;

/** clamp and keep only known, non-default values (what a plan stores) */
export function sanitizeParams(input: unknown): Partial<SimParams> | undefined {
  if (!input || typeof input !== "object") return undefined;
  const src = input as Record<string, unknown>, out: Partial<SimParams> = {};
  for (const p of PARAMS) {
    const v = src[p.key];
    if (typeof v !== "number" || !isFinite(v)) continue;
    const c = Math.min(p.max, Math.max(p.min, v));
    if (c !== p.def) out[p.key] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/** full parameter set for a run */
export const resolveParams = (p?: Partial<SimParams> | null): SimParams => ({ ...DEFAULT_PARAMS, ...(p ?? {}) });
