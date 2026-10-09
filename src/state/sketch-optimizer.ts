/**
 * Runs the V2 lights optimiser in the browser, as V1's (state/optimizer.ts): the search (lib/sketch-optimize.ts)
 * runs here, the simulations it asks for in a pool of workers (one per spare CPU core), so the page stays responsive.
 */
import { optimizeLights, OPTIMIZE_EFFORT, type Evaluate, type OptimizeEffort, type OptimizeProgress, type OptimizeResult, type OptimizeTarget, type RunMetrics } from "@/lib/sketch-optimize";
import type { Sketch } from "@/lib/lane-sketch";
import type { SimParams } from "@/lib/lane-sketch-sim";

export function startSketchOptimizer(sketch: Sketch, params: SimParams, junctions: string[], targets: OptimizeTarget[], effort: OptimizeEffort, onProgress: (p: OptimizeProgress) => void) {
  const cfg = OPTIMIZE_EFFORT[effort];
  const size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from({ length: size }, () => new Worker(new URL("./sketch-optimize.worker.ts", import.meta.url), { type: "module" }));
  const abort = new AbortController();
  const waiting = new Map<number, { res: (m: RunMetrics) => void; rej: (e: unknown) => void }>();
  const free = [...workers], pending: { sketch: Sketch; seed: number; res: (m: RunMetrics) => void; rej: (e: unknown) => void }[] = [];
  let nextId = 0, failed: unknown = null;
  for (const w of workers) {
    w.onmessage = (e: MessageEvent<{ id: number; m: RunMetrics }>) => { const f = waiting.get(e.data.id); waiting.delete(e.data.id); free.push(w); f?.res(e.data.m); dispatch(); };
    w.onerror = e => { e.preventDefault(); stop(new Error(e.message || "A simulation worker failed")); };
  }
  function dispatch() {
    while (free.length && pending.length && !abort.signal.aborted) {
      const w = free.pop()!, t = pending.shift()!, id = nextId++;
      waiting.set(id, { res: t.res, rej: t.rej });
      w.postMessage({ id, sketch: t.sketch, params, seed: t.seed, spec: cfg.spec });
    }
  }
  const run = (sk: Sketch, seed: number) => new Promise<RunMetrics>((res, rej) => { if (failed) return rej(failed); pending.push({ sketch: sk, seed, res, rej }); dispatch(); });
  const evaluate: Evaluate = (sks, seeds) => Promise.all(sks.map(sk => Promise.all(seeds.map(seed => run(sk, seed)))));
  const done: Promise<OptimizeResult> = optimizeLights(sketch, { junctions, targets, seeds: cfg.seeds, confirmSeeds: cfg.confirmSeeds, holdoutSeeds: cfg.holdoutSeeds, spec: cfg.spec, rounds: cfg.rounds }, evaluate, onProgress, abort.signal)
    .finally(() => workers.forEach(w => w.terminate()));
  /** everything stopped: runs waiting or under way fail, so the search ends */
  function stop(why: unknown) {
    if (failed) return;
    failed = why; abort.abort();
    workers.forEach(w => w.terminate());
    for (const p of pending.splice(0)) p.rej(why);
    for (const w of waiting.values()) w.rej(why);
    waiting.clear();
  }
  return { done, cancel: () => stop(new DOMException("Optimisation cancelled", "AbortError")), workers: size };
}
