/**
 * "Fill holes" on an automatic junction (T147): its whole inside as road surface. The automatic surface is
 * the union of bands (connectors, the lanes on it, the road ends it joins); between them it can leave
 * slivers (thin wedges where connectors part or run side by side, too narrow for `junctionHoles`, which
 * counts slits under a metre as shut) and openings to the outside. Filled: the bands' union closed
 * (grown by FILL_GAP / 2, then shrunk back), so every gap narrower than FILL_GAP and everything the bands
 * shut in is paved; the outer edge stays where the bands are, and wide notches between arms stay open. It
 * only adds paving: today's holes are kept, and what is unpaved today stays so only where it is an island
 * (inside a ring lane of the junction, as `junctionHoles` leaves it) or a large enclosed area (over
 * FILL_ISLAND m², a plaza between arms). Display only: lanes, connectors and the cars are untouched.
 * Plain geometry, no framework.
 */
import {
  boundsOfPts, insidePolygon, isFullCircle, junctionBands, junctionHoles, laneById, rasterBands, samples, traceLoops,
  type Band, type JunctionContents, type Pt, type Sketch, type SketchJunction,
} from "./lane-sketch";

/** gaps narrower than this (metres) between a filled junction's bands are paved */
export const FILL_GAP = 4;
/** ground a filled junction shuts in stays unpaved past this area (m²): a plaza, not a hole */
export const FILL_ISLAND = 400;

/**
 * The loops to pave over bands `bands` with every gap under `gap` metres closed, but for what `rings` go
 * round (islands) and enclosed ground over `island` m². Loops from one tracing: an island inside a filled
 * area comes as an inner loop winding the other way (fill them nonzero or even-odd).
 */
export function fillLoops(bands: Band[], rings: Pt[][], gap = FILL_GAP, island = FILL_ISLAND): Pt[][] {
  if (!bands.length) return [];
  const bb = boundsOfPts(bands.flatMap(b => b.pts));
  if (!bb) return [];
  const r = gap / 2, reach = Math.max(...bands.map(b => Math.max(b.width, b.w1 ?? 0) / 2)) + r + 2;
  const x0 = bb.minX - reach, y0 = bb.minY - reach, w = bb.maxX - x0 + reach, h = bb.maxY - y0 + reach;
  const cell = Math.max(0.25, Math.sqrt((w * h) / 60_000)), nx = Math.ceil(w / cell) + 1, ny = Math.ceil(h / cell) + 1, N = nx * ny;
  // grown by r; then the ground reached from the grid's edge outside it is outside
  const grown = rasterBands(bands, x0, y0, cell, nx, ny, r);
  const outside = new Uint8Array(N), stack: number[] = [];
  const seed = (q: number) => { if (!grown[q] && !outside[q]) { outside[q] = 1; stack.push(q); } };
  for (let i = 0; i < nx; i++) { seed(i); seed((ny - 1) * nx + i); }
  for (let j = 0; j < ny; j++) { seed(j * nx); seed(j * nx + nx - 1); }
  const spread = (mark: Uint8Array, ok: (q: number) => boolean, until = 0, piece?: number[]) => {
    while (stack.length > until) {
      const q = stack.pop()!, i = q % nx;
      piece?.push(q);
      for (const u of [i > 0 ? q - 1 : -1, i < nx - 1 ? q + 1 : -1, q >= nx ? q - nx : -1, q < N - nx ? q + nx : -1]) if (u >= 0 && !mark[u] && ok(u)) { mark[u] = 1; stack.push(u); }
    }
  };
  spread(outside, u => !grown[u]);
  // shrunk back by r: the distance (metres, a chamfer approximation) from each cell to the outside
  const d = new Float32Array(N);
  for (let q = 0; q < N; q++) d[q] = outside[q] ? 0 : 1e9;
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
  // (a quarter metre inside the bands' outer edge: the bands draw that edge, and its kerb, as they always do)
  const edge = r + 0.25, fill = new Uint8Array(N);
  for (let q = 0; q < N; q++) if (d[q] > edge) fill[q] = 1;
  // the islands left: inside a ring (but its own band), and enclosed ground over `island` m² (on the bands as
  // drawn: what they shut in, gaps under half a metre counted as shut, as junctionHoles does)
  const at = (q: number): Pt => ({ x: x0 + (q % nx) * cell, y: y0 + Math.floor(q / nx) * cell });
  if (rings.length) for (let q = 0; q < N; q++) if (fill[q] && rings.some(g => insidePolygon(at(q), g))) fill[q] = 0;
  const bare = rasterBands(bands, x0, y0, cell, nx, ny, 0.5), seen = new Uint8Array(N);
  for (let q = 0; q < N; q++) {
    if (bare[q] || seen[q] || outside[q]) continue;
    const piece: number[] = [];
    seen[q] = 1; stack.push(q);
    let open = false;
    spread(seen, u => !bare[u], 0, piece);
    for (const v of piece) if (outside[v]) { open = true; break; }
    if (!open && piece.length * cell * cell > island) for (const v of piece) fill[v] = 0;
  }
  // (the rings' own bands paved again: an island's edge stays where its ring runs)
  if (rings.length) {
    const ringBands = rasterBands(bands.filter(b => b.closed), x0, y0, cell, nx, ny, 0);
    for (let q = 0; q < N; q++) if (ringBands[q] && d[q] > edge) fill[q] = 1;
  }
  // (traced on the distance itself where it decides, so the edge runs smooth between the cells, not in steps)
  return traceLoops(x0, y0, cell, nx, ny, (i, j) => { const q = j * nx + i; return fill[q] ? Math.max(d[q] - edge, 1e-3) : Math.min(d[q] - edge, -1e-3); });
}

