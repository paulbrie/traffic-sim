import { sanitizeSketch, type Sketch } from "./lane-sketch";
import { addToSketchWindow, type WindowAdd } from "./sketch-window-add";

/**
 * A V2 plan's sketch from a file, for History's two file actions, and what each changes against the plan's
 * current revision:
 * - "Restore from file": the file is a whole sketch and replaces the plan's;
 * - "Apply changes from file": the file holds only some items (lanes, connectors, roads, junctions, links,
 *   crossings, zones); each changes the current item with its id, field by field (only the fields it has: `{id, width}`
 *   changes a lane's width; null clears an optional field), or is added (then it must be whole); nothing is
 *   removed, and everything else is kept (`applyPatch`). An agent patch (T140) may also remove items by id
 *   (`remove`), checked so nothing goes unlisted (`removalProblems`), and add a piece to the plan's Sketch window
 *   (`sketchWindowAdd`, T152: beside what the window holds, the main plan untouched); a plain file may do neither.
 * Both results go through `sanitizeSketch`, the same checks the server applies to every saved sketch, and
 * whatever those leave out is reported, so nothing is dropped silently. The server repeats the merge itself
 * against the stored sketch (src/server/restore-file.ts).
 */

/** a sketch file is at most what a save may send (next.config's serverActions.bodySizeLimit) */
export const SKETCH_FILE_MAX_BYTES = 40 * 1024 * 1024;

/** the lists compared item by item (by id) */
export const SKETCH_KINDS = ["lanes", "connectors", "junctions", "roads", "links", "crossings", "zones"] as const;
export type SketchKind = (typeof SKETCH_KINDS)[number];
type Item = { id: string };

export type FileMode = "restore" | "apply";
/** items to remove, by kind, ids only (agent patches only) */
export type Removal = Partial<Record<SketchKind, string[]>>;
export type SketchPatch = Partial<Record<SketchKind, unknown[]>> & { remove?: Removal; sketchWindowAdd?: Record<string, unknown> };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const items = (sk: Sketch | null | undefined, k: SketchKind): Item[] => (sk?.[k] ?? []) as Item[];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** a file's JSON: a sketch, or anything with the sketch under `sketch` (a plan's state, an export) */
function body(raw: unknown): unknown {
  return isObj(raw) && !Array.isArray(raw.lanes) && isObj(raw.sketch) ? raw.sketch : raw;
}

/** the item lists of a (partial) sketch file, each item with an id, and its `remove` lists; null if it has none */
export function pickPatch(raw: unknown): SketchPatch | null {
  const b = body(raw);
  if (!isObj(b)) return null;
  const patch: SketchPatch = {};
  let n = 0;
  for (const k of SKETCH_KINDS) {
    if (!Array.isArray(b[k])) continue;
    const list = (b[k] as unknown[]).filter(x => isObj(x) && typeof x.id === "string" && x.id);
    if (list.length) { patch[k] = list; n += list.length; }
  }
  if (isObj(b.remove)) {
    const remove: Removal = {};
    for (const k of SKETCH_KINDS) {
      const ids = Array.isArray(b.remove[k]) ? [...new Set((b.remove[k] as unknown[]).filter((x): x is string => typeof x === "string" && !!x))] : [];
      if (ids.length) { remove[k] = ids; n += ids.length; }
    }
    if (Object.keys(remove).length) patch.remove = remove;
  }
  if (isObj(b.sketchWindowAdd)) { patch.sketchWindowAdd = b.sketchWindowAdd; n++; }
  return n ? patch : null;
}

/** the patch's removals as a set per kind */
const removalSets = (rem: Removal | undefined) => Object.fromEntries(SKETCH_KINDS.map(k => [k, new Set(rem?.[k] ?? [])])) as Record<SketchKind, Set<string>>;

/**
 * What stops a patch's removals (T140), checked on `merged` (the current sketch with the patch's changes): ids that
 * aren't in the current revision, or both changed and removed; and what would be left pointing at a removed item
 * unless listed too: a removed lane's connectors, a road left with no lane, a link on a removed connector or road,
 * a junction whose lights or turning shares name a removed connector, road or lane, a journey on a removed lane.
 * Empty when nothing stops them.
 */
