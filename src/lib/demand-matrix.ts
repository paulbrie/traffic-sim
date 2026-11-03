/**
 * Demand matrices (ticket #113): vehicles per hour from each way in to each way out of a sketch (its Demand panel's ways),
 * several kept with it, named, each for a period of the day or all day. The one in use (`matrixOn`), or by the time of day
 * (MATRIX_BY_TIME: at each moment the one whose period it is, the simulation's clock starting at `traffic.clock`), is all the
 * traffic coming in, the ways' own rates and shares aside; journeys come on top. With none in use, or no matrix for the time,
 * the ways' rates and shares. Cells are kept by a lane of each way (as journeys name them), so they follow their ways when
 * lanes are added beside them. Framework-free.
 */
import {
  LastFew, MATRIX_BY_TIME, MAX_CELL, MAX_MATRICES, RouteTable, demandWays, dist, laneById, laneInRate, laneOutWeight, roadOf,
  type DemandMatrix, type DemandWay, type Sketch,
} from "./lane-sketch";

export { MATRIX_BY_TIME };
export const MINUTES_A_DAY = 1440;

/** what demand a sketch runs on: its ways' rates and shares, one matrix, or by the time of day */
export type DemandMode = { kind: "ways" } | { kind: "matrix"; matrix: DemandMatrix } | { kind: "time" };
export function demandMode(sk: Sketch): DemandMode {
  if (sk.matrixOn === MATRIX_BY_TIME && sk.matrices?.length) return { kind: "time" };
  const m = sk.matrixOn ? sk.matrices?.find(x => x.id === sk.matrixOn) : undefined;
  return m ? { kind: "matrix", matrix: m } : { kind: "ways" };
}
/** the time of day the simulation starts at (minutes after midnight) */
export const startClock = (sk: Sketch) => sk.traffic?.clock ?? 0;
/** the time of day `t` seconds into the simulation (minutes after midnight, 0 to 1440) */
export const clockAt = (sk: Sketch, t: number) => (((startClock(sk) + t / 60) % MINUTES_A_DAY) + MINUTES_A_DAY) % MINUTES_A_DAY;
/** is minute `min` of the day in matrix `m`'s period (all day: always)? */
export function inPeriod(m: DemandMatrix, min: number): boolean {
  if (m.start === undefined || m.end === undefined || m.start === m.end) return true;
  return m.start < m.end ? min >= m.start && min < m.end : min >= m.start || min < m.end;
}
/** the matrix in use at minute `min` of the day (null: the ways' rates and shares) */
export function matrixAt(sk: Sketch, min: number): DemandMatrix | null {
  const mode = demandMode(sk);
  if (mode.kind === "matrix") return mode.matrix;
  if (mode.kind === "ways") return null;
  // (by the time of day: the first whose period it is; all-day ones only where no period covers it)
  const ms = sk.matrices ?? [];
  return ms.find(m => m.start !== undefined && m.end !== undefined && m.start !== m.end && inPeriod(m, min)) ?? ms.find(m => inPeriod(m, min)) ?? null;
}
/** matrices whose periods overlap (by the time of day the first listed wins): pairs of names */
export function overlaps(sk: Sketch): [string, string][] {
  const ms = (sk.matrices ?? []).filter(m => m.start !== undefined && m.end !== undefined && m.start !== m.end), out: [string, string][] = [];
  for (let i = 0; i < ms.length; i++) for (let k = i + 1; k < ms.length; k++) {
    if (Array.from({ length: 96 }, (_, q) => q * 15 + 7.5).some(t => inPeriod(ms[i], t) && inPeriod(ms[k], t))) out.push([ms[i].name, ms[k].name]);
  }
  return out;
}
/**
 * (ticket #123) By the time of day: the times no matrix covers (minutes after midnight, `start` to `end`, past midnight when `end`
 * is before it; none with an all-day matrix), and the vehicles an hour coming in then (the ways' own rates, and journeys)
 */
export function uncovered(sk: Sketch): { gaps: { start: number; end: number }[]; fallback: number } {
  const ms = sk.matrices ?? [], on = (t: number) => ms.some(m => inPeriod(m, t + 0.5)), gaps: { start: number; end: number }[] = [];
  if (sk.matrixOn !== MATRIX_BY_TIME || !ms.length || ms.some(m => m.start === undefined || m.end === undefined || m.start === m.end)) return { gaps, fallback: 0 };
  for (let t = 0; t < MINUTES_A_DAY; t++) {
    if (on(t)) continue;
    const last = gaps[gaps.length - 1];
    if (last && last.end === t) last.end = t + 1; else gaps.push({ start: t, end: t + 1 });
  }
  // (one gap across midnight: as one)
  if (gaps.length > 1 && gaps[0].start === 0 && gaps[gaps.length - 1].end === MINUTES_A_DAY) { gaps[0] = { start: gaps[gaps.length - 1].start, end: gaps[0].end }; gaps.pop(); }
  const w = demandWays(sk), fallback = w.entries.reduce((a, e) => a + e.lanes.reduce((b, id) => b + laneInRate(laneById(sk, id)!, sk), 0), 0) + (sk.journeys ?? []).reduce((a, j) => a + j.rate, 0);
  return { gaps, fallback };
}

