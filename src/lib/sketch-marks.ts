/**
 * Marks on a V2 plan (ticket #289): a pin at a place, with a name and a colour, put there by pasting its coordinates
 * (Ctrl/Cmd+V with them on the clipboard, or typed into search), or from the map's right-click menu. Only drawn: the
 * cars don't see them. Kept in plan metres (x east, y south) as everything else is; their latitude and longitude come
 * from where the plan is placed on the map. Framework-free.
 */
import type { Pt, Sketch } from "./lane-sketch";

export interface SketchMark {
  id: string;
  name: string;
  at: Pt;
  color: string;
}

/** the colours offered (the first, a new mark's) */
export const MARK_COLORS = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#475569"] as const;
export const MARK_COLOR = MARK_COLORS[0];
const MAX_NAME = 80;

const HEX = /^#[0-9a-f]{6}$/;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function nextMarkId(marks: SketchMark[] | undefined): string {
  let n = 0;
  for (const m of marks ?? []) if (/^m\d+$/.test(m.id)) n = Math.max(n, Number(m.id.slice(1)));
  return `m${n + 1}`;
}

/** a mark at `at` (its name: "Mark n", or given), added last; the sketch and the mark */
export function addMark(sk: Sketch, at: Pt, opts: { name?: string; color?: string } = {}): [Sketch, SketchMark] {
  const id = nextMarkId(sk.marks);
  const color = opts.color && HEX.test(opts.color) ? opts.color : MARK_COLOR;
  const m: SketchMark = { id, name: (opts.name?.trim() || `Mark ${id.slice(1)}`).slice(0, MAX_NAME), at: { x: r2(at.x), y: r2(at.y) }, color };
  return [{ ...sk, marks: [...(sk.marks ?? []), m] }, m];
}

export function updateMark(sk: Sketch, id: string, patch: Partial<Omit<SketchMark, "id">>): Sketch {
  if (!sk.marks?.some(m => m.id === id)) return sk;
  return {
    ...sk,
    marks: sk.marks.map(m => {
      if (m.id !== id) return m;
      const n = { ...m, ...patch };
      if (patch.at) n.at = { x: r2(patch.at.x), y: r2(patch.at.y) };
      if (patch.name !== undefined) n.name = patch.name.slice(0, MAX_NAME);
      if (patch.color !== undefined && !HEX.test(patch.color)) n.color = m.color;
      return n;
    }),
  };
}

export function deleteMark(sk: Sketch, id: string): Sketch {
  const marks = (sk.marks ?? []).filter(m => m.id !== id);
  if (marks.length === sk.marks?.length) return sk;
  const { marks: _, ...rest } = sk;
  return marks.length ? { ...rest, marks } : rest;
}

/**
 * How a pin is drawn, in screen pixels: its tip on the place, its head a circle above it. `markAt` and the 2D painter
 * share it, so a click on the head picks what is drawn there.
 */
export const PIN = { head: 9, rise: 24 };

/** the mark under the pointer (`px`: a screen pixel in metres): its head or its tip; the nearest, the last drawn first */
export function markAt(marks: SketchMark[] | undefined, p: Pt, px: number): SketchMark | null {
  let best: SketchMark | null = null, bd = Infinity;
  for (const m of [...(marks ?? [])].reverse()) {
    const head = { x: m.at.x, y: m.at.y - PIN.rise * px };
    const d = Math.min(Math.hypot(p.x - head.x, p.y - head.y) - PIN.head * px, Math.hypot(p.x - m.at.x, p.y - m.at.y) - 4 * px);
    if (d <= 2 * px && d < bd) { bd = d; best = m; }
  }
  return best;
}

