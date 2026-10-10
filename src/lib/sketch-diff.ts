import { sanitizeSketch, type Sketch } from "./lane-sketch";

/**
 * A V2 plan's sketch from a file, for History's two file actions, and what each changes against the plan's
 * current revision:
 * - "Restore from file": the file is a whole sketch and replaces the plan's;
 * - "Apply changes from file": the file holds only some items (lanes, connectors, roads, junctions, links,
 *   crossings, zones); each changes the current item with its id, field by field (only the fields it has: `{id, width}`
 *   changes a lane's width; null clears an optional field), or is added (then it must be whole); nothing is
 *   removed, and everything else is kept (`applyPatch`).
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
export type SketchPatch = Partial<Record<SketchKind, unknown[]>>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const items = (sk: Sketch | null | undefined, k: SketchKind): Item[] => (sk?.[k] ?? []) as Item[];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** a file's JSON: a sketch, or anything with the sketch under `sketch` (a plan's state, an export) */
function body(raw: unknown): unknown {
  return isObj(raw) && !Array.isArray(raw.lanes) && isObj(raw.sketch) ? raw.sketch : raw;
}

/** the item lists of a (partial) sketch file, each item with an id; null if it has none */
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
  return n ? patch : null;
}

/**
 * `cur` with the patch's items merged onto those with the same id (the item's own fields over the current
 * ones), and the new ones added; sanitised. An item the checks leave out is left out of the patch (`leftOut`,
 * "kind:id"), so the current one stays: applying never removes anything.
 */
export function applyPatchDetail(cur: Sketch | null, patch: SketchPatch): { sketch: Sketch | null; leftOut: Set<string> } {
  const leftOut = new Set<string>();
  let p = patch;
  for (;;) {
    const sketch = merge(cur, p), bad: string[] = [];
    for (const k of SKETCH_KINDS) {
      const kept = new Set(items(sketch, k).map(x => x.id));
      for (const x of p[k] ?? []) if (!kept.has((x as Item).id)) bad.push(`${k}:${(x as Item).id}`);
    }
    if (!bad.length || !sketch) return { sketch, leftOut };
    for (const b of bad) leftOut.add(b);
    p = Object.fromEntries(SKETCH_KINDS.map(k => [k, (p[k] ?? []).filter(x => !leftOut.has(`${k}:${(x as Item).id}`))]));
  }
}
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
  kind: SketchKind; id: string; change: "added" | "changed" | "unchanged" | "left out (invalid)" | "left out (invalid; the current one stays)";
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

export type FileResult = { ok: true; sketch: Sketch; kept: string[]; file: Sketch | null; patch: SketchPatch; leftOut?: Set<string> } | { ok: false; error: string };

/**
 * The sketch that would be saved from a file's JSON (`raw`) for `mode`, on top of `cur`. The client and the
 * server both use it: the server again on the stored sketch, with what the client sent (`payloadOf`).
 */
export function fileResult(raw: unknown, mode: FileMode, cur: Sketch | null): FileResult {
  const patch = pickPatch(raw);
  if (!patch) return { ok: false, error: "The file has no sketch items (lanes, connectors, roads, junctions, links, crossings or zones, each with an id)." };
  if (mode === "apply") {
    const { sketch, leftOut } = applyPatchDetail(cur, patch);
    return sketch ? { ok: true, sketch, kept: [], file: null, patch, leftOut } : { ok: false, error: "Nothing usable is left once the file's items are checked." };
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

export type ReadFile = { ok: true; summary: FileSummary; payload: unknown } | { ok: false; error: string };

/** a file's text, read for `mode` and summarised against `cur` (the current revision's sketch) */
export function readSketchFile(text: string, mode: FileMode, cur: Sketch | null): ReadFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: "The file isn't valid JSON." };
  }
  const r = fileResult(raw, mode, cur);
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
    }
  }
  const kinds = kindDiffs(cur, sketch), fields = fieldDiffs(cur, sketch, r.kept);
  const geo = !same(cur?.geo, sketch.geo), traffic = !same(cur?.traffic, sketch.traffic);
  const moved = SKETCH_KINDS.some(k => kinds[k].added.length || kinds[k].removed.length || kinds[k].changed.length);
  const sameAll = !moved && !geo && !traffic && !fields.some(f => f.change !== "kept from the current version");
  return { ok: true, summary: { mode, sketch, kinds, geo, traffic, fields, items: changes, dropped, same: sameAll }, payload: payloadOf(raw, mode) };
}
