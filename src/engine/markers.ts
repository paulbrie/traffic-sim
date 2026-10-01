import type { BuildingDef, MarkerDef, Network, Vec } from "./types";

/** a marker's colour when none is set */
export const DEFAULT_MARKER_COLOR = "#e11d48";

const inside = (p: Vec, pts: readonly Vec[]) => {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};

/**
 * What a marker stands on: the building whose footprint it is in (the tallest, where footprints overlap) and
 * the height of its roof, or the ground (height 0).
 */
export function markerBase(net: Network, m: Pick<MarkerDef, "x" | "y">): { building: BuildingDef | null; height: number } {
  let best: BuildingDef | null = null;
  for (const b of net.buildings ?? []) if (b.pts.length >= 3 && inside(m, b.pts) && (!best || b.height > best.height)) best = b;
  return { building: best, height: best?.height ?? 0 };
}
