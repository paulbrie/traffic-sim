import { Subject } from "subjecto";

/** one-shot view commands (fit, zoom) broadcast to whichever view is active */
export type ViewCommand = { cmd: "fit" | "zoomIn" | "zoomOut" | "focus" | "north"; x?: number; y?: number; n: number };
export const viewCmd$ = new Subject<ViewCommand | null>(null, { name: "viewCmd" });
let n = 0;
export const sendView = (cmd: ViewCommand["cmd"], x?: number, y?: number) => viewCmd$.next({ cmd, x, y, n: ++n });

/** last visible world rectangle of the plan view (metres), used to place new content in view; planId: whose plan ("" until drawn) */
export const viewport = { cx: 0, cy: 0, wm: 300, hm: 200, planId: "" };

/** where the plan view of a plan (centre and zoom) is kept in this browser; the 3D view writes it too, so switching keeps the place */
export const planViewKey = (planId: string) => `trafficsim:view:${planId}`;
