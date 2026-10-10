"use client";

/**
 * A V2 plan's top bar tools: the layers picker (as on V1 plans), the frame rate, with the speed the
 * cars actually run at while they run, and the page's memory.
 */
import { useEffect, useState } from "react";
import { useSubject } from "subjecto/react";
import { ChevronDown, Layers } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ALL_SKETCH_LAYERS, SKETCH_LAYERS, setSketchLayers, sketchLayers$, toggleSketchLayer, type SketchLayer, type SketchLayers } from "@/state/sketch-layers";
import { sketchSim } from "@/state/lane-sketch";

/** the keys of the layers, in the menu's order: 1–9, then 0 (the rest have none) */
const LAYER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const keyOf = (id: SketchLayer) => { const i = SKETCH_LAYERS.findIndex(l => l.id === id); return i >= 0 && i < LAYER_KEYS.length ? LAYER_KEYS[i] : null; };
const KEYS_HINT = "Shift+L opens this · 1–9, 0: a layer on or off · Shift+digit: that layer only · ` (backtick): all on or off";
/** what changed, said once (a toast replaced, not one for each key) */
const say = (text: string) => { toast(text, { id: "sketch-layers", duration: 1500 }); };

/** all the layers on, or (all on already) all off */
function allOnOff() {
  const cur = sketchLayers$.getValue(), all = SKETCH_LAYERS.every(l => cur[l.id]);
  setSketchLayers(all ? (Object.fromEntries(SKETCH_LAYERS.map(l => [l.id, false])) as SketchLayers) : ALL_SKETCH_LAYERS);
  say(all ? "All layers off" : "All layers on");
}

export function SketchLayerPicker() {
  const [layers] = useSubject(sketchLayers$);
  const [open, setOpen] = useState(false);
  const on = SKETCH_LAYERS.filter(l => layers[l.id]), all = on.length === SKETCH_LAYERS.length;
  const label = all ? "All layers" : on.length === 0 ? "No layers" : on.length === 1 ? on[0].label : `${on.length} layers`;
  // (the menu stays open while switching layers on and off)
  const keep = (e: Event) => e.preventDefault();
  // the keys, on the page (before the editor's own: Shift+L would be its lane tool): not while typing, in a dialog or
  // another menu, nor with Ctrl, Cmd or Alt (the browser's and the editor's)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
      // (any dialog open — the search box, a settings dialog — but the windows one works beside: the sketch window, the bridge's panel)
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(d => d.getAttribute("aria-label") !== "Lane sketch" && !d.closest("[data-bridge-ui]") && (d as HTMLElement).offsetParent !== null);
      if (dialogs.length) return;
      const menu = t?.closest('[role="menu"]');
      if (menu && !menu.hasAttribute("data-layers-menu")) return;
      if (e.code === "KeyL" && e.shiftKey) { e.preventDefault(); e.stopPropagation(); setOpen(true); return; }
      if (e.code === "Backquote" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); allOnOff(); return; }
      const digit = /^Digit([0-9])$/.exec(e.code)?.[1], i = digit === undefined ? -1 : LAYER_KEYS.indexOf(digit), l = SKETCH_LAYERS[i];
      if (!l) return;
      e.preventDefault(); e.stopPropagation();
      toggleSketchLayer(l.id, e.shiftKey);
      say(e.shiftKey ? `Only ${l.label}` : `${l.label} ${sketchLayers$.getValue()[l.id] ? "on" : "off"}`);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 w-44 justify-start font-normal" aria-label={`Layers: what the map shows (${label})`} title={`What the map shows · ${KEYS_HINT}`}>
          <Layers className="size-3.5 text-muted-foreground" />
          <span className="flex-1 text-left">{label}</span>
          <ChevronDown className="size-4 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" data-layers-menu>
        <DropdownMenuCheckboxItem checked={all} onSelect={keep} onCheckedChange={allOnOff}>
          All layers
          <kbd className="ml-auto rounded border px-1 font-mono text-[10px] text-muted-foreground">`</kbd>
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {SKETCH_LAYERS.map(l => (
          <DropdownMenuCheckboxItem key={l.id} className="group" checked={layers[l.id]} title={l.hint} onCheckedChange={() => toggleSketchLayer(l.id)} onSelect={keep}>
            <span className={cn(l.id === "markings" && !layers.surfaces && "text-muted-foreground")}>{l.label}</span>
            <span className="ml-auto flex items-center gap-1">
              {keyOf(l.id) && <kbd className="rounded border px-1 font-mono text-[10px] text-muted-foreground" title={`${keyOf(l.id)}: on or off · Shift+${keyOf(l.id)}: only this`}>{keyOf(l.id)}</kbd>}
              <button type="button" className="rounded px-1 text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus:opacity-100 hover:bg-background hover:text-foreground"
                onClick={e => { e.stopPropagation(); e.preventDefault(); toggleSketchLayer(l.id, true); }} aria-label={`Only ${l.label}`}>only</button>
            </span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Only the layers that are on are drawn. Markings show on the road surfaces only. {KEYS_HINT}.</DropdownMenuLabel>
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

/** Chrome's and Edge's own measure of the page's JavaScript memory (none in Safari or Firefox) */
type HeapInfo = { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
const heapNow = () => (performance as Performance & { memory?: HeapInfo }).memory ?? null;
/** how often the memory is read (ms), and where it turns amber and red (MB) */
const MEMORY_EVERY = 3000, MEMORY_AMBER = 1024, MEMORY_RED = 2048;

/**
 * The page's JavaScript memory (MB), read every 3 s while the tab is shown: amber over 1 GB, red over 2 GB (save and
 * reload, before the tab runs out). Only in browsers that tell it (Chrome, Edge: performance.memory); elsewhere nothing
 * is shown (measureUserAgentSpecificMemory would need the page cross-origin isolated, which it isn't).
 */
export function MemoryGauge() {
  const [m, setM] = useState<{ used: number; total: number; limit: number } | null>(null);
  useEffect(() => {
    if (!heapNow()) return;
    const mb = (b: number) => Math.round(b / 1048576);
    const read = () => {
      const h = heapNow();
      if (!h || document.hidden) return;
      const next = { used: mb(h.usedJSHeapSize), total: mb(h.totalJSHeapSize), limit: mb(h.jsHeapSizeLimit) };
      setM(was => (was && was.used === next.used && was.total === next.total && was.limit === next.limit ? was : next));
    };
    read();
    const id = setInterval(read, MEMORY_EVERY);
    // (back on the tab: read at once, not up to 3 s later)
    document.addEventListener("visibilitychange", read);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", read); };
  }, []);
  if (!m) return null;
  const red = m.used > MEMORY_RED, amber = m.used > MEMORY_AMBER;
  const gb = (x: number) => (x >= 1024 ? `${(x / 1024).toFixed(1)} GB` : `${x} MB`);
  return (
    <span className={cn("font-mono text-[11px] text-muted-foreground tabular", amber && "text-amber-700 dark:text-amber-400", red && "font-medium text-destructive")}
      title={`${red ? "Memory is high: save (⌘S) and reload the page. " : ""}The page's JavaScript memory: ${gb(m.used)} used of ${gb(m.total)} allocated (the browser's limit ${gb(m.limit)}); read every 3 s while the tab is shown. Amber over 1 GB, red over 2 GB.`}
      aria-label={`Page memory ${gb(m.used)}${red ? ", high: save and reload" : ""}`}>
      {gb(m.used)}
    </span>
  );
}
