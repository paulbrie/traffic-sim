"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/** the panels folded away, by id: kept in this browser */
const CLOSED_KEY = "trafficsim:v2-closed-panels";
let closedCache: Record<string, true> | null = null;
function closedPanels(): Record<string, true> {
  if (closedCache) return closedCache;
  try { closedCache = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? "{}") as Record<string, true>; } catch { closedCache = {}; }
  return closedCache;
}

/**
 * A panel of the V2 editor's inspector that folds away under its title, as V1's inspector sections do: a
 * click on the title opens or closes it, and which are closed is remembered in this browser (by `id`, so a
 * panel whose title changes with the selection stays as it was left). Open until closed. `actions`: buttons
 * beside the title (closing a car, deleting), outside the fold toggle.
 */
export function InspectorPanel({ id, title, icon, actions, className, children }: {
  id: string; title: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string; children: React.ReactNode;
}) {
  const [, redraw] = useState(0);
  const open = typeof window === "undefined" || !closedPanels()[id];
  const toggle = () => {
    const all = closedPanels();
    if (open) all[id] = true; else delete all[id];
    try { localStorage.setItem(CLOSED_KEY, JSON.stringify(all)); } catch { /* private mode: just this session */ }
    redraw(x => x + 1);
  };
  return (
    <section className={cn("grid grid-cols-[minmax(0,1fr)] border-b px-3", open ? "gap-2 pt-1.5 pb-3" : "py-0.5", className)} aria-label={typeof title === "string" ? title : undefined}>
      <div className="flex items-center gap-1">
        <button type="button" onClick={toggle} aria-expanded={open} title={open ? "Fold away" : "Open"}
          className="-ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1.5 text-left hover:bg-muted/60">
          <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
          {icon}
          <h3 className="truncate text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{title}</h3>
        </button>
        {actions}
      </div>
      {open && children}
    </section>
  );
}