export function removalProblems(cur: Sketch | null, merged: Sketch, patch: SketchPatch): string[] {
  if (!patch.remove) return [];
  const R = removalSets(patch.remove), out: string[] = [], one = (k: SketchKind) => KIND_ONE[k];
  for (const k of SKETCH_KINDS) {
    const there = new Set(items(cur, k).map(x => x.id)), changed = new Set((patch[k] ?? []).map(x => (x as Item).id));
    const unknown = [...R[k]].filter(id => !there.has(id)), both = [...R[k]].filter(id => changed.has(id));
    if (unknown.length) out.push(`no ${one(k)} ${unknown.join(", ")} in the plan to remove`);
    if (both.length) out.push(`${one(k)} ${both.join(", ")} both changed and removed`);
  }
  const conns = merged.connectors.filter(c => !R.connectors.has(c.id));
  const onLanes = conns.filter(c => R.lanes.has(c.from.lane) || R.lanes.has(c.to.lane)).map(c => c.id);
  if (onLanes.length) out.push(`removing lane${R.lanes.size === 1 ? "" : "s"} ${[...R.lanes].join(", ")} also removes connector${onLanes.length === 1 ? "" : "s"} ${onLanes.join(", ")}: list ${onLanes.length === 1 ? "it" : "them"} in remove.connectors`);
  for (const r of merged.roads) if (!R.roads.has(r.id) && r.lanes.length && r.lanes.every(l => R.lanes.has(l))) out.push(`road ${r.id} would be left with no lane: list it in remove.roads`);
  for (const l of merged.links ?? []) {
    if (R.links.has(l.id)) continue;
    const gone = [...l.conns.filter(c => R.connectors.has(c)).map(c => `connector ${c}`), ...[l.a.road, l.b.road].filter(r => R.roads.has(r)).map(r => `road ${r}`)];
    if (gone.length) out.push(`link ${l.id} joins through ${gone.join(", ")}: list it in remove.links`);
  }
  const way = (w: string) => (w.startsWith("lane:") ? R.lanes.has(w.slice(5)) : R.roads.has(w)) ? w : null;
  for (const j of merged.junctions) {
    if (R.junctions.has(j.id)) continue;
    const named = [
      ...(j.lights?.phases ?? []).flatMap(ph => ph.conns.filter(c => R.connectors.has(c)).map(c => `connector ${c} (its lights)`)),
      ...(j.splits ?? []).flatMap(x => [x.from, ...Object.keys(x.shares)].flatMap(w => (way(w) ? [`${w.startsWith("lane:") ? "lane " + w.slice(5) : "road " + w} (its turning shares)`] : []))),
    ];
    if (named.length) out.push(`junction ${j.id} still names ${[...new Set(named)].join(", ")}: change it in the patch, or remove it`);
  }
  for (const jr of merged.journeys ?? []) {
    const on = [jr.from, jr.to].filter(l => R.lanes.has(l));
    if (on.length) out.push(`journey ${jr.id} runs on lane ${on.join(", ")}: change or drop the journey in the plan first`);
  }
  return out;
}

/** `sk` without the removed items: roads drop removed lanes (and their alignment, if its lead lane goes), signal groups drop removed junctions (an emptied group goes) */
function withoutRemoved(sk: Sketch, rem: Removal): Sketch {
  const R = removalSets(rem), out: Record<string, unknown> = { ...sk };
  for (const k of SKETCH_KINDS) if (R[k].size && Array.isArray(out[k])) out[k] = (out[k] as Item[]).filter(x => !R[k].has(x.id));
  out.roads = (out.roads as Sketch["roads"]).map(r => {
    if (!r.lanes.some(l => R.lanes.has(l))) return r;
    const { align, ...rest } = r, lanes = r.lanes.filter(l => !R.lanes.has(l));
    return align && !R.lanes.has(align.ref) ? { ...rest, lanes, align: { ...align, lanes: align.lanes.filter(x => !R.lanes.has(x.id)) } } : { ...rest, lanes };
  });
  if (sk.signalGroups && R.junctions.size) {
    const gs = sk.signalGroups.map(g => ({ ...g, members: g.members.filter(m => !R.junctions.has(m.junction)) })).filter(g => g.members.length);
    if (gs.length) out.signalGroups = gs; else delete out.signalGroups;
  }
  return out as unknown as Sketch;
}

