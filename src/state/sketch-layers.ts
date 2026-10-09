/**
 * What the lane sketch shows: its layers, on or off (kept in the browser), shared by the editor and,
 * on a V2 plan, the top bar's layers picker.
 */
import { Subject } from "subjecto";

export type SketchLayer = "grid" | "surfaces" | "markings" | "lanes" | "connectors" | "signs" | "cars" | "names" | "demand" | "satellite" | "image";
export type SketchLayers = Record<SketchLayer, boolean>;
/** (`page`: only on a V2 plan's full-page editor) */
export const SKETCH_LAYERS: { id: SketchLayer; label: string; hint: string; page?: boolean }[] = [
  { id: "surfaces", label: "Road surfaces", hint: "Asphalt under the roads and junctions, as on the plan's map" },
  { id: "markings", label: "Markings", hint: "Lane lines and centre lines on the road surfaces" },
  { id: "lanes", label: "Lanes", hint: "Each lane's green line and its direction of travel (the selected ones always show)" },
  { id: "connectors", label: "Connectors", hint: "The yellow connectors between lanes (the selected ones always show)" },
  { id: "signs", label: "Signs and lights", hint: "Stop and yield lines and signs, traffic lights" },
  { id: "cars", label: "Cars", hint: "The cars, while the simulation is on" },
  { id: "names", label: "Names", hint: "Road and junction names" },
  { id: "demand", label: "Ways in and out", hint: "Where traffic comes in (vehicles per hour) and leaves (share of trips)" },
  { id: "grid", label: "Grid", hint: "A line every metre close up, every 10 m stronger" },
  { id: "satellite", label: "Satellite imagery", hint: "The imagery where the plan is on the map (V2 plans placed on the map)", page: true },
  { id: "image", label: "Reference image", hint: "The plan's reference image (V2 plans)", page: true },
];
export const ALL_SKETCH_LAYERS = Object.fromEntries(SKETCH_LAYERS.map(l => [l.id, true])) as SketchLayers;
/** the layers shown at first: all but the grid */
export const DEFAULT_SKETCH_LAYERS: SketchLayers = { ...ALL_SKETCH_LAYERS, grid: false };
const KEY = "laneSketch:layers:2";

function load(): SketchLayers {
  if (typeof window === "undefined") return DEFAULT_SKETCH_LAYERS;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (saved && typeof saved === "object") return { ...DEFAULT_SKETCH_LAYERS, ...Object.fromEntries(SKETCH_LAYERS.filter(l => typeof saved[l.id] === "boolean").map(l => [l.id, saved[l.id]])) };
    // (the road surfaces switch there was before)
    return { ...DEFAULT_SKETCH_LAYERS, surfaces: localStorage.getItem("laneSketch:surfaces") !== "0" };
  } catch { return DEFAULT_SKETCH_LAYERS; }
}

export const sketchLayers$ = new Subject<SketchLayers>(load(), { name: "sketchLayers" });
export function setSketchLayers(l: SketchLayers) {
  sketchLayers$.next(l);
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch { /* private mode */ }
}
/** a layer on or off; `only`: that one alone (of those the editor shows: `page`) */
export function toggleSketchLayer(id: SketchLayer, only = false, page = true) {
  const cur = sketchLayers$.getValue();
  if (only) setSketchLayers({ ...(Object.fromEntries(SKETCH_LAYERS.map(l => [l.id, !page && l.page ? cur[l.id] : false])) as SketchLayers), [id]: true });
  else setSketchLayers({ ...cur, [id]: !cur[id] });
}
