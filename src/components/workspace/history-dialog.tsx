"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { FilePlus2, FileUp, History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useDeepSubject } from "subjecto/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { fetchPlanState, listPlanVersions, restorePlanFromFile, restorePlanVersion, type VersionRow } from "@/server/actions";
import { RESTORE_NOTE_MAX } from "@/server/restore-file";
import { readSketchFile, SKETCH_FILE_MAX_BYTES, SKETCH_KINDS, type FileMode, type FileSummary, type SketchKind } from "@/lib/sketch-diff";
import { ui } from "@/state/store";
import { timeAgo } from "@/lib/time";

const KIND: Record<string, string> = { create: "Created", baseline: "Start of history", save: "Edited", restore: "Restored" };
const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

type FromFile = { mode: FileMode; fileName: string; summary: FileSummary; payload: unknown; revision: number };
const MODE_TITLE: Record<FileMode, string> = { apply: "Apply changes from", restore: "Restore from" };

/**
 * Saved versions of the plan, newest first, with one-click rollback for editors; on a V2 plan (`fromFile`) also
 * a sketch file applied (its items replace or add to the plan's) or restored (it replaces the plan's sketch),
 * shown against the current revision before it is saved.
 */
export function HistoryButton({ planId, canRestore, fromFile = true }: { planId: string; canRestore: boolean; fromFile?: boolean }) {
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
  const fileInput = useRef<HTMLInputElement>(null);
  const fileMode = useRef<FileMode>("apply");
  const [file, setFile] = useState<FromFile | null>(null);
  const [note, setNote] = useState("");
  const [fileError, setFileError] = useState("");

  const choose = (mode: FileMode) => { fileMode.current = mode; fileInput.current?.click(); };
  const pickFile = (f: File | undefined) => start(async () => {
    if (!f) return;
    const mode = fileMode.current;
    if (f.size > SKETCH_FILE_MAX_BYTES) { toast.error("The file is too large", { description: `A sketch file can be at most ${SKETCH_FILE_MAX_BYTES / 1024 / 1024} MB.` }); return; }
    try {
      const text = await f.text();
      const cur = await fetchPlanState(planId);
      if (!cur) { toast.error("Couldn't load the plan"); return; }
      const read = readSketchFile(text, mode, cur.sketch);
      if (!read.ok) { toast.error(read.error); return; }
      setNote(""); setFileError("");
      setFile({ mode, fileName: f.name, summary: read.summary, payload: read.payload, revision: cur.revision });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't read the file"); }
  });
  const restoreFile = (x: FromFile) => start(async () => {
    try {
      const r = await restorePlanFromFile(planId, { mode: x.mode, file: x.payload, revision: x.revision, note, fileName: x.fileName });
      if (!r.ok) { setFileError(r.error); return; }
      toast.success(x.mode === "apply" ? "Changes applied from the file" : "Restored from the file", { description: "It is a new version in the history, so you can undo it the same way." });
      // reload so the editor, simulation and undo stack start from the restored state
      location.reload();
    } catch (e) { setFileError(e instanceof Error ? e.message : "Couldn't restore"); }
  });
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
          {canRestore && fromFile && (
            <div className="flex items-center gap-2">
              <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={e => { pickFile(e.target.files?.[0]); e.target.value = ""; }} />
              <Button size="sm" variant="outline" disabled={pending || busy} onClick={() => choose("apply")} title={busy ? "Wait for the current changes to save" : "Items in a .json file replace the plan's with the same id, new ones are added, nothing is removed"}>
                <FilePlus2 /> Apply changes from file…
              </Button>
              <Button size="sm" variant="ghost" disabled={pending || busy} onClick={() => choose("restore")} title={busy ? "Wait for the current changes to save" : "A whole sketch in a .json file replaces the plan's"}>
                <FileUp /> Restore from file…
              </Button>
            </div>
          )}
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
      <AlertDialog open={!!file} onOpenChange={o => { if (!o) setFile(null); }}>
        <AlertDialogContent className="sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>{file ? MODE_TITLE[file.mode] : ""} {file?.fileName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {file?.mode === "apply"
                ? "The file's items replace the plan's with the same id and new ones are added; nothing is removed and everything else stays as it is. "
                : "The file's sketch replaces the plan's. "}
              Compared with the current version (rev. {file?.revision}). It is saved as a new version for everyone who opens the plan; the current state stays in the history, so you can switch back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {file && <FileSummaryView s={file.summary} />}
          <Textarea value={note} onChange={e => setNote(e.target.value)} maxLength={RESTORE_NOTE_MAX} rows={2} placeholder="Note for the history (optional)" aria-label="Note" />
          {fileError && <p className="text-sm text-destructive" role="alert">{fileError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={pending || busy || !!file?.summary.same} onClick={e => { e.preventDefault(); if (file) restoreFile(file); }}>
              {pending && <Loader2 className="animate-spin" />} {file?.mode === "apply" ? "Apply" : "Restore"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const KIND_LABEL: Record<SketchKind, string> = { lanes: "Lanes", connectors: "Connectors", junctions: "Junctions", roads: "Roads", links: "Links", crossings: "Crossings" };
const FIRST = 4;
const ids = (xs: string[]) => xs.slice(0, FIRST).join(", ") + (xs.length > FIRST ? ` +${xs.length - FIRST}` : "");

/**
 * What the file changes: for "apply" each of its items (added / replaced / unchanged, shape before → after);
 * for both, per kind added / removed / changed against the current version (counts and the first ids), geo,
 * traffic, every other top-level field not kept as it is, and what the checks left out.
 */
function FileSummaryView({ s }: { s: FileSummary }) {
  if (s.same) return <p className="text-sm text-muted-foreground">The result is the same as the current version: nothing to save.</p>;
  const skipped = SKETCH_KINDS.filter(k => s.dropped[k]).map(k => `${s.dropped[k]} ${KIND_LABEL[k].toLowerCase()}`);
  const removed = s.mode === "apply" ? SKETCH_KINDS.filter(k => s.kinds[k].removed.length) : [];
  const kinds = SKETCH_KINDS.filter(k => s.kinds[k].added.length || s.kinds[k].removed.length || s.kinds[k].changed.length);
  const goes = s.mode === "restore" ? SKETCH_KINDS.reduce((n, k) => n + s.kinds[k].removed.length, 0) : 0;
  const differs = (d: boolean, now: unknown, word: string) => (!d ? "same" : <span className="font-medium text-foreground">{now === undefined ? "missing in file" : word}</span>);
  return (
    <div className="max-h-[50vh] space-y-3 overflow-y-auto text-sm">
      {s.mode === "apply" && (
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-1 pr-2 font-medium">In the file</th><th className="py-1 pr-2 font-medium">Change</th><th className="py-1 font-medium">Shape: before → after</th></tr>
          </thead>
          <tbody className="divide-y">
            {s.items.map(x => (
              <tr key={`${x.kind}:${x.id}`} className={x.change === "unchanged" ? "text-muted-foreground" : x.change.startsWith("left out") ? "text-destructive" : ""}>
                <td className="py-1 pr-2"><span className="text-muted-foreground">{KIND_LABEL[x.kind].replace(/s$/, "").toLowerCase()} </span><span className="font-mono">{x.id}</span></td>
                <td className="py-1 pr-2">{x.change}</td>
                <td className="py-1 tabular">{x.before ?? "—"} → {x.after ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {kinds.length > 0 && (
        <table className="w-full text-xs">
          <thead className="text-left text-muted-foreground">
            <tr><th className="py-1 pr-2 font-medium">Against the current version</th><th className="py-1 pr-2 font-medium">Added</th><th className="py-1 pr-2 font-medium">Removed</th><th className="py-1 font-medium">Changed</th></tr>
          </thead>
          <tbody className="divide-y">
            {kinds.map(k => (
              <tr key={k} className="align-top">
                <td className="py-1 pr-2 font-medium">{KIND_LABEL[k]}</td>
                {(["added", "removed", "changed"] as const).map(c => (
                  <td key={c} className="py-1 pr-2">
                    <span className="tabular">{s.kinds[k][c].length || "—"}</span>
                    {s.kinds[k][c].length > 0 && <div className="break-all font-mono text-[10px] text-muted-foreground">{ids(s.kinds[k][c])}</div>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="text-xs text-muted-foreground">
        Place on Earth (geo): {differs(s.geo, s.sketch.geo, "differs")} · Traffic settings: {differs(s.traffic, s.sketch.traffic, "differ")}
      </p>
      {s.fields.length > 0 && (
        <ul className="space-y-0.5 text-xs">
          {s.fields.map(f => (
            <li key={f.field} className={f.change === "kept from the current version" ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}>
              <span className="font-mono">{f.field}</span>: {f.change}
            </li>
          ))}
        </ul>
      )}
      {goes > 0 && (
        <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          Restoring removes {goes} item{goes === 1 ? "" : "s"} the plan has now (see Removed). If the file holds only the items to change, use &quot;Apply changes from file&quot; instead.
        </p>
      )}
      {removed.length > 0 && (
        <p className="text-xs text-destructive">Once checked, these current items would go (they depend on what the file changes): {removed.map(k => `${KIND_LABEL[k].toLowerCase()} ${ids(s.kinds[k].removed)}`).join("; ")}.</p>
      )}
      {skipped.length > 0 && (
        <p className="text-xs text-amber-600 dark:text-amber-400">Items in the file that aren&apos;t valid, left out as the server would: {skipped.join(", ")}.</p>
      )}
    </div>
  );
}
