/**
 * The spatial driving experiment (T213; any junction since ticket #59): the map a car senses. The sketch's drivable surface round
 * each junction traffic goes through (its paving, the lanes near it), rasterised, with a distance to the nearest edge per cell so
 * a ray marches in a few long steps. A junction's ground is as the editor draws it: a drawn one its border, an automatic one its
 * bands; inside a ring lane on it (the junction's own or a road's) an island, unpaved. Each junction is a zone: a roundabout if
 * its paving goes all the way round an island (its middle, the carriageway's width, which way round traffic goes: its ring lanes'
 * way, else from the arms' roads: the country's side of the road), and per way out a route field over its grid: the shortest
 * way there over the paving, off the kerbs, round an island only the ring's way, which any shape of junction or island has.
 * Read only: built from the sketch with the editor's own geometry helpers, nothing changed.
 * No framework: runs in a worker or headless.
 */
import { bandPolygon, contentsOf, hasLevels, insidePolygon, isFullCircle, junctionBands, junctionLevel, laneById, nearestOn, outlinePath, pointAt, laneLength, samples, zAt, type Band, type Pt, type Sketch, type SketchJunction, type SketchLane } from "../../lane-sketch";
import { junctionSurfaceHoles, nestLoops } from "../../junction-fill";

/** raster cell (m) */
export const CELL = 0.25;
/** ground taken round a junction (m): the arms' lanes this far out are mapped too */
const MARGIN = 35;
/** an island this far from round (its reach's spread over its median) is driven round by route fields, not by angle */
const ROUND = 0.35;
/** a junction's route fields: cell (m), and the ground round its border they cover (m) */
export const FCELL = 0.5;
const FPAD = 12;

/** a roundabout's island: its middle, which way round traffic goes, the carriageway's width round it */
export interface Island {
  c: Pt;
  /** +1: traffic goes round with the angle growing (atan2), -1: the other way */
  sense: 1 | -1;
  width: number;
  /**
   * a round island (its reach from the middle the same within ROUND of its median all round): per degree of angle round the
   * middle, where the island ends and the carriageway round it ends (m from the middle); cars go round it by these (as since
   * T213), not by a route field. Null: not round (an oval, say), the route fields take them round.
   */
  polar: { rIn: Float32Array; rOut: Float32Array } | null;
}
/**
 * A junction the experiment drives (T213, ticket #59: any junction, a roundabout or not): its connectors and lanes (entering it
 * means leaving the lane follower), its island if it is a roundabout, and its own grid (FCELL m) over its ground and the arms
 * near it: what is drivable, its own paving, the ring's way at each cell round an island, and per way out a route field (metres
 * to go, kept off the kerbs, round the island only its way) built when a car first asks for it.
 */
export interface Zone {
  junction: string; name: string;
  /** the junction's border (as the editor draws it) */
  outline: Pt[];
  connectors: Set<string>; lanes: Set<string>;
  island: Island | null;
  gx0: number; gy0: number; gnx: number; gny: number;
  /** per cell: 0 off the paving, 1 the junction's own paving, 2 other paving (the arms' lanes) */
  kind: Uint8Array;
  /** per cell: metres to the kerb */
  kerb: Float32Array;
  /** per cell: on the ring (round the island, within the carriageway): the ring's way (unit), else 0, 0 */
  tx: Float32Array; ty: Float32Array;
  /** where the give-way rules hold: a roundabout's ring, else the junction's own paving */
  core: Uint8Array;
  fields: Map<string, Float32Array>;
}

export interface Surface {
  x0: number; y0: number; nx: number; ny: number;
  /** 1 drivable, 0 not */
  road: Uint8Array;
  /** metres to the nearest cell of the other kind (road: to the edge; off road: to the road) */
  edge: Float32Array;
  zones: Zone[];
}

const idx = (s: Surface, x: number, y: number) => {
  const i = Math.floor((x - s.x0) / CELL), j = Math.floor((y - s.y0) / CELL);
  return i < 0 || j < 0 || i >= s.nx || j >= s.ny ? -1 : j * s.nx + i;
};
/** drivable at p (off the mapped ground: not) */
export const drivable = (s: Surface, p: Pt) => { const k = idx(s, p.x, p.y); return k >= 0 && s.road[k] === 1; };
/** metres from p to the edge of the kind of ground it is on (0 off the map) */
export const edgeDist = (s: Surface, p: Pt) => { const k = idx(s, p.x, p.y); return k >= 0 ? s.edge[k] : 0; };

