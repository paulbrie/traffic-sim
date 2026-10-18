"use client";

/**
 * Bus lines (T21, as v1's): each a loop of bus stops, a colour on the map, and how many buses run on it at
 * once. Put bus stops with the Bus stop tool, then add them here in order. A line needs at least two stops
 * before buses run.
 */
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { addBusLine, BUS_LINE_COLORS, deleteBusLine, updateBusLine, type Sketch, type SketchBusLine } from "@/lib/lane-sketch";
import { useSketchStore } from "@/state/lane-sketch";
import { InspectorPanel } from "./inspector-panel";

export function BusLinesPanel({ sketch, readOnly, onFocus, onPick }: {
  sketch: Sketch; readOnly: boolean;
  /** hovering a line: the stops it highlights */
  onFocus?: (stops: string[] | null) => void;
  /** click a stop in the list: select and centre on it */
  onPick?: (stop: string) => void;
}) {
  const { edit: editSketch } = useSketchStore();
  const lines = sketch.busLines ?? [], stops = sketch.stops ?? [];
  if (!lines.length && !stops.length) return null;
  const set = (l: SketchBusLine, patch: Partial<Omit<SketchBusLine, "id">>) => editSketch(sk => updateBusLine(sk, l.id, patch));
  return (
    <InspectorPanel id="bus-lines" title="Bus lines">
      <p className="text-[11px] text-muted-foreground">Each a loop of bus stops; buses run it in order, back to the first after the last.</p>
      {lines.map(l => {
        const unused = stops.filter(s => !l.stops.includes(s.id));
        return (
          <div key={l.id} className="grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border p-2" onMouseEnter={() => onFocus?.(l.stops)} onMouseLeave={() => onFocus?.(null)}>
            <div className="flex items-center gap-1.5">
              <Input aria-label={`Line ${l.id} name`} value={l.name} disabled={readOnly} className="h-7 min-w-0 flex-1 text-xs" onChange={e => set(l, { name: e.target.value })} />
              {!readOnly && <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Delete line ${l.id}`} title="Delete this line" onClick={() => editSketch(sk => deleteBusLine(sk, l.id))}><Trash2 className="size-3.5" /></Button>}
            </div>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={`${l.name} colour`}>
              {BUS_LINE_COLORS.map(c => (
                <button key={c} type="button" role="radio" aria-checked={l.color === c} aria-label={c} title={c} disabled={readOnly} onClick={() => set(l, { color: c })}
                  className="size-5 rounded-full border-2 transition-transform hover:scale-110" style={{ background: c, borderColor: l.color === c ? "var(--foreground)" : "transparent" }} />
              ))}
            </div>
            <label className="flex items-center gap-2 text-xs">
              <span className="w-10 shrink-0 text-muted-foreground">Buses</span>
              <Slider aria-label={`${l.name} buses`} value={[l.buses]} min={0} max={20} step={1} disabled={readOnly} className="flex-1" onValueChange={([v]) => set(l, { buses: v })} />
              <span className="w-5 shrink-0 text-right font-mono tabular">{l.buses}</span>
            </label>
            <div className="grid gap-1">
              <span className="text-[11px] text-muted-foreground">Stops, in order</span>
              {l.stops.map((id, i) => {
                const stop = stops.find(s => s.id === id);
                return (
                  <div key={id} className="flex items-center gap-1 text-xs">
                    <span className="w-4 shrink-0 text-right text-muted-foreground tabular">{i + 1}</span>
                    <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline disabled:pointer-events-none" disabled={!stop} onClick={() => stop && onPick?.(stop.id)}>
                      {stop?.name ?? "a stop that's gone"}
                    </button>
                    {!readOnly && (
                      <>
                        <Button variant="ghost" size="icon" className="size-6 shrink-0" disabled={i === 0} aria-label="Move earlier"
                          onClick={() => { const next = [...l.stops]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; set(l, { stops: next }); }}>↑</Button>
                        <Button variant="ghost" size="icon" className="size-6 shrink-0" disabled={i === l.stops.length - 1} aria-label="Move later"
                          onClick={() => { const next = [...l.stops]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; set(l, { stops: next }); }}>↓</Button>
                        <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label="Remove from the line" onClick={() => set(l, { stops: l.stops.filter(x => x !== id) })}><Trash2 className="size-3" /></Button>
                      </>
                    )}
                  </div>
                );
              })}
              {!readOnly && unused.length > 0 && (
                <Select value="" disabled={readOnly} onValueChange={id => set(l, { stops: [...l.stops, id] })}>
                  <SelectTrigger size="sm" className="h-7 text-xs" aria-label={`Add a stop to ${l.name}`}><SelectValue placeholder="Add a stop…" /></SelectTrigger>
                  <SelectContent>{unused.map(s => <SelectItem key={s.id} value={s.id} className="text-xs">{s.name}</SelectItem>)}</SelectContent>
                </Select>
              )}
              {l.stops.length < 2 && <p className="text-[11px] text-amber-700 dark:text-amber-500">Needs at least two stops before buses run.</p>}
            </div>
          </div>
        );
      })}
      {!readOnly && (
        <Button variant="outline" size="sm" className="h-7 justify-self-start" onClick={() => editSketch(sk => addBusLine(sk)[0])}>
          <Plus /> Add a bus line
        </Button>
      )}
    </InspectorPanel>
  );
}