/**
 * `cur` with the patch's items merged onto those with the same id (the item's own fields over the current
 * ones), and the new ones added; sanitised. An item the checks leave out is left out of the patch (`leftOut`,
 * "kind:id"), so the current one stays: applying never removes anything. Then its Sketch window piece, if any,
 * added to the window (`window`), or refused (`windowError`).
 */
export function applyPatchDetail(cur: Sketch | null, patch: SketchPatch, opts: FileOptions = {}): { sketch: Sketch | null; leftOut: Set<string>; problems: string[]; window?: WindowAdd; windowError?: string } {
  const r = applyMain(cur, patch);
  if (!patch.sketchWindowAdd || !r.sketch || r.problems.length) return r;
  const w = addToSketchWindow(r.sketch, patch.sketchWindowAdd, opts.sketchName, opts.now);
  return w.ok ? { ...r, sketch: w.sketch, window: w } : { ...r, sketch: null, windowError: w.error };
}

function applyMain(cur: Sketch | null, patch: SketchPatch): { sketch: Sketch | null; leftOut: Set<string>; problems: string[] } {
  const leftOut = new Set<string>();
  let p: SketchPatch = { ...patch, remove: undefined, sketchWindowAdd: undefined };
  for (;;) {
    const sketch = merge(cur, p), bad: string[] = [];
    for (const k of SKETCH_KINDS) {
      const kept = new Set(items(sketch, k).map(x => x.id));
      for (const x of p[k] ?? []) if (!kept.has((x as Item).id)) bad.push(`${k}:${(x as Item).id}`);
    }
    if (!bad.length || !sketch) {
      if (!sketch || !patch.remove) return { sketch, leftOut, problems: [] };
      // (removals: on the result of the changes, refused unless everything they leave pointing at nothing is listed too)
      const problems = removalProblems(cur, sketch, patch);
      if (problems.length) return { sketch: null, leftOut, problems };
      const after = sanitizeSketch(withoutRemoved(sketch, patch.remove));
      // (and nothing more goes than listed: the checks' own cascades are a safety net, never a way to lose items)
      const R = removalSets(patch.remove), more: string[] = [];
      if (after) for (const k of SKETCH_KINDS) {
        const kept = new Set(items(after, k).map(x => x.id));
        for (const x of items(sketch, k)) if (!R[k].has(x.id) && !kept.has(x.id)) more.push(`${KIND_ONE[k]} ${x.id}`);
      }
      if (!after || more.length) return { sketch: null, leftOut, problems: [`removing these would also drop ${more.join(", ") || "the whole sketch"}: list them too`] };
      return { sketch: after, leftOut, problems: [] };
    }
    for (const b of bad) leftOut.add(b);
    p = Object.fromEntries(SKETCH_KINDS.map(k => [k, (p[k] ?? []).filter(x => !leftOut.has(`${k}:${(x as Item).id}`))]));
  }
}

const KIND_ONE: Record<SketchKind, string> = { lanes: "lane", connectors: "connector", junctions: "junction", roads: "road", links: "link", crossings: "crossing", zones: "zone" };
export function applyPatch(cur: Sketch | null, patch: SketchPatch): Sketch | null {
  return applyPatchDetail(cur, patch).sketch;
}

function merge(cur: Sketch | null, patch: SketchPatch): Sketch | null {
  const out: Record<string, unknown> = { ...(cur ?? { lanes: [], connectors: [], roads: [], junctions: [] }) };
  for (const k of SKETCH_KINDS) {
    const add = patch[k];
    if (!add?.length) continue;
    const list: unknown[] = [...items(cur, k)], at = new Map(list.map((x, i) => [(x as Item).id, i]));
    for (const x of add) {
      const id = (x as Item).id, i = at.get(id);
      // (field by field: a file with only {id, width} changes the width, T88)
      if (i === undefined) { at.set(id, list.length); list.push(x); } else list[i] = { ...(list[i] as object), ...(x as object) };
    }
    out[k] = list;
  }
  return sanitizeSketch(out);
}

