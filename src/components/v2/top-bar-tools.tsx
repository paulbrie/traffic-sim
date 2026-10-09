"use client";

/**
 * A V2 plan's top bar tools: the layers picker (as on V1 plans) and the frame rate, with the speed the
 * cars actually run at while they run.
 */
import { useEffect, useState } from "react";
import { useSubject } from "subjecto/react";
import { ChevronDown, Layers, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ALL_SKETCH_LAYERS, SKETCH_LAYERS, setSketchEditing, setSketchLayers, sketchEditing$, sketchLayers$, toggleSketchLayer, type SketchLayers } from "@/state/sketch-layers";
import { sketchSim } from "@/state/lane-sketch";

/** the Sketch button, as V1's: pressed, the editor draws (tools, structure, editing); not, it only shows the map and the cars */
export function SketchModeButton() {
  const [editing] = useSubject(sketchEditing$);
  return (
    <Button size="sm" variant={editing ? "secondary" : "ghost"} className="h-8" aria-pressed={editing} onClick={() => setSketchEditing(!editing)}
      title={editing ? "Sketch: drawing lanes, connectors and junctions. Click to only view the map and the cars" : "Viewing the map and the cars. Click to sketch: draw and edit lanes, connectors and junctions"}>
      <PenLine /> Sketch
    </Button>
  );
}

export function SketchLayerPicker() {
  const [layers] = useSubject(sketchLayers$);
  const on = SKETCH_LAYERS.filter(l => layers[l.id]), all = on.length === SKETCH_LAYERS.length;
  const label = all ? "All layers" : on.length === 0 ? "No layers" : on.length === 1 ? on[0].label : `${on.length} layers`;
  // (the menu stays open while switching layers on and off)
  const keep = (e: Event) => e.preventDefault();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-44 justify-start font-normal" aria-label={`Layers: what the map shows (${label})`}>
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-left">{label}</span>
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuCheckboxItem checked={all} onSelect={keep}
          onCheckedChange={() => setSketchLayers(all ? (Object.fromEntries(SKETCH_LAYERS.map(l => [l.id, false])) as SketchLayers) : ALL_SKETCH_LAYERS)}>
          All layers
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {SKETCH_LAYERS.map(l => (
          <DropdownMenuCheckboxItem key={l.id} className="group" checked={layers[l.id]} title={l.hint} onCheckedChange={() => toggleSketchLayer(l.id)} onSelect={keep}>
            <span className={cn(l.id === "markings" && !layers.surfaces && "text-muted-foreground")}>{l.label}</span>
            <button type="button" className="ml-auto rounded px-1 text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus:opacity-100 hover:bg-background hover:text-foreground"
              onClick={e => { e.stopPropagation(); e.preventDefault(); toggleSketchLayer(l.id, true); }} aria-label={`Only ${l.label}`}>only</button>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Only the layers that are on are drawn. Markings show on the road surfaces only.</DropdownMenuLabel>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** frames the page draws a second (counted over half a second), and while the cars run, how fast they really run */
export function FrameRate() {
  const [fps, setFps] = useState<number | null>(null), [rate, setRate] = useState(0), [updates, setUpdates] = useState(0);
  useEffect(() => {
    let raf = 0, n = 0, since = performance.now();
    const tick = (now: number) => {
      n++;
      if (now - since >= 500) { setFps(Math.round((n * 1000) / (now - since))); n = 0; since = now; setRate(sketchSim()?.rate ?? 0); setUpdates(sketchSim()?.updates ?? 0); }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  if (fps === null) return null;
  return (
    <span className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground tabular" title="Frames the page draws a second (under 30: something is slow); while the cars run, simulated seconds per real second">
      <span className={cn(fps < 30 && "text-amber-700 dark:text-amber-400", fps < 15 && "text-destructive")}>{fps} fps</span>
      {rate > 0 && <span title="Simulated seconds per real second, and how often a second the cars' places come from the simulation (between them they are drawn on their way)">cars ×{rate.toFixed(1)} · {Math.round(updates)}/s</span>}
    </span>
  );
}