/**
 * A junction's paved ground: its bands (its connectors, the road ends they join, its ring lanes), and a drawn one's border (the editor fills it;
 * the bands close the slits between it and the arms' lanes), an automatic one's loops paved over and between them; either way but
 * the islands its innermost ring lanes go round (junctionHoles leaves only the junction's own rings' islands: a ring that is a
 * road's lanes, as Roundabout 3's, would be paved over)
 */
function paved(sk: Sketch, j: SketchJunction, bands: Band[], rings: { lane: SketchLane; pts: Pt[] }[]) {
  let on: (p: Pt) => boolean;
  const polys = [...bands, ...rings.map(r => ({ pts: r.pts, width: r.lane.width, closed: false }))].map(b => bandPolygon(b));
  if (j.shape !== "auto") { const border = outlinePath(j); on = p => insidePolygon(p, border) || polys.some(q => insidePolygon(p, q)); }
  else {
    const loops = nestLoops(junctionSurfaceHoles(sk, j, contentsOf(sk).get(j.id) ?? { lanes: [], connectors: [], roads: [] }));
    on = p => polys.some(q => insidePolygon(p, q)) || loops.some(l => insidePolygon(p, l.outer) && !l.holes.some(h => insidePolygon(p, h)));
  }
  const inner = rings.filter(r => !rings.some(o => o !== r && insidePolygon(o.pts[0], r.pts)));
  return (p: Pt) => on(p) && !inner.some(r => insidePolygon(p, r.pts) && nearestOn(r.lane.shape, p).d > r.lane.width / 2);
}
/** the ring lanes on a junction (full circles and closed lines, its own or a road's, mostly inside its border), each's line */
function ringsOn(sk: Sketch, j: SketchJunction) {
  const border = outlinePath(j);
  return sk.lanes.filter(l => isFullCircle(l.shape)).map(lane => ({ lane, pts: samples(lane.shape, 0.5) }))
    .filter(r => r.pts.filter(p => insidePolygon(p, border)).length >= r.pts.length * 0.8);
}

/** the map round every junction of the sketch that traffic goes through (connectors on it); null: none */
export function buildSurface(sk: Sketch): Surface | null {
  const contents = contentsOf(sk);
  const cands = sk.junctions.map(j => ({ j, c: contents.get(j.id) })).filter(x => x.c && x.c.connectors.length && x.j.outline.length >= 3);
  if (!cands.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { j } of cands) for (const p of outlinePath(j)) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  minX -= MARGIN; minY -= MARGIN; maxX += MARGIN; maxY += MARGIN;
  const nx = Math.ceil((maxX - minX) / CELL), ny = Math.ceil((maxY - minY) / CELL);
  const s: Surface = { x0: minX, y0: minY, nx, ny, road: new Uint8Array(nx * ny), edge: new Float32Array(nx * ny), zones: [] };
  // (each junction's paving, and which junction's; the lanes outside junctions near them as bands)
  const rings = new Map(cands.map(({ j }) => [j.id, ringsOn(sk, j)]));
  const fills = cands.map(({ j, c }) => ({ j, bb: bbox(outlinePath(j), 3), inside: paved(sk, j, junctionBands(sk, c!), rings.get(j.id)!) }));
  const own = new Int16Array(nx * ny).fill(-1);
  const inJ = new Set(cands.flatMap(x => x.c!.lanes));
  const near = (b: Band) => b.pts.some(p => p.x > minX && p.x < maxX && p.y > minY && p.y < maxY);
  const lanePolys = sk.lanes.filter(l => !inJ.has(l.id)).map(l => ({ lane: l, b: { pts: densify(l.shape), width: l.width, closed: false } as Band })).filter(x => near(x.b)).map(({ lane, b }) => ({ lane, poly: bandPolygon(b), bb: bbox(b.pts, b.width) }));
  // (ticket #78: a lane at another level than a junction it passes over or under (a bridge, a tunnel) is no paving of it there
  // (near it: within its grid's reach))
  const levels = hasLevels(sk) ? cands.map(({ j, c }) => ({ lv: junctionLevel(sk, c!), bb: bbox(outlinePath(j), FPAD) })) : null;
  const level = (l: SketchLane, p: Pt) => !levels || levels.every(x => !inBox(p, x.bb) || Math.abs(zAt(sk, l.id, nearestOn(l.shape, p).s) - x.lv) < 0.5);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = { x: minX + (i + 0.5) * CELL, y: minY + (j + 0.5) * CELL };
    let on = false;
    for (let f = 0; f < fills.length; f++) if (inBox(p, fills[f].bb) && fills[f].inside(p)) { on = true; own[j * nx + i] = f; break; }
    if (!on) for (const l of lanePolys) if (inBox(p, l.bb) && insidePolygon(p, l.poly) && level(l.lane, p)) { on = true; break; }
    s.road[j * nx + i] = on ? 1 : 0;
  }
  closeSlits(s, own);
  distances(s);
  cands.forEach(({ j, c }, f) => s.zones.push(zoneOf(sk, s, j, c!, rings.get(j.id)!.map(x => x.lane), own, f)));
  return s;
}

