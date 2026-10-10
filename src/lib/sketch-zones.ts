/**
 * Zones (neighbourhoods, areas) on the sketch: polygons the user draws and labels, with a colour and
 * a note. They are for the plan's reader only: the simulation never sees them. Plain data and
 * geometry, no framework; coordinates are metres, y down (like the plan). Not V1's demand zones.
 */
import type { Pt, Sketch } from "./lane-sketch";

export interface SketchZone {
  id: string;
  name: string;
  /** its corners, in order (three at least) */
  outline: Pt[];
  /** one of ZONE_COLORS (any #rrggbb is kept) */
  color: string;
  note?: string;
}

/** the colours a zone can take (the panel's swatches); new zones go round them */
export const ZONE_COLORS = ["#3b82f6", "#22c55e", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6", "#ec4899", "#64748b"] as const;

const round = (v: number) => Math.round(v * 100) / 100;
const roundPt = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });

/** the next free zone id ("z1", "z2"…) */
export function nextZoneId(zones: SketchZone[]): string {
  let n = 0;
  for (const z of zones) if (z.id.startsWith("z")) n = Math.max(n, Number(z.id.slice(1)) || 0);
  return `z${n + 1}`;
}

/** a new zone with these corners: "Zone n", the next colour round the palette (unless given) */
export function addZone(sk: Sketch, outline: Pt[], opts: { name?: string; color?: string } = {}): [Sketch, SketchZone] {
  const zones = sk.zones ?? [];
  const id = nextZoneId(zones);
  const z: SketchZone = { id, name: opts.name ?? `Zone ${id.slice(1)}`, outline: outline.map(roundPt), color: opts.color ?? ZONE_COLORS[zones.length % ZONE_COLORS.length] };
  return [{ ...sk, zones: [...zones, z] }, z];
}

export function updateZone(sk: Sketch, id: string, patch: Partial<Omit<SketchZone, "id">>): Sketch {
  return {
    ...sk,
    zones: (sk.zones ?? []).map(z => {
      if (z.id !== id) return z;
      const next = { ...z, ...patch };
      // (an emptied note goes, rather than staying as "")
      if (!next.note) delete next.note;
      return next;
    }),
  };
}

export function deleteZone(sk: Sketch, id: string): Sketch {
  const rest = (sk.zones ?? []).filter(z => z.id !== id);
  const { zones: _, ...out } = sk;
  return rest.length ? { ...out, zones: rest } : out;
}

/** zones moved by (dx, dy) */
export function moveZones(sk: Sketch, ids: string[], dx: number, dy: number): Sketch {
  const set = new Set(ids);
  return { ...sk, zones: (sk.zones ?? []).map(z => (set.has(z.id) ? { ...z, outline: z.outline.map(p => roundPt({ x: p.x + dx, y: p.y + dy })) } : z)) };
}

/** corner `i` moved to `p` */
export function moveZoneCorner(z: SketchZone, i: number, p: Pt): SketchZone {
  return { ...z, outline: z.outline.map((q, k) => (k === i ? roundPt(p) : q)) };
}
/** a corner put in before corner `i` */
export function insertZoneCorner(z: SketchZone, i: number, p: Pt): SketchZone {
  return { ...z, outline: [...z.outline.slice(0, i), roundPt(p), ...z.outline.slice(i)] };
}
/** corner `i` taken out (keeping three at least) */
export function removeZoneCorner(z: SketchZone, i: number): SketchZone {
  return z.outline.length <= 3 ? z : { ...z, outline: z.outline.filter((_, k) => k !== i) };
}

/** the zone's area, m² */
export function zoneArea(outline: Pt[]): number {
  let a = 0;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) a += (outline[j].x + outline[i].x) * (outline[j].y - outline[i].y);
  return Math.abs(a / 2);
}
/** an area as people say it: m² up to a hectare, then ha */
export function formatArea(m2: number): string {
  if (m2 < 10_000) return `${Math.round(m2).toLocaleString("en-GB")} m²`;
  const ha = m2 / 10_000;
  return `${ha < 100 ? ha.toFixed(2) : Math.round(ha).toLocaleString("en-GB")} ha`;
}

