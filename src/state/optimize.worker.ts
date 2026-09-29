/// <reference lib="webworker" />
/** Runs one simulation per message for the signal optimiser (see src/state/optimizer.ts). */
import { measureRun, type Network, type PlanSettings, type RunSpec } from "@/engine";

self.onmessage = (e: MessageEvent<{ id: number; net: Network; settings: PlanSettings; spec: RunSpec }>) => {
  const { id, net, settings, spec } = e.data;
  self.postMessage({ id, m: measureRun(net, settings, spec) });
};