/** a junction as the experiment drives it: its island if any (see `islandOf`), and its grid */
function zoneOf(sk: Sketch, s: Surface, j: SketchJunction, c: { lanes: string[]; connectors: string[] }, rings: SketchLane[], own: Int16Array, f: number): Zone {
  const border = outlinePath(j), isl = islandOf(sk, s, border, c, rings);
  const b = bbox(border, FPAD), gx0 = Math.max(s.x0, b.x0), gy0 = Math.max(s.y0, b.y0);
  const gnx = Math.ceil((Math.min(s.x0 + s.nx * CELL, b.x1) - gx0) / FCELL), gny = Math.ceil((Math.min(s.y0 + s.ny * CELL, b.y1) - gy0) / FCELL), N = gnx * gny;
  const kind = new Uint8Array(N), kerb = new Float32Array(N), tx = new Float32Array(N), ty = new Float32Array(N), core = new Uint8Array(N);
  // (the island's cells, and metres from each cell to it: the ring is the carriageway round it)
  const isl1 = new Uint8Array(N), dI = new Float32Array(N).fill(1e9);
  for (let q = 0; q < N; q++) {
    const p = { x: gx0 + ((q % gnx) + 0.5) * FCELL, y: gy0 + (Math.floor(q / gnx) + 0.5) * FCELL }, k = idx(s, p.x, p.y);
    if (k < 0) continue;
    kind[q] = s.road[k] ? (own[k] === f ? 1 : 2) : 0;
    kerb[q] = s.road[k] ? s.edge[k] : 0;
    if (isl && isl.cells.has(k)) { isl1[q] = 1; dI[q] = 0; }
  }
  let island: Island | null = null;
  if (isl) {
    island = { c: isl.c, sense: isl.sense, width: isl.width, polar: isl.polar };
    chamfer(dI, gnx, gny, FCELL);
    for (let q = 0; q < N; q++) {
      // (the ring's way holds on the carriageway round the island and on all the junction's own paving (a drawn one's apron past
      // its ring lanes too: else the shortest way to a far exit would go round the other way there))
      const ring = dI[q] <= isl.width + 0.75;
      if (!kind[q] || (!ring && kind[q] !== 1)) continue;
      // (the ring's way: square to the way out from the island (the distance's slope), the country's way round)
      const i = q % gnx, jj = Math.floor(q / gnx);
      let gx = (dI[jj * gnx + Math.min(gnx - 1, i + 1)] - dI[jj * gnx + Math.max(0, i - 1)]), gy = (dI[Math.min(gny - 1, jj + 1) * gnx + i] - dI[Math.max(0, jj - 1) * gnx + i]);
      let l = Math.hypot(gx, gy);
      if (l < 1e-6 || l > 1e6) { const p = { x: gx0 + (i + 0.5) * FCELL, y: gy0 + (jj + 0.5) * FCELL }; gx = p.x - isl.c.x; gy = p.y - isl.c.y; l = Math.hypot(gx, gy) || 1; }
      tx[q] = (isl.sense * -gy) / l; ty[q] = (isl.sense * gx) / l;
      if (ring) core[q] = 1;
    }
  } else for (let q = 0; q < N; q++) if (kind[q] === 1) core[q] = 1;
  return { junction: j.id, name: j.name, outline: border, connectors: new Set(c.connectors), lanes: new Set([...c.lanes, ...rings.map(l => l.id)]), island, gx0, gy0, gnx, gny, kind, kerb, tx, ty, core, fields: new Map() };
}

