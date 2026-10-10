"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useDeepSubject } from "subjecto/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { applyAgentPatch, fetchPlanState, listAgentPatches, rejectAgentPatch } from "@/server/actions";
import type { AgentPatchView } from "@/server/data/agent-patches";
import { AGENT_FILE, authorColor } from "@/lib/agent-patch";
import { readSketchFile, SKETCH_KINDS, type FileSummary } from "@/lib/sketch-diff";
import type { WindowAdd } from "@/lib/sketch-window-add";
import { ui } from "@/state/store";
import { timeAgo } from "@/lib/time";
import { FileSummaryView } from "./history-dialog";

/** a patch's preview against the plan as it is now */
type Preview = { revision: number; summary: FileSummary } | { revision: number; error: string };

const STATUS: Record<AgentPatchView["status"], string> = { pending: "pending", applied: "applied", rejected: "rejected", superseded: "superseded" };

/**
 * "Agent patches" (T132): changes agents propose to the plan instead of editing it. The button's badge counts
 * the pending ones; the panel lists them all, and one opened shows its description and the same preview as
 * History's "Apply changes from file" (refused items in red, a note when the plan moved on since it was made).
 * The plan's editors apply it (one new version, noted with the patch) or reject it. A patch may also add a piece
 * to the plan's Sketch window (T152), told in its own section: what it adds, where, and that the main plan stays.
 */
