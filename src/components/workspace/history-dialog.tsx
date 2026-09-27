"use client";

import { useEffect, useState, useTransition } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useDeepSubject } from "subjecto/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { listPlanVersions, restorePlanVersion, type VersionRow } from "@/server/actions";
import { ui } from "@/state/store";
import { timeAgo } from "@/lib/time";

const KIND: Record<string, string> = { create: "Created", baseline: "Start of history", save: "Edited", restore: "Restored" };
const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Saved versions of the plan, newest first, with one-click rollback for editors. */
export function HistoryButton({ planId, canRestore }: { planId: string; canRestore: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<VersionRow[] | null>(null);
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState<VersionRow | null>(null);
  const [pending, start] = useTransition();
  const [save] = useDeepSubject(ui, "save");

  useEffect(() => {
    if (!open) return;
    listPlanVersions(planId).then(setRows).catch(e => setError(e instanceof Error ? e.message : "Couldn't load the history"));
  }, [open, planId, save.revision]);

  const busy = save.status === "dirty" || save.status === "saving";
  const restore = (v: VersionRow) => start(async () => {
    try {
      const r = await restorePlanVersion(planId, v.id);
      if (!r.ok) { toast.error(r.error); return; }
      toast.success("Version restored", { description: "The restore is itself in the history, so you can undo it the same way." });
      // reload so the editor, simulation and undo stack start from the restored state
      location.reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't restore"); }
  });

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => { setRows(null); setError(""); setOpen(true); }} aria-label="Plan history"><History /> History</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Plan history</DialogTitle>
            <DialogDescription>
              Every save is kept. Edits by the same person within a few minutes are grouped into one version.
              {canRestore ? " Restoring puts that version back for everyone and adds it as a new version." : " You have view access, so you can't restore versions."}
            </DialogDescription>
          </DialogHeader>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {rows === null && !error ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
          ) : rows && rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No versions yet. They appear as the plan is saved.</p>
          ) : rows && (
            <ol className="max-h-[60vh] divide-y overflow-y-auto rounded-lg border">
              {rows.map((v, i) => (
                <li key={v.id} className="flex items-start gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{fmt(v.updatedAt)}</span>
                      <span className="text-xs text-muted-foreground">{timeAgo(new Date(v.updatedAt))}</span>
                      {i === 0 && <Badge variant="secondary">Current</Badge>}
                      {v.kind !== "save" && <Badge variant="outline">{KIND[v.kind] ?? v.kind}</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {v.by ?? "Unknown"} · rev. {v.revision} · <span className="tabular">{v.roads} roads, {v.nodes} nodes, {v.stops} stops, {v.lines} lines</span>
                    </div>
                    {v.note && <div className="text-xs text-muted-foreground">{v.note}</div>}
                  </div>
                  {canRestore && i > 0 && (
                    <Button size="sm" variant="outline" className="h-7 shrink-0" disabled={pending || busy} onClick={() => setConfirm(v)} title={busy ? "Wait for the current changes to save" : undefined}>
                      <RotateCcw /> Restore
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog open={!!confirm} onOpenChange={o => { if (!o) setConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore the version from {confirm ? fmt(confirm.updatedAt) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>The plan goes back to that state for everyone who opens it. The current state stays in the history, so you can switch back.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending} onClick={e => { e.preventDefault(); if (confirm) restore(confirm); }}>
              {pending && <Loader2 className="animate-spin" />} Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
