/**
 * Shapes on the sketch (ticket #268): closed areas the user draws (point by point, or a rectangle or a circle to
 * start from, every point then editable) and colours as they like: a park, a building, water, a car park. Only
 * drawn, on the ground under the roads: the simulation never sees them. Plain data and geometry, no framework;
 * coordinates are metres, y down (like the plan). Not zones (sketch-zones.ts), which are labelled areas to read
 * the plan by.
 */
import type { Pt, Sketch } from "./lane-sketch";
import { insideZone, zoneArea } from "./sketch-zones";

export interface SketchShape {
  id: string;
  /** what it is (the list's and the panel's; not drawn on the map) */
  name: string;
  /** its points, in order (three at least), closed back to the first */
  outline: Pt[];
  /** its fill, #rrggbb */
  color: string;
  /** the fill's opacity, 0.05 (see-through) to 1 (solid, the default) */
  opacity?: number;
  /** a border round it: its colour (#rrggbb) and width (metres) */
  border?: { color: string; width: number };
}

/** the panel's swatches (any #rrggbb can be picked besides) */
export const SHAPE_COLORS = ["#94a3b8", "#4ade80", "#166534", "#60a5fa", "#fbbf24", "#f87171", "#a16207", "#e5e7eb"] as const;
export const SHAPE_COLOR = SHAPE_COLORS[0];
export const SHAPE_BORDER = { color: "#334155", width: 0.3 };
/** points round a circle drawn as a shape */
export const CIRCLE_POINTS = 24;
export const MIN_OPACITY = 0.05;

const HEX = /^#[0-9a-f]{6}$/i;
const round = (v: number) => Math.round(v * 100) / 100;
const roundPt = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });
const clampOpacity = (v: number) => Math.round(Math.min(1, Math.max(MIN_OPACITY, v)) * 100) / 100;

/** the fill's opacity (1 when not set) */
export const shapeOpacity = (s: SketchShape) => s.opacity ?? 1;

/** the next free shape id ("s1", "s2"…) */
export function nextShapeId(shapes: SketchShape[]): string {
  let n = 0;
  for (const s of shapes) if (/^s\d+$/.test(s.id)) n = Math.max(n, Number(s.id.slice(1)));
  return `s${n + 1}`;
}

/** a rectangle with corners `a` and `b` (opposite), its sides along the axes */
export function rectOutline(a: Pt, b: Pt): Pt[] {
  return [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
}
/** a circle round `c` through `edge`, as CIRCLE_POINTS points (the first at `edge`) */
export function circleOutline(c: Pt, edge: Pt, n = CIRCLE_POINTS): Pt[] {
  const r = Math.hypot(edge.x - c.x, edge.y - c.y), a0 = Math.atan2(edge.y - c.y, edge.x - c.x);
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos(a0 + (2 * Math.PI * i) / n), y: c.y + r * Math.sin(a0 + (2 * Math.PI * i) / n) }));
}

/** a new shape with these points: "Shape n", in `color` (else the default), solid */
export function addShape(sk: Sketch, outline: Pt[], opts: { name?: string; color?: string; opacity?: number; border?: SketchShape["border"] } = {}): [Sketch, SketchShape] {
  const shapes = sk.shapes ?? [], id = nextShapeId(shapes);
  const s: SketchShape = {
    id, name: opts.name ?? `Shape ${id.slice(1)}`, outline: outline.map(roundPt), color: opts.color ?? SHAPE_COLOR,
    ...(opts.opacity !== undefined && opts.opacity < 1 ? { opacity: clampOpacity(opts.opacity) } : {}), ...(opts.border ? { border: { ...opts.border } } : {}),
  };
  return [{ ...sk, shapes: [...shapes, s] }, s];
}

/** a shape changed: `opacity` 1 and `border` null are taken out (as not set) */
export function updateShape(sk: Sketch, id: string, patch: Partial<Omit<SketchShape, "id" | "border">> & { border?: SketchShape["border"] | null }): Sketch {
  return {
    ...sk,
    shapes: (sk.shapes ?? []).map(s => {
      if (s.id !== id) return s;
      const { border, ...rest } = patch;
      const next: SketchShape = { ...s, ...rest };
      if (border === null) delete next.border; else if (border) next.border = { color: border.color, width: Math.round(Math.min(5, Math.max(0.05, border.width)) * 100) / 100 };
      if (next.opacity !== undefined) { if (next.opacity >= 1) delete next.opacity; else next.opacity = clampOpacity(next.opacity); }
      return next;
    }),
  };
}

