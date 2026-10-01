/// <reference lib="webworker" />
/**
 * Works out junction outlines off the page's main thread (they merge every lane path through a
 * junction, which takes a while on a big plan). The page compiles with `outlines: "cached"`, draws
 * the missing ones simply, asks here, and puts the answers in its shape cache (src/state/sim-controller.ts).
 */
import { compile, getShape, type JunctionShape } from "@/engine/compile";
import type { Network } from "@/engine/types";

self.onmessage = (e: MessageEvent<{ req: number; network: Network; keys: string[] }>) => {
  const { req, network, keys } = e.data;
  const t0 = performance.now();
  compile(network); // a full compile fills this worker's shape cache (kept between requests)
  const shapes: [string, JunctionShape][] = keys.map(k => [k, getShape(k) ?? null]);
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  self.postMessage({ req, shapes, ms: performance.now() - t0, heapMB: mem ? mem.usedJSHeapSize / 1048576 : null });
};
