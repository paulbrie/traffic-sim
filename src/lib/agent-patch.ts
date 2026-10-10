import type { Sketch } from "./lane-sketch";
import { leftOutCount, pickPatch, readSketchFile, SKETCH_KINDS, type FileSummary } from "./sketch-diff";

/**
 * Agent patches (T132): changes an agent proposes to a plan instead of editing it, applied or rejected by the
 * plan's editors on its page. A patch is what "Apply changes from file" takes (lanes, connectors, roads,
 * junctions, links, crossings, zones, each with an id; an item's own fields over the current one's), and may also
 * remove items: `remove: { lanes: ["l5"], connectors: ["c7"], … }`, ids only, checked so nothing goes unlisted;
 * and add a piece to the plan's Sketch window: `sketchWindowAdd: { lanes, connectors, roads, junctions, crossings,
 * zones, geo?, … }` (a sketch fragment, as Test in Sketch's Add takes it; T152), alone or with the rest.
 */

export type AgentPatchStatus = "pending" | "applied" | "rejected" | "superseded";

export type AgentPatchRow = {
  id: number; planId: string; author: string; task: string; title: string; description: string; patch: unknown;
  baseRevision: number; status: AgentPatchStatus; createdAt: string; decidedAt: string | null; decidedBy: string | null;
  appliedRevision: number | null; rejectNote: string | null;
};

export const PATCH_TITLE_MAX = 160, PATCH_DESC_MAX = 20_000;

/**
 * Whether `patchText` can be submitted against the plan's current sketch: a patch file, with nothing the checks
 * would leave out (each refused item listed, with why) and something it changes. Submitting never changes the
 * plan; this only keeps unusable patches out of the editors' list.
 */
export function checkPatch(patchText: string, current: Sketch | null): { ok: true; summary: FileSummary; payload: unknown } | { ok: false; errors: string[] } {
  const r = readSketchFile(patchText, "apply", current, AGENT_FILE);
  if (!r.ok) return { ok: false, errors: r.problems ?? [r.error] };
  const s = r.summary, errors: string[] = [];
  if (leftOutCount(s))
    for (const x of s.items) if (x.change.startsWith("left out")) errors.push(`${x.kind.replace(/s$/, "")} ${x.id}: ${x.change}${x.why ? ` (${x.why})` : ""}`);
  if (!errors.length && s.same) errors.push("Nothing would change: the plan already has all of it.");
  return errors.length ? { ok: false, errors } : { ok: true, summary: s, payload: r.payload };
}

/** what an agent patch may do that a plain file may not */
export const AGENT_FILE = { allowRemove: true, allowSketchWindow: true };

/** the version note an applied patch gets in the plan's history ("… (Sketch window)" when it adds there) */
export function patchNote(p: Pick<AgentPatchRow, "id" | "task" | "author" | "title"> & { patch?: unknown }): string {
  const who = [p.task, p.author].filter(Boolean).join(", "), pt = pickPatch(p.patch);
  const where = !pt?.sketchWindowAdd ? "" : SKETCH_KINDS.some(k => pt[k]?.length) || pt.remove ? " (plan and Sketch window)" : " (Sketch window)";
  const head = `Agent patch #${p.id}${who ? ` (${who})` : ""}: `;
  return `${head}${p.title.slice(0, 500 - head.length - where.length)}${where}`;
}

/** a steady colour for an author's name (the agents' own colours live in the admin, not here) */
export function authorColor(name: string): string {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 45%)`;
}
