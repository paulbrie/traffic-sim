/**
 * Fuel use, by Akçelik's power-based model (Bowyer, Akçelik & Biggs 1985; Akçelik & Besley 2003):
 *
 *   f = α + β1·R·v + β2·M·a²·v / 1000 (the last term only while accelerating),  R = b1 + b2·v² + M·a / 1000
 *
 * f in mL/s, v in m/s, a in m/s², M in kg, R the total tractive force in kN (on level road). When R
 * is not positive (coasting, braking) or the vehicle stands still, it burns only its idle rate α.
 * The light-vehicle constants are the published ones; the heavy-vehicle ones are rounded for a
 * typical rigid truck / city bus. The idle rate comes from the simulation parameters (fuelIdleCar,
 * fuelIdleTruck), since that is the part people most often want to vary.
 */
import type { Kind } from "./sim/base";

interface FuelModel { M: number; b1: number; b2: number; beta1: number; beta2: number }

const LIGHT: FuelModel = { M: 1400, b1: 0.333, b2: 0.00108, beta1: 0.09, beta2: 0.03 };
const TRUCK: FuelModel = { M: 12000, b1: 1.0, b2: 0.004, beta1: 0.07, beta2: 0.02 };
const BUS: FuelModel = { M: 13000, b1: 1.0, b2: 0.0045, beta1: 0.07, beta2: 0.02 };
export const FUEL_MODELS: Record<Kind, FuelModel> = { car: LIGHT, truck: TRUCK, bus: BUS };

/** below this speed (m/s) a vehicle counts as standing still: its engine only idles */
export const FUEL_STILL = 0.3;

/** fuel burnt per second (mL/s) at speed `v` and acceleration `a`, with idle rate `idle` (mL/s) */
export function fuelRate(kind: Kind, v: number, a: number, idle: number): number {
  if (v < FUEL_STILL) return idle;
  const m = FUEL_MODELS[kind];
  const R = m.b1 + m.b2 * v * v + (m.M * a) / 1000;
  if (R <= 0) return idle;
  return idle + m.beta1 * R * v + (a > 0 ? (m.beta2 * m.M * a * a * v) / 1000 : 0);
}

/**
 * Whether a vehicle has an engine stop-start system (off while standing still), given the share
 * of vehicles that have one (%). Decided from its id, not the run's random numbers, so switching
 * fuel on or changing the share leaves the traffic exactly as it was.
 */
export function hasStopStart(id: number, sharePct: number): boolean {
  if (sharePct <= 0) return false;
  const h = Math.imul(id ^ 0x5bd1e995, 0x9e3779b1) >>> 0;
  return (h % 1000) < sharePct * 10;
}

/** fuel totals (litres) and distance (km): all of it, and the part burnt standing still in traffic */
export interface FuelTally { total: number; idle: number }
