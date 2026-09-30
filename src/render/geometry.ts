/** Static road geometry derived from the compiled network, shared by 2D and 3D renderers. */
import { CURB, LEVEL_H, armEnd, connectorPreview, linkCenter, linkZ, type Arm, type CNode, type Movement, type Compiled, type Edge } from "@/engine/compile";
import { Poly, normAngle } from "@/engine/geom";
import type { LinkDef, MedianKind, Network, Vec } from "@/engine/types";

export interface Strip { left: Poly; right: Poly }
/**
 * What a piece of road drawing belongs to: its elevation level (drawn in level order, lowest first)
 * and the road or junction it sits on (its height in 3D follows that road's profile).
 */
export interface On { lv: number; link?: string; node?: string }
/** hatch = the diagonal paint on a painted median or the space before a turn bay; guide = dashed turn paths through a junction */
export interface LineGeo { poly: Poly; dashed: boolean; kind: "lane" | "center" | "bus" | "hatch" | "guide"; on: On }
export interface RoadGeo {
  /** `z`: height (in levels) at each vertex of `center` (and of the kerb / asphalt edges, which have as many) */
  surfaces: { linkId: string; curb: Strip; asphalt: Strip; center: Poly; on: On; z: Float32Array }[];
  /** the space between the two directions: the median, plus turn bays before they open */
  medians: { linkId: string; kind: MedianKind; strip: Strip; on: On }[];
  /** kerbed islands between slip lanes and the junction corner they cut off */
  islands: { pts: Vec[]; on: On }[];
  /** zebra crossings at traffic lights: one polygon per stripe */
  zebras: { pts: Vec[]; on: On }[];
  /** ring: centre and radius of a roundabout's (outer) circulating lane; `r2` the inner lane of a two-lane one */
  junctions: { nodeId: string; polygon: Vec[]; surface: Vec[]; ring: { c: Vec; r: number; r2?: number } | null; deadEnd: { c: Vec; r: number } | null; on: On }[];
  busBands: (Strip & { on: On })[];
  lines: LineGeo[];
  stopLines: { a: Vec; b: Vec; kind: "stop" | "yield" | "signal" | "priority"; on: On }[];
  arrows: { p: Vec; dir: Vec; turns: string; on: On }[];
  /** the elevation levels in use, lowest first */
  levels: number[];
  /** `lane` set: one head per lane (junctions with custom phases), hung from a mast at `pole` */
  signals: { nodeIdx: number; arm: number; p: Vec; dir: Vec; kind: "lights" | "stop" | "yield"; lane?: number; pole?: Vec }[];
  stops: { id: string; name: string; p: Vec; dir: Vec; color: string; on: On }[];
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

/** length of the taper in front of a turn bay that opens `at` m along its road */
const taper = (at: number) => Math.min(25, Math.max(6, at * 0.4));
const rampStart = (at: number) => Math.max(0, at - taper(at));
/** 0 before a bay's taper, 1 where it is open (s along the edge) */
function bayRamp(at: number, lanes: number) {
  if (!lanes || at <= 0) return () => 1;
  const s0 = rampStart(at);
  return (s: number) => (s <= s0 ? 0 : s >= at ? 1 : (s - s0) / (at - s0));
}
const rampStations = (at: number, lanes: number) => (lanes && at > 0 ? [rampStart(at), at] : []);

/** the polyline with extra vertices at the given arc lengths (so a taper has corners where it starts and ends) */
function withStations(p: Poly, stations: number[]): Poly {
  const inner = stations.filter(s => s > 0.05 && s < p.len - 0.05);
  if (!inner.length) return p;
  const all = [...new Set([...Array.from(p.cum), ...inner])].sort((a, b) => a - b), out: number[] = [];
  for (const s of all) { const q = p.at(s); out.push(q.x, q.y); }
  return new Poly(out);
}

/** offset to the right by a distance that changes along the line (averaged normals, as Poly.offset) */
function offsetBy(p: Poly, d: (s: number) => number): Poly {
  const n = p.count, a = p.pts, out = new Float64Array(n * 2);
  for (let k = 0; k < n; k++) {
    let tx = 0, ty = 0;
    if (k > 0) { const dx = a[2 * k] - a[2 * k - 2], dy = a[2 * k + 1] - a[2 * k - 1], m = Math.hypot(dx, dy) || 1; tx += dx / m; ty += dy / m; }
    if (k < n - 1) { const dx = a[2 * k + 2] - a[2 * k], dy = a[2 * k + 3] - a[2 * k + 1], m = Math.hypot(dx, dy) || 1; tx += dx / m; ty += dy / m; }
    const m = Math.hypot(tx, ty) || 1, off = d(p.cum[k]);
    out[2 * k] = a[2 * k] - (ty / m) * off;
    out[2 * k + 1] = a[2 * k + 1] + (tx / m) * off;
  }
  return new Poly(out);
}

/**
 * The island between a slip lane and the corner of the junction it bypasses: bounded by the slip
 * lane's inner kerb and by the kerbs of the approach and the exit (kept just clear of both roads).
 */
function slipIsland(c: Compiled, e: Edge | null, nodeId: string): Vec[] | null {
  const J = c.nodeById.get(nodeId);
  if (!e || !J) return null;
  const D = e.from.def.id, M = e.to.def.id;
  const at = (id: string) => J.arms.find(a => armEnd(c.nodeById, J, a).def.id === id);
  const aIn = at(D), aOut = at(M);
  if (!aIn || !aOut || aIn === aOut) return null;
  const ec = e.center.slice(e.trimA, Math.max(e.trimA + 0.1, e.center.len - e.trimB));
  const inner = ec.offset(e.base - CURB - 0.25);
  const m = 0.4, rIn = { x: -aIn.u.y, y: aIn.u.x }, rOut = { x: -aOut.u.y, y: aOut.u.x };
  // lateral position across each arm, from the junction centre
  const latIn = (p: Vec) => (p.x - J.pos.x) * rIn.x + (p.y - J.pos.y) * rIn.y, latOut = (p: Vec) => (p.x - J.pos.x) * rOut.x + (p.y - J.pos.y) * rOut.y;
  // the corner: where the approach's right kerb meets the exit's right kerb
  const p1 = { x: J.pos.x + rIn.x * (aIn.lo - m), y: J.pos.y + rIn.y * (aIn.lo - m) }, p2 = { x: J.pos.x + rOut.x * (aOut.hi + m), y: J.pos.y + rOut.y * (aOut.hi + m) };
  const den = aIn.u.x * aOut.u.y - aIn.u.y * aOut.u.x;
  if (Math.abs(den) < 0.05) return null;
  const t = ((p2.x - p1.x) * aOut.u.y - (p2.y - p1.y) * aOut.u.x) / den;
  const corner = { x: p1.x + aIn.u.x * t, y: p1.y + aIn.u.y * t };
  let poly: Vec[] = [];
  for (let k = 0; k < inner.count; k++) poly.push({ x: inner.pts[2 * k], y: inner.pts[2 * k + 1] });
  poly.push(corner);
  poly = clipHalf(poly, p => latIn(p) - (aIn.lo - m));
  poly = clipHalf(poly, p => (aOut.hi + m) - latOut(p));
  if (poly.length < 3) return null;
  let area = 0;
  for (let k = 0; k < poly.length; k++) { const a = poly[k], b = poly[(k + 1) % poly.length]; area += a.x * b.y - b.x * a.y; }
  return Math.abs(area) / 2 > 3 ? poly : null;
}

/** where a lane line (between lanes k-1 and k) of an edge meets the junction: at its end or its start, with the direction of travel */
function edgeEnd(e: Edge, k: number, atEnd: boolean): { at: Vec; t: Vec } {
  const s = atEnd ? e.center.len - e.trimB : e.trimA, p = e.center.at(s), t = e.center.tangent(s), off = e.base + k * e.lw;
  return { at: { x: p.x - t.y * off, y: p.y + t.x * off }, t: { x: t.x, y: t.y } };
}

/** a smooth line from p (heading tp) to q (arriving heading tq) */
function bridge(p: Vec, tp: Vec, q: Vec, tq: Vec): Poly | null {
  const d = Math.hypot(q.x - p.x, q.y - p.y);
  if (d < 1) return null;
  const c1 = { x: p.x + tp.x * d / 3, y: p.y + tp.y * d / 3 }, c2 = { x: q.x - tq.x * d / 3, y: q.y - tq.y * d / 3 }, pts: number[] = [];
  for (let k = 0; k <= 16; k++) {
    const t = k / 16, u = 1 - t;
    pts.push(u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x, u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y);
  }
  return new Poly(pts);
}

/** a point across an arm's mouth (lateral y in the arm's outward right-normal frame) */
function mouth(a: Arm, y: number): Vec {
  return { x: a.mouth.x - a.mu.y * y, y: a.mouth.y + a.mu.x * y };
}

/**
 * The lines painted on a road where it meets a node, as lateral positions in the arm's frame:
 * the centre line (none where there is a median) and the dividers between through lanes.
 */
function armLines(n: CNode, a: Arm, byLink: Map<string, { f: Edge | null; b: Edge | null }>): { y: number; kind: "lane" | "center"; dashed: boolean }[] {
  const es = byLink.get(a.link.id);
  if (!es) return [];
  const flip = a.link.to === n.def.id ? -1 : 1, out: { y: number; kind: "lane" | "center"; dashed: boolean }[] = [];
  const l = a.link;
  if (es.f && es.b && !(l.median ?? 0) && !es.f.left && !es.b.left) {
    if (l.lanesF === 1 && l.lanesB === 1) out.push({ y: 0, kind: "center", dashed: true });
    else out.push({ y: 0.2 * flip, kind: "center", dashed: false }, { y: -0.2 * flip, kind: "center", dashed: false });
  }
  for (const e of [es.f, es.b]) {
    if (!e) continue;
    const toLink = e.dir === 1 ? 1 : -1;
    for (let k = e.left + 1; k < e.left + e.thru; k++) out.push({ y: (e.base + k * e.lw) * toLink * flip, kind: "lane", dashed: !(e.bus && k === e.kerb) });
  }
  return out;
}

/** zebra stripes across a road (lateral lo..hi of direction u from p), between d0 and d1 along it */
function zebra(out: { pts: Vec[]; on: On }[], on: On, p: Vec, u: Vec, lo: number, hi: number, d0: number, d1: number) {
  const r = { x: -u.y, y: u.x }, P = (d: number, y: number) => ({ x: p.x + u.x * d + r.x * y, y: p.y + u.y * d + r.y * y });
  for (let y = lo + 0.5; y + 0.5 <= hi - 0.4; y += 1.1) out.push({ pts: [P(d0, y), P(d1, y), P(d1, y + 0.5), P(d0, y + 0.5)], on });
}

/** the part of a polygon where f(p) <= 0 (Sutherland–Hodgman against one straight edge) */
function clipHalf(poly: Vec[], f: (p: Vec) => number): Vec[] {
  const out: Vec[] = [];
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length], fa = f(a), fb = f(b);
    if (fa <= 0) out.push(a);
    if ((fa <= 0) !== (fb <= 0)) { const t = fa / (fa - fb); out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }); }
  }
  return out;
}