/** a grid's distances (to the cells at 0), two chamfer passes */
function chamfer(d: Float32Array, nx: number, ny: number, cell: number) {
  const D = cell * Math.SQRT2;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const q = j * nx + i;
    if (i > 0) d[q] = Math.min(d[q], d[q - 1] + cell);
    if (j > 0) { d[q] = Math.min(d[q], d[q - nx] + cell); if (i > 0) d[q] = Math.min(d[q], d[q - nx - 1] + D); if (i < nx - 1) d[q] = Math.min(d[q], d[q - nx + 1] + D); }
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const q = j * nx + i;
    if (i < nx - 1) d[q] = Math.min(d[q], d[q + 1] + cell);
    if (j < ny - 1) { d[q] = Math.min(d[q], d[q + nx] + cell); if (i < nx - 1) d[q] = Math.min(d[q], d[q + nx + 1] + D); if (i > 0) d[q] = Math.min(d[q], d[q + nx - 1] + D); }
  }
}

/** the zone's cell at p (-1 off its grid) */
export const zoneCell = (z: Zone, p: Pt) => { const i = Math.floor((p.x - z.gx0) / FCELL), j = Math.floor((p.y - z.gy0) / FCELL); return i < 0 || j < 0 || i >= z.gnx || j >= z.gny ? -1 : j * z.gnx + i; };
const cellPt = (z: Zone, q: number): Pt => ({ x: z.gx0 + ((q % z.gnx) + 0.5) * FCELL, y: z.gy0 + (Math.floor(q / z.gnx) + 0.5) * FCELL });
/** is p where the zone's give-way rules hold (its ring; a plain junction's own paving) */
export const inCore = (z: Zone, p: Pt) => { const q = zoneCell(z, p); return q >= 0 && z.core[q] === 1; };

/**
 * Where on a way out's lane, from `s0` (where the junction's connectors join it), a car makes for: there, or (a lane drawn from
 * inside the junction, across its island, say) where it first comes onto the junction's own paving, up to 40 m on
 */
export function exitStart(z: Zone, lane: SketchLane, s0: number) {
  const L = laneLength(lane.shape);
  for (let u = s0; u < Math.min(L, s0 + 40); u += FCELL / 2) {
    const p = pointAt(lane.shape, u).p, q = zoneCell(z, p);
    if (q < 0 || z.kind[q] === 1 || !insidePolygon(p, z.outline)) return u;
  }
  return s0;
}
/** a roundabout's paving past its carriageway (an apron) costs this much more a metre */
const APRON_COST = 2;
/** nearer the kerb than this (m), a metre costs more: up to KERB_COST times more at the kerb */
const KERB_SOFT = 1.4, KERB_COST = 4;
/** the way out's lane taken this far on (m) as where the field leads (on down it, not just to its start); its line taken this far
 * back into the junction, a metre on it at LINE_COST: cars line up with the lane before they get to it (they can't turn on the spot) */
const RUN = 12, LINE_BACK = 6, LINE_COST = 0.4;
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]] as const;
/** may a car go from cell a to cell b (8-neighbours): round an island, never against the ring's way on the ring, nor much
 * against it on the paving round it (coming in from an arm, a little against it is as the arm runs) */
function allowed(z: Zone, a: number, di: number, dj: number) {
  const t = z.tx[a] * di + z.ty[a] * dj;
  return t >= (z.core[a] ? -0.05 : -0.5) * Math.hypot(di, dj) || (z.tx[a] === 0 && z.ty[a] === 0);
}
/**
 * The route field to a way out (its lane, from `s0` on, where the junction's connectors join it): metres to go from each cell,
 * a shortest way over the junction's paving (Dijkstra back from the lane's line down RUN m of it, those cells below 0, and back
 * from its line taken on into the junction, cheaply), dearer near the kerb, round an island only the ring's way. The arms' lanes
 * are not on it but for the way out's own: no going across from a lane in to the lane out beside it. Kept per way out.
 */
