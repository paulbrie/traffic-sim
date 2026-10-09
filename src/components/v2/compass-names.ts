import type { Pt } from "@/lib/lane-sketch";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/**
 * Names that tell apart things sharing one (two roads both called Drumul Cetății): each of those gets where it
 * lies from the middle of them, "Drumul Cetății (N)" and "(S)", and a number on top if they still match
 * ("(SW 1)", "(SW 2)"). The others keep their name. In the order given.
 */
export function compassNames<T>(items: T[], name: (x: T) => string, at: (x: T) => Pt): string[] {
  // (y grows southwards)
  const dir = (p: Pt, m: Pt) => COMPASS[Math.round((((Math.atan2(p.x - m.x, m.y - p.y) * 180) / Math.PI + 360) % 360) / 45) % 8];
  const same = new Map<string, T[]>();
  for (const x of items) same.set(name(x), [...(same.get(name(x)) ?? []), x]);
  const mid = new Map([...same].map(([n, xs]) => [n, { x: xs.reduce((a, x) => a + at(x).x, 0) / xs.length, y: xs.reduce((a, x) => a + at(x).y, 0) / xs.length }]));
  const named = items.map(x => (same.get(name(x))!.length > 1 ? `${name(x)} (${dir(at(x), mid.get(name(x))!)})` : name(x)));
  const again = new Map<string, number>(), seen = new Map<string, number>();
  for (const n of named) again.set(n, (again.get(n) ?? 0) + 1);
  return named.map(n => {
    if (again.get(n)! < 2) return n;
    const k = (seen.get(n) ?? 0) + 1;
    seen.set(n, k);
    return `${n.slice(0, -1)} ${k})`;
  });
}
