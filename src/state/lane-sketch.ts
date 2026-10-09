import { createContext, useContext } from "react";
import { Subject } from "subjecto";
import { emptySketch, settle, type Pt, type Sketch } from "@/lib/lane-sketch";
import type { SketchSimClient } from "./sketch-sim-client";
import { laneSketch$, sketchReplaced } from "./store";

const MAX = 200;

/**
 * A sketch the editor works on, with its own undo history and its own cars:
 * - `whole`: the plan's lane sketch as it is (a V1 plan's sketch window);
 * - `plan`: a V2 plan, its sketch without the ideas sketched apart (`scratch`);
 * - `scratch`: those ideas (a V2 plan's Sketch window), saved with the plan but never part of it.
 * Each shows as its own subject; changes go into `laneSketch$` (what the plan saves).
 */
export interface SketchStore {
  kind: "whole" | "plan" | "scratch";
  sketch$: Subject<Sketch>;
  /** a sketch put in place as it is (a drag's end, a rename: `record` makes it undoable) */
  show(sk: Sketch): void;
  /** a change, undoable (roads kept side by side laid out again) */
  edit(f: (s: Sketch) => Sketch): void;
  undo(): void;
  redo(): void;
  /** a change already shown made undoable: `before` is the sketch it started from */
  record(before: Sketch): void;
  /** its cars and what they did (kept while the page is open, the editor closed or not) */
  sim(): SketchSimClient | null;
  setSim(s: SketchSimClient): void;
  /** its undo history forgotten (another plan loaded, or one saved elsewhere merged in) */
  forget(): void;
}

function makeStore(kind: SketchStore["kind"], sketch$: Subject<Sketch>, write: (sk: Sketch) => void): SketchStore {
  const past: Sketch[] = [], future: Sketch[] = [];
  let sim: SketchSimClient | null = null;
  const store: SketchStore = {
    kind, sketch$, show: write,
    edit(f) {
      const cur = sketch$.getValue(), changed = f(cur);
      if (changed === cur) return;
      past.push(cur);
      if (past.length > MAX) past.shift();
      future.length = 0;
      write(settle(changed));
    },
    undo() { const prev = past.pop(); if (!prev) return; future.push(sketch$.getValue()); write(prev); },
    redo() { const next = future.pop(); if (!next) return; past.push(sketch$.getValue()); write(next); },
    record(before) {
      if (sketch$.getValue() === before) return;
      past.push(before);
      if (past.length > MAX) past.shift();
      future.length = 0;
    },
    sim: () => sim,
    setSim(s) { sim = s; },
    forget() { past.length = 0; future.length = 0; },
  };
  // (another plan loaded: its cars go, their worker stopped)
  sketchReplaced.add(why => { store.forget(); if (why === "load") { sim?.terminate(); sim = null; } });
  return store;
}

/** a sketch without its ideas sketched apart */
const planPart = (k: Sketch): Sketch => { if (!k.scratch) return k; const { scratch: _, ...rest } = k; return rest; };
/** the same sketch but for the ideas sketched apart (each part the very same) */
function samePlan(a: Sketch, b: Sketch) {
  const ka = Object.keys(a).filter(k => k !== "scratch"), kb = Object.keys(b).filter(k => k !== "scratch");
  return ka.length === kb.length && ka.every(k => (a as unknown as Record<string, unknown>)[k] === (b as unknown as Record<string, unknown>)[k]);
}

export const wholeSketch = makeStore("whole", laneSketch$, sk => laneSketch$.next(sk));

const planView$ = new Subject<Sketch>(planPart(laneSketch$.getValue()), { name: "planSketch", updateIfStrictlyEqual: false });
const scratchView$ = new Subject<Sketch>(laneSketch$.getValue().scratch ?? emptySketch(), { name: "scratchSketch", updateIfStrictlyEqual: false });
// (the plan loaded, merged, or restored: each part shown again if it changed)
laneSketch$.subscribe(k => {
  if (!samePlan(k, planView$.getValue())) planView$.next(planPart(k));
  const sc = k.scratch ?? null, cur = scratchView$.getValue();
  if (sc ? sc !== cur : cur.lanes.length || cur.junctions.length || cur.connectors.length || cur.crossings?.length) scratchView$.next(sc ?? emptySketch());
});
export const planSketch = makeStore("plan", planView$, sk => {
  planView$.next(sk);
  const sc = laneSketch$.getValue().scratch;
  laneSketch$.next(sc ? { ...sk, scratch: sc } : sk);
});
export const scratchSketch = makeStore("scratch", scratchView$, sk => {
  scratchView$.next(sk);
  const plan = planPart(laneSketch$.getValue()), empty = !sk.lanes.length && !sk.junctions.length && !sk.connectors.length && !sk.crossings?.length && !sk.traffic;
  laneSketch$.next(empty ? plan : { ...plan, scratch: planPart(sk) });
});

/** the sketch the editor around works on (a V1 plan's window: the whole sketch) */
export const SketchStoreContext = createContext<SketchStore>(wholeSketch);
export const useSketchStore = () => useContext(SketchStoreContext);

// (the whole sketch's, for what isn't inside an editor)
export const editSketch = wholeSketch.edit, undoSketch = wholeSketch.undo, redoSketch = wholeSketch.redo, recordSketch = wholeSketch.record;
/** the plan's cars (a V2 plan's page; a V1 plan's sketch window) */
export const sketchSim = () => planSketch.sim() ?? wholeSketch.sim();
export function setSketchSim(s: SketchSimClient) { wholeSketch.setSim(s); }

/** what ⌘C / ⌘X took in the sketch (kept while the page is open, shared by the plan and its sketch window); `pastes` puts each paste a little off the last when it isn't at the cursor */
export interface SketchClip { part: Sketch; centre: Pt; pastes: number; /** which copy it is (the same on the system clipboard: one copied here wins without being read back) */ stamp?: string }
let clip: SketchClip | null = null;
export const sketchClip = () => clip;
export function setSketchClip(c: SketchClip) { clip = c; }

/** the clipboard's text for a copied piece of sketch, marked so a paste (in another tab too) knows it */
const CLIP_MARK = "trafficsim/sketch-part";
export const clipText = (c: SketchClip) => JSON.stringify({ kind: CLIP_MARK, stamp: c.stamp, centre: c.centre, part: c.part });
/** a piece of sketch from the clipboard's text (null: something else) */
export function readClipText(text: string): SketchClip | null {
  if (!text.startsWith(`{"kind":"${CLIP_MARK}"`)) return null;
  try {
    const o = JSON.parse(text) as { stamp?: string; centre?: Pt; part?: Sketch };
    const p = o.part;
    if (!p || !Array.isArray(p.lanes) || !Array.isArray(p.connectors) || !Array.isArray(p.junctions) || !o.centre) return null;
    return { part: { ...p, roads: p.roads ?? [] }, centre: o.centre, pastes: 0, stamp: o.stamp };
  } catch { return null; }
}

/** what the Sketch window does when it next shows a piece put in it ("Test in Sketch"): the view fitted to it, nothing selected, the cars run if `run` */
export interface ScratchFocus { run: boolean }
let scratchFocus: ScratchFocus | null = null;
const scratchFocusWaiting = new Set<() => void>();
export function requestScratchFocus(f: ScratchFocus) { scratchFocus = f; scratchFocusWaiting.forEach(g => g()); }
/** the request, taken (null: none) */
export function takeScratchFocus(): ScratchFocus | null { const f = scratchFocus; scratchFocus = null; return f; }
export function onScratchFocus(g: () => void) { scratchFocusWaiting.add(g); return () => { scratchFocusWaiting.delete(g); }; }
