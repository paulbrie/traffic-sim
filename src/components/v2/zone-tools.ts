/**
 * The V2 editor's zones (T129) on its 2D canvas: drawing them under everything else, and what's under the
 * pointer. The canvas is in plan metres (the editor's transform); `px` is a pixel in metres.
 */
import type { Pt } from "@/lib/lane-sketch";
import { insideZone, zoneArea, type SketchZone } from "@/lib/sketch-zones";
import { translucentArea } from "@/render/area-fill";

/** the zone under `p`: the smallest one holding it (a zone inside another is picked first) */
export function zoneAt(zones: SketchZone[] | undefined, p: Pt): SketchZone | null {
  let best: SketchZone | null = null, area = Infinity;
  for (const z of zones ?? []) {
    if (!insideZone(p, z.outline)) continue;
    const a = zoneArea(z.outline);
    if (a < area) { area = a; best = z; }
  }
  return best;
}

/**
 * A double-click on a selected zone (T129): on a corner (within `tol`), that corner taken out (three stay at
 * least: null then); else on its border (within `tol`), a corner put in there, between the ends of the
 * nearest edge (`i`: where it goes in the outline); else nothing (null).
 */
export function zoneEditAt(z: SketchZone, p: Pt, tol: number): { kind: "remove"; i: number } | { kind: "insert"; i: number } | null {
  const n = z.outline.length;
  const ci = z.outline.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) <= tol);
  if (ci >= 0) return n > 3 ? { kind: "remove", i: ci } : null;
  let best = -1, bd = Infinity;
  for (let k = 0; k < n; k++) {
    const a = z.outline[k], b = z.outline[(k + 1) % n], dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
    if (d < bd) { bd = d; best = k; }
  }
  return bd <= tol ? { kind: "insert", i: best + 1 } : null;
}

/**
 * The zones: a light fill and a dashed border in each one's colour; the selected one (and the one under the
 * pointer) a little stronger, its border solid.
 */
export function paintZones(ctx: CanvasRenderingContext2D, zones: SketchZone[], px: number, sel: string | null, hover: string | null) {
  for (const z of zones) {
    const on = z.id === sel, over = z.id === hover;
    translucentArea(ctx, z.outline, z.color, px, on
      ? { fill: 0.22, border: 2.5, borderAlpha: 1 }
      : { fill: over ? 0.18 : 0.12, border: over ? 2 : 1.5, borderAlpha: 0.9, dash: [6, 4] });
  }
}

/** a zone being drawn: its corners so far and the pointer, filled in its colour, closing back to the first */
export function paintZoneDraft(ctx: CanvasRenderingContext2D, pts: Pt[], cur: Pt | null, color: string, px: number) {
  const all = cur ? [...pts, cur] : pts;
  if (all.length >= 3) translucentArea(ctx, all, color, px, { fill: 0.18, border: 0 });
  if (all.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(all[0].x, all[0].y);
    for (let i = 1; i < all.length; i++) ctx.lineTo(all[i].x, all[i].y);
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]); ctx.stroke(); ctx.setLineDash([]);
  }
}