/** the ring lanes on a junction (closed lines and full circles): their islands stay unpaved, as junctionHoles leaves them */
function ringsOf(sk: Sketch, c: JunctionContents): Pt[][] {
  return c.lanes.flatMap(id => { const l = laneById(sk, id); return l && (isFullCircle(l.shape) || (l.shape.kind === "line" && l.shape.closed)) ? [samples(l.shape, 1)] : []; });
}

// (kept while the sketch and the contents are the same)
const kept = new WeakMap<JunctionContents, { sk: Sketch; loops: Pt[][] }>();
/**
 * The ground to pave over an automatic junction's bands: what it shuts in (junctionHoles) and, with "Fill
 * holes" on, its whole inside too (fillLoops). Today's holes always come first, so filling only adds.
 */
export function junctionSurfaceHoles(sk: Sketch, j: SketchJunction, c: JunctionContents): Pt[][] {
  const holes = junctionHoles(sk, c);
  if (!j.fill) return holes;
  const k = kept.get(c);
  if (k && k.sk === sk) return k.loops;
  const loops = [...holes, ...fillLoops(junctionBands(sk, c), ringsOf(sk, c))];
  kept.set(c, { sk, loops });
  return loops;
}

/** the automatic junctions not filled yet (Tidy offers to fill them) */
export const unfilledJunctions = (sk: Sketch) => sk.junctions.filter(j => j.shape === "auto" && !j.fill);
/** "Fill holes in all junctions": the box ticked on every automatic junction (each can be unticked again) */
export function fillAllJunctions(sk: Sketch): { sketch: Sketch; n: number } {
  const todo = new Set(unfilledJunctions(sk).map(j => j.id));
  if (!todo.size) return { sketch: sk, n: 0 };
  return { sketch: { ...sk, junctions: sk.junctions.map(j => (todo.has(j.id) ? { ...j, fill: true as const } : j)) }, n: todo.size };
}

/** loops (a polygon's outside and its holes, in any order) grouped: each outside with the holes right inside it */
export function nestLoops(loops: Pt[][]): { outer: Pt[]; holes: Pt[][] }[] {
  const depth = loops.map((l, i) => loops.reduce((n, m, k) => (k !== i && l.length && insidePolygon(l[0], m) ? n + 1 : n), 0));
  const out = loops.flatMap((l, i) => (depth[i] % 2 === 0 ? [{ outer: l, holes: [] as Pt[][], depth: depth[i] }] : []));
  loops.forEach((l, i) => {
    if (depth[i] % 2 === 0) return;
    const parent = out.find(o => o.depth === depth[i] - 1 && insidePolygon(l[0], o.outer));
    if (parent) parent.holes.push(l);
  });
  return out.map(({ outer, holes }) => ({ outer, holes }));
}
