/**
 * What TomTom recorded for the plan (ticket #321), from `npm run traffic:export`'s JSON (see docs/traffic-history.md):
 * for each way (a road one way) and each peak hour, the share of free-flow speed driven there, its median over the
 * weekdays recorded (each day's mean over the hour first), only where TomTom covers at least half the way and on 3
 * weekdays or more. Its weight in a fit: its length times TomTom's cover. Framework-free.
 */

export interface Peak { id: "morning" | "evening"; name: string; /** UTC, "HH:MM", from (in) to (out) */ from: string; to: string;
  /** local time, minutes after midnight: the matrix's period */ start: number; end: number }
/** Bistrița is UTC+2 in November: 07:30–08:30 and 16:00–17:00 local, each peak's worst hour in the recordings */
export const PEAKS: Peak[] = [
  { id: "morning", name: "Morning peak (TomTom)", from: "05:30", to: "06:30", start: 7 * 60, end: 9 * 60 + 30 },
  { id: "evening", name: "Evening peak (TomTom)", from: "14:00", to: "15:00", start: 15 * 60 + 30, end: 18 * 60 + 30 },
];

export interface Observed { rel: number; days: number; sd: number; weight: number; lengthM: number; name: string }

interface ExportJson {
  ways: { id: string; name: string; lengthM: number }[];
  samples: { weekday: string; day: string; slot: string; ways: Record<string, [number | null, number | null, number | null, number, number]> }[];
}

const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

export function observed(e: ExportJson, p: Peak, days?: Set<string>): Map<string, Observed> {
  const per = new Map<string, Map<string, { sum: number; n: number; cover: number }>>();
  for (const s of e.samples) {
    if (s.weekday === "Sat" || s.weekday === "Sun" || s.slot < p.from || s.slot >= p.to || (days && !days.has(s.day))) continue;
    for (const [id, [, rel, , cover, closed]] of Object.entries(s.ways)) {
      if (rel === null || cover < 0.5 || closed) continue;
      const byDay = per.get(id) ?? per.set(id, new Map()).get(id)!;
      const d = byDay.get(s.day) ?? byDay.set(s.day, { sum: 0, n: 0, cover: 0 }).get(s.day)!;
      d.sum += rel; d.n++; d.cover += cover;
    }
  }
  const info = new Map(e.ways.map(w => [w.id, w]));
  const out = new Map<string, Observed>();
  for (const [id, byDay] of per) {
    if (byDay.size < 3) continue;
    const daily = [...byDay.values()].map(d => d.sum / d.n), m = daily.reduce((a, b) => a + b, 0) / daily.length;
    const cover = [...byDay.values()].reduce((a, d) => a + d.cover / d.n, 0) / byDay.size, w = info.get(id);
    out.set(id, { rel: median(daily), days: byDay.size, sd: Math.sqrt(daily.reduce((a, x) => a + (x - m) ** 2, 0) / daily.length), weight: (w?.lengthM ?? 0) * cover, lengthM: w?.lengthM ?? 0, name: w?.name ?? id });
  }
  return out;
}
