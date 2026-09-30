/** Merging the selected roads (the M key, or the button in the road inspector). */
import { toast } from "sonner";
import { commit, network$, select, ui } from "./store";
import * as ops from "./ops";

/**
 * Merge the selected roads into one: those picked with Shift+click, or, with one road selected,
 * the whole road it belongs to (all its pieces between junctions).
 */
export function mergeSelectedRoads() {
  const u = ui.getValue(), sel = u.selection, net = network$.getValue();
  if (sel?.kind !== "link") { toast.message("Select the roads to merge first (Shift+click to add more), then press M."); return; }
  const ids = u.multi.length ? [sel.id, ...u.multi] : ops.chainLinks(net, sel.id).map(c => c.id);
  if (ids.length < 2) { toast.message("Nothing to merge: Shift+click the roads that follow on from this one, or pick a road made of several pieces."); return; }
  const r = ops.mergeLinks(net, ids);
  if ("error" in r) { toast.error(r.error); return; }
  commit(r.net);
  select({ kind: "link", id: r.id });
  toast.success(`Merged ${ids.length} roads into ${r.id}`, r.err > 2 ? { description: `Its shape is simplified: up to ${r.err.toFixed(1)} m from before. Add a bend point (double-click) to reshape it.` } : undefined);
}

/** Smooth the join between the two selected roads (the S key, or the button in the road inspector). */
export function smoothSelectedJoin() {
  const u = ui.getValue(), sel = u.selection;
  if (sel?.kind !== "link" || u.multi.length !== 1) { toast.message("Select the two roads that meet (click one, Shift+click the other), then press S."); return; }
  const r = ops.smoothBetween(network$.getValue(), sel.id, u.multi[0]);
  if ("error" in r) { toast.error(r.error); return; }
  commit(r);
}
