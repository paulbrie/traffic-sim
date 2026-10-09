"use client";

import { createContext, useContext, useRef, useState } from "react";
import { ChevronRight, Minus, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/** an object's ID, click to copy (to refer to it precisely, e.g. when reporting a problem) */
export function IdChip({ id, className }: { id: string; className?: string }) {
  return (
    <button
      type="button" title="Copy the ID"
      className={cn("min-w-0 max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-left font-mono text-[11px] font-normal tracking-normal normal-case text-muted-foreground hover:bg-accent hover:text-foreground", className)}
      onClick={e => { e.stopPropagation(); navigator.clipboard?.writeText(id).then(() => toast.success(`Copied ${id}`), () => {}); }}
    >{id}</button>
  );
}

/** Numeric input that commits on Enter / blur, with optional unit suffix. */
export function NumberField({ label, value, onCommit, unit, step = 1, min, max, digits = 2, id, className, hideLabel }: {
  label: string; value: number; onCommit: (v: number) => void; unit?: string; step?: number; min?: number; max?: number; digits?: number; id: string; className?: string;
  /** the label is for screen readers only (the field sits in a row that says what it is) */
  hideLabel?: boolean;
}) {
  const fmt = (v: number) => (Number.isFinite(v) ? String(Number(v.toFixed(digits))) : "");
  // while editing we keep the raw text; otherwise we show the live value
  const [draft, setDraft] = useState<string | null>(null);
  // (a draft is committed once: Enter commits and then blurs, and the blur would commit it again before the field is
  // shown anew, one change made two undo steps)
  const committed = useRef(false);
  const text = draft ?? fmt(value);
  const commit = () => {
    const v = Number((draft ?? "").replace(",", "."));
    setDraft(null);
    if (draft === null || committed.current || !Number.isFinite(v)) return;
    committed.current = true;
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    if (c !== value) onCommit(c);
  };
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id} className={cn("text-xs text-muted-foreground", hideLabel && "sr-only")}>{label}</Label>
      <div className="relative">
        <Input
          id={id} inputMode="decimal" value={text} step={step}
          onFocus={() => { committed.current = false; setDraft(fmt(value)); }}
          onChange={e => { committed.current = false; setDraft(e.target.value); }}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === "Enter") { commit(); (e.target as HTMLInputElement).blur(); }
            if (e.key === "Escape") { setDraft(null); (e.target as HTMLInputElement).blur(); }
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
              const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, (Number(text) || 0) + d));
              setDraft(fmt(c)); onCommit(c);
            }
          }}
          className={cn("h-8 font-mono text-sm tabular", unit && "pr-9")}
        />
        {unit && <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-muted-foreground">{unit}</span>}
      </div>
    </div>
  );
}

/** − n + stepper for small integers (lanes). */
export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <Button type="button" variant="outline" size="icon-sm" className="size-7" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label={`Fewer ${label}`}><Minus /></Button>
      <span className="w-6 text-center font-mono text-sm tabular" aria-live="polite">{value}</span>
      <Button type="button" variant="outline" size="icon-sm" className="size-7" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label={`More ${label}`}><Plus /></Button>
    </div>
  );
}

/** sections under this provider fold away under their title (the inspector), remembering which are open */
export const CollapsibleSections = createContext(false);
const OPEN_KEY = "trafficsim:open-sections";
let openCache: Record<string, true> | null = null;
function openSections(): Record<string, true> {
  if (openCache) return openCache;
  try { openCache = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, true>; } catch { openCache = {}; }
  return openCache;
}

export function Section({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  const collapsible = useContext(CollapsibleSections) && !!title;
  // collapsed unless it was left open last time (kept in this browser, by section title; read on every
  // render, since the same component may show another section after the selection changes)
  const [, redraw] = useState(0);
  const open = !collapsible || (typeof window !== "undefined" && !!openSections()[title!]);
  if (!collapsible) {
    return (
      <section className={cn("grid gap-3 border-b px-4 py-4 last:border-b-0", className)}>
        {title && <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>}
        {children}
      </section>
    );
  }
  const toggle = () => {
    const next = !open, all = openSections();
    if (next) all[title!] = true; else delete all[title!];
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(all)); } catch { /* private mode: just this session */ }
    redraw(x => x + 1);
  };
  return (
    <section className={cn("grid border-b px-4 last:border-b-0", open ? "gap-3 pt-3 pb-4" : "py-1", className)}>
      <button type="button" onClick={toggle} aria-expanded={open} className="-mx-1 flex items-center gap-1.5 rounded px-1 py-2 text-left hover:bg-muted/60">
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
      </button>
      {open && children}
    </section>
  );
}

export const compass = (dx: number, dy: number) => {
  const deg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return { deg, name: names[Math.round(deg / 45) % 8] };
};