/** "07:30" (as a clock shows it: 07:30:50 is still 07:30) */
export const hhmm = (min: number) => { const m = Math.floor(min + 1e-6) % MINUTES_A_DAY; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
/** "07:30" (or "7:30", "730", "7") as minutes after midnight (null: not a time) */
export function parseHhmm(s: string): number | null {
  const t = s.trim(), m = /^(\d{1,2})(?::?(\d{2}))?$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]), mi = m[2] ? Number(m[2]) : 0;
  return h <= 24 && mi < 60 && h * 60 + mi <= MINUTES_A_DAY ? h * 60 + mi : null;
}
/** a matrix's period as text ("07:00–09:00", or "all day") */
export const periodText = (m: DemandMatrix) => (m.start === undefined || m.end === undefined || m.start === m.end ? "all day" : `${hhmm(m.start)}–${hhmm(m.end)}`);

// ---------------------------------------------------------------- reading a matrix by its ways

/**
 * Each cell's way in and way out (keys; null: none found) by the lanes it is kept under (ticket #120): a lane of a way, that way;
 * a lane that is no longer one (the street carried on past it, or begun before it), the way it leads on to (a way out's) or
 * comes from (a way in's) along a run with no branching: every lane leaving it (or into it) the same one, or all of one way's.
 */
export function cellWays(sk: Sketch): (from: string, to: string) => [string | null, string | null] {
  let x = resolvers.get(sk);
  if (x) return x;
  const ways = demandWays(sk), inWay = new Map(ways.entries.flatMap(w => w.lanes.map(l => [l, w.key]))), outWay = new Map(ways.exits.flatMap(w => w.lanes.map(l => [l, w.key])));
  const ons = new Map<string, Set<string>>(), backs = new Map<string, Set<string>>();
  for (const c of sk.connectors) { (ons.get(c.from.lane) ?? ons.set(c.from.lane, new Set()).get(c.from.lane)!).add(c.to.lane); (backs.get(c.to.lane) ?? backs.set(c.to.lane, new Set()).get(c.to.lane)!).add(c.from.lane); }
  const memo = new Map<string, string | null>();
  const follow = (lane: string, way: Map<string, string>, next: Map<string, Set<string>>, tag: string): string | null => {
    const k = `${tag}${lane}`;
    if (memo.has(k)) return memo.get(k)!;
    let cur = lane, found: string | null = null;
    const seen = new Set<string>();
    for (let n = 0; n < 40 && !seen.has(cur); n++) {
      if (way.has(cur)) { found = way.get(cur)!; break; }
      if (!laneById(sk, cur)) break;
      seen.add(cur);
      const nx = [...(next.get(cur) ?? [])];
      if (!nx.length) break;
      // (several lanes, all of one way: that way)
      const ks = new Set(nx.map(l => way.get(l) ?? null));
      if (nx.length > 1) { if (ks.size === 1 && !ks.has(null)) found = [...ks][0]; break; }
      cur = nx[0];
    }
    memo.set(k, found);
    return found;
  };
  x = (f, t) => [follow(f, inWay, backs, "<"), follow(t, outWay, ons, ">")];
  resolvers.set(sk, x);
  return x;
}
const resolvers = new LastFew<Sketch, (from: string, to: string) => [string | null, string | null]>(6);

/** a matrix's cells by way: entries' keys to exits' keys to vehicles per hour; and cells no way in and out could be found for (`lost`) */
export interface MatrixGrid { cell: Map<string, Map<string, number>>; rows: Map<string, number>; cols: Map<string, number>; total: number; orphans: number;
  /** cells kept under lanes that lead to no way in or out (now): their lanes, rate, and the way found at either end (null: none) */
  lost: { from: string; to: string; rate: number; fromWay: string | null; toWay: string | null; /** both ways found, but of one street (ticket #122) */ same?: true }[] }
