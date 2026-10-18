/**
 * The Claude bridge's edit actions on a V2 plan's page (T189, docs/claude-bridge.md): the editors on the page (the plan's,
 * and the Sketch window's while it is open) offer themselves, and each edit an agent asks for is checked against the leave
 * the user gave (the server sends it with the command: the plan and all its sketches, or one sketch only), applied to the
 * editor's sketch through its store (one undo step, saved as a user's edit is), and answered with where it was, so the
 * agent's cursor and a few words show the user who did what. The edits themselves: src/lib/bridge-edits.ts.
 */
import { applyEdit, MAP_EDITS, SKETCH_EDITS } from "@/lib/bridge-edits";
import type { Pt, SavedSketch, Sketch } from "@/lib/lane-sketch";
import { duplicateSketch, newSketch, openSketch, renameSketch, sketchList } from "@/lib/sketch-list";
import { bridgeEdit, setBridgeEditScope, type EditOutcome, type EditPermit } from "./bridge-registry";
import { changeSketches } from "./lane-sketch";
import { laneSketch$, ui } from "./store";

type Kind = "plan" | "scratch";
/** an editor as the bridge edits it: its sketch now, a new one put in (as one undo step), and a point of the map on the page */
export interface BridgeEditor { sketch: () => Sketch; edit: (next: Sketch) => void; toClient: (p: Pt) => { x: number; y: number } | null; view: () => SavedSketch["view"] }
const editors = new Map<Kind, BridgeEditor>();
/** an editor on the page offers itself (until the function returned is called) */
export function offerEditorToBridge(kind: Kind, ed: BridgeEditor) {
  editors.set(kind, ed);
  return () => { if (editors.get(kind) === ed) editors.delete(kind); };
}

type Allowed = Exclude<EditPermit, { mode: "off" }>;
const fail = (m: string): never => { throw new Error(m); };
/** the editor an edit is for (`editor`, else the one the user is at), if the leave given covers it */
function editorFor(editor: unknown, permit: Allowed, active: () => Kind): { kind: Kind; ed: BridgeEditor } {
  if (editor !== undefined && editor !== "plan" && editor !== "scratch") fail(`"editor": "plan" or "scratch" (the Sketch window)`);
  if (ui.getValue().readOnly) fail("this plan is open view-only here: nothing can be changed");
  const kind = (editor as Kind | undefined) ?? (permit.mode === "sketch" ? "scratch" : active());
  if (permit.mode === "sketch") {
    if (kind !== "scratch") fail(`you may edit only the sketch "${permit.name}" (in the Sketch window), not the plan: the user allowed that sketch only`);
    if (ui.getValue().planId !== permit.plan) fail(`you may edit only the sketch "${permit.name}" of another plan: the user allowed that sketch only`);
    if (sketchList(laneSketch$.getValue()).open !== permit.sketch) fail(`the Sketch window has another sketch open: you may edit only "${permit.name}" (the user allowed that sketch only)`);
  }
  const ed = editors.get(kind) ?? fail(kind === "scratch" ? "the Sketch window isn't open (app sketchWindow { open: true })" : "the plan's editor isn't on this page");
  return { kind, ed };
}

/** the edits offered to the bridge while a V2 plan is open; `active`: the editor the user is at */
export function offerEditsToBridge(active: () => Kind) {
  const offs = [
    // ("this sketch only": the one the Sketch window has open)
    setBridgeEditScope(() => {
      const plan = ui.getValue().planId, k = laneSketch$.getValue(), { list, open } = sketchList(k);
      return plan ? { plan, sketch: open, name: list.find(x => x.id === open)?.name ?? open } : null;
    }),
    ...MAP_EDITS.map(action =>
      bridgeEdit.register(action, (a, permit): EditOutcome => {
        const { editor, ...args } = a, { ed } = editorFor(editor, permit, active);
        const done = applyEdit(ed.sketch(), action, args);
        ed.edit(done.sketch);
        return { result: done.result, at: done.at ? ed.toClient(done.at) : null, said: done.said };
      })),
    // the plan's sketches (T156), as the Sketch window's picker: one opened, a new one, a copy (the plan and all its sketches only)
    ...SKETCH_EDITS.map(action => bridgeEdit.register(action, (a, permit): EditOutcome => {
      if (permit.mode !== "all") fail(`the user allowed edits to the sketch "${permit.name}" only: picking or making sketches needs "Plan and its sketches"`);
      if (ui.getValue().readOnly) fail("this plan is open view-only here: nothing can be changed");
      const keys = action === "openSketch" ? ["id"] : action === "newSketch" ? ["name"] : ["id", "name"], bad = Object.keys(a).filter(k => !keys.includes(k));
      if (bad.length) fail(`unknown ${bad.map(k => `"${k}"`).join(", ")}: ${action} takes ${keys.join(", ")}`);
      for (const k of keys) if (a[k] !== undefined && (typeof a[k] !== "string" || !(a[k] as string).trim())) fail(`"${k}" must be a string, not ${JSON.stringify(a[k])}`);
      const k = laneSketch$.getValue(), { list, open } = sketchList(k), view = editors.get("scratch")?.view(), now = Date.now();
      const id = (a.id as string | undefined) ?? (action === "duplicateSketch" ? open : undefined);
      if (action !== "newSketch" && !list.some(x => x.id === id)) fail(`${id === undefined ? `"id" is needed` : `no sketch ${id}`}: ${list.map(x => `${x.id} "${x.name}"`).join(", ")}`);
      let made: string | null = null;
      changeSketches(cur => {
        if (action === "openSketch") return openSketch(cur, id!, view);
        const r = action === "newSketch" ? newSketch(cur, (a.name as string | undefined) ?? `Sketch ${sketchList(cur).list.length + 1}`, now, view) : duplicateSketch(cur, id!, now, view);
        if (!r) return cur;
        made = r.id;
        return a.name && action === "duplicateSketch" ? renameSketch(r.sketch, r.id, a.name as string) : r.sketch;
      });
      const after = sketchList(laneSketch$.getValue()), shown = after.list.find(x => x.id === after.open);
      const said = action === "openSketch" ? `opened the sketch "${shown?.name}"` : `${action === "newSketch" ? "made a new sketch" : "copied a sketch as"} "${shown?.name}"`;
      return { result: { open: after.open, name: shown?.name, ...(made ? { made } : {}), sketches: after.list.map(x => ({ id: x.id, name: x.name })) }, at: null, said };
    })),
  ];
  return () => { for (const off of offs) off(); };
}
