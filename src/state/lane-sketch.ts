import { settle, type Pt, type Sketch } from "@/lib/lane-sketch";
import type { SketchSimClient } from "./sketch-sim-client";
import { laneSketch$, sketchReplaced } from "./store";

/** the lane sketch's own undo history (apart from the plan's) */
const past: Sketch[] = [], future: Sketch[] = [];
const MAX = 200;

/** a change to the sketch, undoable */
export function editSketch(f: (s: Sketch) => Sketch) {
  const cur = laneSketch$.getValue(), changed = f(cur);
  if (changed === cur) return;
  // (roads kept side by side laid out again)
  const next = settle(changed);
  past.push(cur);
  if (past.length > MAX) past.shift();
  future.length = 0;
  laneSketch$.next(next);
}

export function undoSketch() {
  const prev = past.pop();
  if (!prev) return;
  future.push(laneSketch$.getValue());
  laneSketch$.next(prev);
}

export function redoSketch() {
  const next = future.pop();
  if (!next) return;
  past.push(laneSketch$.getValue());
  laneSketch$.next(next);
}

/** a change already shown (a drag, sent straight to `laneSketch$`) made undoable: `before` is the sketch it started from */
export function recordSketch(before: Sketch) {
  if (laneSketch$.getValue() === before) return;
  past.push(before);
  if (past.length > MAX) past.shift();
  future.length = 0;
}

/** what ⌘C / ⌘X took in the sketch (kept while the page is open); `pastes` puts each paste a little off the last when it isn't at the cursor */
export interface SketchClip { part: Sketch; centre: Pt; pastes: number }
let clip: SketchClip | null = null;
export const sketchClip = () => clip;
export function setSketchClip(c: SketchClip) { clip = c; }

/** the cars on the sketch and what they did (kept while the page is open, the window closed or not) */
let sim: SketchSimClient | null = null;
export const sketchSim = () => sim;
export function setSketchSim(s: SketchSimClient) { sim = s; }

// another plan's sketch loaded, or one saved elsewhere merged in: this one's undo history no longer applies
// (and with another plan, its cars go)
sketchReplaced.add(why => {
  past.length = 0; future.length = 0;
  // (its worker stopped)
  if (why === "load") { sim?.terminate(); sim = null; }
});
