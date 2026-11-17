/**
 * The V2 editor's shapes (ticket #268) on its 2D canvas: drawn under the zones and the roads, and the one being
 * drawn. The canvas is in plan metres (the editor's transform); `px` is a pixel in metres.
 */
import type { Pt } from "@/lib/lane-sketch";
import { shapeOpacity, type SketchShape } from "@/lib/sketch-shapes";
import { withAlpha } from "@/render/area-fill";

const outline = (ctx: CanvasRenderingContext2D, pts: Pt[]) => {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
};

/**
 * The shapes, in their order (a later one over an earlier): each filled in its colour at its opacity, its border (metres
 * wide) round it; the selected ones (`sel`) outlined in `selColor`, the one under the pointer in a thin dashed line.
 */
export function paintShapes(ctx: CanvasRenderingContext2D, shapes: SketchShape[], px: number, sel: string[], hover: string | null, selColor: string) {
  ctx.save();
  ctx.setLineDash([]); ctx.lineJoin = "miter"; ctx.miterLimit = 3;
  for (const s of shapes) {
    if (s.outline.length < 3) continue;
    outline(ctx, s.outline);
    ctx.fillStyle = withAlpha(s.color, shapeOpacity(s));
    ctx.fill();
    if (s.border) { ctx.strokeStyle = s.border.color; ctx.lineWidth = s.border.width; ctx.stroke(); }
  }
  for (const s of shapes) {
    const on = sel.includes(s.id);
    if (s.outline.length < 3 || (!on && s.id !== hover)) continue;
    outline(ctx, s.outline);
    ctx.strokeStyle = selColor; ctx.lineWidth = (on ? 2 : 1.5) * px;
    ctx.setLineDash(on ? [] : [5 * px, 3 * px]);
    ctx.stroke();
  }
  ctx.restore();
}

/** a shape being drawn: its points so far and the pointer (or a rectangle or circle being dragged out), in its colour */
export function paintShapeDraft(ctx: CanvasRenderingContext2D, pts: Pt[], cur: Pt | null, color: string, px: number, closed = false) {
  const all = cur ? [...pts, cur] : pts;
  ctx.save();
  if (all.length >= 3) { outline(ctx, all); ctx.fillStyle = withAlpha(color, 0.5); ctx.fill(); }
  if (all.length >= 2) {
    ctx.beginPath();
    ctx.moveTo(all[0].x, all[0].y);
    for (let i = 1; i < all.length; i++) ctx.lineTo(all[i].x, all[i].y);
    if (closed) ctx.closePath();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]); ctx.stroke();
  }
  ctx.restore();
}
