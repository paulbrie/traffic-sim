/**
 * Speed bumps, humps, tables and cushions (ticket #101): drawn across a road from one kerb `a` to the other `b`,
 * `length` metres along the traffic. Cars slow to the bump's crossing speed by the time they reach it and keep to
 * it until they are off it; buses and trucks slow more (less over cushions, which they straddle). Framework-free;
 * metres, y down. The figures behind the presets are in docs/speed-bumps.md.
 */
import type { Pt, Sketch } from "./lane-sketch";

export type BumpKind = "bump" | "hump" | "table" | "cushion";
export interface SketchBump {
  id: string;
  kind: BumpKind;
  /** its ends, kerb to kerb */
  a: Pt; b: Pt;
  /** metres along the traffic */
  length: number;
  /** centimetres above the road */
  height: number;
  /** the speed cars cross it at (km/h); none: its kind's */
  speed?: number;
}

export interface BumpPreset {
  label: string; short: string; length: number; height: number;
  /** cars' crossing speed (km/h) */
  speed: number;
  hint: string;
}
/**
 * The kinds, with typical dimensions and the mean speed cars cross them at (UK TRL measurements: TAL 2/96 for
 * 75 mm round-top and flat-top humps, TRL 312 / TAL 1/98 for cushions; short bumps from manufacturers' ratings).
 */
export const BUMP_KINDS: Record<BumpKind, BumpPreset> = {
  bump: { label: "Speed bump", short: "Bump", length: 0.6, height: 5, speed: 12, hint: "Short and abrupt (0.3–0.9 m): car parks and private roads, crossed at walking pace to 15 km/h" },
  hump: { label: "Speed hump", short: "Hump", length: 3.7, height: 7.5, speed: 24, hint: "Round-top or sinusoidal, about 3.7 m long, 75 mm: cars cross at about 24 km/h on average" },
  table: { label: "Speed table", short: "Table", length: 6, height: 7.5, speed: 21, hint: "Flat-top plateau with ramps, often with a zebra on top: cars cross at about 21 km/h" },
  cushion: { label: "Speed cushions", short: "Cushions", length: 3, height: 7, speed: 27, hint: "Raised squares, one per lane, about 1.8 m wide: cars slow to about 27 km/h; buses, trucks and fire engines straddle them" },
};
export const BUMP_KIND_IDS = Object.keys(BUMP_KINDS) as BumpKind[];
export const BUMP_KIND: BumpKind = "hump";
/** how much slower buses and trucks cross a bump, hump or table than cars (km/h; TRL 417: about 5 mph) */
export const HEAVY_SLOWER = 8;
/** a cushion: how much faster wide vehicles cross it than cars do (as a share), straddling it */
export const CUSHION_HEAVY = 1.5;
/** a cushion's width, and the stretch of road each one sits in (a lane) */
export const CUSHION_WIDTH = 1.8, CUSHION_PITCH = 3.5;

/** what cars cross it at (km/h) */
export const bumpSpeed = (b: SketchBump) => b.speed ?? BUMP_KINDS[b.kind].speed;
/** what buses and trucks cross it at (km/h) */
export const bumpHeavySpeed = (b: SketchBump) => (b.kind === "cushion" ? Math.round(bumpSpeed(b) * CUSHION_HEAVY) : Math.max(5, bumpSpeed(b) - HEAVY_SLOWER));

const round = (v: number) => Math.round(v * 100) / 100;
const roundPt = (p: Pt): Pt => ({ x: round(p.x), y: round(p.y) });

