"use client";

/**
 * Saved results side by side (ticket #124): what each is a run of (the sketch, the demand, the time counted), then in all, per
 * junction (opened into its lanes in and out), per trip from a way in to a way out, per road; one measure at a time, each
 * result's value and its change from the first (green better, red worse). Copied as CSV, every measure, for a spreadsheet.
 */
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { hhmm } from "@/lib/demand-matrix";
import { changeFrom, compareResults, comparisonCsv, type CompareSection, type SimResult } from "@/lib/sim-results";

const span = (s: number) => { const m = Math.round(s / 60); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`; };

export function CompareResultsDialog({ results, onClose }: { results: SimResult[]; onClose: () => void }) {
  const sections = useMemo(() => compareResults(results), [results]);
  const [tab, setTab] = useState<CompareSection["id"]>("junctions");
  const [metric, setMetric] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const sec = sections.find(s => s.id === tab)!, k = metric[tab] ?? 0, m = sec.metrics[k];
  // (a lane's row has its flow only: shown with the first measure)
  const rows = sec.rows.filter(r => !r.parent || (k === 0 && open.has(r.parent)));
  const fmt = (x: number | null | undefined) => (x === null || x === undefined ? "—" : Math.abs(x) >= 100 ? String(Math.round(x)) : String(x));
  const tone = (d: number | null) => {
    if (d === null || Math.abs(d) < 0.5 || !m.better) return "text-muted-foreground";
    return (d > 0) === (m.better === "higher") ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400";
  };
  return (
    <Dialog open onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="flex h-[86vh] max-w-[min(1300px,96vw)] flex-col gap-3 sm:max-w-[min(1300px,96vw)]" onKeyDown={e => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Compare results</DialogTitle>
          <DialogDescription>Per hour of the time counted; the change is from the first ({results[0].name}): green better, red worse. Junctions and roads matched by id (a duplicated sketch keeps them), else by name.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 text-[11px]" style={{ gridTemplateColumns: `repeat(${results.length}, minmax(0, 1fr))` }}>
          {results.map((r, i) => (
            <div key={r.id} className={cn("rounded border p-1.5", i === 0 && "border-primary")}>
              <div className="truncate font-medium" title={r.name}>{r.name}</div>
              <div className="truncate text-muted-foreground" title={r.meta.demand}>{r.meta.sketch.name} · rev {r.meta.revision} · {r.meta.demand}</div>
              <div className="text-muted-foreground">{hhmm(r.meta.clock + r.data.from / 60)}–{hhmm(r.meta.clock + r.data.t / 60)} counted ({span(r.data.t - r.data.from)}{r.data.from > 0 ? `, after ${span(r.data.from)}` : ""})</div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup type="single" value={tab} onValueChange={v => v && setTab(v as CompareSection["id"])} className="h-8">
            {sections.map(s => <ToggleGroupItem key={s.id} value={s.id} className="h-8 px-2.5 text-xs">{s.id === "totals" ? "In all" : s.id === "junctions" ? "Junctions" : s.id === "trips" ? "Trips" : "Roads"}</ToggleGroupItem>)}
          </ToggleGroup>
          <ToggleGroup type="single" value={String(k)} onValueChange={v => v && setMetric(x => ({ ...x, [tab]: Number(v) }))} className="h-8">
            {sec.metrics.map((x, i) => <ToggleGroupItem key={x.key} value={String(i)} className="h-8 px-2 text-xs">{x.label}</ToggleGroupItem>)}
          </ToggleGroup>
          <Button size="sm" variant="outline" className="ml-auto h-8" title="Every measure of every section, as comma-separated text for a spreadsheet"
            onClick={() => void navigator.clipboard.writeText(comparisonCsv(sections, results.map(r => r.name))).then(() => toast("Copied as CSV"))}><Copy /> Copy as CSV</Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b">
                <th className="px-2 py-1.5 text-left font-medium">{sec.title}</th>
                {results.map((r, i) => <th key={r.id} className="px-2 py-1.5 text-right font-medium" title={r.name}><span className="block max-w-40 truncate">{r.name}</span><span className="font-normal text-muted-foreground">{m.label}{m.unit ? ` (${m.unit})` : ""}{i ? " · change" : ""}</span></th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const first = r.values[0]?.[k], kids = sec.id === "junctions" && !r.parent && k === 0 && sec.rows.some(x => x.parent === r.key);
                return (
                  <tr key={r.key} className={cn("border-b hover:bg-muted/50", r.parent && "text-muted-foreground")}>
                    <td className={cn("px-2 py-1", r.parent && "pl-7")}>
                      {kids ? (
                        <button type="button" className="flex items-center gap-1 text-left hover:underline" onClick={() => setOpen(o => { const n = new Set(o); if (n.has(r.key)) n.delete(r.key); else n.add(r.key); return n; })}>
                          {open.has(r.key) ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{r.name}
                        </button>
                      ) : r.name}
                    </td>
                    {r.values.map((v, i) => {
                      const x = v?.[k], d = i ? changeFrom(first, x) : null;
                      return (
                        <td key={i} className="px-2 py-1 text-right font-mono tabular">
                          {fmt(x)}{i > 0 && x !== undefined && <span className={cn("ml-1.5 inline-block w-14", tone(d))}>{d === null ? (first === undefined || first === null ? "new" : "") : `${d > 0 ? "+" : ""}${Math.round(d)}%`}</span>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {!rows.length && <tr><td className="px-2 py-3 text-muted-foreground" colSpan={results.length + 1}>Nothing counted here.</td></tr>}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}