export function buildRoadGeo(c: Compiled, net: Network): RoadGeo {
  const geo: RoadGeo = { surfaces: [], medians: [], islands: [], zebras: [], junctions: [], busBands: [], lines: [], stopLines: [], arrows: [], signals: [], stops: [], levels: [] };
  const byLink = edgesByLink(c);
  const onL = (l: LinkDef): On => ({ lv: l.level ?? 0, link: l.id }), onN = (n: CNode): On => ({ lv: n.level, node: n.def.id });
  for (const link of net.links) {
    const es = byLink.get(link.id); if (!es) continue;
    const on = onL(link);
    const A = c.nodeById.get(link.from)!, B = c.nodeById.get(link.to)!;
    const full = linkCenter(link, A.pos, B.pos);
    const tA = es.f ? es.f.trimA : es.b ? es.b.trimB : 0;
    const tB = es.f ? es.f.trimB : es.b ? es.b.trimA : 0;
    const center0 = full.slice(tA, Math.max(tA + 0.1, full.len - tB)), Lc = center0.len;
    const twoWay = !!es.f && !!es.b;
    // each direction's edges as functions of s along the link (from → to); bays widen the road
    // (kerb side) or eat into the median (centre side) from where they open, after a taper
    const sides = [es.f, es.b].filter((e): e is Edge => !!e).map(e => {
      const sg = e.dir === 1 ? 1 : -1, at = (s: number) => (e.dir === 1 ? s : Lc - s);
      const gL = bayRamp(e.leftAt, e.left), gR = bayRamp(e.rightAt, e.right);
      // a lane that ends: gone (0) past its taper, on the left (centre side) or the right (kerb side)
      const dr = (s: number) => (e.dropLane < 0 ? 1 : s <= e.dropFrom ? 1 : s >= e.dropEnd ? 0 : 1 - (s - e.dropFrom) / Math.max(1e-6, e.dropEnd - e.dropFrom));
      const dropL = e.dropLane >= 0 && e.dropLane === e.left, dropR = e.dropLane >= 0 && !dropL;
      const goneL = (s: number) => (dropL ? (1 - dr(at(s))) * e.lw : 0);
      return {
        e, sg,
        /** centre-side edge of the lanes in use, and the kerb-side edge (lateral, in the edge's own frame) */
        inner: (s: number) => e.base + (twoWay ? 0 : e.left * e.lw * (1 - gL(at(s))) + goneL(s)),
        hatch: (s: number) => (twoWay ? e.left * e.lw * (1 - gL(at(s))) + goneL(s) : 0),
        outer: (s: number) => e.base + (e.left + e.thru - (dropR ? 1 - dr(at(s)) : 0) + e.right * gR(at(s))) * e.lw,
        stations: [...rampStations(e.leftAt, e.left), ...rampStations(e.rightAt, e.right), ...(e.dropLane >= 0 ? [e.dropFrom, e.dropEnd] : [])].map(x => at(x)),
      };
    });
    // a road that climbs (a bridge) gets a vertex every few metres so its height profile shows
    const climb = (link.level ?? 0) !== 0 ? Array.from({ length: Math.floor(Lc / 4) }, (_, k) => (k + 1) * 4) : [];
    const center = withStations(center0, [...sides.flatMap(x => x.stations), ...climb]);
    // lateral edges of the asphalt in the link frame (right-normal of from → to)
    const lo = (s: number) => Math.min(...sides.map(x => (x.sg > 0 ? x.inner(s) : -x.outer(s)))), hi = (s: number) => Math.max(...sides.map(x => (x.sg > 0 ? x.outer(s) : -x.inner(s))));
    geo.surfaces.push({
      linkId: link.id, center,
      curb: { left: offsetBy(center, s => lo(s) - CURB), right: offsetBy(center, s => hi(s) + CURB) },
      asphalt: { left: offsetBy(center, lo), right: offsetBy(center, hi) }, on,
      z: Float32Array.from(center.cum, s => linkZ(c, link, (tA + s) / Math.max(1e-6, full.len), full.len)),
    });
    if (twoWay) {
      const f = sides.find(x => x.sg > 0)!, b = sides.find(x => x.sg < 0)!, m = link.median ?? 0;
      const hasMedian = m > 0 || f.e.left > 0 || b.e.left > 0 || (f.e.dropLane >= 0 && f.e.dropLane === f.e.left) || (b.e.dropLane >= 0 && b.e.dropLane === b.e.left);
      if (!hasMedian) {
        if (link.lanesF === 1 && link.lanesB === 1) geo.lines.push({ poly: center, dashed: true, kind: "center", on });
        else { geo.lines.push({ poly: center.offset(0.2), dashed: false, kind: "center", on }, { poly: center.offset(-0.2), dashed: false, kind: "center", on }); }
      } else {
        // where a slip lane leaves or joins (a 3-way point with the road running straight on, median
        // and all), the median carries on through instead of stopping at the junction area
        const through = (n: CNode) => n.degree === 3 && !n.ringR && n.arms.some(o => o.link !== link && (o.link.median ?? 0) > 0 && Math.abs(normAngle(o.angle - n.arms.find(x => x.link === link)!.angle)) > 2.8);
        const eA = through(A) ? 0 : tA, eB = through(B) ? 0 : tB, shift = tA - eA;
        const mc = eA === tA && eB === tB ? center : withStations(full.slice(eA, Math.max(eA + 0.1, full.len - eB)), sides.flatMap(x => x.stations).map(x => x + shift));
        const left = offsetBy(mc, s => -(m / 2 + b.hatch(s - shift))), right = offsetBy(mc, s => m / 2 + f.hatch(s - shift));
        const kind: MedianKind = link.medianKind === "raised" && m > 0 ? "raised" : "painted";
        geo.medians.push({ linkId: link.id, kind, strip: { left, right }, on });
        if (kind === "painted") {
          geo.lines.push({ poly: left, dashed: false, kind: "center", on }, { poly: right, dashed: false, kind: "center", on });
          // diagonal hatching wherever the strip is wide enough to see
          for (let s = 1.5; s < Lc - 1; s += 4) {
            const a = -(m / 2 + b.hatch(s)), z = m / 2 + f.hatch(s + 1);
            if (z - a < 0.6) continue;
            const p = center.at(s), t = center.tangent(s), q = center.at(Math.min(Lc, s + 1.5 + (z - a) * 0.5)), tq = center.tangent(Math.min(Lc, s + 1.5 + (z - a) * 0.5));
            geo.lines.push({ poly: new Poly([p.x - t.y * (a + 0.15), p.y + t.x * (a + 0.15), q.x - tq.y * (z - 0.15), q.y + tq.x * (z - 0.15)]), dashed: false, kind: "hatch", on });
          }
        }
      }
    }
    for (const e of [es.f, es.b]) {
      if (!e) continue;
      const ec = e.center.slice(e.trimA, Math.max(e.trimA + 0.1, e.center.len - e.trimB));
      for (let k = 1; k < e.n; k++) {
        const busSep = e.bus && k === e.kerb;
        // lines beside a turn bay start where it opens (the one against the through lanes at the taper)
        const from = k < e.left ? e.leftAt : k === e.left ? rampStart(e.leftAt) : k > e.left + e.thru ? e.rightAt : k === e.left + e.thru ? rampStart(e.rightAt) : 0;
        if (from >= ec.len - 1) continue;
        // the line beside a lane that ends stops where it starts to narrow (the taper takes over)
        if (e.dropLane >= 0 && k === (e.dropLane === e.left ? e.dropLane + 1 : e.dropLane)) {
          if (e.dropFrom > from + 1) geo.lines.push({ poly: ec.slice(from, e.dropFrom).offset(e.base + k * e.lw), dashed: true, kind: "lane", on });
          continue;
        }
        const off = e.base + k * e.lw;
        // the last metres before a junction's stop line are solid (no changing lanes there)
        const solid = e.to.controlled && !e.to.ringR && e.to.degree >= 2 && ec.len > 30 ? Math.min(20, ec.len * 0.3) : 0;
        const cut = Math.max(from, ec.len - solid);
        if (busSep || !solid) geo.lines.push({ poly: (from > 0 ? ec.slice(from, ec.len) : ec).offset(off), dashed: !busSep, kind: busSep ? "bus" : "lane", on });
        else {
          if (cut > from + 1) geo.lines.push({ poly: ec.slice(from, cut).offset(off), dashed: true, kind: "lane", on });
          geo.lines.push({ poly: ec.slice(cut, ec.len).offset(off), dashed: false, kind: "lane", on });
        }
      }
      if (e.bus || e.busOnly) geo.busBands.push({ left: ec.offset(e.base + e.kerb * e.lw + 0.15), right: ec.offset(e.base + (e.kerb + 1) * e.lw - 0.1), on });
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
        // (without a lane that has ended by the line)
        const b0 = e.base + 0.2 + (e.dropLane >= 0 && e.dropLane === e.left ? e.lw : 0), b1 = e.base + e.n * e.lw - 0.2 - (e.dropLane >= 0 && e.dropLane !== e.left ? e.lw : 0);
        // roads with right of way (no sign at a priority junction) have no line across them
        if (kind !== "priority") geo.stopLines.push({ a: { x: end.x + r.x * b0, y: end.y + r.y * b0 }, b: { x: end.x + r.x * b1, y: end.y + r.y * b1 }, kind, on });
        const arm = e.inArm;
        if (kind === "signal" && arm >= 0 && node.customPhases) {
          const off = e.base + e.n * e.lw + 1.4, pole = { x: end.x + r.x * off - t.x * 0.8, y: end.y + r.y * off - t.y * 0.8 };
          for (let k = 0; k < e.n; k++) {
            const lo = e.base + (k + 0.5) * e.lw;
            geo.signals.push({ nodeIdx: node.idx, arm, lane: k, pole, p: { x: end.x + r.x * lo - t.x * 1.4, y: end.y + r.y * lo - t.y * 1.4 }, dir: t, kind: "lights" });
          }
        } else if ((kind === "signal" || kind === "stop" || (kind === "yield" && signed)) && arm >= 0) {
          const off = e.base + e.n * e.lw + 1.4;
          geo.signals.push({ nodeIdx: node.idx, arm, p: { x: end.x + r.x * off - t.x * 0.8, y: end.y + r.y * off - t.y * 0.8 }, dir: t, kind: kind === "signal" ? "lights" : kind === "yield" ? "yield" : "stop" });
        }
        const moves = node.moves.get(e.idx) || [];
        if (moves.length > 1 && ec.len > 18) {
          for (let k = 0; k < e.n; k++) {
            if (k === e.dropLane) continue;
            const turns = moves.filter(m => k >= m.lo && k <= m.hi).map(m => m.turn).join("");
            const s = ec.len - 9, p = ec.at(s), tt = ec.tangent(s), off = e.base + (k + 0.5) * e.lw;
            geo.arrows.push({ p: { x: p.x - tt.y * off, y: p.y + tt.x * off }, dir: tt, turns, on });
          }
        }
      }
    }
  }
  for (const l of net.links) {
    const isl = l.slip ? slipIsland(c, byLink.get(l.id)?.f ?? null, l.slip) : null;
    if (isl) geo.islands.push({ pts: isl, on: onL(l) });
  }
  // where traffic goes straight on through a 3-way junction without lights (a slip road joining or
  // leaving, a road splitting into two carriageways), the lane lines carry on across it…
  for (const n of c.nodes) {
    if (n.degree !== 3 || n.ringR || n.def.control === "lights") continue;
    // merges into a road where one of the joining roads gives way (a sign)
    const signedInto = new Set<Edge>();
    for (const list of n.moves.values()) for (const m of list) if (m.merge && m.in.sign) signedInto.add(m.out);
    for (const list of n.moves.values()) for (const m of list) {
      if (m.turn !== "S" || Math.abs(m.delta) > 0.6) continue;
      // at a merge only the priority road's lines carry on: not the one giving way, nor (with no sign
      // at all) the one joining from the right
      if (m.merge && (m.in.sign || (m.merge === "right" && !signedInto.has(m.out)))) continue;
      const k = Math.min(m.in.thru, m.out.thru);
      for (let j = 1; j < k; j++) {
        const p = edgeEnd(m.in, m.in.left + j, true), q = edgeEnd(m.out, m.out.left + j, false);
        const line = bridge(p.at, p.t, q.at, q.t);
        if (line) geo.lines.push({ poly: line, dashed: true, kind: "lane", on: onN(n) });
      }
    }
    // a merge where one road gives way (a sign): the priority road's edge on that side carries on
    // across the junction as a broken line, which the joining traffic crosses once it may go
    if (n.def.control === "priority") {
      const into = new Map<Edge, { major?: Movement; minor?: Movement }>();
      for (const list of n.moves.values()) for (const m of list) {
        if (!m.merge) continue;
        const r = into.get(m.out) ?? into.set(m.out, {}).get(m.out)!;
        if (m.in.sign) r.minor = m; else r.major = m;
      }
      for (const [out, { major, minor }] of into) {
        if (!major || !minor || minor.merge === major.merge) continue;
        const right = minor.merge === "right";
        const p = edgeEnd(major.in, right ? major.in.left + major.in.thru : major.in.left, true), q = edgeEnd(out, right ? out.left + out.thru : out.left, false);
        const line = bridge(p.at, p.t, q.at, q.t);
        if (line) geo.lines.push({ poly: line, dashed: true, kind: "lane", on: onN(n) });
      }
    }
    // …and so does the centre line where a two-way road runs on as a two-way road
    let best: { i: number; j: number; d: number } | null = null;
    const center = n.arms.map(a => armLines(n, a, byLink).filter(x => x.kind === "center"));
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const d = Math.abs(normAngle(n.arms[i].angle - n.arms[j].angle));
      if (d > 2.6 && center[i].length && center[j].length && (!best || d > best.d)) best = { i, j, d };
    }
    if (!best) {
      // a two-way road splitting into two one-way carriageways: its centre line runs to the nose between them
      const i = center.findIndex(x => x.length > 0);
      if (i < 0) continue;
      const a = n.arms[i], others = n.arms.filter(o => o !== a);
      if (!others.every(o => center[n.arms.indexOf(o)].length === 0 && Math.abs(normAngle(o.angle - a.angle)) > 2.3)) continue;
      let nose: Vec | null = null, nd = Infinity;
      for (const y1 of [others[0].lo, others[0].hi]) for (const y2 of [others[1].lo, others[1].hi]) {
        const p1 = mouth(others[0], y1), p2 = mouth(others[1], y2), d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (d < nd) { nd = d; nose = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }; }
      }
      if (!nose) continue;
      const dir = { x: (others[0].mu.x + others[1].mu.x) / 2, y: (others[0].mu.y + others[1].mu.y) / 2 }, dl = Math.hypot(dir.x, dir.y) || 1;
      for (const x of center[i]) {
        const line = bridge(mouth(a, x.y), { x: -a.mu.x, y: -a.mu.y }, nose, { x: dir.x / dl, y: dir.y / dl });
        if (line) geo.lines.push({ poly: line, dashed: x.dashed, kind: "center", on: onN(n) });
      }
      continue;
    }
    const a = n.arms[best.i], b = n.arms[best.j];
    for (const x of center[best.i]) {
      const y = center[best.j].find(z => Math.abs(z.y + x.y) < 0.6);
      if (!y) continue;
      const line = bridge(mouth(a, x.y), { x: -a.mu.x, y: -a.mu.y }, mouth(b, y.y), b.mu);
      if (line) geo.lines.push({ poly: line, dashed: x.dashed, kind: "center", on: onN(n) });
    }
  }
  // zebra crossings where traffic lights stop the traffic: across each arm just past its stop line
  // (a lit crossing on a plain road: one across the road at the node)
  for (const n of c.nodes) {
    if (!n.controlled || n.ringR || (n.def.control !== "lights" && !n.peds)) continue;
    if (n.degree === 2) { const a = n.arms[0]; zebra(geo.zebras, onN(n), n.pos, a.u, a.lo, a.hi, -1.5, 1.5); continue; }
    for (const a of n.arms) if (a.setback > 5) zebra(geo.zebras, onN(n), a.mouth, a.mu, a.lo, a.hi, -3.6, -0.6);
  }
  // guide lines for left turns through big lit junctions: the edges of each left-turn lane's path
  for (const v of connectorPreview(c, (n, m) => n.def.control === "lights" && n.degree >= 3 && m.turn === "L")) {
    const p = new Poly(v.pts), half = v.move.in.lw / 2;
    if (p.len < 8) continue;
    geo.lines.push({ poly: p.offset(half), dashed: true, kind: "guide", on: onN(v.node) });
    if (v.inLane === v.move.lo) geo.lines.push({ poly: p.offset(-half), dashed: true, kind: "guide", on: onN(v.node) });
  }
  // two-lane roundabouts: a dashed line between the circulating lanes
  for (const n of c.nodes) if (n.ring2) {
    const r = (n.ringR + n.ringR2) / 2, pts: number[] = [];
    for (let k = 0; k <= 96; k++) { const th = (k / 96) * Math.PI * 2; pts.push(n.pos.x + r * Math.cos(th), n.pos.y + r * Math.sin(th)); }
    geo.lines.push({ poly: new Poly(pts), dashed: true, kind: "lane", on: onN(n) });
  }
  for (const n of c.nodes) {
    if (n.degree === 0) continue;
    const w = Math.max(...n.arms.map(a => a.w));
    geo.junctions.push({
      nodeId: n.def.id,
      polygon: n.degree >= 2 ? n.polygon : [], surface: n.degree >= 2 ? n.surface : [],
      ring: n.ringR > 0 ? { c: n.pos, r: n.ringR, ...(n.ring2 ? { r2: n.ringR2 } : {}) } : null,
      deadEnd: n.deadEnd ? { c: { x: n.pos.x - n.arms[0].u.x * 1, y: n.pos.y - n.arms[0].u.y * 1 }, r: Math.max(6.5, w + 0.5) } : null,
      on: onN(n),
    });
  }
  const lineColor = new Map<string, string>();
  for (const l of net.lines) for (const s of l.stops) if (!lineColor.has(s)) lineColor.set(s, l.color);
  for (const s of c.stops) {
    const e = s.edge, lane = e.lanes[e.kerb], sOn = s.s * (lane.len / Math.max(1e-6, e.length));
    const p = lane.poly.at(sOn), t = lane.poly.tangent(sOn), off = e.lw / 2 + 1.6;
    geo.stops.push({ id: s.def.id, name: s.def.name, p: { x: p.x - t.y * off, y: p.y + t.x * off }, dir: t, color: lineColor.get(s.def.id) ?? "#888888", on: onL(e.link) });
  }
  geo.levels = [...new Set([...geo.surfaces.map(x => x.on.lv), ...geo.junctions.map(x => x.on.lv)])].sort((a, b) => a - b);
  if (!geo.levels.length) geo.levels = [0];
  return geo;
}

