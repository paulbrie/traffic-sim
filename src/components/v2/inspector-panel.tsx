"use client";

import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useUiPath } from "@/state/sketch-ui";

/**
 * A panel of the V2 editor's inspector that folds away under its title, as V1's inspector sections do: a
 * click on the title opens or closes it, and which are closed is remembered in this browser (in the V2 UI store, by `id`, so a
 * panel whose title changes with the selection stays as it was left). Open until closed. `actions`: buttons
 * beside the title (closing a car, deleting), outside the fold toggle.
 */
export function InspectorPanel({ id, title, icon, actions, className, children }: {
  id: string; title: React.ReactNode; icon?: React.ReactNode; actions?: React.ReactNode; className?: string; children: React.ReactNode;
}) {
  // (which are folded away: in the V2 UI store, kept in this browser)
  const [closed, setClosed] = useUiPath<Record<string, true>>("panels/closed");
  const open = !closed[id];
  const toggle = () => setClosed(c => { const next = { ...c }; if (open) next[id] = true; else delete next[id]; return next; });
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
