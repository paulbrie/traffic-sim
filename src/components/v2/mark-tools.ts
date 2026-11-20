/**
 * The V2 editor's marks (ticket #289) on its 2D canvas: pins the same size on screen at any zoom, their tip on the
 * place, their name beside the head; over everything else. Drawn in screen pixels (`toScreen`), the canvas's
 * transform set aside.
 */
import type { Pt } from "@/lib/lane-sketch";
import { PIN, type SketchMark } from "@/lib/sketch-marks";

export function paintMarks(ctx: CanvasRenderingContext2D, marks: SketchMark[], toScreen: (p: Pt) => Pt, dpr: number,
  sel: string | null, hover: string | null, col: { sel: string; pill: string; fg: string }) {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.setLineDash([]);
  // (the selected one last, over the others)
  const order = [...marks.filter(m => m.id !== sel), ...marks.filter(m => m.id === sel)];
  for (const m of order) {
    const t = toScreen(m.at), on = m.id === sel, over = m.id === hover;
    const hx = t.x, hy = t.y - PIN.rise, r = PIN.head;
    // (its shadow on the ground, then the pin: a teardrop from the head down to the tip)
    ctx.beginPath(); ctx.ellipse(t.x, t.y, 4, 1.6, 0, 0, Math.PI * 2); ctx.fillStyle = "rgba(0,0,0,0.3)"; ctx.fill();
    const a = Math.asin(r / (t.y - hy));
    ctx.beginPath();
    ctx.moveTo(t.x, t.y);
    ctx.arc(hx, hy, r, Math.PI / 2 + a, Math.PI / 2 - a + 2 * Math.PI);
    ctx.closePath();
    ctx.fillStyle = m.color; ctx.fill();
    ctx.lineWidth = on ? 2.5 : 1.5; ctx.strokeStyle = on ? col.sel : "rgba(255,255,255,0.95)"; ctx.stroke();
    if (on || over) { ctx.beginPath(); ctx.arc(hx, hy, r + 4, 0, Math.PI * 2); ctx.lineWidth = on ? 2 : 1.5; ctx.strokeStyle = col.sel; if (!on) ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]); }
    ctx.beginPath(); ctx.arc(hx, hy, r * 0.38, 0, Math.PI * 2); ctx.fillStyle = "#fff"; ctx.fill();
    // (its name, to the right of the head)
    if (m.name) {
      ctx.font = `${on ? 600 : 500} 11px ui-sans-serif, system-ui, sans-serif`;
      const tw = ctx.measureText(m.name).width, x0 = hx + r + 5;
      ctx.fillStyle = col.pill; ctx.beginPath(); ctx.roundRect(x0, hy - 9, tw + 10, 18, 4); ctx.fill();
      ctx.fillStyle = on ? col.sel : col.fg; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(m.name, x0 + 5, hy + 0.5);
    }
  }
  ctx.restore();
}