export type KindDiff = { added: string[]; removed: string[]; changed: string[] };
/** a top-level field of the sketch that the result doesn't keep as it is, or keeps because the file lacks it */
export type FieldChange = "differs" | "cleared by the file" | "only in file" | "kept from the current version";
export type FieldDiff = { field: string; change: FieldChange };
/** an item the file touches, for "apply": what it was and what it becomes */
export type ItemChange = {
  kind: SketchKind; id: string; change: "added" | "changed" | "unchanged" | "removed" | "left out (invalid)" | "left out (invalid; the current one stays)";
  before?: string; after?: string;
  /** "changed": the item's fields that change */
  fields?: string[];
  /** "left out": why, when it can be told (a required field cleared with null, a new item that isn't whole) */
  why?: string;
};

export type FileSummary = {
  mode: FileMode;
  /** the sketch that would be saved */
  sketch: Sketch;
  /** item by item against the current revision */
  kinds: Record<SketchKind, KindDiff>;
  geo: boolean;
  traffic: boolean;
  /** every top-level field (geo and traffic too, and an item list the file lacks) that differs, is cleared or is kept */
  fields: FieldDiff[];
  /** "apply": each item in the file */
  items: ItemChange[];
  /** items in the file the checks left out, per kind */
  dropped: Partial<Record<SketchKind, number>>;
  /** nothing would change */
  same: boolean;
  /** an agent patch's piece added to the Sketch window (T152) */
  window?: WindowAdd;
};

/** the file's items the checks left out: refused (apply: a required field cleared, a new item not whole…) or invalid */
export function leftOutCount(s: FileSummary): number {
  return s.mode === "apply" ? s.items.filter(x => x.change.startsWith("left out")).length : SKETCH_KINDS.reduce((n, k) => n + (s.dropped[k] ?? 0), 0);
}

/**
 * When nothing would change, what to say: plainly "nothing to save", or, when items were left out, that they
 * were (the list with the reasons follows; T115). Null when something would change.
 */
export function nothingToSave(s: FileSummary): string | null {
  if (!s.same) return null;
  const n = leftOutCount(s);
  return n ? `Nothing would change: ${n} item${n === 1 ? " was" : "s were"} left out (see why below).` : "The result is the same as the current version: nothing to save.";
}

/** a short account of an item's shape, for before / after */
export function shapeOf(kind: SketchKind, x: unknown): string {
  const o = x as Record<string, unknown>;
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (kind) {
    case "lanes": {
      const sh = o.shape as Record<string, unknown> | undefined;
      return sh?.kind === "arc" ? "arc" : `${n(sh?.pts)} points`;
    }
    case "junctions": return `${n(o.outline)} outline points`;
    case "connectors": return `${n(o.via)} bend points`;
    case "roads": return `${n(o.lanes)} lanes`;
    case "links": return `${n(o.conns)} connectors`;
    case "crossings": return "2 points";
    case "zones": return `${n(o.outline)} corners`;
  }
}

/** an item's fields set to null that it can't do without (e.g. a lane's shape), as "shape can't be cleared" */
function clearedRequired(cur: Sketch | null, k: SketchKind, x: Item): string | undefined {
  const nulls = Object.keys(x).filter(f => (x as Record<string, unknown>)[f] === null);
  const bad = nulls.filter(f => applyPatchDetail(cur, { [k]: [{ id: x.id, [f]: null }] }).leftOut.size > 0);
  return bad.length ? `${bad.join(", ")} can't be cleared` : undefined;
}

/** the top-level fields of an item that differ between two versions of it */
function changedFields(before: object, after: object): string[] {
  const b = before as Record<string, unknown>, a = after as Record<string, unknown>;
  return [...new Set([...Object.keys(b), ...Object.keys(a)])].filter(f => !same(b[f], a[f]));
}

