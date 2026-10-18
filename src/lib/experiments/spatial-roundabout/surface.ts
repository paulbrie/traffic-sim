/**
 * The spatial roundabout experiment (T213): the map a car senses. The sketch's drivable surface round each roundabout (its
 * junction's bands and paving, the lanes near it), rasterised, with a distance to the nearest edge per cell so a ray marches in
 * a few long steps; and each roundabout found from its island (unpaved ground the surface goes all the way round): its middle,
 * how far out the island and the carriageway reach at each angle, and which way round traffic goes (from the arms' roads: the
 * country's side of the road). Read only: built from the sketch with the editor's own geometry helpers, nothing changed.
 * No framework: runs in a worker or headless.
 */
import { bandPolygon, contentsOf, insidePolygon, junctionBands, laneById, pointAt, laneLength, type Band, type Pt, type Sketch, type SketchJunction } from "../../lane-sketch";
import { junctionSurfaceHoles, nestLoops } from "../../junction-fill";

/** raster cell (m) */
export const CELL = 0.25;
/** ground taken round a roundabout's junction (m): the arms' lanes this far out are mapped too */
const MARGIN = 35;

export interface Roundabout {
  junction: string;
  /** the island's middle */
  c: Pt;
  /** +1: traffic goes round with the angle growing (atan2), -1: the other way */
  sense: 1 | -1;
  /** per degree of angle round the middle: where the island ends and the carriageway round it ends (m from the middle) */
  rIn: Float32Array; rOut: Float32Array;
  /** the carriageway's width round the ring (median over the angles) */
  width: number;
  /** the junction's outline (for which cars are on it) */
  outline: Pt[];
  /** its connectors and lanes (the junction's own: entering it means leaving the lane follower) */
  connectors: Set<string>; lanes: Set<string>;
}

export interface Surface {
  x0: number; y0: number; nx: number; ny: number;
  /** 1 drivable, 0 not */
  road: Uint8Array;
  /** metres to the nearest cell of the other kind (road: to the edge; off road: to the road) */
  edge: Float32Array;
  roundabouts: Roundabout[];
}

const idx = (s: Surface, x: number, y: number) => {
  const i = Math.floor((x - s.x0) / CELL), j = Math.floor((y - s.y0) / CELL);
  return i < 0 || j < 0 || i >= s.nx || j >= s.ny ? -1 : j * s.nx + i;
};
/** drivable at p (off the mapped ground: not) */
export const drivable = (s: Surface, p: Pt) => { const k = idx(s, p.x, p.y); return k >= 0 && s.road[k] === 1; };
/** metres from p to the edge of the kind of ground it is on (0 off the map) */
export const edgeDist = (s: Surface, p: Pt) => { const k = idx(s, p.x, p.y); return k >= 0 ? s.edge[k] : 0; };

/** an automatic junction's paved ground: its bands, and the loops paved over and between them (an island stays a hole) */
function paved(sk: Sketch, j: SketchJunction, bands: Band[]) {
  const polys = bands.map(b => bandPolygon(b));
  const loops = nestLoops(junctionSurfaceHoles(sk, j, contentsOf(sk).get(j.id) ?? { lanes: [], connectors: [], roads: [] }));
  return (p: Pt) => polys.some(q => insidePolygon(p, q)) || loops.some(l => insidePolygon(p, l.outer) && !l.holes.some(h => insidePolygon(p, h)));
}

/** the map round every roundabout of the sketch (a junction whose surface goes round an island); null: none */
export function buildSurface(sk: Sketch): Surface | null {
  const contents = contentsOf(sk);
  const cands = sk.junctions.map(j => ({ j, c: contents.get(j.id) })).filter(x => x.c && x.j.outline.length >= 3);
  if (!cands.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { j } of cands) for (const p of j.outline) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  minX -= MARGIN; minY -= MARGIN; maxX += MARGIN; maxY += MARGIN;
  const nx = Math.ceil((maxX - minX) / CELL), ny = Math.ceil((maxY - minY) / CELL);
  const s: Surface = { x0: minX, y0: minY, nx, ny, road: new Uint8Array(nx * ny), edge: new Float32Array(nx * ny), roundabouts: [] };
  // (each junction's paving; the lanes outside junctions near them as bands)
  const fills = cands.map(({ j, c }) => ({ j, bb: bbox(j.outline, 3), inside: paved(sk, j, junctionBands(sk, c!)) }));
  const inJ = new Set(cands.flatMap(x => x.c!.lanes));
  const near = (b: Band) => b.pts.some(p => p.x > minX && p.x < maxX && p.y > minY && p.y < maxY);
  const lanePolys = sk.lanes.filter(l => !inJ.has(l.id)).map(l => ({ pts: densify(l.shape), width: l.width, closed: false } as Band)).filter(near).map(b => ({ poly: bandPolygon(b), bb: bbox(b.pts, b.width) }));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = { x: minX + (i + 0.5) * CELL, y: minY + (j + 0.5) * CELL };
    let on = false;
    for (const f of fills) if (inBox(p, f.bb) && f.inside(p)) { on = true; break; }
    if (!on) for (const l of lanePolys) if (inBox(p, l.bb) && insidePolygon(p, l.poly)) { on = true; break; }
    s.road[j * nx + i] = on ? 1 : 0;
  }
  distances(s);
  for (const { j, c } of cands) { const r = roundaboutOf(sk, s, j, c!); if (r) s.roundabouts.push(r); }
  return s.roundabouts.length ? s : null;
}

