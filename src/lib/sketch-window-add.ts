/**
 * An agent patch's piece put into a new sketch of the plan's own (T152; T156, the user's choice: several saved sketches),
 * named after the patch's title (" (2)"… where that name is taken), never into the user's open or saved sketches, and
 * never touching the main plan. The piece as it is: its own ids (after the checks), at its own place (its geo, else the
 * plan's), its traffic, links, journeys and signal groups with it. The sketch open stays open: the user opens the new one.
 */
import { piecePoints, sanitizeSketch, type Piece, type Pt, type Sketch } from "./lane-sketch";
import { addAsNewSketch, contentOf, sketchList } from "./sketch-list";

export type WindowCounts = { lanes: number; connectors: number; roads: number; junctions: number; crossings: number; zones: number };
export type WindowAdd = {
  /** the plan's sketch with the piece in a new saved sketch (the main plan and the user's sketches as they were) */
  sketch: Sketch;
  /** the new sketch: its id and name */
  sketchId: string; sketchName: string;
  /** the ids the piece has there (its own) */
  added: Piece & { crossings: string[] };
  counts: WindowCounts;
  /** for a thumbnail: the piece's lanes' lines, a few points each */
  preview: { added: Pt[][] };
};

const all = (sk: Sketch): Piece => ({ lanes: sk.lanes.map(l => l.id), connectors: sk.connectors.map(c => c.id), junctions: sk.junctions.map(j => j.id), ...(sk.zones?.length ? { zones: sk.zones.map(z => z.id) } : {}) });
const lines = (sk: Sketch, max = 400) =>
  sk.lanes.slice(0, max).map(l => piecePoints({ ...sk, lanes: [l] }, { lanes: [l.id], connectors: [], junctions: [] }).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 12)) === 0 || i === a.length - 1));
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** what isn't the Sketch window's: the main plan */
const mainOf = (sk: Sketch) => JSON.stringify({ ...sk, scratch: undefined, sketches: undefined, sketchOpen: undefined });
/** the user's sketches: the one open, and each saved one's id, name and content (not when made or changed) */
const userOf = (sk: Sketch, ids: string[]) => JSON.stringify({ open: sketchList(sk).open, scratch: sk.scratch ?? null, list: ids.map(id => ({ id, name: sketchList(sk).list.find(x => x.id === id)?.name, content: contentOf(sk, id) ?? null })) });

/**
 * `plan` with `raw` (a sketch fragment) as a new sketch named `name`, or why not. `now`: when it is made (ms; 0 where
 * only looked at, the server setting it when it saves: the rest is the same either way)
 */
export function addToSketchWindow(plan: Sketch, raw: unknown, name = "Agent patch", now = 0): ({ ok: true } & WindowAdd) | { ok: false; error: string } {
  const piece = isObj(raw) ? sanitizeSketch({ ...raw, scratch: undefined, sketches: undefined, sketchOpen: undefined }) : null;
  if (!piece || !piece.lanes.length) return { ok: false, error: "The Sketch window piece isn't a usable sketch (it has no valid lanes)." };
  const content: Sketch = { ...piece, ...(piece.geo ?? plan.geo ? { geo: piece.geo ?? plan.geo } : {}) };
  const r = addAsNewSketch(plan, content, `${name}`.replace(/\s+/g, " ").trim() || "Agent patch", now);
  const sketch = sanitizeSketch(r.sketch);
  if (!sketch) return { ok: false, error: "The new sketch wouldn't keep the piece." };
  // (the main plan exactly as it was; the user's sketches too (the one open, each one saved); only the new one more)
  const before = sanitizeSketch({ ...plan }) ?? plan, ids = sketchList(before).list.map(x => x.id);
  if (mainOf(sketch) !== mainOf(before)) return { ok: false, error: "Adding the new sketch would change the main plan: refused." };
  if (userOf(sketch, ids) !== userOf(before, ids)) return { ok: false, error: "Adding the new sketch would change the user's own sketches: refused." };
  const w = contentOf(sketch, r.id), has = (list: { id: string }[] | undefined, ids: string[]) => ids.every(id => (list ?? []).some(x => x.id === id));
  const added = { ...all(piece), crossings: (piece.crossings ?? []).map(x => x.id) };
  if (!w || !has(w.lanes, added.lanes) || !has(w.connectors, added.connectors) || !has(w.junctions, added.junctions) || !has(w.crossings, added.crossings))
    return { ok: false, error: "Some of the piece's items wouldn't survive in the new sketch (they don't fit together on their own)." };
  const counts: WindowCounts = { lanes: added.lanes.length, connectors: added.connectors.length, roads: w.roads.length, junctions: added.junctions.length, crossings: added.crossings.length, zones: added.zones?.length ?? 0 };
  return { ok: true, sketch, sketchId: r.id, sketchName: r.name, added, counts, preview: { added: lines(w) } };
}