export function routeField(z: Zone, lane: SketchLane, s0: number): Float32Array {
  const key = `${lane.id}@${s0.toFixed(1)}`, had = z.fields.get(key);
  if (had) return had;
  const N = z.gnx * z.gny, D = new Float64Array(N).fill(Infinity), done = new Uint8Array(N), L = laneLength(lane.shape);
  // (its run: the lane's own cells down from s0, cheap as the junction's)
  const run = new Uint8Array(N);
  for (let u = -3; u <= RUN + 2; u += FCELL / 2) {
    const a = pointAt(lane.shape, Math.max(0, Math.min(L, s0 + u)));
    for (let w = -lane.width / 2; w <= lane.width / 2; w += FCELL / 2) { const q = zoneCell(z, { x: a.p.x - a.d.y * w, y: a.p.y + a.d.x * w }); if (q >= 0 && z.kind[q]) run[q] = 1; }
  }
  const on = (q: number) => z.kind[q] === 1 || run[q] === 1;
  const weight = (q: number) => (1 + (KERB_COST - 1) * Math.max(0, KERB_SOFT - z.kerb[q]) / KERB_SOFT) * (z.island && !z.core[q] && !run[q] ? APRON_COST : 1);
  const heap: number[] = [], hk: number[] = [];
  const push = (q: number, c: number) => {
    if (c >= D[q]) return;
    D[q] = c; heap.push(c); hk.push(q);
    for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p] <= heap[i]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; [hk[p], hk[i]] = [hk[i], hk[p]]; i = p; }
  };
  const pop = () => {
    const c = heap[0], q = hk[0], lc = heap.pop()!, lq = hk.pop()!;
    if (heap.length) { heap[0] = lc; hk[0] = lq; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l] < heap[m]) m = l; if (r < heap.length && heap[r] < heap[m]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; [hk[m], hk[i]] = [hk[i], hk[m]]; i = m; } }
    return [c, q];
  };
  // (seeds: the lane's line from s0 down RUN m, each below 0 by how far down it is)
  for (let u = 0; u <= Math.min(RUN, L - s0); u += FCELL / 2) { const q = zoneCell(z, pointAt(lane.shape, s0 + u).p); if (q >= 0 && on(q)) push(q, -u); }
  const g = pointAt(lane.shape, s0);
  for (let u = FCELL / 2; u <= LINE_BACK; u += FCELL / 2) { const q = zoneCell(z, { x: g.p.x - g.d.x * u, y: g.p.y - g.d.y * u }); if (q < 0 || !z.kind[q]) break; run[q] = 1; push(q, u * LINE_COST); }
  while (heap.length) {
    const [c, q] = pop();
    if (done[q] || c > D[q]) continue;
    done[q] = 1;
    const i = q % z.gnx, j = Math.floor(q / z.gnx);
    // (back from q: the cells a car could have come to it from)
    for (const [di, dj] of NB) {
      const ii = i - di, jj = j - dj;
      if (ii < 0 || jj < 0 || ii >= z.gnx || jj >= z.gny) continue;
      const a = jj * z.gnx + ii;
      if (done[a] || !on(a) || !allowed(z, a, di, dj)) continue;
      push(a, c + Math.hypot(di, dj) * FCELL * (weight(a) + weight(q)) / 2);
    }
  }
  const out = Float32Array.from(D);
  z.fields.set(key, out);
  return out;
}
/**
 * Down a route field from p: the point `steps` cells on along the cheapest way (the aim), and the metres still to go from p
 * (Infinity: p is nowhere the field reaches).
 */
