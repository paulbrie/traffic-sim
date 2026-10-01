"use client";

import { useEffect, useState } from "react";
import { useDeepSubject } from "subjecto/react";
import { ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { pagePerf } from "@/state/perf";

/** Chrome's heap numbers (non-standard: other browsers have none) */
const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
const mb = (v: number | null | undefined) => (v == null ? "–" : v >= 1024 ? `${(v / 1024).toFixed(1)} GB` : `${Math.round(v)} MB`);
const pct = (v: number) => `${Math.round(v * 100)}%`;

interface Sample { fps: number; drawMs: number; blocked: number; heapMB: number | null; heapLimitMB: number | null }

/**
 * The load the plan puts on this computer: the page (main thread) and the workers. Browsers don't let a
 * page read Chrome's own CPU use, so "busy" is measured inside each thread: the share of time it spent
 * working; memory is the JavaScript heap where Chrome reports it.
 */
export function PerfPanel() {
  const [display] = useDeepSubject(ui, "display");
  const [s, setS] = useState<Sample>({ fps: 0, drawMs: 0, blocked: 0, heapMB: null, heapLimitMB: null });
  useEffect(() => {
    if (!display.perf) return;
    // frames per second from animation frames; time blocked by long tasks (over 50 ms each)
    let frames = 0, raf = 0, longMs = 0, since = performance.now();
    const tick = () => { frames++; raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    let obs: PerformanceObserver | null = null;
    try {
      obs = new PerformanceObserver(list => { for (const e of list.getEntries()) longMs += e.duration; });
      obs.observe({ type: "longtask", buffered: false });
    } catch { obs = null; }
    const id = setInterval(() => {
      const now = performance.now(), span = (now - since) / 1000, m = heap();
      setS({ fps: frames / span, drawMs: pagePerf.drawMs, blocked: Math.min(1, longMs / (span * 1000)), heapMB: m ? m.usedJSHeapSize / 1048576 : null, heapLimitMB: m ? m.jsHeapSizeLimit / 1048576 : null });
      frames = 0; longMs = 0; since = now;
    }, 1000);
    return () => { cancelAnimationFrame(raf); clearInterval(id); obs?.disconnect(); };
  }, [display.perf]);
  if (!display.perf) return null;
  const sim = simController.simLoad, out = simController.outlineLoad, running = ui.getValue().sim.running;
  const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
  const bar = (v: number) => (
    <span className="inline-block h-1.5 w-14 overflow-hidden rounded-full bg-muted align-middle">
      <span className={`block h-full ${v > 0.85 ? "bg-destructive" : v > 0.6 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.round(Math.min(1, v) * 100)}%` }} />
    </span>
  );
  return (
    <div className="pointer-events-none absolute right-3 bottom-24 z-10 grid w-64 gap-1.5 rounded-lg border bg-background/95 px-3 py-2 text-[11px] shadow-sm backdrop-blur" aria-label="CPU and memory load">
      <div className="flex justify-between font-medium"><span>Load</span><span className="text-muted-foreground">{cores ? `${cores} CPU threads` : ""}</span></div>
      <div className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 tabular">
        <span className="text-muted-foreground">Page</span>
        <span>{s.fps.toFixed(0)} fps · draw {s.drawMs.toFixed(1)} ms</span>
        <span />
        <span className="flex items-center gap-1.5">{bar(s.blocked)} blocked {pct(s.blocked)}</span>
        <span />
        <span>memory {mb(s.heapMB)}{s.heapLimitMB ? ` of ${mb(s.heapLimitMB)}` : ""}</span>
        <span className="text-muted-foreground">Simulation</span>
        <span className="flex items-center gap-1.5">{bar(running ? sim.busy : 0)} {running ? `busy ${pct(sim.busy)}` : "paused"}</span>
        <span />
        <span>{running && sim.stepMs ? `${sim.stepMs.toFixed(1)} ms per step · ` : ""}{simController.rate ? `${simController.rate.toFixed(1)}× · ` : ""}memory {mb(sim.heapMB)}</span>
        <span className="text-muted-foreground">Outlines</span>
        <span>{out.busy ? "working…" : out.lastMs ? `idle (last job ${(out.lastMs / 1000).toFixed(1)} s)` : "idle"}{out.heapMB != null ? ` · memory ${mb(out.heapMB)}` : ""}</span>
      </div>
      <p className="text-[10px] text-muted-foreground">Measured inside each thread (browsers don&apos;t show a page Chrome&apos;s own CPU use). Memory: Chrome only.</p>
    </div>
  );
}
