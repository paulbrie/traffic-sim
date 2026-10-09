/// <reference lib="webworker" />
/** Runs one simulation per message for the V2 lights optimiser (see src/state/sketch-optimizer.ts). */
import { measureRun, type RunSpec } from "@/lib/sketch-optimize";
import type { Sketch } from "@/lib/lane-sketch";
import type { SimParams } from "@/lib/lane-sketch-sim";

self.onmessage = (e: MessageEvent<{ id: number; sketch: Sketch; params: SimParams; seed: number; spec: RunSpec }>) => {
  const { id, sketch, params, seed, spec } = e.data;
  self.postMessage({ id, m: measureRun(sketch, params, seed, spec) });
};