export function descend(z: Zone, D: Float32Array, p: Pt, steps: number): { aim: Pt | null; toGo: number } {
  let q = zoneCell(z, p);
  if (q < 0) return { aim: null, toGo: Infinity };
  // (off the field (on a kerb's cell, or a ring's cell it can't go on from): the best cell next to it)
  if (!Number.isFinite(D[q])) {
    let best = -1;
    for (let r = 1; r <= 3 && best < 0; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = (q % z.gnx) + di, j = Math.floor(q / z.gnx) + dj;
      if (i < 0 || j < 0 || i >= z.gnx || j >= z.gny) continue;
      const a = j * z.gnx + i;
      if (Number.isFinite(D[a]) && (best < 0 || D[a] < D[best])) best = a;
    }
    if (best < 0) return { aim: null, toGo: Infinity };
    q = best;
  }
  const toGo = D[q];
  for (let n = 0; n < steps; n++) {
    const i = q % z.gnx, j = Math.floor(q / z.gnx);
    let next = -1, bc = D[q];
    for (const [di, dj] of NB) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= z.gnx || jj >= z.gny) continue;
      const a = jj * z.gnx + ii;
      if (!allowed(z, q, di, dj) || !(D[a] < bc)) continue;
      bc = D[a]; next = a;
    }
    if (next < 0) break;
    q = next;
  }
  return { aim: cellPt(z, q), toGo };
}

const bbox = (pts: Pt[], pad: number) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); }
  return { x0: a - pad, y0: b - pad, x1: c + pad, y1: d + pad };
};
const inBox = (p: Pt, b: { x0: number; y0: number; x1: number; y1: number }) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
const densify = (sh: Parameters<typeof laneLength>[0]) => { const L = laneLength(sh), n = Math.max(2, Math.ceil(L / 0.5)); return Array.from({ length: n + 1 }, (_, i) => pointAt(sh, (L * i) / n).p); };

/**
 * (ticket #74) Slits in the paving closed: ground narrower than SLIT_CLOSE between paved cells (where an arm's lane meets a
 * junction's drawn border at an angle, say) paved too: grown by half that, then shrunk back. A car's path through one read as a
 * kerb and held it there. Closed ground taken as its junction's when a neighbour is. Islands and real kerbs are wider and stay.
 */
const SLIT_CLOSE = 1;
function closeSlits(s: Surface, own: Int16Array) {
  const { nx, ny, road } = s, r = Math.max(1, Math.round(SLIT_CLOSE / 2 / CELL)), N = nx * ny;
  const grow = (src: Uint8Array, val: 0 | 1) => {
    // (src cells of value `val` spread `r` cells, square: one pass along rows, one along columns)
    const a = new Uint8Array(N), out = new Uint8Array(N);
    for (let j = 0; j < ny; j++) { let last = -Infinity; for (let i = 0; i < nx; i++) { if (src[j * nx + i] === val) last = i; a[j * nx + i] = i - last <= r ? 1 : 0; } last = Infinity; for (let i = nx - 1; i >= 0; i--) { if (src[j * nx + i] === val) last = i; if (last - i <= r) a[j * nx + i] = 1; } }
    for (let i = 0; i < nx; i++) { let last = -Infinity; for (let j = 0; j < ny; j++) { if (a[j * nx + i]) last = j; out[j * nx + i] = j - last <= r ? 1 : 0; } last = Infinity; for (let j = ny - 1; j >= 0; j--) { if (a[j * nx + i]) last = j; if (last - j <= r) out[j * nx + i] = 1; } }
    return out;
  };
  const grown = grow(road, 1);
  // (shrunk back: unpaved where some unpaved cell of the grown ground is within r)
  const hole = new Uint8Array(N); for (let k = 0; k < N; k++) hole[k] = grown[k] ? 0 : 1;
  const near = grow(hole, 1);
  for (let k = 0; k < N; k++) if (!road[k] && grown[k] && !near[k]) {
    road[k] = 1;
    const i = k % nx;
    for (const m of [k - 1, k + 1, k - nx, k + nx]) if (m >= 0 && m < N && Math.abs((m % nx) - i) <= 1 && own[m] >= 0) { own[k] = own[m]; break; }
  }
}

