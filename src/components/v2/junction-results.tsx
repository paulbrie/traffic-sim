"use client";

import { useEditorKind, useUiPath, type TableUi } from "@/state/sketch-ui";
import { ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Sketch } from "@/lib/lane-sketch";
import type { JunctionStats, SimStats } from "@/lib/lane-sketch-sim";
import { cn } from "@/lib/utils";
import { InspectorPanel } from "./inspector-panel";

type Key = "delay" | "rate" | "queue" | "fuel";
const COLS: { key: Key; label: string; title: string }[] = [
  { key: "rate", label: "veh/h", title: "Vehicles through it an hour (so far)" },
  { key: "delay", label: "delay", title: "Time each vehicle lost, on average, on the last 100 m of its ways in and on it (against driving at the speed it wants)" },
  { key: "queue", label: "queue", title: "Vehicles standing on the last 100 m of its ways in and on it: on average (and at most)" },
  { key: "fuel", label: "fuel", title: "Fuel burnt there so far" },
];

/**
 * Each junction's results while the cars run, as V1's data tables: vehicles through it an hour, the delay each
 * had there on average, the queue, the fuel; sorted by any of them; a click takes the view to it.
 */
export function JunctionResults({ sketch, stats, onGo }: { sketch: Sketch; stats: SimStats; onGo: (id: string) => void }) {
  // (by a column, the most first; again, the other way; by name, A to Z first)
  // (how it is sorted and how much shows: the editor's, in the V2 UI store)
  const [table, setTable] = useUiPath<TableUi>(`editors/${useEditorKind()}/tables/junctions`);
  const by = table.by as Key | "name", flip = table.flip, n = table.shown;
  const sortBy = (k: Key | "name") => setTable(s => ({ ...s, by: k, flip: s.by === k ? !s.flip : false }));
  const setN = (f: (n: number) => number) => setTable(s => ({ ...s, shown: f(s.shown) }));
  const t = Math.max(1, stats.t), name = new Map(sketch.junctions.map(j => [j.id, j.name]));
  const rows = (stats.junctions ?? []).filter(j => j.through > 0 || j.queueMax > 0).map(j => ({
    j, rate: (j.through / t) * 3600, delay: j.through ? j.delay / j.through : j.delay, queue: j.queueMean, fuel: j.fuel,
  }));
  rows.sort((a, b) => {
    const d = by === "name" ? (name.get(a.j.id) ?? a.j.id).localeCompare(name.get(b.j.id) ?? b.j.id, undefined, { numeric: true }) : b[by] - a[by];
    return flip ? -d : d;
  });
  const arrow = (k: Key | "name") => (by !== k ? "" : (k === "name") !== flip ? " ↑" : " ↓");
  if (!rows.length) return null;
  const csv = () => {
    const head = "junction,id,vehicles per hour,through,mean delay (s),delay (vehicle-s),queue mean,queue max,fuel (L)";
    const lines = rows.map(r => [JSON.stringify(name.get(r.j.id) ?? r.j.id), r.j.id, r.rate.toFixed(0), r.j.through, r.delay.toFixed(1), r.j.delay.toFixed(0), r.queue.toFixed(2), r.j.queueMax, r.fuel.toFixed(3)].join(","));
    void navigator.clipboard.writeText([head, ...lines].join("\n")).then(() => toast.success("Junction results copied", { description: `${rows.length} junctions, as CSV (paste into a spreadsheet).` }), () => toast.error("Couldn't copy"));
  };
  return (
    <InspectorPanel id="junction-results" title="Junctions"
      actions={<Button size="icon-sm" variant="ghost" aria-label="Copy the junctions' results as CSV" title="Copy as CSV" onClick={csv}><ClipboardCopy className="size-3.5" /></Button>}>
      <p className="text-[11px] text-muted-foreground">Since the cars started ({Math.floor(t / 60)} min): each junction&apos;s traffic, on the last 100 m of its ways in and on it. Click a column to sort, a row to go there.</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="pb-1 text-left font-normal">
              <button type="button" title="Sort by name (again: the other way)" onClick={() => sortBy("name")} className={cn("hover:text-foreground", by === "name" && "font-semibold text-foreground")}>Junction{arrow("name")}</button>
            </th>
            {COLS.map(c => (
              <th key={c.key} className="pb-1 text-right font-normal">
                <button type="button" title={`${c.title} (again: the other way)`} onClick={() => sortBy(c.key)} className={cn("hover:text-foreground", by === c.key && "font-semibold text-foreground")}>{c.label}{arrow(c.key)}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, n).map(r => (
            <tr key={r.j.id} className="cursor-pointer border-t hover:bg-muted" onClick={() => onGo(r.j.id)}>
              <td className="max-w-24 truncate py-0.5 pr-1" title={name.get(r.j.id) ?? r.j.id}>{name.get(r.j.id) ?? r.j.id}</td>
              <td className="py-0.5 text-right font-mono tabular">{r.rate.toFixed(0)}</td>
              <td className={cn("py-0.5 text-right font-mono tabular", r.delay >= 30 && "text-amber-700 dark:text-amber-400", r.delay >= 60 && "text-destructive")}>{fmtS(r.delay)}</td>
              <td className="py-0.5 text-right font-mono tabular" title={`at most ${r.j.queueMax}`}>{r.queue.toFixed(1)}<span className="text-muted-foreground">/{r.j.queueMax}</span></td>
              <td className="py-0.5 text-right font-mono tabular">{r.fuel < 1 ? `${Math.round(r.fuel * 1000)} mL` : `${r.fuel.toFixed(1)} L`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > n && <button className="justify-self-start px-1 text-[11px] text-primary hover:underline" onClick={() => setN(x => x + 25)}>Show {Math.min(25, rows.length - n)} more ({rows.length - n} of {rows.length} junctions not shown yet)</button>}
    </InspectorPanel>
  );
}

const fmtS = (s: number) => (s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);


/** a junction's results so far, for its own panel: vehicles an hour, the delay each had, the queue, the fuel (nothing before any traffic) */
export function JunctionLine({ st, t }: { st: JunctionStats | undefined; t: number }) {
  if (!st || (!st.through && !st.queueMax)) return null;
  const delay = st.through ? st.delay / st.through : st.delay;
  return (
    <div className="grid grid-cols-4 gap-1 rounded-md border bg-muted/40 p-1.5 text-center" title="Since the cars started, on the last 100 m of its ways in and on it">
      {[
        ["veh/h", String(Math.round((st.through / Math.max(1, t)) * 3600))],
        ["delay each", fmtS(delay)],
        ["queue", `${st.queueMean.toFixed(1)}/${st.queueMax}`],
        ["fuel", st.fuel < 1 ? `${Math.round(st.fuel * 1000)} mL` : `${st.fuel.toFixed(1)} L`],
      ].map(([k, v]) => (
        <div key={k}><div className={cn("font-mono text-xs font-semibold tabular", k === "delay each" && delay >= 30 && "text-amber-700 dark:text-amber-400", k === "delay each" && delay >= 60 && "text-destructive")}>{v}</div><div className="text-[10px] text-muted-foreground">{k}</div></div>
      ))}
    </div>
  );
}
