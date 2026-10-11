import type { BuildingUse } from "@/engine/types";

export interface Palette {
  ground: string; grid: string; gridMajor: string; asphalt: string; curb: string; mark: string; divider: string;
  bus: string; island: string; select: string; car: string; truck: string; busVeh: string;
  go: string; slow: string; stop: string; fg: string; muted: string; bg: string; primary: string;
  sans: string; mono: string; sky: string; building: string; buildingEdge: string;
}

/**
 * The page in its dark (night) colours: the system's preference (globals.css switches on prefers-color-scheme), or a
 * `dark` class on the page, should one ever be set. Canvases pick their own colours by it, so they match the CSS ones.
 */
export function isDark(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark") || (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches);
}
/** `f` called when the page changes between day and night colours; the function to stop it */
export function onThemeChange(f: () => void): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const m = matchMedia("(prefers-color-scheme: dark)");
  m.addEventListener("change", f);
  return () => m.removeEventListener("change", f);
}

export function readPalette(el: Element = document.documentElement): Palette {
  const cs = getComputedStyle(el);
  const g = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return {
    ground: g("--map-ground", "#e3e8dd"), grid: g("--map-grid", "#d4dbcc"), gridMajor: g("--map-grid-major", "#c4ccba"),
    asphalt: g("--map-asphalt", "#4a5058"), curb: g("--map-curb", "#f1f3ec"), mark: g("--map-mark", "#f6f1d8"),
    divider: g("--map-divider", "#d6a21e"), bus: g("--map-bus", "#9a4a40"), island: g("--map-island", "#86ad74"),
    select: g("--map-select", "#1f7a5a"), car: g("--veh-car", "#f4f5f2"), truck: g("--veh-truck", "#3d6c8c"), busVeh: g("--veh-bus", "#d99800"),
    go: g("--sig-go", "#23a566"), slow: g("--sig-slow", "#e8a300"), stop: g("--sig-stop", "#d9403f"),
    fg: g("--foreground", "#222"), muted: g("--muted-foreground", "#666"), bg: g("--background", "#fff"), primary: g("--primary", "#1f7a5a"),
    sky: g("--map-sky", "#dfe7e4"), building: g("--map-building", "#d6d3c9"), buildingEdge: g("--map-building-edge", "#b4b0a3"), sans: g("--font-geist-sans", "system-ui, sans-serif"), mono: g("--font-geist-mono", "ui-monospace, monospace"),
  };
}

const hexCache = new Map<string, [number, number, number]>();
function rgb(c: string): [number, number, number] {
  let v = hexCache.get(c);
  if (v) return v;
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  v = m ? [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)] : [128, 128, 128];
  hexCache.set(c, v);
  return v;
}
export function mix(a: string, b: string, f: number) {
  const A = rgb(a), B = rgb(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * f)},${Math.round(A[1] + (B[1] - A[1]) * f)},${Math.round(A[2] + (B[2] - A[2]) * f)})`;
}
export function speedColor(p: Palette, r: number) {
  r = Math.max(0, Math.min(1, r));
  return r < 0.5 ? mix(p.stop, p.slow, r * 2) : mix(p.slow, p.go, (r - 0.5) * 2);
}

/** a hint of colour per building use, over the neutral building tone */
const USE_TINT: Record<BuildingUse, string | null> = {
  home: "#c79a6b", shop: "#d9784a", office: "#5f86b3", industry: "#8a7fa3", school: "#d6ad2e", civic: "#5e9e6e", other: null, minor: null,
};
export function buildingColor(p: Palette, use: BuildingUse): string {
  const t = USE_TINT[use];
  return t ? mix(p.building, t, 0.32) : use === "minor" ? mix(p.building, p.buildingEdge, 0.5) : p.building;
}