/** marks as kept (a saved plan, a patch): bad ones dropped, a repeated id kept once, names and colours as they may be */
export function sanitizeMarks(raw: unknown): SketchMark[] {
  if (!Array.isArray(raw)) return [];
  const out: SketchMark[] = [], seen = new Set<string>();
  for (const o of raw) {
    if (!o || typeof o !== "object") continue;
    const m = o as Record<string, unknown>, at = m.at as Record<string, unknown> | undefined;
    if (typeof m.id !== "string" || !m.id || seen.has(m.id)) continue;
    if (!at || typeof at.x !== "number" || typeof at.y !== "number" || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
    seen.add(m.id);
    const color = typeof m.color === "string" && HEX.test(m.color.toLowerCase()) ? m.color.toLowerCase() : MARK_COLOR;
    const name = typeof m.name === "string" && m.name.trim() ? m.name.slice(0, MAX_NAME) : `Mark ${m.id.replace(/^m/, "")}`;
    out.push({ id: m.id, name, at: { x: r2(at.x), y: r2(at.y) }, color });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Coordinates pasted or typed

export interface LatLon { lat: number; lon: number }

const ok = (lat: number, lon: number): LatLon | null =>
  Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;

const NUM = String.raw`[-+−]?\d+(?:\.\d+)?`;
/**
 * one coordinate: degrees, with minutes and seconds (DMS, as Google Maps copies them: 46°08'05.0"N) or decimal
 * minutes (46°08.083'N) or neither (46.1347); its hemisphere letter before it (`lead`) or after it
 */
const DEG = String.raw`(${NUM})\s*(?:[°º]\s*)?(?:(\d+(?:\.\d+)?)\s*['′’]\s*)?(?:(\d+(?:\.\d+)?)\s*(?:"|''|″|”)\s*)?`;
const PART = { lead: String.raw`(?:([NSEW])\s*)?${DEG}`, trail: String.raw`${DEG}([NSEW])?` };
const SEP = String.raw`\s*(?:[,;/]\s*|\s+)`;
// (each way the letters may be written: both after, both before, then mixed)
const PAIRS = ([["trail", "trail"], ["lead", "lead"], ["lead", "trail"], ["trail", "lead"]] as const).map(([a, b]) => ({ a, b, re: new RegExp(String.raw`^\s*${PART[a]}${SEP}${PART[b]}\s*$`, "i") }));

function part(deg: string, min: string | undefined, sec: string | undefined, hem: string | undefined) {
  const d = Number(deg.replace("−", "-").replace("+", ""));
  if ((min || sec) && !Number.isInteger(d)) return null;
  const m = Number(min ?? 0), s = Number(sec ?? 0);
  if (m >= 60 || s >= 60) return null;
  const h = hem?.toUpperCase() ?? null;
  // (a minus sign and a letter both: one too many)
  if (h && d < 0) return null;
  return { v: (d < 0 || h === "S" || h === "W" ? -1 : 1) * (Math.abs(d) + m / 60 + s / 3600), h };
}

/** a coordinate's groups as matched: its letter first (`lead`) or last */
const groups = (m: RegExpExecArray, at: number, how: "lead" | "trail") =>
  how === "lead" ? part(m[at + 1], m[at + 2], m[at + 3], m[at]) : part(m[at], m[at + 1], m[at + 2], m[at + 3]);

/**
 * Latitude and longitude in what was pasted or typed, if that is all it is: "46.1347, 24.5012" (or a space, a
 * semicolon between), with N/S/E/W ("46.1347° N 24.5012° E", "N 46.1347 E 24.5012", either way round),
 * degrees-minutes-seconds (46°08'05.0"N 24°30'04.3"E), a Google Maps link (the place's own pin, else its query,
 * else the view's middle), an OpenStreetMap link, or geo:46.13,24.50. Null for anything else, so ordinary text
 * pasted is left alone.
 */
export function parseCoordinates(text: string): LatLon | null {
  const t = text.trim();
  if (!t || t.length > 2000) return null;
  if (/^(https?:\/\/|geo:)/i.test(t)) return fromLink(t);
  const one = t.replace(/\s+/g, " ");
  for (const p of PAIRS) {
    const m = p.re.exec(one);
    if (!m) continue;
    const a = groups(m, 1, p.a), b = groups(m, 5, p.b);
    if (!a || !b) continue;
    // (lat first unless the letters say otherwise: E/W on the first, or N/S on the second)
    const swap = a.h === "E" || a.h === "W" || b.h === "N" || b.h === "S";
    const lat = swap ? b : a, lon = swap ? a : b;
    if ((lat.h && !"NS".includes(lat.h)) || (lon.h && !"EW".includes(lon.h))) continue;
    const g = ok(lat.v, lon.v);
    if (g) return g;
  }
  return null;
}

function fromLink(t: string): LatLon | null {
  let u = t;
  try { u = decodeURIComponent(t); } catch { /* as it is */ }
  const pair = (re: RegExp) => { const m = re.exec(u); return m ? ok(Number(m[1]), Number(m[2])) : null; };
  const n = String.raw`(-?\d+(?:\.\d+)?)`;
  return (
    // (Google Maps: a place's pin, then a query, then the view's middle)
    pair(new RegExp(String.raw`!3d${n}!4d${n}`)) ??
    pair(new RegExp(String.raw`[?&](?:q|query|ll|center|destination|daddr)=(?:loc:)?${n}\s*,\s*${n}`)) ??
    pair(new RegExp(String.raw`@${n},${n}`)) ??
    // (OpenStreetMap: a marker, then the map's middle; geo: URIs)
    pair(new RegExp(String.raw`[?&]mlat=${n}&mlon=${n}`)) ??
    pair(new RegExp(String.raw`#map=\d+(?:\.\d+)?/${n}/${n}`)) ??
    pair(new RegExp(String.raw`^geo:${n},${n}`, "i"))
  );
}

/** the coordinates written as Google Maps takes them */
export const formatLatLon = (g: LatLon) => `${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}`;