const bbox = (pts: Pt[], pad: number) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of pts) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); }
  return { x0: a - pad, y0: b - pad, x1: c + pad, y1: d + pad };
};
const inBox = (p: Pt, b: { x0: number; y0: number; x1: number; y1: number }) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;
const densify = (sh: Parameters<typeof laneLength>[0]) => { const L = laneLength(sh), n = Math.max(2, Math.ceil(L / 0.5)); return Array.from({ length: n + 1 }, (_, i) => pointAt(sh, (L * i) / n).p); };

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
 * A junction as a roundabout: its island (an unpaved patch inside the outline the paving goes all the way round, the largest);
 * its middle, the island's and carriageway's reach per degree, and the way round: in a country driving on the right the island
 * is on a circulating car's left. Which side that is in the sketch's frame is read off its two-way roads: an arm's lane coming
 * in has the lane going out on its left there, as the island will be.
 */
function roundaboutOf(sk: Sketch, s: Surface, j: SketchJunction, c: { lanes: string[]; connectors: string[] }): Roundabout | null {
  // (the island: off-road cells inside the outline, flood-filled; the largest patch not touching the outline's box edge)
  const b = bbox(j.outline, 0), i0 = Math.max(0, Math.floor((b.x0 - s.x0) / CELL)), i1 = Math.min(s.nx - 1, Math.ceil((b.x1 - s.x0) / CELL));
  const j0 = Math.max(0, Math.floor((b.y0 - s.y0) / CELL)), j1 = Math.min(s.ny - 1, Math.ceil((b.y1 - s.y0) / CELL));
  const seen = new Uint8Array(s.nx * s.ny);
  let best: { n: number; sx: number; sy: number } | null = null;
  for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
    const k = jj * s.nx + ii;
    if (s.road[k] || seen[k]) continue;
    const p = { x: s.x0 + (ii + 0.5) * CELL, y: s.y0 + (jj + 0.5) * CELL };
    if (!insidePolygon(p, j.outline)) continue;
    let n = 0, sx = 0, sy = 0, open = false;
    const stack = [k]; seen[k] = 1;
    while (stack.length) {
      const m = stack.pop()!, mi = m % s.nx, mj = (m - mi) / s.nx;
      n++; sx += mi; sy += mj;
      if (mi <= i0 || mi >= i1 || mj <= j0 || mj >= j1) open = true;
      for (const q of [m - 1, m + 1, m - s.nx, m + s.nx]) if (q >= 0 && q < s.nx * s.ny && !s.road[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
    }
    if (!open && n * CELL * CELL > 12 && (!best || n > best.n)) best = { n, sx, sy };
  }
  if (!best) return null;
  const cx = s.x0 + (best.sx / best.n + 0.5) * CELL, cy = s.y0 + (best.sy / best.n + 0.5) * CELL, ctr = { x: cx, y: cy };
  // (per degree: out from the middle to the road, then on to where the paving ends within the outline)
  const rIn = new Float32Array(360), rOut = new Float32Array(360), widths: number[] = [];
  for (let a = 0; a < 360; a++) {
    const ux = Math.cos((a * Math.PI) / 180), uy = Math.sin((a * Math.PI) / 180);
    let r = 0;
    while (r < 60 && !drivable(s, { x: cx + ux * r, y: cy + uy * r })) r += CELL / 2;
    rIn[a] = r;
    while (r < 80 && drivable(s, { x: cx + ux * r, y: cy + uy * r })) r += CELL / 2;
    rOut[a] = r; widths.push(rOut[a] - rIn[a]);
  }
  widths.sort((p, q) => p - q);
  const width = widths[Math.floor(widths.length * 0.3)];
  // (where the arms run past the ring the paving goes on: the carriageway taken as the usual width there)
  for (let a = 0; a < 360; a++) rOut[a] = Math.min(rOut[a], rIn[a] + width * 1.15);
  return { junction: j.id, c: ctr, sense: senseOf(sk, c, ctr), rIn, rOut, width, outline: j.outline, connectors: new Set(c.connectors), lanes: new Set(c.lanes) };
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