/** metres to the other kind of ground, per cell (two chamfer passes, 3-4 weights: within a few percent of the true distance) */
function distances(s: Surface) {
  const { nx, ny, road, edge } = s, BIG = 1e9;
  for (let k = 0; k < nx * ny; k++) edge[k] = BIG;
  const isEdge = (i: number, j: number) => {
    const v = road[j * nx + i];
    return (i > 0 && road[j * nx + i - 1] !== v) || (i < nx - 1 && road[j * nx + i + 1] !== v) || (j > 0 && road[(j - 1) * nx + i] !== v) || (j < ny - 1 && road[(j + 1) * nx + i] !== v);
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) if (isEdge(i, j)) edge[j * nx + i] = 0.5;
  const relax = (k: number, m: number, w: number) => { if (edge[m] + w < edge[k]) edge[k] = edge[m] + w; };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (i > 0) relax(k, k - 1, 1); if (j > 0) relax(k, k - nx, 1);
    if (i > 0 && j > 0) relax(k, k - nx - 1, 1.4142); if (i < nx - 1 && j > 0) relax(k, k - nx + 1, 1.4142);
  }
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) {
    const k = j * nx + i;
    if (i < nx - 1) relax(k, k + 1, 1); if (j < ny - 1) relax(k, k + nx, 1);
    if (i < nx - 1 && j < ny - 1) relax(k, k + nx + 1, 1.4142); if (i > 0 && j < ny - 1) relax(k, k + nx - 1, 1.4142);
  }
  for (let k = 0; k < nx * ny; k++) edge[k] = (edge[k] - 0.5) * CELL;
}

/**
 * A junction's island, if it is a roundabout: an unpaved patch inside its border the paving goes all the way round (the largest,
 * over 12 m²): its cells, its middle, the island's and carriageway's reach per degree if it is round, the carriageway's width
 * round it (its ring lanes', else the usual width of the paving round it), and the way round: its ring lanes' way, else (in a country driving on the right the island is on a circulating car's left)
 * read off its two-way roads: an arm's lane coming in has the lane going out on its left there, as the island will be.
 */
