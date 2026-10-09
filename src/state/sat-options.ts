/** how the V2 editor's satellite imagery is shown: its brightness and source (kept in the browser) */
import type { SatSource } from "@/render/satellite";

export interface SatOptions { brightness: number; source: SatSource }
export const loadSatOptions = (): SatOptions => {
  try { const o = JSON.parse(localStorage.getItem("v2:sat") ?? "null"); if (o && typeof o.brightness === "number") return { brightness: Math.min(1, Math.max(0.3, o.brightness)), source: o.source === "google" ? "google" : "esri" }; } catch { /* private mode, or nothing kept */ }
  return { brightness: 0.85, source: "esri" };
};
export const saveSatOptions = (o: SatOptions) => { try { localStorage.setItem("v2:sat", JSON.stringify(o)); } catch { /* private mode */ } };
