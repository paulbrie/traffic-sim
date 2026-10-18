/// <reference lib="webworker" />
/**
 * Junction warnings (src/lib/junction-warnings.ts, Bob's T161) worked out off the page's main thread: on Bistrița they take
 * some 3.5 s. The page asks with the sketch and a request number; the answer comes back with the same number.
 */
import { junctionWarnings } from "@/lib/junction-warnings";
import type { Sketch } from "@/lib/lane-sketch";

self.onmessage = (e: MessageEvent<{ req: number; sketch: Sketch }>) => {
  const t0 = performance.now();
  const warnings = junctionWarnings(e.data.sketch);
  self.postMessage({ req: e.data.req, warnings, ms: Math.round(performance.now() - t0) });
};
