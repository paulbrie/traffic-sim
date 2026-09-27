/** Static road geometry derived from the compiled network, shared by 2D and 3D renderers. */
import { CURB, LW, linkCenter, linkExtent, type Compiled, type Edge } from "@/engine/compile";
import type { Poly } from "@/engine/geom";
import type { Network, Vec } from "@/engine/types";

export interface Strip { left: Poly; right: Poly }
export interface LineGeo { poly: Poly; dashed: boolean; kind: "lane" | "center" | "bus" }
export interface RoadGeo {
  surfaces: { linkId: string; curb: Strip; asphalt: Strip; center: Poly }[];
  junctions: { nodeId: string; polygon: Vec[]; ring: { c: Vec; r: number } | null; deadEnd: { c: Vec; r: number } | null }[];
  busBands: Strip[];
  lines: LineGeo[];
  stopLines: { a: Vec; b: Vec; kind: "stop" | "yield" | "signal" | "priority" }[];
  arrows: { p: Vec; dir: Vec; turns: string }[];
  signals: { nodeIdx: number; arm: number; p: Vec; dir: Vec; kind: "lights" | "stop" | "yield" }[];
  stops: { id: string; name: string; p: Vec; dir: Vec; color: string }[];
}

export function edgesByLink(c: Compiled) {
  const m = new Map<string, { f: Edge | null; b: Edge | null }>();
  for (const e of c.edges) {
    const r = m.get(e.link.id) ?? { f: null, b: null };
    if (e.dir === 1) r.f = e; else r.b = e;
    m.set(e.link.id, r);
  }
  return m;
}

export function buildRoadGeo(c: Compiled, net: Network): RoadGeo {
  const geo: RoadGeo = { surfaces: [], junctions: [], busBands: [], lines: [], stopLines: [], arrows: [], signals: [], stops: [] };
  const byLink = edgesByLink(c);
  for (const link of net.links) {
    const es = byLink.get(link.id); if (!es) continue;
    const A = c.nodeById.get(link.from)!, B = c.nodeById.get(link.to)!;
    const full = linkCenter(link, A.pos, B.pos);
    const tA = es.f ? es.f.trimA : es.b ? es.b.trimB : 0;
    const tB = es.f ? es.f.trimB : es.b ? es.b.trimA : 0;
    const center = full.slice(tA, Math.max(tA + 0.1, full.len - tB));
    const [lo, hi] = linkExtent(link);
    geo.surfaces.push({
      linkId: link.id, center,
      curb: { left: center.offset(lo), right: center.offset(hi) },
      asphalt: { left: center.offset(lo + CURB), right: center.offset(hi - CURB) },
    });
    if (link.lanesF > 0 && link.lanesB > 0) {
      if (link.lanesF === 1 && link.lanesB === 1) geo.lines.push({ poly: center, dashed: true, kind: "center" });
      else { geo.lines.push({ poly: center.offset(0.2), dashed: false, kind: "center" }, { poly: center.offset(-0.2), dashed: false, kind: "center" }); }
    }
    for (const e of [es.f, es.b]) {
      if (!e) continue;
      const ec = e.center.slice(e.trimA, Math.max(e.trimA + 0.1, e.center.len - e.trimB));
      for (let k = 1; k < e.n; k++) {
        const busSep = e.bus && k === e.n - 1;
        geo.lines.push({ poly: ec.offset(e.base + k * LW), dashed: !busSep, kind: busSep ? "bus" : "lane" });
      }
      if (e.bus || e.busOnly) geo.busBands.push({ left: ec.offset(e.base + (e.n - 1) * LW + 0.15), right: ec.offset(e.base + e.n * LW - 0.1) });
      // stop / yield line and lane arrows where the edge meets a junction
      const node = e.to;
      if (node.controlled && !node.deadEnd) {
        const end = ec.at(ec.len), t = ec.tangent(ec.len), r = { x: -t.y, y: t.x };
        const ctl = node.def.control;
        const kind = node.ringR > 0 ? "yield"
          : ctl === "stop" && node.degree >= 2 ? "stop"
            : ctl === "lights" && node.degree >= 2 ? "signal"
              : ctl === "priority" && e.sign === "stop" ? "stop"
                : ctl === "priority" && e.sign === "yield" ? "yield" : "priority";
        const signed = ctl === "priority" && !!e.sign;
        const b0 = e.base + 0.2, b1 = e.base + e.n * LW - 0.2;
        geo.stopLines.push({ a: { x: end.x + r.x * b0, y: end.y + r.y * b0 }, b: { x: end.x + r.x * b1, y: end.y + r.y * b1 }, kind });
        const arm = node.arms.findIndex(a => a.inEdge === e);
        if ((kind === "signal" || kind === "stop" || (kind === "yield" && signed)) && arm >= 0) {
          const off = e.base + e.n * LW + 1.4;
          geo.signals.push({ nodeIdx: node.idx, arm, p: { x: end.x + r.x * off - t.x * 0.8, y: end.y + r.y * off - t.y * 0.8 }, dir: t, kind: kind === "signal" ? "lights" : kind === "yield" ? "yield" : "stop" });
        }
        const moves = node.moves.get(e.idx) || [];
        if (moves.length > 1 && ec.len > 18) {
          for (let k = 0; k < e.n; k++) {
            const turns = moves.filter(m => k >= m.lo && k <= m.hi).map(m => m.turn).join("");
            const s = ec.len - 9, p = ec.at(s), tt = ec.tangent(s), off = e.base + (k + 0.5) * LW;
            geo.arrows.push({ p: { x: p.x - tt.y * off, y: p.y + tt.x * off }, dir: tt, turns });
          }
        }
      }
    }
  }
  for (const n of c.nodes) {
    if (n.degree === 0) continue;
    const w = Math.max(...n.arms.map(a => a.w));
    geo.junctions.push({
      nodeId: n.def.id,
      polygon: n.degree >= 2 ? n.polygon : [],
      ring: n.ringR > 0 ? { c: n.pos, r: n.ringR } : null,
      deadEnd: n.deadEnd ? { c: { x: n.pos.x - n.arms[0].u.x * 1, y: n.pos.y - n.arms[0].u.y * 1 }, r: Math.max(6.5, w + 0.5) } : null,
    });
  }
  const lineColor = new Map<string, string>();
  for (const l of net.lines) for (const s of l.stops) if (!lineColor.has(s)) lineColor.set(s, l.color);
  for (const s of c.stops) {
    const e = s.edge, lane = e.lanes[e.n - 1], sOn = s.s * (lane.len / Math.max(1e-6, e.length));
    const p = lane.poly.at(sOn), t = lane.poly.tangent(sOn), off = LW / 2 + 1.6;
    geo.stops.push({ id: s.def.id, name: s.def.name, p: { x: p.x - t.y * off, y: p.y + t.x * off }, dir: t, color: lineColor.get(s.def.id) ?? "#888888" });
  }
  return geo;
}