/** its axes (`u` from kerb to kerb, `v` along the traffic), its width kerb to kerb, and its outline (a's side 0 and 3, b's 1 and 2) */
export function bumpFrame(b: SketchBump) {
  const dx = b.b.x - b.a.x, dy = b.b.y - b.a.y, len = Math.hypot(dx, dy) || 1, u = { x: dx / len, y: dy / len }, v = { x: -u.y, y: u.x }, h = b.length / 2;
  const at = (s: number, t: number): Pt => ({ x: b.a.x + u.x * s + v.x * t, y: b.a.y + u.y * s + v.y * t });
  return { u, v, len, at, corners: [at(0, h), at(len, h), at(len, -h), at(0, -h)] };
}
/** is `p` on it (with `pad` metres to spare all round) */
export function onBump(b: SketchBump, p: Pt, pad = 0): boolean {
  const f = bumpFrame(b), qx = p.x - b.a.x, qy = p.y - b.a.y, along = qx * f.u.x + qy * f.u.y, across = qx * f.v.x + qy * f.v.y;
  return along >= -pad && along <= f.len + pad && Math.abs(across) <= b.length / 2 + pad;
}

/** cushions: where each sits kerb to kerb (from, to; metres from `a`), one centred in each lane's width */
export function cushionSpans(b: SketchBump): [number, number][] {
  const len = bumpFrame(b).len, n = Math.max(1, Math.round(len / CUSHION_PITCH)), pitch = len / n, w = Math.min(CUSHION_WIDTH, pitch * 0.6);
  return Array.from({ length: n }, (_, i) => [pitch * (i + 0.5) - w / 2, pitch * (i + 0.5) + w / 2] as [number, number]);
}

/**
 * How it is drawn: its raised body (`body`, one polygon, or one per cushion) in `color`, and its markings in
 * `markColor`: white triangles on the ramps of humps, tables and cushions, pointing up them (as the UK and the
 * Netherlands mark them), yellow and black bands across a short bump.
 */
export function bumpShapes(b: SketchBump): { body: Pt[][]; color: string; marks: Pt[][]; markColor: string } {
  const f = bumpFrame(b), h = b.length / 2;
  const box = (s0: number, s1: number, t0: number, t1: number) => [f.at(s0, t0), f.at(s1, t0), f.at(s1, t1), f.at(s0, t1)];
  if (b.kind === "bump") {
    const marks: Pt[][] = [];
    for (let s = 0; s < f.len; s += 1) marks.push(box(s, Math.min(f.len, s + 0.5), -h, h));
    return { body: [f.corners], color: "#18181b", marks, markColor: "#facc15" };
  }
  // (the teeth: on each ramp, from its foot inward, each `base` wide along it)
  const ramp = b.kind === "table" ? Math.min(1.5, h * 0.4) : Math.min(1, h * 0.45);
  const teeth = (s0: number, s1: number): Pt[][] => {
    const out: Pt[][] = [], n = Math.max(1, Math.round((s1 - s0) / 1.2)), base = (s1 - s0) / n;
    for (let i = 0; i < n; i++) {
      const m = s0 + base * (i + 0.5), w = Math.min(0.5, base * 0.35);
      out.push([f.at(m - w, h), f.at(m + w, h), f.at(m, h - ramp)], [f.at(m - w, -h), f.at(m + w, -h), f.at(m, -h + ramp)]);
    }
    return out;
  };
  if (b.kind === "cushion") {
    const spans = cushionSpans(b);
    return { body: spans.map(([s0, s1]) => box(s0, s1, -h, h)), color: "#b45309", marks: spans.flatMap(([s0, s1]) => teeth(s0, s1)), markColor: "#ffffff" };
  }
  return { body: [f.corners], color: b.kind === "table" ? "#9f4b3a" : "#7c4a3a", marks: teeth(0, f.len), markColor: "#ffffff" };
}

