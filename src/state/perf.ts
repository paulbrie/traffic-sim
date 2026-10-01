/** The page's own load numbers, written where the work happens and read by the load panel. */
export const pagePerf = {
  /** time spent drawing the 2D plan per frame (ms, smoothed) */
  drawMs: 0,
  /** frames drawn (the panel turns it into frames per second) */
  draws: 0,
};
export function noteDraw(ms: number) {
  pagePerf.drawMs = pagePerf.drawMs ? pagePerf.drawMs * 0.9 + ms * 0.1 : ms;
  pagePerf.draws++;
}
