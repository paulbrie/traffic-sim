import { Subject } from "subjecto";

/** one-shot view commands (fit, zoom) broadcast to whichever view is active */
export type ViewCommand = { cmd: "fit" | "zoomIn" | "zoomOut" | "focus" | "frame" | "north"; x?: number; y?: number; w?: number; h?: number; n: number };
export const viewCmd$ = new Subject<ViewCommand | null>(null, { name: "viewCmd" });
let n = 0;
export const sendView = (cmd: ViewCommand["cmd"], x?: number, y?: number) => viewCmd$.next({ cmd, x, y, n: ++n });
/** centre the plan view on this rectangle (metres) and zoom so all of it shows */
export const sendFrame = (minX: number, minY: number, maxX: number, maxY: number) =>
  viewCmd$.next({ cmd: "frame", x: (minX + maxX) / 2, y: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY, n: ++n });

/** last visible world rectangle of the plan view (metres), used to place new content in view; planId: whose plan ("" until drawn) */
export const viewport = { cx: 0, cy: 0, wm: 300, hm: 200, planId: "" };

/** where the plan view of a plan (centre and zoom) is kept in this browser; the 3D view writes it too, so switching keeps the place */
export const planViewKey = (planId: string) => `trafficsim:view:${planId}`;