function islandOf(sk: Sketch, s: Surface, border: Pt[], c: { lanes: string[]; connectors: string[] }, rings: SketchLane[]): (Island & { cells: Set<number> }) | null {
  const b = bbox(border, 0), i0 = Math.max(0, Math.floor((b.x0 - s.x0) / CELL)), i1 = Math.min(s.nx - 1, Math.ceil((b.x1 - s.x0) / CELL));
  const j0 = Math.max(0, Math.floor((b.y0 - s.y0) / CELL)), j1 = Math.min(s.ny - 1, Math.ceil((b.y1 - s.y0) / CELL));
  const seen = new Uint8Array(s.nx * s.ny);
  let best: { cells: number[]; sx: number; sy: number } | null = null;
  for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
    const k = jj * s.nx + ii;
    if (s.road[k] || seen[k]) continue;
    const p = { x: s.x0 + (ii + 0.5) * CELL, y: s.y0 + (jj + 0.5) * CELL };
    if (!insidePolygon(p, border)) continue;
    const cells: number[] = [];
    let sx = 0, sy = 0, open = false;
    const stack = [k]; seen[k] = 1;
    while (stack.length) {
      const m = stack.pop()!, mi = m % s.nx, mj = (m - mi) / s.nx;
      cells.push(m); sx += mi; sy += mj;
      if (mi <= i0 || mi >= i1 || mj <= j0 || mj >= j1) open = true;
      for (const q of [m - 1, m + 1, m - s.nx, m + s.nx]) if (q >= 0 && q < s.nx * s.ny && !s.road[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    if (!open && cells.length * CELL * CELL > 12 && (!best || cells.length > best.cells.length)) best = { cells, sx, sy };
  }
  if (!best) return null;
  const n = best.cells.length, ctr = { x: s.x0 + (best.sx / n + 0.5) * CELL, y: s.y0 + (best.sy / n + 0.5) * CELL };
  // (per degree: out from the middle to the road, then on to where the paving ends within the outline)
  const rIn = new Float32Array(360), rOut = new Float32Array(360), widths: number[] = [];
  for (let a = 0; a < 360; a++) {
    const ux = Math.cos((a * Math.PI) / 180), uy = Math.sin((a * Math.PI) / 180);
    let r = 0;
    while (r < 60 && !drivable(s, { x: ctr.x + ux * r, y: ctr.y + uy * r })) r += CELL / 2;
    rIn[a] = r;
    while (r < 80 && drivable(s, { x: ctr.x + ux * r, y: ctr.y + uy * r })) r += CELL / 2;
    rOut[a] = r; widths.push(rOut[a] - rIn[a]);
  }
  widths.sort((p, q) => p - q);
  // (with ring lanes the carriageway is theirs: out to where the outermost one's band ends (a drawn junction's paving can go on
  // well past it); else where the arms run past the ring the paving goes on: the carriageway taken as the usual width there)
  let width = widths[Math.floor(widths.length * 0.3)];
  if (rings.length) {
    const ringW: number[] = [];
    for (let a = 0; a < 360; a++) {
      const ux = Math.cos((a * Math.PI) / 180), uy = Math.sin((a * Math.PI) / 180);
      let r = rIn[a], last = -1;
      while (r < rOut[a]) { const p = { x: ctr.x + ux * r, y: ctr.y + uy * r }; if (rings.some(l => nearestOn(l.shape, p).d <= l.width / 2)) last = r; r += CELL; }
      if (last > rIn[a]) { rOut[a] = Math.min(rOut[a], last + CELL); ringW.push(rOut[a] - rIn[a]); }
    }
    if (ringW.length > 180) { ringW.sort((p, q) => p - q); width = ringW[Math.floor(ringW.length / 2)]; }
  }
  for (let a = 0; a < 360; a++) rOut[a] = Math.min(rOut[a], rIn[a] + width * 1.15);
  // (round or not: the island's reach all round against its median; not round, its ring lanes side by side as the carriageway)
  const reach = [...rIn].sort((p, q) => p - q), med = reach[180], round = (reach[359] - reach[0]) / Math.max(1, med) <= ROUND;
  if (!round && rings.length) width = rings.reduce((a, l) => a + l.width, 0);
  const sense = senseOfRings(rings, ctr) ?? senseOf(sk, c, ctr);
  return { c: ctr, sense, width, polar: round ? { rIn, rOut } : null, cells: new Set(best.cells) };
}

/** which way round its ring lanes go (the way round their middle they turn, as driven), if it has any */
function senseOfRings(rings: SketchLane[], ctr: Pt): 1 | -1 | null {
  let turn = 0;
  for (const l of rings) {
    const pts = samples(l.shape, 0.5);
    for (let k = 1; k < pts.length; k++) {
      let d = Math.atan2(pts[k].y - ctr.y, pts[k].x - ctr.x) - Math.atan2(pts[k - 1].y - ctr.y, pts[k - 1].x - ctr.x);
      if (d > Math.PI) d -= 2 * Math.PI; if (d < -Math.PI) d += 2 * Math.PI;
      turn += d;
    }
  }
  return Math.abs(turn) > Math.PI ? (turn > 0 ? 1 : -1) : null;
}

/** which way round: the side the lanes going out lie on, seen from the lanes coming in beside them (two-way roads), the island on that side */
function senseOf(sk: Sketch, c: { connectors: string[] }, ctr: Pt): 1 | -1 {
  let votes = 0;
  const ins = new Set(c.connectors.map(id => sk.connectors.find(x => x.id === id)?.from.lane).filter(Boolean) as string[]);
  const outs = new Set(c.connectors.map(id => sk.connectors.find(x => x.id === id)?.to.lane).filter(Boolean) as string[]);
  for (const r of sk.roads) {
    const a = r.lanes.filter(l => ins.has(l) && !outs.has(l)), b = r.lanes.filter(l => outs.has(l) && !ins.has(l));
    for (const la of a) for (const lb of b) {
      const A = laneById(sk, la), B = laneById(sk, lb);
      if (!A || !B) continue;
      const end = pointAt(A.shape, laneLength(A.shape)), st = pointAt(B.shape, 0);
      // (the lane going out on the incoming lane's left or right: the sign of the cross product, in the sketch's own frame)
      const side = Math.sign(end.d.x * (st.p.y - end.p.y) - end.d.y * (st.p.x - end.p.x));
      votes += side;
    }
  }
  // (the island on the circulating car's same side: for a car going round with the angle growing, the middle is on the side of
  // sign +1 in this cross product)
  void ctr;
  // (no two-way road to tell by: driving on the right, as the sketches are drawn (y down the screen), round anticlockwise on it)
  return votes > 0 ? 1 : -1;
}
