/**
 * A translucent area on the plan's 2D canvas (the V2 editor): a light fill in its colour and its border,
 * dashed or not. Shared by the zones (T129) and a junction's fill while it is edited (T130). The canvas is
 * in plan metres (its transform set by the caller); `px` is a pixel in metres, so line widths and dashes
 * stay the same on screen at any zoom.
 */
import type { Pt } from "@/lib/lane-sketch";

/** "#rrggbb" (or "#rgb") as rgba() with this alpha; anything else is returned as it is */
export function withAlpha(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export interface AreaStyle {
  /** the fill's opacity (0: none) */
  fill: number;
  /** the border's width in pixels (0: none) and its opacity */
  border?: number;
  borderAlpha?: number;
  /** the border's dash in pixels, e.g. [6, 4]; none: solid */
  dash?: number[];
}

/** the area inside `pts` (closed), filled and outlined in `color` */
export function translucentArea(ctx: CanvasRenderingContext2D, pts: Pt[], color: string, px: number, style: AreaStyle): void {
  if (pts.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  if (style.fill > 0) {
    ctx.fillStyle = withAlpha(color, style.fill);
    ctx.fill();
  }
  if (style.border) {
    ctx.strokeStyle = withAlpha(color, style.borderAlpha ?? 1);
    ctx.lineWidth = style.border * px;
    ctx.setLineDash(style.dash ? style.dash.map(d => d * px) : []);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}