/** the next free id ("h1", "h2"…) */
function nextBumpId(sk: Sketch): string {
  const used = new Set((sk.bumps ?? []).map(x => x.id));
  let n = used.size + 1;
  while (used.has(`h${n}`)) n++;
  return `h${n}`;
}
/** a new one from kerb `a` to kerb `b`, of this kind (its kind's length and height) */
export function addBump(sk: Sketch, a: Pt, b: Pt, kind: BumpKind = BUMP_KIND): [Sketch, SketchBump] {
  const k = BUMP_KINDS[kind], x: SketchBump = { id: nextBumpId(sk), kind, a: roundPt(a), b: roundPt(b), length: k.length, height: k.height };
  return [{ ...sk, bumps: [...(sk.bumps ?? []), x] }, x];
}
/** a change to one (`speed: null`: back to its kind's; a new kind takes that kind's length and height, unless given too) */
export type BumpPatch = Partial<Omit<SketchBump, "id" | "speed">> & { speed?: number | null };
export function updateBump(sk: Sketch, id: string, patch: BumpPatch): Sketch {
  return { ...sk, bumps: (sk.bumps ?? []).map(x => {
    if (x.id !== id) return x;
    const { speed, ...rest } = patch, k = patch.kind && patch.kind !== x.kind ? BUMP_KINDS[patch.kind] : null;
    const next: SketchBump = { ...x, ...(k ? { length: k.length, height: k.height } : {}), ...rest };
    if (rest.a) next.a = roundPt(rest.a);
    if (rest.b) next.b = roundPt(rest.b);
    if (speed === null || k) delete next.speed;
    if (typeof speed === "number") next.speed = speed;
    return next;
  }) };
}
export function deleteBump(sk: Sketch, id: string): Sketch {
  const rest = (sk.bumps ?? []).filter(x => x.id !== id);
  const { bumps: _, ...out } = sk;
  return rest.length ? { ...out, bumps: rest } : out;
}

/**
 * What the norms say about it, where it differs from them (plain sentences for the inspector). There is no EU-wide
 * standard; these are the national rules most often cited (docs/speed-bumps.md). `limit`: the speed limit where it is (km/h).
 */
export function bumpNotes(b: SketchBump, limit?: number): string[] {
  const out: string[] = [];
  if (b.height > 10) out.push("Higher than 10 cm: over the UK (100 mm) and French (10 cm) maximum.");
  if (b.height < 2.5) out.push("Lower than 25 mm: under the UK minimum; drivers barely slow.");
  if (b.kind !== "bump" && b.length < 0.9) out.push("Shorter than 0.9 m: under the UK minimum for a road hump.");
  if (b.kind === "bump" && b.height > 5) out.push("A short bump over 5 cm is harsh: kept to car parks and private roads.");
  if (limit !== undefined && limit > 30) out.push(`On a ${Math.round(limit)} km/h road: France allows humps and tables only on roads limited to 30 km/h; in Romania a signed bump means 30 km/h in towns.`);
  if (b.kind === "cushion" && b.height > 7.5) out.push("Cushions over 75 mm: UK guidance (TAL 1/98) keeps them to 75 mm (65 mm if short).");
  return out;
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const pt = (p: unknown): Pt | null => { const q = p as Pt; return q && num(q.x) && num(q.y) ? { x: q.x, y: q.y } : null; };
/** the bumps kept from a saved sketch: a known kind (else a hump), ends half a metre apart at least, sizes and speed in range */
export function sanitizeBumps(raw: unknown): SketchBump[] {
  const out: SketchBump[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const a = pt(x?.a), b = pt(x?.b);
    if (typeof x?.id !== "string" || !x.id || !a || !b || Math.hypot(a.x - b.x, a.y - b.y) < 0.5 || out.some(y => y.id === x.id)) continue;
    const kind: BumpKind = BUMP_KIND_IDS.includes(x.kind) ? x.kind : BUMP_KIND, k = BUMP_KINDS[kind];
    out.push({ id: x.id, kind, a, b, length: num(x.length) ? Math.min(20, Math.max(0.3, x.length)) : k.length, height: num(x.height) ? Math.min(20, Math.max(1, x.height)) : k.height,
      ...(num(x.speed) ? { speed: Math.min(80, Math.max(3, x.speed)) } : {}) });
  }
  return out;
}
