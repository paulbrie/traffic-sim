/**
 * Aligning lanes as a design tool does (T149): with two or more selected, their bounding boxes lined up on
 * one axis (left, centre or right edges; top, middle or bottom) against the first selected (the anchor,
 * which stays put). Whole lanes move, their shapes unchanged; a lane of a side-by-side road moves with its
 * road (its lead and the lanes laid out beside it), as a road's move does; connectors follow their lanes'
 * ends, as when dragging; junctions don't move. In plan metres: x east, y south (as the map), so "top" is
 * the smallest y, north. Plain geometry, no framework.
 */
import { boundsOfPts, laneById, roadOf, samples, transformPiece, translation, type Pt, type Sketch } from "./lane-sketch";

export type Align = "left" | "center" | "right" | "top" | "middle" | "bottom";
export const ALIGNS: Align[] = ["left", "center", "right", "top", "middle", "bottom"];

type Box = { minX: number; minY: number; maxX: number; maxY: number };
/** what moves together: a lane, or a side-by-side road's lanes all; and its bounding box */
export type AlignUnit = { lanes: string[]; box: Box };

/** the lanes that move with `id`: its side-by-side road's (laid out from a lead), else itself */
function unitOf(sk: Sketch, id: string): string[] {
  const r = roadOf(sk, id);
  return r?.align ? r.lanes : [id];
}
function boxOf(sk: Sketch, lanes: string[]): Box | null {
  const pts: Pt[] = [];
  for (const id of lanes) { const l = laneById(sk, id); if (l) pts.push(...samples(l.shape, 1)); }
  return boundsOfPts(pts);
}

/**
 * The selected lanes as units to align, in the selection's order: the first is the anchor's. A lane whose
 * unit is already in (two lanes of one side-by-side road) adds nothing; unknown lanes are left out.
 */
export function alignUnits(sk: Sketch, laneIds: string[]): AlignUnit[] {
  const out: AlignUnit[] = [], taken = new Set<string>();
  for (const id of laneIds) {
    if (taken.has(id) || !laneById(sk, id)) continue;
    const lanes = unitOf(sk, id), box = boxOf(sk, lanes);
    lanes.forEach(l => taken.add(l));
    if (box) out.push({ lanes, box });
  }
  return out;
}

/** the coordinate a box lines up by */
const edge = (b: Box, how: Align) =>
  how === "left" ? b.minX : how === "right" ? b.maxX : how === "center" ? (b.minX + b.maxX) / 2
    : how === "top" ? b.minY : how === "bottom" ? b.maxY : (b.minY + b.maxY) / 2;
const horizontal = (how: Align) => how === "left" || how === "center" || how === "right";

/** how far each unit after the anchor moves (dx, dy), lined up `how` against the anchor */
export function alignOffsets(units: AlignUnit[], how: Align): { lanes: string[]; dx: number; dy: number }[] {
  if (units.length < 2) return [];
  const target = edge(units[0].box, how);
  return units.slice(1).map(u => {
    const d = Math.round((target - edge(u.box, how)) * 100) / 100;
    return horizontal(how) ? { lanes: u.lanes, dx: d, dy: 0 } : { lanes: u.lanes, dx: 0, dy: d };
  });
}

/** can these lanes be aligned (two units at least) */
export const canAlign = (sk: Sketch, laneIds: string[]) => alignUnits(sk, laneIds).length >= 2;

/** the sketch with the selected lanes lined up `how` against the first (unchanged if there's nothing to move) */
export function alignLanes(sk: Sketch, laneIds: string[], how: Align): Sketch {
  let out = sk;
  for (const m of alignOffsets(alignUnits(sk, laneIds), how)) {
    if (!m.dx && !m.dy) continue;
    out = transformPiece(out, { lanes: m.lanes, connectors: [], junctions: [] }, translation(m.dx, m.dy));
  }
  return out;
}
