/**
 * TomTom's traffic recorded over time for a plan (ticket #261): every 5 minutes in the hours asked for, the traffic
 * recorder (scripts/traffic-collect.ts, run by cron) fetches what the Live traffic panel fetches. That is the flow
 * tiles (each road's speed and its share of the free-flow speed, closures) and the incidents. It keeps the lines
 * (gzipped) and each lane's match on the plan as it was then, in `traffic_samples`.
 * Exported (`historyExport`; npm run traffic:export, or the panel's download) per road and direction (a "way"), per
 * sample, with what each field means, so the data can be handed to someone (an agent) to analyse and propose changes.
 * Plain data, no framework.
 */
import type { GeoArea } from "@/engine/types";
import { laneLength, samples, speedLimitOf, type Sketch } from "./lane-sketch";
import type { Incident } from "./tomtom-api";
import type { TrafficMatch } from "./tomtom";

/** a lane's match in a sample: km/h, share of free flow, free-flow km/h (null: none), share of it covered, closed (1/0) */
export type LaneTuple = [kmh: number | null, rel: number | null, free: number | null, cover: number, closed: 0 | 1];
export const TUPLE_COLUMNS = ["kmh", "rel", "free", "cover", "closed"] as const;

/** a sample as kept (the lines apart, in `data`) */
export interface StoredSample {
  at: Date | string;
  /** the plan's revision its lanes were matched on */
  revision: number;
  area: GeoArea;
  tiles: number;
  /** each lane TomTom covers, by id (see LaneTuple) */
  lanes: Record<string, LaneTuple>;
  incidents: Incident[];
  /** why it has no data (TomTom down, the quota…) */
  error: string | null;
}

const r1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** a match's lanes, rounded, as stored */
export function laneTuples(m: TrafficMatch): Record<string, LaneTuple> {
  const out: Record<string, LaneTuple> = {};
  for (const [id, t] of m.lanes) out[id] = [r1(t.kmh), r2(t.rel), r1(t.free), r2(t.cover)!, t.closed ? 1 : 0];
  return out;
}

// ---------------------------------------------------------------- the plan's ways: each road one way, and the other

