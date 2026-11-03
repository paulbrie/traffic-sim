"use client";

/**
 * A run's results saved, and saved results compared (ticket #124): when the counting begins (the warm-up), "Save this run's
 * results" (named; the flows every 5 s kept or not), the plan's saved results (any of its sketches; seen by all who can see the
 * plan), renamed (ticket #125), and those ticked compared side by side (compare-results-dialog.tsx). Saved apart from the plan: its
 * saves stay small.
 */
import { useCallback, useEffect, useState } from "react";
import { BarChart3, Pencil, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberField } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import type { Sketch } from "@/lib/lane-sketch";
import type { SimStats } from "@/lib/lane-sketch-sim";
import { hhmm, startClock } from "@/lib/demand-matrix";
import { sketchList } from "@/lib/sketch-list";
import { resultMeta, type SimResult, type SimResultInfo } from "@/lib/sim-results";
import { deleteSimResult, getSimResults, listSimResults, renameSimResult, saveSimResult } from "@/server/actions";
import { useSketchStore } from "@/state/lane-sketch";
import { laneSketch$, ui } from "@/state/store";
import { CompareResultsDialog } from "./compare-results-dialog";
import { InspectorPanel } from "./inspector-panel";

const span = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`; };

export function ResultsPanel({ sketch, stats, readOnly }: { sketch: Sketch; stats: SimStats | null; readOnly: boolean }) {
  const store = useSketchStore();
  const planId = ui.getValue().planId;
  const [list, setList] = useState<SimResultInfo[] | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [saving, setSaving] = useState<{ name: string; series: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [comparing, setComparing] = useState<SimResult[] | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const reload = useCallback(() => { if (planId) void listSimResults(planId).then(setList).catch(() => setList([])); }, [planId]);
  useEffect(() => { reload(); }, [reload]);
  const warmup = sketch.traffic?.warmup ?? 0, from = warmup * 60, start = startClock(sketch);
  const counted = stats ? Math.max(0, stats.t - from) : 0;
  // (the sketch it is a run of: the Sketch window's open one, or the plan's own)
  const which = () => {
    if (store.kind !== "scratch") return { id: "plan", name: "The plan" };
    const { list: l, open } = sketchList(laneSketch$.getValue());
    return { id: open, name: l.find(x => x.id === open)?.name ?? open };
  };
  const defaultName = () => `${which().name} · ${hhmm(start + from / 60)}–${hhmm(start + (stats?.t ?? 0) / 60)}`;
  const save = async () => {
    const sim = store.sim();
    if (!planId || !sim || !saving) return;
    setBusy(true);
    try {
      const data = await sim.results(saving.series);
      if (!data) { toast.error("No run to save"); return; }
      const t = sketch.traffic, meta = resultMeta(sketch, { sketch: which(), revision: ui.getValue().save.revision, speed: t?.speed ?? 50, ...(t?.seed !== undefined ? { seed: t.seed } : {}), ...(t?.tune ? { tune: t.tune as Record<string, number> } : {}) });
      const r = await saveSimResult(planId, { name: saving.name.trim() || defaultName(), meta, data });
      if (!r.ok) { toast.error("Not saved", { description: r.error }); return; }
      toast.success("Results saved", { description: `${span(data.t - data.from)} counted` });
      setSaving(null); setTicked(x => [...x, r.id]); reload();
    } finally { setBusy(false); }
  };
  const rename = () => {
    if (!planId || !renaming) return;
    const { id, name } = renaming, was = list?.find(x => x.id === id)?.name;
    setRenaming(null);
    if (!name.trim() || name.trim() === was) return;
    setList(l => l && l.map(x => (x.id === id ? { ...x, name: name.trim() } : x)));
    void renameSimResult(planId, id, name).then(r => { if (!r.ok) toast.error("Not renamed", { description: r.error }); reload(); });
  };
  const compare = async () => {
    if (!planId) return;
    setBusy(true);
    try { const rs = await getSimResults(planId, ticked); setComparing(rs.length ? rs : null); } finally { setBusy(false); }
  };
  return (
    <InspectorPanel id="results" title="Saved results">
      <p className="text-[11px] text-muted-foreground">Save a run&apos;s results to compare variants: junctions and their lanes in and out, trips from each way in to each way out, roads, and in all. Kept with the plan, for anyone who can see it.</p>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <span className="pb-1.5 text-xs" title="The network fills up first: what happens before then isn't counted in the results (the panels and graphs count everything)">Count from</span>
        <NumberField id="res-warmup" label="Count from" hideLabel unit="min in" digits={0} min={0} max={240} step={5} className="w-28" value={warmup}
          onCommit={v => store.edit(s => ({ ...s, traffic: { ...(s.traffic ?? { rate: 400, speed: 50 }), warmup: Math.round(v) } }))} />
      </div>
      {stats && <p className="text-[11px] text-muted-foreground">{stats.t < from ? `Counting begins at ${hhmm(start + warmup)} (${span(from - stats.t)} from now).` : `${span(counted)} counted so far (from ${hhmm(start + warmup)}).`}</p>}
      {!readOnly && (saving ? (
        <div className="grid gap-1.5 rounded-md border p-2">
          <Input value={saving.name} onChange={e => setSaving({ ...saving, name: e.target.value })} maxLength={80} className="h-7 text-xs" aria-label="Results' name" autoFocus
            onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") void save(); if (e.key === "Escape") setSaving(null); }} />
          <label className="flex items-center gap-1.5 text-xs" title="Each junction's flows every 5 s (sketches of 24 junctions at most): to see how they changed over the run; about ten times the size">
            <input type="checkbox" className="accent-primary" checked={saving.series} onChange={e => setSaving({ ...saving, series: e.target.checked })} /> With the flows every 5 s
          </label>
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7" disabled={busy} onClick={() => void save()}><Save /> Save</Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setSaving(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="h-7 justify-self-start" disabled={!stats || counted < 60}
          title={!stats ? "Run the cars first" : counted < 60 ? "A minute counted at least" : "Save what this run counted so far"}
          onClick={() => setSaving({ name: defaultName(), series: false })}><Save /> Save this run&apos;s results</Button>
      ))}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
        {list === null ? <p className="text-[11px] text-muted-foreground">…</p> : !list.length ? <p className="text-[11px] text-muted-foreground">None saved yet.</p> : list.map(x => renaming?.id === x.id ? (
          <Input key={x.id} value={renaming.name} onChange={e => setRenaming({ id: x.id, name: e.target.value })} maxLength={80} className="h-7 text-xs" aria-label="Results' name" autoFocus
            onFocus={e => e.currentTarget.select()} onBlur={rename}
            onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") rename(); if (e.key === "Escape") setRenaming(null); }} />
        ) : (
          <label key={x.id} className={cn("flex items-center gap-1.5 rounded px-1 text-xs hover:bg-muted", ticked.includes(x.id) && "bg-primary/10")}
            title={`${x.name}\n${x.sketch} · ${span(x.seconds)} counted${x.series ? " · flows every 5 s" : ""}\n${x.by ? `${x.by}, ` : ""}${new Date(x.createdAt).toLocaleString()}`}>
            <input type="checkbox" className="accent-primary" checked={ticked.includes(x.id)} onChange={e => setTicked(t => (e.target.checked ? [...t, x.id] : t.filter(y => y !== x.id)))} />
            <span className="min-w-0 flex-1 truncate" onDoubleClick={readOnly ? undefined : e => { e.preventDefault(); setRenaming({ id: x.id, name: x.name }); }}>{x.name}</span>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular">{span(x.seconds)}</span>
            {!readOnly && <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={`Rename ${x.name}`} title="Rename it"
              onClick={e => { e.preventDefault(); setRenaming({ id: x.id, name: x.name }); }}><Pencil className="size-3.5" /></Button>}
            {!readOnly && <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={`Delete ${x.name}`} title="Delete it"
              onClick={e => { e.preventDefault(); if (!planId) return; void deleteSimResult(planId, x.id).then(r => { if (!r.ok) toast.error(r.error); setTicked(t => t.filter(y => y !== x.id)); reload(); }); }}><Trash2 className="size-3.5" /></Button>}
          </label>
        ))}
      </div>
      {!!list?.length && (
        <Button size="sm" variant="outline" className="h-7 justify-self-start" disabled={!ticked.length || busy} onClick={() => void compare()}
          title={ticked.length ? "Side by side, the first ticked the one the others are measured against" : "Tick the results to compare"}><BarChart3 /> Compare{ticked.length ? ` (${ticked.length})` : ""}</Button>
      )}
      {comparing && <CompareResultsDialog results={comparing} onClose={() => setComparing(null)} />}
    </InspectorPanel>
  );
}