export function AgentPatchesButton({ planId, canApply }: { planId: string; canApply: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AgentPatchView[] | null>(null);
  const [error, setError] = useState("");
  const [save] = useDeepSubject(ui, "save");

  const load = useCallback(() => {
    listAgentPatches(planId).then(r => { setRows(r); setError(""); }).catch(e => setError(e instanceof Error ? e.message : "Couldn't load the agent patches"));
  }, [planId]);
  // on load, when opened, after each save, and every minute (agents submit at any time)
  useEffect(() => {
    load();
    const iv = setInterval(() => { if (document.visibilityState === "visible") load(); }, 60_000);
    return () => clearInterval(iv);
  }, [load, open, save.revision]);

  const pending = rows?.filter(r => r.status === "pending").length ?? 0;
  const [picked, setPicked] = useState<AgentPatchView | null>(null);
  // Back (or Esc) from a patch returns to the list: kept mounted meanwhile (its scroll stays), and focus goes back to
  // the patch's row (focus left on nothing would read as leaving the dialog, which closes it)
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());
  const back = () => {
    const id = picked?.id;
    setPicked(null);
    if (id !== undefined) requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  };

  // (nothing to show to one who can't see the plan, or before any patch)
  if (rows === null || (rows.length === 0 && !error)) return null;
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} aria-label={`Agent patches (${pending} pending)`} title="Changes agents propose to this plan">
        <Bot /> Agent patches {pending > 0 && <Badge className="ml-0.5 h-4 min-w-4 px-1 text-[10px]">{pending}</Badge>}
      </Button>
      <Dialog open={open} onOpenChange={o => { setOpen(o); if (!o) setPicked(null); }}>
        <DialogContent className="sm:max-w-2xl" onEscapeKeyDown={e => { if (picked) { e.preventDefault(); back(); } }}>
          {picked && <PatchDetail planId={planId} p={picked} canApply={canApply} onBack={back} onDecided={() => { setPicked(null); load(); }} />}
          <div className={picked ? "hidden" : "contents"}>
            {!picked && (
              <DialogHeader>
                <DialogTitle>Agent patches</DialogTitle>
                <DialogDescription>
                  Changes agents propose to this plan instead of editing it. Open one to see what it changes;
                  {canApply ? " applying it saves one new version (in the history, so it can be undone)." : " the plan's editors apply or reject them."}
                </DialogDescription>
              </DialogHeader>
            )}
              {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
              <ol className="max-h-[60vh] divide-y overflow-y-auto rounded-lg border">
                {rows.map(r => (
                  <li key={r.id}>
                    <button type="button" ref={el => { if (el) rowRefs.current.set(r.id, el); else rowRefs.current.delete(r.id); }} onClick={() => setPicked(r)} className={`flex w-full items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/50 ${r.status === "pending" ? "" : "opacity-60"}`}>
                      <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: authorColor(r.author) }} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          <span className="font-mono text-muted-foreground">#{r.id}</span>
                          <span className="font-medium">{r.title}</span>
                          <Badge variant={r.status === "pending" ? "default" : "secondary"}>{STATUS[r.status]}</Badge>
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {r.author}{r.task ? ` · ${r.task}` : ""} · {timeAgo(new Date(r.createdAt))} · against rev. {r.baseRevision}
                          {r.status !== "pending" && r.decidedAt && ` · ${r.status}${r.decidedByName ? ` by ${r.decidedByName}` : ""} ${timeAgo(new Date(r.decidedAt))}${r.appliedRevision ? ` (rev. ${r.appliedRevision})` : ""}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PatchDetail({ planId, p, canApply, onBack, onDecided }: { planId: string; p: AgentPatchView; canApply: boolean; onBack: () => void; onDecided: () => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");

  /** the patch read against the plan as it is saved now (as History's apply dialog does) */
  const summarise = useCallback(async () => {
    const cur = await fetchPlanState(planId);
    if (!cur) { setPreview({ revision: 0, error: "Couldn't load the plan" }); return null; }
    // (an agent patch may remove items, T140, and add to the Sketch window, T152)
    const r = readSketchFile(JSON.stringify(p.patch), "apply", cur.sketch, AGENT_FILE);
    const next: Preview = r.ok ? { revision: cur.revision, summary: r.summary } : { revision: cur.revision, error: r.error };
    setPreview(next);
    return next;
  }, [planId, p.patch]);
  useEffect(() => { void summarise(); }, [summarise]); // eslint-disable-line react-hooks/set-state-in-effect

  const apply = async () => {
    if (!preview || "error" in preview) return;
    setBusy(true); setError("");
    try {
      const r = await applyAgentPatch(planId, p.id, preview.revision);
      if (r.ok) {
        toast.success(`Agent patch #${p.id} applied`, { description: "It is a new version in the history, so you can undo it the same way." });
        // (the editor, simulation and undo stack start from the new state, as after a History restore)
        location.reload();
        return;
      }
      if (r.revision !== undefined) {
        await summarise();
        setError(`The plan was saved in the meantime (now rev. ${r.revision}). The preview above is against that version: check it and apply again.`);
      } else setError(r.error);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't apply it"); }
    finally { setBusy(false); }
  };
  const reject = async () => {
    setBusy(true); setError("");
    try {
      const r = await rejectAgentPatch(planId, p.id, note);
      if (r.ok) { toast.success(`Agent patch #${p.id} rejected`); onDecided(); return; }
      setError(r.error);
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't reject it"); }
    finally { setBusy(false); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(p.patch, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = `agent-patch-${p.id}${p.task ? `-${p.task}` : ""}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const s = preview && "summary" in preview ? preview.summary : null;
  const moved = preview && preview.revision > p.baseRevision;
  const pending = p.status === "pending";
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: authorColor(p.author) }} />
          <span className="font-mono text-muted-foreground">#{p.id}</span> {p.title}
        </DialogTitle>
        <DialogDescription>
          {p.author}{p.task ? ` · ${p.task}` : ""} · submitted {timeAgo(new Date(p.createdAt))} against rev. {p.baseRevision} · {STATUS[p.status]}
          {!pending && p.decidedAt && `${p.decidedByName ? ` by ${p.decidedByName}` : ""} ${timeAgo(new Date(p.decidedAt))}${p.appliedRevision ? ` (rev. ${p.appliedRevision})` : ""}`}
          {p.rejectNote && ` · “${p.rejectNote}”`}
        </DialogDescription>
      </DialogHeader>
      {p.description && <div className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-sm">{p.description}</div>}
      {pending && (
        <div className="space-y-2">
          {moved && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              The plan moved on since this patch was made (rev. {p.baseRevision} → {preview!.revision}): the preview is against the plan as it is now.
            </p>
          )}
          {!preview ? <p className="text-sm text-muted-foreground"><Loader2 className="mr-1 inline size-3.5 animate-spin" />Comparing with the current version…</p>
            : "error" in preview ? <p className="text-sm text-destructive">{preview.error}</p>
            : preview.summary.window ? (
              <div className="max-h-[50vh] space-y-3 overflow-y-auto">
                <SketchWindowView w={preview.summary.window} />
                <h3 className="text-sm font-medium">Main plan</h3>
                {mainTouched(preview.summary) ? <FileSummaryView s={preview.summary} /> : <p className="text-sm text-muted-foreground">Unchanged: this patch only adds to the Sketch window.</p>}
              </div>
            )
            : <FileSummaryView s={preview.summary} />}
        </div>
      )}
      {rejecting && (
        <Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={2} placeholder="Why (optional, the agent sees it)" />
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>Back</Button>
        <Button size="sm" variant="ghost" onClick={download}><Download /> Download</Button>
        <span className="flex-1" />
        {pending && canApply && (rejecting ? (
          <>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRejecting(false)}>Cancel</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void reject()}>Reject</Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setRejecting(true)}>Reject…</Button>
            <Button size="sm" disabled={busy || !s || s.same} onClick={() => void apply()} title={s?.same ? "Nothing would change" : undefined}>
              {busy && <Loader2 className="animate-spin" />} Apply
            </Button>
          </>
        ))}
      </div>
    </>
  );
}

/** the patch changes the main plan too (items, removals, geo, traffic or another field), not only the Sketch window */
const mainTouched = (s: FileSummary) =>
  s.items.length > 0 || s.geo || s.traffic || s.fields.some(f => f.change !== "kept from the current version") || SKETCH_KINDS.some(k => s.kinds[k].added.length || s.kinds[k].removed.length || s.kinds[k].changed.length);

/** what a patch adds to the Sketch window (T152): the counts, where it goes, and a small map of it beside what is there */
function SketchWindowView({ w }: { w: WindowAdd }) {
  const c = w.counts, n = (k: number, one: string, many = `${one}s`) => (k ? [`${k} ${k === 1 ? one : many}`] : []);
  const parts = [...n(c.lanes, "lane"), ...n(c.connectors, "connector"), ...n(c.roads, "road"), ...n(c.junctions, "junction"), ...n(c.crossings, "crossing"), ...n(c.zones, "zone")];
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <h3 className="font-medium">Sketch window</h3>
      <div className="flex flex-wrap items-start gap-3">
        <WindowThumb w={w} />
        <div className="min-w-0 flex-1 space-y-1">
          <p>Adds {parts.join(", ")} to the plan&apos;s Sketch window{w.empty ? " (empty now)" : ", beside your current content"}.</p>
          {w.beside > 0 && <p className="text-xs text-muted-foreground">At its own place it would lie over what the window holds, so it goes {w.beside} m east of it.</p>}
          {w.notCarried.length > 0 && <p className="text-xs text-amber-600 dark:text-amber-400">Not carried (as Test in Sketch&apos;s Add): {w.notCarried.join(", ")}.</p>}
          <p className="text-xs text-muted-foreground">Nothing in the window is replaced, and the window&apos;s traffic settings stay. This part doesn&apos;t change the main plan.</p>
        </div>
      </div>
    </div>
  );
}

/** the window's lanes (grey) and the piece's (in colour), fitted to a small box */
function WindowThumb({ w }: { w: WindowAdd }) {
  const all = [...w.preview.existing, ...w.preview.added].flat();
  if (!all.length) return null;
  const x0 = Math.min(...all.map(p => p.x)), y0 = Math.min(...all.map(p => p.y)), x1 = Math.max(...all.map(p => p.x)), y1 = Math.max(...all.map(p => p.y));
  const pad = Math.max(x1 - x0, y1 - y0, 10) * 0.05, path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");
  return (
    <svg viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`} className="h-28 w-40 shrink-0 rounded border bg-muted/30" role="img" aria-label="The Sketch window with the piece added">
      {w.preview.existing.map((pts, i) => <path key={`e${i}`} d={path(pts)} fill="none" stroke="currentColor" strokeOpacity={0.35} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />)}
      {w.preview.added.map((pts, i) => <path key={`a${i}`} d={path(pts)} fill="none" stroke="#2563eb" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}