/**
 * Heights (m) for 3D: at a point of a road (following its profile between its junctions) or of a
 * junction. Plans with every road at ground level answer 0 straight away.
 */
export function heightFn(c: Compiled, net: Network) {
  const flat = c.nodes.every(n => n.level === 0) && net.links.every(l => !l.level);
  const links = new Map(net.links.map(l => [l.id, l])), centers = new Map<string, Poly>();
  const centerOf = (l: LinkDef) => {
    let p = centers.get(l.id);
    if (!p) { const A = c.nodeById.get(l.from), B = c.nodeById.get(l.to); p = A && B ? linkCenter(l, A.pos, B.pos) : new Poly([0, 0, 0, 0]); centers.set(l.id, p); }
    return p;
  };
  const at = (on: On, x: number, y: number): number => {
    if (flat) return 0;
    if (on.node) return (c.nodeById.get(on.node)?.level ?? 0) * LEVEL_H;
    const l = on.link ? links.get(on.link) : undefined;
    if (!l) return 0;
    const p = centerOf(l);
    return linkZ(c, l, p.project(x, y).s / Math.max(1e-6, p.len), p.len) * LEVEL_H;
  };
  const node = (idx: number) => (flat ? 0 : (c.nodes[idx]?.level ?? 0) * LEVEL_H);
  return { flat, at, node };
}
export type HeightFn = ReturnType<typeof heightFn>;
