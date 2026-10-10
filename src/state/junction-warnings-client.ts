"use client";

/**
 * The editor's junction warnings (T165): worked out in a worker (junction-warnings.worker.ts) a moment after the sketch stops
 * changing (not at each move of a drag, not each frame), one request at a time; an answer for a sketch since changed is
 * dropped and the newest asked for. Meanwhile `checking` is true and the last list stays shown.
 */
import { useEffect, useRef, useState } from "react";
import type { JunctionWarning } from "@/lib/junction-warnings";
import type { Sketch } from "@/lib/lane-sketch";

/** how long the sketch stays the same before it is checked (ms) */
const SETTLE = 1200;
export interface JunctionWarningState { list: JunctionWarning[]; checking: boolean; ms: number | null; byJunction: Map<string, JunctionWarning[]> }

export function useJunctionWarnings(sketch: Sketch, on = true): JunctionWarningState {
  // (checking: the list shown isn't for the sketch as it is now)
  const [state, setState] = useState<Omit<JunctionWarningState, "checking"> & { for: Sketch | null }>({ list: [], ms: null, byJunction: new Map(), for: null });
  const worker = useRef<Worker | null>(null), req = useRef(0), busy = useRef(false), wanted = useRef<Sketch | null>(null), sent = useRef<Sketch | null>(null);
  useEffect(() => () => { worker.current?.terminate(); worker.current = null; }, []);
  useEffect(() => {
    if (!on || typeof Worker === "undefined") return;
    const ask = () => {
      const sk = wanted.current;
      if (!sk || busy.current) return;
      wanted.current = null; busy.current = true;
      if (!worker.current) {
        worker.current = new Worker(new URL("./junction-warnings.worker.ts", import.meta.url), { type: "module" });
        worker.current.onmessage = (e: MessageEvent<{ req: number; warnings: JunctionWarning[]; ms: number }>) => {
          const asked = sent.current;
          busy.current = false;
          // (the sketch changed meanwhile: that one asked for now, this answer dropped)
          if (wanted.current) { ask(); return; }
          if (e.data.req !== req.current) return;
          const byJunction = new Map<string, JunctionWarning[]>();
          for (const w of e.data.warnings) if (w.junction) byJunction.set(w.junction, [...(byJunction.get(w.junction) ?? []), w]);
          setState({ list: e.data.warnings, ms: e.data.ms, byJunction, for: asked });
        };
      }
      sent.current = sk;
      worker.current.postMessage({ req: ++req.current, sketch: sk });
    };
    const id = setTimeout(() => { wanted.current = sketch; ask(); }, SETTLE);
    return () => clearTimeout(id);
  }, [sketch, on]);
  return { list: state.list, ms: state.ms, byJunction: state.byJunction, checking: on && state.for !== sketch };
}
