"use client";

import { useMemo, useState } from "react";
import { ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Sketch } from "@/lib/lane-sketch";
import type { SimStats } from "@/lib/lane-sketch-sim";
import { cn } from "@/lib/utils";
import { roadNames } from "./compass-names";
import { InspectorPanel } from "./inspector-panel";

/** a road's results as the sim keeps them (see `RoadStats` in lane-sketch-sim.ts) */
interface RoadRow { id: string; through: number; vehKm: number; vehHours: number; delay: number; queueMax: number }
type Key = "rate" | "speed" | "delay" | "queue";
const COLS: { key: Key; label: string; title: string }[] = [
  { key: "rate", label: "veh/h", title: "Vehicles onto it an hour (so far)" },
  { key: "speed", label: "km/h", title: "Their mean speed on it (distance driven over time spent)" },
  { key: "delay", label: "delay", title: "Time each vehicle lost on it, on average (against driving at the speed it wants)" },
  { key: "queue", label: "queue", title: "The most vehicles standing on it at once" },
];

/**
 * Each road's results while the cars run, as V1's data tables (the junctions' beside it): vehicles onto it an hour,
 * their mean speed, the delay each had on it, its longest queue; sorted by any of them (slowest first by default);
 * a click takes the view to the road.
 */
export function RoadResults({ sketch, stats, onGo }: { sketch: Sketch; stats: SimStats; onGo: (id: string) => void }) {
  // (by a column, the most first (speed: the slowest); again, the other way; by name, A to Z first)
  const [{ by, flip }, setSort] = useState<{ by: Key | "name"; flip: boolean }>({ by: "delay", flip: false });
  const sortBy = (k: Key | "name") => setSort(s => ({ by: k, flip: s.by === k ? !s.flip : false }));
  const [n, setN] = useState(12);
  const name = useMemo(() => roadNames(sketch), [sketch]);
  const list = (stats as SimStats & { roads?: RoadRow[] }).roads;
  if (!list?.length) return null;
  const t = Math.max(1, stats.t);
  const rows = list.filter(r => r.through > 0).map(r => ({
    r, rate: (r.through / t) * 3600, speed: r.vehHours > 0 ? r.vehKm / r.vehHours : 0, delay: r.delay / r.through, queue: r.queueMax,
  }));
  if (!rows.length) return null;
  // (speed: the slowest first; the others, the most first)
  rows.sort((a, b) => {
    const d = by === "name" ? (name.get(a.r.id) ?? a.r.id).localeCompare(name.get(b.r.id) ?? b.r.id, undefined, { numeric: true }) : by === "speed" ? a.speed - b.speed : b[by] - a[by];
    return flip ? -d : d;
  });
  const arrow = (k: Key | "name") => (by !== k ? "" : (k === "name" || k === "speed") !== flip ? " ↑" : " ↓");
  const csv = () => {
    const head = "road,id,vehicles per hour,through,mean speed (km/h),mean delay (s),vehicle-km,queue max";
    const lines = rows.map(x => [JSON.stringify(name.get(x.r.id) ?? x.r.id), x.r.id, x.rate.toFixed(0), x.r.through, x.speed.toFixed(1), x.delay.toFixed(1), x.r.vehKm.toFixed(2), x.r.queueMax].join(","));
    void navigator.clipboard.writeText([head, ...lines].join("\n")).then(() => toast.success("Road results copied", { description: `${rows.length} roads, as CSV (paste into a spreadsheet).` }), () => toast.error("Couldn't copy"));
  };
  return (
    <InspectorPanel id="road-results" title="Roads"
      actions={<Button size="icon-sm" variant="ghost" aria-label="Copy the roads' results as CSV" title="Copy as CSV" onClick={csv}><ClipboardCopy className="size-3.5" /></Button>}>
      <p className="text-[11px] text-muted-foreground">Since the cars started ({Math.floor(t / 60)} min): each road&apos;s traffic over all its lanes. Click a column to sort, a row to go there.</p>
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="pb-1 text-left font-normal">
              <button type="button" title="Sort by name (again: the other way)" onClick={() => sortBy("name")} className={cn("hover:text-foreground", by === "name" && "font-semibold text-foreground")}>Road{arrow("name")}</button>
            </th>
            {COLS.map(c => (
              <th key={c.key} className="pb-1 text-right font-normal">
                <button type="button" title={`${c.title} (again: the other way)`} onClick={() => sortBy(c.key)} className={cn("hover:text-foreground", by === c.key && "font-semibold text-foreground")}>{c.label}{arrow(c.key)}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, n).map(x => (
            <tr key={x.r.id} className="cursor-pointer border-t hover:bg-muted" onClick={() => onGo(x.r.id)}>
              <td className="max-w-24 truncate py-0.5 pr-1" title={name.get(x.r.id) ?? x.r.id}>{name.get(x.r.id) ?? x.r.id}</td>
              <td className="py-0.5 text-right font-mono tabular">{x.rate.toFixed(0)}</td>
              <td className={cn("py-0.5 text-right font-mono tabular", x.speed < 15 && "text-amber-700 dark:text-amber-400", x.speed < 5 && "text-destructive")}>{x.speed.toFixed(0)}</td>
              <td className={cn("py-0.5 text-right font-mono tabular", x.delay >= 30 && "text-amber-700 dark:text-amber-400", x.delay >= 60 && "text-destructive")}>{fmtS(x.delay)}</td>
              <td className="py-0.5 text-right font-mono tabular">{x.queue}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > n && <button className="justify-self-start px-1 text-[11px] text-primary hover:underline" onClick={() => setN(k => k + 25)}>Show {Math.min(25, rows.length - n)} more ({rows.length - n} of {rows.length} roads not shown yet)</button>}
    </InspectorPanel>
  );
}

const fmtS = (s: number) => (s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)} s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
