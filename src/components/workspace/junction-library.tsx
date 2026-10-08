"use client";

import { useState } from "react";
import { Shapes, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { deleteFromJunctionLibrary, listJunctionLibrary, type LibraryItem } from "@/server/actions";
import { startPlacing } from "@/state/placing";

/**
 * The junction library (top bar): junctions saved with the user's account, to place in any of their plans.
 * Picking one starts placing it: it follows the pointer, R turns it, a click puts it down, joined to the roads
 * it lands on.
 */
export function JunctionLibrary() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const r = await listJunctionLibrary().catch(() => ({ ok: false as const, error: "Couldn't load the junction library." }));
    if (r.ok) { setItems(r.items); setError(null); } else setError(r.error);
  };
  const remove = async (it: LibraryItem) => {
    const r = await deleteFromJunctionLibrary(it.id).catch(() => ({ ok: false as const, error: "Couldn't delete it." }));
    if (r.ok) setItems(xs => xs?.filter(x => x.id !== it.id) ?? null); else toast.error(r.error);
  };
  const stats = (it: LibraryItem) => {
    const n = it.piece.net, ends = n.nodes.filter(p => n.links.filter(l => l.from === p.id || l.to === p.id).length === 1).length;
    return `${n.links.length} roads · ${ends} entry / exit point${ends === 1 ? "" : "s"}`;
  };
  return (
    <DropdownMenu onOpenChange={open => { if (open) void load(); }}>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8" title="Your junction library: place a saved junction"><Shapes /> Junctions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel>Your junction library</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {error && <p className="px-2 py-2 text-xs text-destructive">{error}</p>}
        {!error && !items && <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>}
        {items?.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            Nothing saved yet. Select a junction group (or select roads and make one), then “Save to library” in the inspector.
          </p>
        )}
        {items?.map(it => (
          <DropdownMenuItem key={it.id} className="flex items-center gap-2" onSelect={() => { startPlacing(it.piece); toast.info(`Placing ${it.name}`, { description: "Click to put it down (it joins the roads it lands on) · R turns it · Esc cancels." }); }}>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{it.name}</div>
              <div className="text-[11px] text-muted-foreground">{stats(it)}</div>
            </div>
            <Button size="icon-sm" variant="ghost" className="shrink-0 text-muted-foreground hover:text-destructive" aria-label={`Delete ${it.name} from the library`}
              onClick={e => { e.preventDefault(); e.stopPropagation(); void remove(it); }}><Trash2 /></Button>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">⌘C / ⌘V copies a selected junction within and between plans.</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
