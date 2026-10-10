import { boundsOfPts, geoShift, nextId, pastePart, piecePoints, sanitizeSketch, type Piece, type Pt, type Sketch, type SketchCrossing } from "./lane-sketch";

/**
 * An agent patch's piece added to the plan's Sketch window (T152, the user's choice): beside what the window holds,
 * never instead of it, and never touching the main plan. As Test in Sketch → Add: the piece's ids made fresh
 * (`pastePart`), put where it is on the plan as the window's own origin has it (`geoShift`); and where that would
 * lie over what the window already holds, moved east of it (`BESIDE_GAP` m clear), so their lanes don't cross. Unlike
 * Add, its zebras come too (fresh ids, moved the same way).
 */

/** metres kept clear between the window's content and a piece moved beside it */
export const BESIDE_GAP = 20;


export type WindowCounts = { lanes: number; connectors: number; roads: number; junctions: number; crossings: number; zones: number };
export type WindowAdd = {
  /** the plan's sketch with the piece in its Sketch window (the main plan as it was) */
  sketch: Sketch;
  /** the ids the piece got there */
  added: Piece & { crossings: string[] };
  counts: WindowCounts;
  /** metres moved east, clear of what the window held (0: at its own place) */
  beside: number;
  /** the window was empty before */
  empty: boolean;
  /** for a thumbnail: the added lanes' lines and the window's other lanes, a few points each */
  preview: { added: Pt[][]; existing: Pt[][] };
  /** what the piece holds that Add doesn't carry (links, journeys, signal groups), as "2 links" */
  notCarried: string[];
};

const EMPTY: Sketch = { lanes: [], connectors: [], roads: [], junctions: [] };
const all = (sk: Sketch): Piece => ({ lanes: sk.lanes.map(l => l.id), connectors: sk.connectors.map(c => c.id), junctions: sk.junctions.map(j => j.id), ...(sk.zones?.length ? { zones: sk.zones.map(z => z.id) } : {}) });
const lines = (sk: Sketch, ids: Set<string> | null, max = 400) =>
  sk.lanes.filter(l => !ids || ids.has(l.id)).slice(0, max).map(l => piecePoints({ ...sk, lanes: [l] }, { lanes: [l.id], connectors: [], junctions: [] }).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 12)) === 0 || i === a.length - 1));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const several = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const mainOf = (sk: Sketch) => JSON.stringify({ ...sk, scratch: undefined });

/** `plan` with `raw` (a sketch fragment) added to its Sketch window, or why not */
export function addToSketchWindow(plan: Sketch, raw: unknown): ({ ok: true } & WindowAdd) | { ok: false; error: string } {
  const piece = isObj(raw) ? sanitizeSketch({ ...raw, scratch: undefined }) : null;
  if (!piece || !piece.lanes.length) return { ok: false, error: "The Sketch window piece isn't a usable sketch (it has no valid lanes)." };
  const cur = plan.scratch ?? EMPTY, empty = !cur.lanes.length && !cur.junctions.length;
  const o = geoShift(piece.geo ?? plan.geo, cur.geo ?? plan.geo);
  // (beside, not over: east of what the window holds, when the piece at its own place would overlap it)
  let dx = 0;
  const P = boundsOfPts(piecePoints(piece, all(piece)).map(p => ({ x: p.x + o.x, y: p.y + o.y }))), C = empty ? null : boundsOfPts(piecePoints(cur, all(cur)));
  if (P && C && P.minX < C.maxX + BESIDE_GAP && P.maxX > C.minX - BESIDE_GAP && P.minY < C.maxY + BESIDE_GAP && P.maxY > C.minY - BESIDE_GAP) dx = C.maxX + BESIDE_GAP - P.minX;
  const r = pastePart(cur, piece, o.x + dx, o.y);
  // (its zebras too, fresh ids, moved as the rest)
  const xIds = (cur.crossings ?? []).map(x => x.id), crossings: SketchCrossing[] = (piece.crossings ?? []).map(x => {
    const id = nextId("x", xIds);
    xIds.push(id);
    return { ...x, id, a: { x: x.a.x + o.x + dx, y: x.a.y + o.y }, b: { x: x.b.x + o.x + dx, y: x.b.y + o.y } };
  });
  const scratch: Sketch = {
    ...r.sketch,
    ...(cur.crossings?.length || crossings.length ? { crossings: [...(cur.crossings ?? []), ...crossings] } : {}),
    ...(cur.geo ?? piece.geo ?? plan.geo ? { geo: cur.geo ?? piece.geo ?? plan.geo } : {}),
    ...(cur.traffic ?? piece.traffic ? { traffic: cur.traffic ?? piece.traffic } : {}),
  };
  const sketch = sanitizeSketch({ ...plan, scratch });
  if (!sketch?.scratch) return { ok: false, error: "The Sketch window wouldn't keep the piece." };
  // (the main plan exactly as it was; and every item of the piece kept in the window)
  if (mainOf(sketch) !== mainOf(sanitizeSketch({ ...plan }) ?? plan)) return { ok: false, error: "Adding to the Sketch window would change the main plan: refused." };
  const w = sketch.scratch, has = (list: { id: string }[] | undefined, ids: string[]) => ids.every(id => (list ?? []).some(x => x.id === id));
  const added = { ...r.piece, crossings: crossings.map(x => x.id) };
  if (!has(w.lanes, added.lanes) || !has(w.connectors, added.connectors) || !has(w.junctions, added.junctions) || !has(w.crossings, added.crossings))
    return { ok: false, error: "Some of the piece's items wouldn't survive in the Sketch window (they don't fit together on their own)." };
  const counts: WindowCounts = { lanes: added.lanes.length, connectors: added.connectors.length, roads: w.roads.length - cur.roads.length, junctions: added.junctions.length, crossings: added.crossings.length, zones: added.zones?.length ?? 0 };
  const notCarried = [several(piece.links?.length ?? 0, "link"), several(piece.journeys?.length ?? 0, "journey"), several(piece.signalGroups?.length ?? 0, "signal group")].filter(x => !x.startsWith("0 "));
  return { ok: true, sketch, added, counts, beside: Math.round(dx), empty, preview: { added: lines(w, new Set(added.lanes)), existing: lines(cur, null) }, notCarried };
}
