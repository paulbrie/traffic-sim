/**
 * A street's name written along it, as on V1's plan map (draw2d's drawStreetNames): letter by letter following the
 * line, reading left to right, light with a dark halo. In screen pixels; used by the lane sketch (V2, ticket #42).
 */
export interface ScreenPt { x: number; y: number }

/** the label's size for a zoom (px per metre), as V1's */
export const streetLabelSize = (scale: number) => Math.round(Math.max(10, Math.min(13, 9 + scale * 0.8)));

/**
 * Writes `name` along the line `pts` (screen px), centred on its middle; nothing if it doesn't fit (with 12 px to spare
 * at each end). `font`: the family. Returns the box the letters cover (for clicks), or null.
 */
export function streetLabel(ctx: CanvasRenderingContext2D, pts: ScreenPt[], name: string, size: number, font: string) {
  if (pts.length < 2 || !name) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const L = cum[cum.length - 1];
  ctx.save();
  ctx.font = `600 ${size}px ${font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round"; ctx.lineWidth = 3;
  const chars = [...name], widths = chars.map(ch => ctx.measureText(ch).width + 0.4), total = widths.reduce((a, b) => a + b, 0);
  if (L < total + 24) { ctx.restore(); return null; }
  // (a point and the direction there, `s` px along)
  let k = 1;
  const at = (s: number) => {
    s = Math.max(0, Math.min(L, s));
    k = Math.max(1, Math.min(k, pts.length - 1));
    while (k < pts.length - 1 && cum[k] < s) k++;
    while (k > 1 && cum[k - 1] > s) k--;
    const a = pts[k - 1], b = pts[k], f = (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, a: Math.atan2(b.y - a.y, b.x - a.x) };
  };
  // read left to right: walk the line backwards when it points leftwards at its middle
  const flip = Math.cos(at(L / 2).a) < 0, dir = flip ? -1 : 1;
  let s = L / 2 - dir * (total / 2);
  const glyphs = chars.map((ch, i) => {
    s += dir * (widths[i] / 2);
    const p = at(s);
    s += dir * (widths[i] / 2);
    return { ...p, a: p.a + (flip ? Math.PI : 0), ch };
  });
  for (const pass of [0, 1]) for (const g of glyphs) {
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.a);
    if (pass === 0) { ctx.strokeStyle = "rgba(20,24,28,0.85)"; ctx.strokeText(g.ch, 0, 0); }
    else { ctx.fillStyle = "#f4f1e8"; ctx.fillText(g.ch, 0, 0); }
    ctx.restore();
  }
  ctx.restore();
  const h = size / 2 + 2;
  return {
    x0: Math.min(...glyphs.map(g => g.x)) - h, y0: Math.min(...glyphs.map(g => g.y)) - h,
    x1: Math.max(...glyphs.map(g => g.x)) + h, y1: Math.max(...glyphs.map(g => g.y)) + h,
  };
}
