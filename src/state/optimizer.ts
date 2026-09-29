/**
 * Runs the signal optimiser in the browser: the search (src/engine/optimize.ts) runs here, the
 * simulations it asks for run in a pool of Web Workers (one per spare CPU core) so the page stays
 * responsive.
 */
import { optimizeSignals, OPTIMIZE_EFFORT, type Evaluate, type Network, type OptimizeEffort, type OptimizeProgress, type OptimizeResult, type OptimizeTarget, type PlanSettings, type RunMetrics, type RunSpec } from "@/engine";

export function startOptimizer(net: Network, settings: PlanSettings, nodes: string[], targets: OptimizeTarget[], effort: OptimizeEffort, onProgress: (p: OptimizeProgress) => void) {
  const cfg = OPTIMIZE_EFFORT[effort];
  const size = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const workers = Array.from({ length: size }, () => new Worker(new URL("./optimize.worker.ts", import.meta.url), { type: "module" }));
  const abort = new AbortController();
  const waiting = new Map<number, { res: (m: RunMetrics) => void; rej: (e: unknown) => void }>();
  const free = [...workers], pending: { net: Network; settings: PlanSettings; res: (m: RunMetrics) => void; rej: (e: unknown) => void }[] = [];
  let nextId = 0, failed: unknown = null;
  for (const w of workers) {
    w.onmessage = (e: MessageEvent<{ id: number; m: RunMetrics }>) => { const f = waiting.get(e.data.id); waiting.delete(e.data.id); free.push(w); f?.res(e.data.m); dispatch(); };
    w.onerror = e => { e.preventDefault(); stop(new Error(e.message || "A simulation worker failed")); };
  }
  function dispatch() {
    while (free.length && pending.length && !abort.signal.aborted) {
      const w = free.pop()!, t = pending.shift()!, id = nextId++;
      waiting.set(id, { res: t.res, rej: t.rej });
      w.postMessage({ id, net: t.net, settings: t.settings, spec: cfg.spec satisfies RunSpec });
    }
  }
  const run = (n: Network, s: PlanSettings) => new Promise<RunMetrics>((res, rej) => { if (failed) return rej(failed); pending.push({ net: n, settings: s, res, rej }); dispatch(); });
  const evaluate: Evaluate = (nets, seeds) => Promise.all(nets.map(n => Promise.all(seeds.map(seed => run(n, { ...settings, seed })))));
  const done: Promise<OptimizeResult> = optimizeSignals(net, settings, { nodes, targets, seeds: [...cfg.seeds], confirmSeeds: [...cfg.confirmSeeds], holdoutSeeds: [...cfg.holdoutSeeds], spec: cfg.spec, rounds: cfg.rounds }, evaluate, onProgress, abort.signal)
    .finally(() => workers.forEach(w => w.terminate()));
  /** stop everything: runs waiting or in progress fail, so the search ends */
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