export function deleteShape(sk: Sketch, id: string): Sketch {
  const rest = (sk.shapes ?? []).filter(s => s.id !== id);
  const { shapes: _, ...out } = sk;
  return rest.length ? { ...out, shapes: rest } : out;
}

/** point `i` moved to `p` */
export const moveShapePoint = (s: SketchShape, i: number, p: Pt): SketchShape => ({ ...s, outline: s.outline.map((q, k) => (k === i ? roundPt(p) : q)) });
/** a point put in before point `i` */
export const insertShapePoint = (s: SketchShape, i: number, p: Pt): SketchShape => ({ ...s, outline: [...s.outline.slice(0, i), roundPt(p), ...s.outline.slice(i)] });
/** point `i` taken out (keeping three at least) */
export const removeShapePoint = (s: SketchShape, i: number): SketchShape => (s.outline.length <= 3 ? s : { ...s, outline: s.outline.filter((_, k) => k !== i) });

/** the shape's area, m² */
export const shapeArea = (s: SketchShape) => zoneArea(s.outline);

/** the shape under `p`: the smallest one holding it (a shape on another is picked first), or null */
export function shapeAt(shapes: SketchShape[] | undefined, p: Pt): SketchShape | null {
  let best: SketchShape | null = null, area = Infinity;
  for (const s of shapes ?? []) {
    if (!insideZone(p, s.outline)) continue;
    const a = zoneArea(s.outline);
    if (a < area) { area = a; best = s; }
  }
  return best;
}

/** a shape as stored, checked: null when it can't be one (fewer than 3 points, no id) */
export function sanitizeShape(raw: unknown): SketchShape | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || !s.id || !Array.isArray(s.outline)) return null;
  const outline = s.outline.flatMap(p => {
    const q = p as Record<string, unknown> | null;
    return q && Number.isFinite(q.x) && Number.isFinite(q.y) ? [roundPt({ x: q.x as number, y: q.y as number })] : [];
  });
  if (outline.length < 3) return null;
  const name = typeof s.name === "string" && s.name.trim() ? s.name.slice(0, 120) : `Shape ${s.id.replace(/^s/, "")}`;
  const color = typeof s.color === "string" && HEX.test(s.color) ? s.color.toLowerCase() : SHAPE_COLOR;
  const opacity = typeof s.opacity === "number" && Number.isFinite(s.opacity) && s.opacity < 1 ? clampOpacity(s.opacity) : undefined;
  const b = s.border as Record<string, unknown> | undefined;
  const border = b && typeof b === "object" && typeof b.color === "string" && HEX.test(b.color) && typeof b.width === "number" && Number.isFinite(b.width) && b.width > 0
    ? { color: b.color.toLowerCase(), width: Math.round(Math.min(5, Math.max(0.05, b.width)) * 100) / 100 } : undefined;
  return { id: s.id, name, outline, color, ...(opacity !== undefined ? { opacity } : {}), ...(border ? { border } : {}) };
}
/** a sketch's shapes as stored, checked (ids kept unique: a repeated one is dropped) */
export function sanitizeShapes(raw: unknown): SketchShape[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap(r => {
    const s = sanitizeShape(r);
    if (!s || seen.has(s.id)) return [];
    seen.add(s.id);
    return [s];
  });
}

/** shapes to paste: these, as they are */
export function copyShapes(sk: Sketch, ids: string[]): SketchShape[] {
  const set = new Set(ids);
  return (sk.shapes ?? []).filter(s => set.has(s.id));
}
/** shapes pasted in with fresh ids and "… copy" names, moved by (dx, dy); answers the sketch and the new ids */
export function pasteShapes(sk: Sketch, shapes: SketchShape[], dx: number, dy: number): { sketch: Sketch; ids: string[] } {
  if (!shapes.length) return { sketch: sk, ids: [] };
  const all = [...(sk.shapes ?? [])], ids: string[] = [];
  for (const s of shapes) {
    const id = nextShapeId(all);
    all.push({ ...s, id, name: / copy$/.test(s.name) ? s.name : `${s.name} copy`, outline: s.outline.map(p => roundPt({ x: p.x + dx, y: p.y + dy })) });
    ids.push(id);
  }
  return { sketch: { ...sk, shapes: all }, ids };
}