function kindDiffs(cur: Sketch | null, next: Sketch) {
  const out = {} as Record<SketchKind, KindDiff>;
  for (const k of SKETCH_KINDS) {
    const a = new Map(items(cur, k).map(x => [x.id, x])), b = new Map(items(next, k).map(x => [x.id, x]));
    const d: KindDiff = { added: [], removed: [], changed: [] };
    for (const [id, x] of b) {
      if (!a.has(id)) d.added.push(id);
      else if (!same(a.get(id), x)) d.changed.push(id);
    }
    for (const id of a.keys()) if (!b.has(id)) d.removed.push(id);
    out[k] = d;
  }
  return out;
}

/**
 * The top-level fields (item lists apart, which are compared item by item, unless the file lacks the list):
 * what the result keeps because the file lacks it, and what it doesn't keep as it is.
 */
function fieldDiffs(cur: Sketch | null, next: Sketch, kept: string[]): FieldDiff[] {
  const items = new Set<string>(SKETCH_KINDS);
  const c = (cur ?? {}) as Record<string, unknown>, n = next as unknown as Record<string, unknown>;
  const out: FieldDiff[] = [];
  for (const f of [...new Set([...Object.keys(c), ...Object.keys(n)])].sort()) {
    if (kept.includes(f)) { out.push({ field: f, change: "kept from the current version" }); continue; }
    if (items.has(f)) continue;
    if (c[f] !== undefined && n[f] === undefined) out.push({ field: f, change: "cleared by the file" });
    else if (c[f] === undefined && n[f] !== undefined) out.push({ field: f, change: "only in file" });
    else if (!same(c[f], n[f])) out.push({ field: f, change: "differs" });
  }
  return out;
}

/**
 * A whole sketch replacing the plan's. Only what the file has replaces the current: a top-level field it
 * lacks (geo, traffic, journeys, signal groups, the Sketch window's ideas, an item list, …) is kept from
 * `cur` (`kept`). The editor's Copy JSON leaves some out, so its export restores without losing them.
 */
export function restoreSketch(cur: Sketch | null, file: Sketch, raw: Record<string, unknown>): { sketch: Sketch; kept: string[] } {
  if (!cur) return { sketch: file, kept: [] };
  const out: Record<string, unknown> = { ...file }, kept: string[] = [];
  for (const [k, v] of Object.entries(cur)) {
    if (v === undefined || raw[k] !== undefined) continue;
    const empty = Array.isArray(v) && !v.length;
    out[k] = v;
    if (!empty) kept.push(k);
  }
  return { sketch: sanitizeSketch(out) ?? file, kept: kept.sort() };
}

export type FileResult = { ok: true; sketch: Sketch; kept: string[]; file: Sketch | null; patch: SketchPatch; leftOut?: Set<string>; window?: WindowAdd } | { ok: false; error: string; problems?: string[] };
/** an agent patch: `allowRemove`, its `remove` lists are applied (a plain file's never are, T140); `allowSketchWindow`, its `sketchWindowAdd` too (T152) */
export type FileOptions = { allowRemove?: boolean; allowSketchWindow?: boolean;
  /** the new sketch an agent patch's piece goes into: its name (the patch's title), and when it is made (ms; the server's, when it saves) */
  sketchName?: string; now?: number };

/**
 * The sketch that would be saved from a file's JSON (`raw`) for `mode`, on top of `cur`. The client and the
 * server both use it: the server again on the stored sketch, with what the client sent (`payloadOf`).
 */
export function fileResult(raw: unknown, mode: FileMode, cur: Sketch | null, opts: FileOptions = {}): FileResult {
  const patch = pickPatch(raw);
  if (!patch) return { ok: false, error: "The file has no sketch items (lanes, connectors, roads, junctions, links, crossings or zones, each with an id)." };
  if (mode === "apply") {
    if (patch.remove && !opts.allowRemove) return { ok: false, error: "The file asks to remove items: only agent patches may remove (Apply changes from file never removes anything)." };
    if (patch.sketchWindowAdd && !opts.allowSketchWindow) return { ok: false, error: "The file asks to add to the Sketch window: only agent patches may (Apply changes from file changes the main plan only)." };
    const { sketch, leftOut, problems, window, windowError } = applyPatchDetail(cur, patch, opts);
    if (problems.length) return { ok: false, error: `The removals can't be applied as they are: ${problems.join("; ")}.`, problems };
    if (windowError) return { ok: false, error: windowError, problems: [windowError] };
    return sketch ? { ok: true, sketch, kept: [], file: null, patch, leftOut, ...(window ? { window } : {}) } : { ok: false, error: "Nothing usable is left once the file's items are checked." };
  }
  const b = body(raw);
  if (!isObj(b) || !Array.isArray(b.lanes)) return { ok: false, error: "The file isn't a whole V2 sketch (no lanes list). Use \"Apply changes from file\" for a file with only some items." };
  const file = sanitizeSketch(b);
  if (!file || !file.lanes.length) return { ok: false, error: "The sketch in the file has no usable lanes." };
  const { sketch, kept } = restoreSketch(cur, file, b);
  return { ok: true, sketch, kept, file, patch };
}