const grids = new LastFew<DemandMatrix, { sk: Sketch; grid: MatrixGrid }>(12);
export function matrixGrid(sk: Sketch, m: DemandMatrix): MatrixGrid {
  const was = grids.get(m);
  if (was && was.sk === sk) return was.grid;
  const ways = cellWays(sk), dw = demandWays(sk), byKey = { entries: new Map(dw.entries.map(w => [w.key, w])), exits: new Map(dw.exits.map(w => [w.key, w])) };
  const cell = new Map<string, Map<string, number>>(), rows = new Map<string, number>(), cols = new Map<string, number>(), lost: MatrixGrid["lost"] = [];
  let total = 0, orphans = 0;
  for (const [f, row] of Object.entries(m.od)) for (const [t, v] of Object.entries(row)) {
    const [a, b] = ways(f, t);
    if (!a || !b) { orphans++; lost.push({ from: f, to: t, rate: v, fromWay: a, toWay: b }); continue; }
    // (in and back out by the same street: no trip, kept apart, ticket #122)
    if (sameStreet(sk, byKey.entries.get(a)!, byKey.exits.get(b)!)) { orphans++; lost.push({ from: f, to: t, rate: v, fromWay: a, toWay: b, same: true }); continue; }
    const r = cell.get(a) ?? cell.set(a, new Map()).get(a)!;
    r.set(b, (r.get(b) ?? 0) + v);
    rows.set(a, (rows.get(a) ?? 0) + v); cols.set(b, (cols.get(b) ?? 0) + v); total += v;
  }
  const grid = { cell, rows, cols, total, orphans, lost };
  grids.set(m, { sk, grid });
  return grid;
}
/** for the simulation: each way in with traffic, its lanes, vehicles per hour in all, and where they go (each way out's lanes and rate) */
export interface MatrixRow { key: string; from: string[]; total: number; dests: { to: string[]; rate: number }[] }
export function matrixRows(sk: Sketch, m: DemandMatrix): MatrixRow[] {
  const ways = demandWays(sk), g = matrixGrid(sk, m), exits = new Map(ways.exits.map(w => [w.key, w]));
  return ways.entries.flatMap(w => {
    const r = g.cell.get(w.key);
    if (!r) return [];
    const dests = [...r].filter(([, v]) => v > 0).map(([k, v]) => ({ to: exits.get(k)!.lanes, rate: v }));
    const total = dests.reduce((a, d) => a + d.rate, 0);
    return total > 0 ? [{ key: w.key, from: w.lanes, total, dests }] : [];
  });
}

// ---------------------------------------------------------------- changing them