export function insideZone(p: Pt, outline: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i], b = outline[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Where a zone's name goes: its centroid if that's inside it, else (a concave zone, an L or a C)
 * the middle of the widest run across it, through its centre's height.
 */
export function zoneLabelPoint(outline: Pt[]): Pt {
  const n = outline.length;
  if (!n) return { x: 0, y: 0 };
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = outline[j].x * outline[i].y - outline[i].x * outline[j].y;
    a += f;
    cx += (outline[j].x + outline[i].x) * f;
    cy += (outline[j].y + outline[i].y) * f;
  }
  const c = Math.abs(a) > 1e-9 ? { x: cx / (3 * a), y: cy / (3 * a) } : { x: outline.reduce((s, p) => s + p.x, 0) / n, y: outline.reduce((s, p) => s + p.y, 0) / n };
  if (insideZone(c, outline)) return c;
  // The widest run across, on a few heights round the centre's.
  const ys = outline.map(p => p.y), lo = Math.min(...ys), hi = Math.max(...ys);
  let best: Pt = outline[0], width = -1;
  for (let k = 1; k < 16; k++) {
    const y = lo + ((hi - lo) * k) / 16;
    const xs: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const p = outline[i], q = outline[j];
      if ((p.y > y) !== (q.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
    }
    xs.sort((u, v) => u - v);
    for (let m = 0; m + 1 < xs.length; m += 2) {
      // (runs nearer the centre's height win ties)
      const w = xs[m + 1] - xs[m] - Math.abs(y - c.y) * 1e-6;
      if (w > width) { width = w; best = { x: (xs[m] + xs[m + 1]) / 2, y }; }
    }
  }
  return best;
}

const HEX = /^#[0-9a-f]{6}$/i;

/** a zone as stored, checked: null when it can't be one (fewer than 3 corners, no id) */
export function sanitizeZone(raw: unknown): SketchZone | null {
  if (!raw || typeof raw !== "object") return null;
  const z = raw as Record<string, unknown>;
  if (typeof z.id !== "string" || !z.id || !Array.isArray(z.outline)) return null;
  const outline = z.outline.flatMap(p => {
    const q = p as Record<string, unknown> | null;
    return q && Number.isFinite(q.x) && Number.isFinite(q.y) ? [roundPt({ x: q.x as number, y: q.y as number })] : [];
  });
  if (outline.length < 3) return null;
  const name = typeof z.name === "string" && z.name.trim() ? z.name.slice(0, 120) : `Zone ${z.id.replace(/^z/, "")}`;
  const color = typeof z.color === "string" && HEX.test(z.color) ? z.color.toLowerCase() : ZONE_COLORS[0];
  const note = typeof z.note === "string" && z.note.trim() ? z.note.slice(0, 2000) : undefined;
  return { id: z.id, name, outline, color, ...(note ? { note } : {}) };
}
/** a sketch's zones as stored, checked (ids kept unique: a repeated one is dropped) */
export function sanitizeZones(raw: unknown): SketchZone[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap(r => {
    const z = sanitizeZone(r);
    if (!z || seen.has(z.id)) return [];
    seen.add(z.id);
    return [z];
  });
}

/** zones to paste: these, as they are */
export function copyZones(sk: Sketch, ids: string[]): SketchZone[] {
  const set = new Set(ids);
  return (sk.zones ?? []).filter(z => set.has(z.id));
}
/** zones pasted in with fresh ids and "… copy" names, moved by (dx, dy); answers the sketch and the new ids */
export function pasteZones(sk: Sketch, zones: SketchZone[], dx: number, dy: number): { sketch: Sketch; ids: string[] } {
  if (!zones.length) return { sketch: sk, ids: [] };
  const all = [...(sk.zones ?? [])];
  const ids: string[] = [];
  for (const z of zones) {
    const id = nextZoneId(all);
    all.push({ ...z, id, name: / copy$/.test(z.name) ? z.name : `${z.name} copy`, outline: z.outline.map(p => roundPt({ x: p.x + dx, y: p.y + dy })) });
    ids.push(id);
  }
  return { sketch: { ...sk, zones: all }, ids };
}