/** what the client sends for `mode`: the whole sketch, or only the items to apply */
export function payloadOf(raw: unknown, mode: FileMode): unknown {
  return mode === "restore" ? body(raw) : pickPatch(raw);
}

export type ReadFile = { ok: true; summary: FileSummary; payload: unknown } | { ok: false; error: string; problems?: string[] };

/** a file's text, read for `mode` and summarised against `cur` (the current revision's sketch) */
export function readSketchFile(text: string, mode: FileMode, cur: Sketch | null, opts: FileOptions = {}): ReadFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file isn't valid JSON." };
  }
  const r = fileResult(raw, mode, cur, opts);
  if (!r.ok) return r;
  const { sketch, patch } = r;
  const dropped: Partial<Record<SketchKind, number>> = {};
  const changes: ItemChange[] = [];
  if (mode === "restore") {
    const b = body(raw) as Record<string, unknown>;
    for (const k of SKETCH_KINDS) {
      const n = (Array.isArray(b[k]) ? (b[k] as unknown[]).length : 0) - items(r.file, k).length;
      if (n > 0) dropped[k] = n;
    }
  } else {
    for (const k of SKETCH_KINDS) {
      const before = new Map(items(cur, k).map(x => [x.id, x])), after = new Map(items(sketch, k).map(x => [x.id, x]));
      let lost = 0;
      for (const x of patch[k] ?? []) {
        const id = (x as Item).id, b = before.get(id), a = after.get(id);
        if (!a || r.leftOut?.has(`${k}:${id}`)) {
          lost++;
          const why = b ? clearedRequired(cur, k, x as Item) : "a new item must have all its fields";
          changes.push({ kind: k, id, change: b ? "left out (invalid; the current one stays)" : "left out (invalid)", ...(b ? { before: shapeOf(k, b), after: shapeOf(k, b) } : {}), ...(why ? { why } : {}) });
          continue;
        }
        const fields = b ? changedFields(b, a) : [];
        changes.push({ kind: k, id, change: !b ? "added" : fields.length ? "changed" : "unchanged", ...(b ? { before: shapeOf(k, b) } : {}), after: shapeOf(k, a), ...(fields.length ? { fields } : {}) });
      }
      if (lost) dropped[k] = lost;
      // (the patch's removals, each named)
      for (const id of patch.remove?.[k] ?? []) {
        const b = before.get(id);
        if (b) changes.push({ kind: k, id, change: "removed", before: shapeOf(k, b) });
      }
    }
  }
  // (the new sketch with the piece is told in its own section, not as "sketches differ")
  const kinds = kindDiffs(cur, sketch), fields = fieldDiffs(cur, sketch, r.kept).filter(f => !(r.window && ["scratch", "sketches", "sketchOpen"].includes(f.field)));
  const geo = !same(cur?.geo, sketch.geo), traffic = !same(cur?.traffic, sketch.traffic);
  const moved = SKETCH_KINDS.some(k => kinds[k].added.length || kinds[k].removed.length || kinds[k].changed.length);
  const sameAll = !moved && !geo && !traffic && !r.window && !fields.some(f => f.change !== "kept from the current version");
  return { ok: true, summary: { mode, sketch, kinds, geo, traffic, fields, items: changes, dropped, same: sameAll, ...(r.window ? { window: r.window } : {}) }, payload: payloadOf(raw, mode) };
}