// (`on`: the one in use after; null: none; left out: as it was)
const withMatrices = (sk: Sketch, ms: DemandMatrix[], on: string | null | undefined = sk.matrixOn): Sketch => {
  const { matrices: _m, matrixOn: _o, ...rest } = sk;
  const keep = on && (on === MATRIX_BY_TIME ? ms.length > 0 : ms.some(m => m.id === on));
  return { ...rest, ...(ms.length ? { matrices: ms } : {}), ...(keep ? { matrixOn: on } : {}) };
};
const nextId = (sk: Sketch) => { const used = new Set((sk.matrices ?? []).map(m => m.id)); let n = used.size + 1; while (used.has(`m${n}`)) n++; return `m${n}`; };
/** a name not taken yet: "Matrix 2", "AM peak (2)" */
export function freeName(sk: Sketch, base: string): string {
  const names = new Set((sk.matrices ?? []).map(m => m.name));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} (${n})`)) n++;
  return `${base} (${n})`;
}
/** a new matrix: empty, or the demand the ways' rates and shares make now (`current`); put in use. Null: MAX_MATRICES already */
export function addMatrix(sk: Sketch, from: "current" | "empty", name?: string): [Sketch, DemandMatrix] | null {
  if ((sk.matrices ?? []).length >= MAX_MATRICES) return null;
  const m: DemandMatrix = { id: nextId(sk), name: freeName(sk, name ?? `Matrix ${(sk.matrices?.length ?? 0) + 1}`), od: from === "current" ? currentDemand(sk) : {} };
  return [withMatrices(sk, [...(sk.matrices ?? []), m], sk.matrixOn === MATRIX_BY_TIME ? MATRIX_BY_TIME : m.id), m];
}
export function duplicateMatrix(sk: Sketch, id: string): [Sketch, DemandMatrix] | null {
  const src = sk.matrices?.find(m => m.id === id);
  if (!src || (sk.matrices ?? []).length >= MAX_MATRICES) return null;
  const m: DemandMatrix = { ...src, id: nextId(sk), name: freeName(sk, src.name), od: Object.fromEntries(Object.entries(src.od).map(([f, r]) => [f, { ...r }])) };
  const ms = [...sk.matrices!];
  ms.splice(ms.indexOf(src) + 1, 0, m);
  return [withMatrices(sk, ms), m];
}
export function updateMatrix(sk: Sketch, id: string, patch: Partial<Pick<DemandMatrix, "name" | "trucks" | "start" | "end">>): Sketch {
  return withMatrices(sk, (sk.matrices ?? []).map(m => {
    if (m.id !== id) return m;
    const n = { ...m, ...patch };
    for (const k of ["trucks", "start", "end"] as const) if (n[k] === undefined) delete n[k];
    // (a period: both its ends, or neither)
    if (n.start === undefined || n.end === undefined) { delete n.start; delete n.end; }
    return n;
  }));
}
export function deleteMatrix(sk: Sketch, id: string): Sketch { return withMatrices(sk, (sk.matrices ?? []).filter(m => m.id !== id)); }
/** one earlier (-1) or later (1) in the list (by the time of day, the first listed wins where periods overlap) */
export function moveMatrix(sk: Sketch, id: string, by: -1 | 1): Sketch {
  const ms = [...(sk.matrices ?? [])], i = ms.findIndex(m => m.id === id), k = i + by;
  if (i < 0 || k < 0 || k >= ms.length) return sk;
  [ms[i], ms[k]] = [ms[k], ms[i]];
  return withMatrices(sk, ms);
}
/** the demand to run on: a matrix (its id), MATRIX_BY_TIME, or null (the ways' rates and shares) */
export const setMatrixOn = (sk: Sketch, on: string | null): Sketch => withMatrices(sk, sk.matrices ?? [], on);
/** the simulation's start, minutes after midnight */
export const setStartClock = (sk: Sketch, min: number): Sketch => {
  const t = { ...(sk.traffic ?? { rate: 400, speed: 50 }) }, m = Math.round(((min % MINUTES_A_DAY) + MINUTES_A_DAY) % MINUTES_A_DAY);
  if (m) t.clock = m; else delete t.clock;
  return { ...sk, traffic: t };
};
/**
 * Cells set (one change): each the way in, the way out, vehicles per hour (0: none). Kept under the first lane of each way;
 * whatever was kept under its other lanes for the same pair goes.
 */
export function setCells(sk: Sketch, id: string, cells: { from: DemandWay; to: DemandWay; rate: number }[]): Sketch {
  return withMatrices(sk, (sk.matrices ?? []).map(m => {
    if (m.id !== id) return m;
    const od: Record<string, Record<string, number>> = Object.fromEntries(Object.entries(m.od).map(([f, r]) => [f, { ...r }]));
    // (whatever is kept for a pair set goes: under its lanes, or under lanes followed to it, ticket #120; found once, by pair)
    const ways = cellWays(sk), byPair = new Map<string, [string, string][]>();
    for (const [f, r] of Object.entries(od)) for (const t of Object.keys(r)) { const [a, b] = ways(f, t); if (a && b) (byPair.get(`${a}|${b}`) ?? byPair.set(`${a}|${b}`, []).get(`${a}|${b}`)!).push([f, t]); }
    for (const c of cells) {
      for (const [f, t] of byPair.get(`${c.from.key}|${c.to.key}`) ?? []) { if (od[f]) { delete od[f][t]; if (!Object.keys(od[f]).length) delete od[f]; } }
      byPair.delete(`${c.from.key}|${c.to.key}`);
      const v = Math.round(Math.min(MAX_CELL, Math.max(0, c.rate)) * 10) / 10;
      if (v > 0) (od[c.from.lanes[0]] ??= {})[c.to.lanes[0]] = v;
    }
    return { ...m, od };
  }));
}
/** a cell no way could be found for, moved to a way in and out (added to what is there; ticket #120), or dropped (`to` null) */
export function moveLostCell(sk: Sketch, id: string, cell: { from: string; to: string }, to: { from: DemandWay; to: DemandWay } | null): Sketch {
  const m = sk.matrices?.find(x => x.id === id), v = m?.od[cell.from]?.[cell.to];
  if (!m || v === undefined) return sk;
  const od: DemandMatrix["od"] = Object.fromEntries(Object.entries(m.od).map(([f, r]) => [f, { ...r }]));
  delete od[cell.from][cell.to];
  if (!Object.keys(od[cell.from]).length) delete od[cell.from];
  const out = withMatrices(sk, (sk.matrices ?? []).map(x => (x.id === id ? { ...x, od } : x)));
  if (!to) return out;
  const now = matrixGrid(out, out.matrices!.find(x => x.id === id)!).cell.get(to.from.key)?.get(to.to.key) ?? 0;
  return setCells(out, id, [{ from: to.from, to: to.to, rate: now + v }]);
}

/** every cell times `f` (rounded to a tenth) */
export function scaleMatrix(sk: Sketch, id: string, f: number): Sketch {
  return withMatrices(sk, (sk.matrices ?? []).map(m => (m.id !== id ? m : {
    ...m, od: Object.fromEntries(Object.entries(m.od).map(([a, r]) => [a, Object.fromEntries(Object.entries(r).map(([b, v]) => [b, Math.round(Math.min(MAX_CELL, v * f) * 10) / 10]).filter(([, v]) => (v as number) > 0))]).filter(([, r]) => Object.keys(r).length)),
  })));
}

// ---------------------------------------------------------------- reaching, and the demand the ways make now

/** metres apart a way in and a way out of the same name may be and still be one street's (its two directions at one end) */
const SAME_STREET = 60;
/**
 * (ticket #122) a way in and a way out of the same street: of one road, or of the same name at the same place (its two
 * directions, drawn as two roads). Going in there and out again is a U-turn back, not a trip: no demand between them.
 */
export function sameStreet(sk: Sketch, a: DemandWay, b: DemandWay): boolean {
  const ra = roadOf(sk, a.lanes[0]), rb = roadOf(sk, b.lanes[0]);
  if (ra && rb && ra.id === rb.id) return true;
  return !!ra && !!rb && !!ra.name && ra.name === rb.name && dist(a.at, b.at) < SAME_STREET;
}

const reach = new LastFew<Sketch, Map<string, Set<string>>>(4);
/** for each way in (key), the ways out (keys) a car coming in there can get to */
export function reachable(sk: Sketch): Map<string, Set<string>> {
  let x = reach.get(sk);
  if (x) return x;
  const ways = demandWays(sk), rt = new RouteTable(sk), outOf = new Map(ways.exits.flatMap(w => w.lanes.map(l => [l, w.key])));
  x = new Map(ways.entries.map(w => [w.key, new Set(w.lanes.flatMap(l => rt.reachable(l, 0)).flatMap(e => outOf.get(e) ?? []))]));
  reach.set(sk, x);
  return x;
}
/**
 * The demand the ways' rates and shares make now, as a matrix: each way in's vehicles an hour over the ways out it can reach
 * (not back out by the same street), by their shares; tenths of a vehicle an hour and less left out
 */
export function currentDemand(sk: Sketch): DemandMatrix["od"] {
  const ways = demandWays(sk), can = reachable(sk), od: DemandMatrix["od"] = {};
  const lane = (id: string) => laneById(sk, id)!, weight = (w: DemandWay) => w.lanes.reduce((a, id) => a + laneOutWeight(lane(id)), 0);
  for (const a of ways.entries) {
    const rate = a.lanes.reduce((s, id) => s + laneInRate(lane(id), sk), 0), to = ways.exits.filter(b => can.get(a.key)?.has(b.key) && weight(b) > 0 && !sameStreet(sk, a, b));
    const sum = to.reduce((s, b) => s + weight(b), 0);
    if (!(rate > 0) || !(sum > 0)) continue;
    for (const b of to) { const v = Math.round(((rate * weight(b)) / sum) * 10) / 10; if (v > 0) (od[a.lanes[0]] ??= {})[b.lanes[0]] = v; }
  }
  return od;
}

// ---------------------------------------------------------------- as text (a spreadsheet's)

/** the matrix as tab-separated text: a row of the ways out's names, then each way in's name and its cells */
export function matrixText(sk: Sketch, m: DemandMatrix, names: { entries: DemandWay[]; exits: DemandWay[] }): string {
  const g = matrixGrid(sk, m), clean = (s: string) => s.replace(/[\t\n\r]/g, " ");
  return [["", ...names.exits.map(w => clean(w.name))].join("\t"), ...names.entries.map(a => [clean(a.name), ...names.exits.map(b => String(g.cell.get(a.key)?.get(b.key) ?? 0))].join("\t"))].join("\n");
}
/** tab- (or comma- or semicolon-) separated text as rows of cells: numbers, or null where a cell isn't one */
export function parseCells(text: string): (number | null)[][] {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const sep = lines.some(l => l.includes("\t")) ? "\t" : lines.some(l => l.includes(";")) ? ";" : ",";
  return lines.map(l => l.split(sep).map(c => { const t = c.trim().replace(/\s/g, ""); if (!t) return 0; const v = Number(sep === ";" ? t.replace(",", ".") : t); return Number.isFinite(v) && v >= 0 ? v : null; }));
}
