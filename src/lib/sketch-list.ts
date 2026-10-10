/**
 * A plan's saved sketches (T156): the Sketch window holds one at a time, the one open (its content the plan's `scratch`,
 * as before), the others kept in `sketches` with their names, when made and changed, the view they were left at and
 * their content. A plan without `sketches` has one, "Sketch 1": its `scratch` (old plans and versions open as they were;
 * the list is written only once there are two, or it is renamed). Framework-free: each change a new sketch.
 */
import { nextId, type SavedSketch, type Sketch } from "./lane-sketch";

/** the first sketch's id and name, where a plan has only its scratch */
export const FIRST_SKETCH = { id: "s1", name: "Sketch 1" };
/** a sketch's name, at most */
export const SKETCH_NAME_MAX = 80;

/** a sketch's content without ideas or saved sketches of its own */
const inner = (k: Sketch | undefined): Sketch | undefined => {
  if (!k) return undefined;
  const { scratch: _s, sketches: _l, sketchOpen: _o, ...rest } = k;
  return rest;
};
/** nothing drawn in it */
export const emptyContent = (k: Sketch | undefined) => !k || (!k.lanes.length && !k.junctions.length && !k.connectors.length && !k.crossings?.length && !k.zones?.length);

/** the saved sketches (the first, "Sketch 1", if none is), and which is open */
export function sketchList(sk: Sketch): { list: SavedSketch[]; open: string } {
  if (sk.sketches?.length) return { list: sk.sketches, open: sk.sketches.some(x => x.id === sk.sketchOpen) ? sk.sketchOpen! : sk.sketches[0].id };
  return { list: [{ id: FIRST_SKETCH.id, name: FIRST_SKETCH.name, created: 0, updated: 0 }], open: FIRST_SKETCH.id };
}
/** a sketch's content: the open one's is the scratch */
export function contentOf(sk: Sketch, id: string): Sketch | undefined {
  const { list, open } = sketchList(sk);
  return id === open ? inner(sk.scratch) : list.find(x => x.id === id)?.sketch;
}
/** a name not taken yet: as asked, else with " (2)", " (3)"… */
export function freeName(sk: Sketch, want: string): string {
  // (the whole name where it is free; cut to leave room for " (n)" only where it isn't)
  const name = (want.trim() || "Sketch").slice(0, SKETCH_NAME_MAX), taken = new Set(sketchList(sk).list.map(x => x.name));
  if (!taken.has(name)) return name;
  const base = name.slice(0, SKETCH_NAME_MAX - 5);
  for (let n = 2; ; n++) if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
}
/** the next sketch's id (as the plan's other ids: s1, s2…) */
export const nextSketchId = (sk: Sketch) => nextId("s", sketchList(sk).list.map(x => x.id));

/** the plan with its list as given (the open one's content in `scratch`; none kept if empty) */
function withList(sk: Sketch, list: SavedSketch[], open: string, scratch: Sketch | undefined): Sketch {
  const { scratch: _s, sketches: _l, sketchOpen: _o, ...plan } = sk;
  const sc = emptyContent(scratch) && !scratch?.traffic && !scratch?.geo ? undefined : inner(scratch);
  return { ...plan, ...(sc ? { scratch: sc } : {}), sketches: list.map(x => (x.id === open ? stripContent(x) : x)), sketchOpen: open };
}
const stripContent = (x: SavedSketch): SavedSketch => { if (!x.sketch) return x; const { sketch: _, ...rest } = x; return rest; };

/**
 * Sketch `id` opened in the window: the one open put away with its content and the view it is at (`view`), the other's
 * content the scratch now
 */
export function openSketch(sk: Sketch, id: string, view?: SavedSketch["view"]): Sketch {
  const { list, open } = sketchList(sk);
  if (id === open || !list.some(x => x.id === id)) return sk;
  const cur = inner(sk.scratch), next = list.find(x => x.id === id)!.sketch;
  const items = list.map(x => (x.id === open ? { ...x, ...(view ? { view } : {}), ...(cur && !emptyContent(cur) ? { sketch: cur } : {}) } : x.id === id ? stripContent(x) : x));
  return withList(sk, items, id, next);
}
/** a new empty sketch, opened (`now`: ms, when it is made) */
export function newSketch(sk: Sketch, name: string, now: number, view?: SavedSketch["view"]): { sketch: Sketch; id: string } {
  const id = nextSketchId(sk), { list } = sketchList(sk);
  const added = withList(sk, [...list, { id, name: freeName(sk, name), created: now, updated: now }], sketchList(sk).open, sk.scratch);
  return { sketch: openSketch(added, id, view), id };
}
/** a sketch's copy, named "… copy" and opened */
export function duplicateSketch(sk: Sketch, id: string, now: number, view?: SavedSketch["view"]): { sketch: Sketch; id: string } | null {
  const { list, open } = sketchList(sk), src = list.find(x => x.id === id);
  if (!src) return null;
  const nid = nextSketchId(sk), content = contentOf(sk, id);
  const copy: SavedSketch = { id: nid, name: freeName(sk, `${src.name} copy`), created: now, updated: now, ...(src.view ? { view: src.view } : {}), ...(content && !emptyContent(content) ? { sketch: content } : {}) };
  const added = withList(sk, [...list, copy], open, sk.scratch);
  return { sketch: openSketch(added, nid, view), id: nid };
}
/** a sketch renamed (a name already taken gets " (2)"…) */
export function renameSketch(sk: Sketch, id: string, name: string): Sketch {
  const { list, open } = sketchList(sk), x = list.find(y => y.id === id);
  const want = name.trim().slice(0, SKETCH_NAME_MAX);
  if (!x || !want || want === x.name) return sk;
  const taken = new Set(list.filter(y => y.id !== id).map(y => y.name));
  let n = want;
  for (let k = 2; taken.has(n); k++) n = `${want.slice(0, SKETCH_NAME_MAX - 5)} (${k})`;
  return withList(sk, list.map(y => (y.id === id ? { ...y, name: n } : y)), open, sk.scratch);
}
/** a sketch deleted (the last one: emptied, as a new "Sketch 1"); the one open deleted: the one before it opened */
export function deleteSketch(sk: Sketch, id: string): Sketch {
  const { list, open } = sketchList(sk);
  const k = list.findIndex(x => x.id === id);
  if (k < 0) return sk;
  if (list.length === 1) { const { scratch: _s, sketches: _l, sketchOpen: _o, ...plan } = sk; return plan; }
  const rest = list.filter(x => x.id !== id);
  if (id !== open) return withList(sk, rest, open, sk.scratch);
  const next = rest[Math.max(0, k - 1)];
  return withList(sk, rest, next.id, next.sketch);
}
/** the open sketch's "changed" time set (each edit in the window) */
export function touchOpen(sk: Sketch, now: number): Sketch {
  if (!sk.sketches?.length) return sk;
  return { ...sk, sketches: sk.sketches.map(x => (x.id === sk.sketchOpen ? { ...x, updated: now } : x)) };
}
/**
 * A piece put into a new sketch, not opened (an agent patch's: the user's sketches untouched, the one open still open);
 * `now` its time (0: set when saved)
 */
export function addAsNewSketch(sk: Sketch, content: Sketch, name: string, now = 0): { sketch: Sketch; id: string; name: string } {
  const { list, open } = sketchList(sk), id = nextSketchId(sk), n = freeName(sk, name);
  return { sketch: withList(sk, [...list, { id, name: n, created: now, updated: now, sketch: inner(content)! }], open, sk.scratch), id, name: n };
}
