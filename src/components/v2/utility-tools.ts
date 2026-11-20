/**
 * The V2 editor's utility networks (ticket #280) on its 2D canvas: each line in its network's colour, its pipes or
 * cables side by side when zoomed in enough to tell them apart, buried ones dashed; its nodes as dots (hollow buried,
 * filled above the ground); and the line being drawn. The canvas is in plan metres (the editor's transform); `px` is a
 * pixel in metres.
 */
import type { Pt, Sketch } from "@/lib/lane-sketch";
import { linePts, lineCount, NET_INFO, netShown, nodeMap, nodesOf, linesOf, offsetPolyline, strandOffsets, strandWidth, strandSpacing, type UtilityDraftPt, type UtilityLayer, type UtilityNet } from "@/lib/sketch-utilities";

const stroke = (ctx: CanvasRenderingContext2D, pts: Pt[]) => {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.stroke();
};

/**
 * The networks shown (`layers`): their lines, then their nodes (from 1.5 px a metre, or on the lines selected). The
 * selected lines (`sel`) with a halo in `selColor`, the one under the pointer a thin dashed one, the node picked ringed.
 */
export function paintUtilities(ctx: CanvasRenderingContext2D, sk: Sketch, layers: Partial<Record<UtilityLayer, boolean>>, px: number, sel: string[], hover: string | null, picked: string | null, selColor: string) {
  const lines = linesOf(sk).filter(l => netShown(layers, l.net));
  if (!lines.length) return;
  const map = nodeMap(sk), scale = 1 / px;
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  // (the selected and hovered lines' halo, under them)
  for (const l of lines) {
    const on = sel.includes(l.id);
    if (!on && l.id !== hover) continue;
    const pts = linePts(sk, l, map);
    if (pts.length < 2) continue;
    const span = (lineCount(l) - 1) * strandSpacing(l) + strandWidth(l);
    ctx.strokeStyle = selColor; ctx.globalAlpha = on ? 0.45 : 0.3;
    ctx.lineWidth = Math.max(span, 4 * px) + (on ? 7 : 5) * px;
    ctx.setLineDash(on ? [] : [5 * px, 3 * px]);
    stroke(ctx, pts);
  }
  ctx.globalAlpha = 1;
  for (const l of lines) {
    const pts = linePts(sk, l, map);
    if (pts.length < 2) continue;
    const info = NET_INFO[l.net], w = strandWidth(l), offs = strandOffsets(l);
    // (its strands apart only where they are 3 px apart or more: else one line as wide as them all)
    const apart = offs.length > 1 && strandSpacing(l) * scale >= 3;
    const runs = apart ? offs.map(o => offsetPolyline(pts, o)) : [pts];
    const width = apart ? Math.max(w, 1.5 * px) : Math.max(w + (offs.length - 1) * strandSpacing(l), (offs.length > 1 ? 3 : 2) * px);
    const dash = l.buried ? [Math.max(width * 2.5, 7 * px), Math.max(width * 1.5, 4 * px)] : [];
    for (const r of runs) {
      // (a light casing first, so it reads on asphalt, imagery and grass alike)
      ctx.setLineDash(dash); ctx.lineDashOffset = 0;
      ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = width + 2 * px; stroke(ctx, r);
      ctx.strokeStyle = info.color; ctx.lineWidth = width; stroke(ctx, r);
    }
  }
  ctx.setLineDash([]);
  // nodes: a dot each (bigger where lines join), hollow below the ground and filled above it
  const used = new Map<string, number>();
  for (const l of lines) for (const n of new Set(l.nodes)) used.set(n, (used.get(n) ?? 0) + 1);
  const selNodes = new Set(lines.filter(l => sel.includes(l.id)).flatMap(l => l.nodes));
  for (const n of nodesOf(sk)) {
    if (!used.has(n.id) || (scale < 1.5 && !selNodes.has(n.id) && n.id !== picked)) continue;
    const join = (used.get(n.id) ?? 0) > 1, r = (join ? 4 : 2.75) * px, c = NET_INFO[n.net].color;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = n.z < 0 ? "#ffffff" : c; ctx.fill();
    ctx.strokeStyle = n.z < 0 ? c : "#ffffff"; ctx.lineWidth = 1.5 * px; ctx.stroke();
    if (n.id === picked) { ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5 * px, 0, Math.PI * 2); ctx.strokeStyle = selColor; ctx.lineWidth = 2 * px; ctx.stroke(); }
  }
  ctx.restore();
}

/** a utility line being drawn: its points so far and on to the pointer, in its network's colour (dashed if buried), the nodes it joins ringed */
export function paintUtilityDraft(ctx: CanvasRenderingContext2D, pts: UtilityDraftPt[], cur: UtilityDraftPt | null, net: UtilityNet, buried: boolean, px: number) {
  const all = cur ? [...pts, cur] : pts, c = NET_INFO[net].color;
  if (!all.length) return;
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  if (all.length >= 2) {
    ctx.setLineDash(buried ? [8 * px, 5 * px] : []);
    ctx.strokeStyle = "rgba(255,255,255,0.8)"; ctx.lineWidth = 4.5 * px; stroke(ctx, all.map(q => q.p));
    ctx.strokeStyle = c; ctx.lineWidth = 2.5 * px; stroke(ctx, all.map(q => q.p));
    ctx.setLineDash([]);
  }
  for (const q of all) {
    const joins = !!(q.node || q.on);
    ctx.beginPath(); ctx.arc(q.p.x, q.p.y, (joins ? 5 : 3) * px, 0, Math.PI * 2);
    ctx.fillStyle = joins ? c : "#ffffff"; ctx.fill(); ctx.strokeStyle = joins ? "#ffffff" : c; ctx.lineWidth = 1.5 * px; ctx.stroke();
  }
  ctx.restore();
}