/** a road one way: its lanes running the same way (a two-way road has two) */
export interface Way {
  /** the road's id and "a" (its first lane's way) or "b" (the other) */
  id: string;
  road: string;
  name: string;
  /** compass heading of travel (N, NE, …) and degrees (0 north, 90 east) */
  heading: string;
  bearing: number;
  /** the lanes (ids), how many, the length (m, the lanes' mean), the speed limit (km/h) */
  lanes: string[];
  laneCount: number;
  lengthM: number;
  limitKmh: number | null;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/** the sketch's roads split by direction (bike lanes left out) */
export function waysOf(sk: Sketch): Way[] {
  const byId = new Map(sk.lanes.map(l => [l.id, l]));
  const out: Way[] = [];
  for (const r of sk.roads) {
    const groups: { dx: number; dy: number; lanes: string[]; len: number }[] = [];
    for (const id of r.lanes) {
      const l = byId.get(id);
      if (!l || l.bike) continue;
      const pts = samples(l.shape, 5), a = pts[0], b = pts[pts.length - 1];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, len = laneLength(l.shape);
      // (the first group's way, or against it: a curved lane by its ends)
      const g = groups.find(x => x.dx * dx + x.dy * dy >= 0);
      if (g) { g.lanes.push(id); g.len += len; } else groups.push({ dx, dy, lanes: [id], len });
    }
    groups.slice(0, 2).forEach((g, i) => {
      // (x east, y south)
      const bearing = Math.round(((Math.atan2(g.dx, -g.dy) * 180) / Math.PI + 360) % 360);
      out.push({
        id: `${r.id}/${i ? "b" : "a"}`, road: r.id, name: r.name || r.id, heading: COMPASS[Math.round(bearing / 45) % 8], bearing,
        lanes: g.lanes, laneCount: g.lanes.length, lengthM: Math.round(g.len / g.lanes.length), limitKmh: speedLimitOf(sk, g.lanes[0]) ?? sk.traffic?.speed ?? null,
      });
    });
  }
  return out;
}

/** a way's traffic in a sample, from its lanes' (weighted by the length each covers); null if TomTom covers none of it */
export function wayTuple(w: Way, lanes: Record<string, LaneTuple>, lengths: Map<string, number>): LaneTuple | null {
  let len = 0, hit = 0, kmh = 0, kmhW = 0, rel = 0, relW = 0, free = 0, freeW = 0, closed = 0;
  for (const id of w.lanes) {
    const L = lengths.get(id) ?? 0;
    len += L;
    const t = lanes[id];
    if (!t) continue;
    const c = L * t[3];
    hit += c;
    if (t[0] !== null) { kmh += t[0] * c; kmhW += c; }
    if (t[1] !== null) { rel += t[1] * c; relW += c; }
    if (t[2] !== null) { free += t[2] * c; freeW += c; }
    if (t[4]) closed += c;
  }
  if (!hit) return null;
  return [r1(kmhW ? kmh / kmhW : null), r2(relW ? rel / relW : null), r1(freeW ? free / freeW : null), r2(len ? hit / len : 0)!, closed > hit / 2 ? 1 : 0];
}

// ---------------------------------------------------------------- the export

/** TomTom's incident kinds (iconCategory) */
const INCIDENT_KIND: Record<number, string> = {
  0: "unknown", 1: "accident", 2: "fog", 3: "dangerous conditions", 4: "rain", 5: "ice", 6: "jam", 7: "lane closed",
  8: "road closed", 9: "roadworks", 10: "wind", 11: "flooding", 14: "broken-down vehicle",
};
const MAGNITUDE = ["unknown", "minor", "moderate", "major", "undefined"];

export interface HistoryExport {
  about: string[];
  plan: { id: string; name: string; revision: number; origin: { lat: number; lon: number } | null };
  exportedAt: string;
  /** the first and last sample's time (UTC), how many */
  range: { from: string | null; to: string | null; samples: number };
  columns: readonly string[];
  /** the gist: by time of day over the days recorded, and the ways slowest against their free flow (medians) */
  summary: {
    bySlot: { slot: string; samples: number; rel: number | null; slowest: string[] }[];
    slowestWays: { way: string; name: string; heading: string; samples: number; rel: number; kmh: number | null; free: number | null; worstSlot: string; worstRel: number }[];
  };
  ways: Omit<Way, "lanes">[];
  incidents: Record<string, { kind: string; magnitude: string; delaySeconds: number | null; from: string | null; to: string | null; description: string | null; firstSeen: string; lastSeen: string; samples: number; coordinates: [number, number][] }>;
  samples: {
    at: string;
    /** the date (UTC), its weekday, the 5-minute slot it is for (UTC, HH:MM) */
    day: string; weekday: string; slot: string;
    error?: string;
    /** the share of the plan's ways' length TomTom covers, and over it the speed now as a share of free flow (length-weighted) */
    covered: number; rel: number | null;
    /** each way TomTom covers (see `columns`) */
    ways: Record<string, LaneTuple>;
    /** the incidents on at that time (ids in `incidents`) */
    incidents: string[];
  }[];
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** the samples as one file for analysis, matched on the plan's sketch now (its roads, names, speed limits) */
export function historyExport(plan: { id: string; name: string; revision: number }, sk: Sketch, rows: StoredSample[], exportedAt = new Date()): HistoryExport {
  const ways = waysOf(sk), lengths = new Map(sk.lanes.map(l => [l.id, laneLength(l.shape)]));
  const total = ways.reduce((s, w) => s + w.lengthM * w.laneCount, 0);
  const incidents: HistoryExport["incidents"] = {};
  const sorted = [...rows].sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const samples = sorted.map(s => {
    const at = new Date(s.at), iso = at.toISOString();
    const slotAt = new Date(Math.round(at.getTime() / 300_000) * 300_000);
    const out: Record<string, LaneTuple> = {};
    let hit = 0, rel = 0, relW = 0;
    for (const w of ways) {
      const t = wayTuple(w, s.lanes, lengths);
      if (!t) continue;
      out[w.id] = t;
      const c = w.lengthM * w.laneCount * t[3];
      hit += c;
      if (t[1] !== null) { rel += t[1] * c; relW += c; }
    }
    for (const i of s.incidents) {
      const k = incidents[i.id];
      if (k) { k.lastSeen = iso; k.samples++; continue; }
      incidents[i.id] = {
        kind: INCIDENT_KIND[i.iconCategory] ?? `category ${i.iconCategory}`, magnitude: MAGNITUDE[i.magnitudeOfDelay] ?? String(i.magnitudeOfDelay),
        delaySeconds: i.delay, from: i.from, to: i.to, description: i.description, firstSeen: iso, lastSeen: iso, samples: 1,
        coordinates: i.coordinates.map(c => [Math.round(c.lat * 1e5) / 1e5, Math.round(c.lon * 1e5) / 1e5]),
      };
    }
    return {
      at: iso, day: iso.slice(0, 10), weekday: WEEKDAY[at.getUTCDay()], slot: slotAt.toISOString().slice(11, 16),
      ...(s.error ? { error: s.error } : {}),
      covered: total ? Math.round((hit / total) * 100) / 100 : 0, rel: r2(relW ? rel / relW : null),
      ways: out, incidents: s.incidents.map(i => i.id),
    };
  });
  return {
    about: [
      `TomTom's traffic recorded for the plan "${plan.name}" every 5 minutes in the hours set (times in UTC). TomTom gives speeds, not vehicle counts.`,
      "A way is a road of the plan one way: `ways` lists them (id = the road's id and a or b; name; heading of travel; lanes; length in metres; the plan's speed limit).",
      "Each sample's `ways` gives, for each way TomTom covers, [kmh, rel, free, cover, closed]: km/h driven now; that as a share of the free-flow speed (1 = no traffic, 0.5 = half the speed); the free-flow speed (km/h, what TomTom sees driven with no traffic); the share of the way's length TomTom has data for (minor streets mostly none); closed (1) or not (0). A way missing from a sample: no data then.",
      "A sample's `covered` is the share of all the plan's ways' length TomTom covers, `rel` the length-weighted share of free flow over it; `error` says why a sample has no data.",
      "`summary` is the gist (medians over the days recorded; ways TomTom covers at least half of): by 5-minute slot, the network's share of free flow and its slowest ways; and the ways slowest overall, with their worst slot.",
      "`incidents` (jams, roadworks, closures, accidents) by id, with when first and last seen; each sample lists those on at its time.",
      "The ways and their matches are the plan's roads as they are at export time (the lanes are matched to TomTom's lines when recorded).",
    ],
    plan: { id: plan.id, name: plan.name, revision: plan.revision, origin: sk.geo ?? null },
    exportedAt: exportedAt.toISOString(),
    range: { from: samples[0]?.at ?? null, to: samples.at(-1)?.at ?? null, samples: samples.length },
    columns: TUPLE_COLUMNS,
    summary: summarize(ways, samples),
    ways: ways.map(({ lanes: _, ...w }) => w),
    incidents, samples,
  };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** a way counts in the summary where TomTom covers this much of it */
const SUMMARY_COVER = 0.5;
/** the slowest ways listed, overall and per slot */
const SLOWEST = 30, SLOWEST_IN_SLOT = 5;

function summarize(ways: Way[], samples: HistoryExport["samples"]): HistoryExport["summary"] {
  const slots = new Map<string, HistoryExport["samples"]>();
  for (const s of samples) if (!s.error) { const l = slots.get(s.slot); if (l) l.push(s); else slots.set(s.slot, [s]); }
  // (each way's share of free flow, per slot and overall)
  const relOf = (s: HistoryExport["samples"][number], id: string) => { const t = s.ways[id]; return t && t[3] >= SUMMARY_COVER && t[1] !== null ? t[1] : null; };
  const bySlot = [...slots].sort(([a], [b]) => a.localeCompare(b)).map(([slot, ss]) => {
    const per = ways.map(w => ({ id: w.id, rel: median(ss.map(s => relOf(s, w.id)).filter((v): v is number => v !== null)) })).filter((x): x is { id: string; rel: number } => x.rel !== null);
    return { slot, samples: ss.length, rel: r2(median(ss.map(s => s.rel).filter((v): v is number => v !== null))), slowest: per.sort((a, b) => a.rel - b.rel).slice(0, SLOWEST_IN_SLOT).map(x => x.id) };
  });
  const slowestWays = ways.flatMap(w => {
    const ts = samples.map(s => (s.error ? undefined : s.ways[w.id])).filter((t): t is LaneTuple => !!t && t[3] >= SUMMARY_COVER && t[1] !== null);
    if (!ts.length) return [];
    let worstSlot = "", worstRel = Infinity;
    for (const [slot, ss] of slots) { const m = median(ss.map(s => relOf(s, w.id)).filter((v): v is number => v !== null)); if (m !== null && m < worstRel) { worstRel = m; worstSlot = slot; } }
    return [{ way: w.id, name: w.name, heading: w.heading, samples: ts.length, rel: r2(median(ts.map(t => t[1]!)))!, kmh: r1(median(ts.flatMap(t => (t[0] === null ? [] : [t[0]])))), free: r1(median(ts.flatMap(t => (t[2] === null ? [] : [t[2]])))), worstSlot, worstRel: r2(worstRel)! }];
  }).sort((a, b) => a.rel - b.rel).slice(0, SLOWEST);
  return { bySlot, slowestWays };
}

const csvCell = (v: string | number | null) => (v === null ? "" : typeof v === "number" ? String(v) : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** the export as a table, one row per sample and way covered: at, day, weekday, slot, way, road, name, heading, then the columns */
export function historyCsv(e: HistoryExport): string {
  const ways = new Map(e.ways.map(w => [w.id, w]));
  const lines = [["at", "day", "weekday", "slot", "way", "road", "name", "heading", "length_m", "limit_kmh", ...e.columns].join(",")];
  for (const s of e.samples) for (const [id, t] of Object.entries(s.ways)) {
    const w = ways.get(id)!;
    lines.push([s.at, s.day, s.weekday, s.slot, id, w.road, w.name, w.heading, w.lengthM, w.limitKmh, ...t].map(csvCell).join(","));
  }
  return lines.join("\n") + "\n";
}
