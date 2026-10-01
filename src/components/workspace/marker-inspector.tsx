"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { USE_LABEL } from "@/engine/buildings";
import { DEFAULT_MARKER_COLOR, markerBase } from "@/engine/markers";
import type { MarkerDef, Network } from "@/engine/types";
import { commit, select } from "@/state/store";
import * as ops from "@/state/ops";
import { cn } from "@/lib/utils";
import { IdChip, NumberField, Section } from "./fields";

const COLORS = ["#e11d48", "#ea580c", "#ca8a04", "#16a34a", "#0891b2", "#2563eb", "#7c3aed", "#475569"];

/** a marker on the map: its label, colour, where it is (and on what it stands: a building's roof, or the ground) */
export function MarkerInspector({ net, m }: { net: Network; m: MarkerDef }) {
  const set = (patch: Partial<Omit<MarkerDef, "id">>, key?: string) => commit(ops.updateMarker(net, m.id, patch), key);
  const base = markerBase(net, m), col = m.color ?? DEFAULT_MARKER_COLOR;
  return (
    <div>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"><span className="shrink-0">Marker</span><IdChip id={m.id} /></div>
          <div className="truncate font-medium">{m.label || "Marker"}</div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Delete marker" onClick={() => { commit(ops.deleteMarker(net, m.id)); select(null); }}><Trash2 /></Button>
      </div>
      <Section>
        <div className="grid gap-1.5">
          <Label htmlFor="mlabel" className="text-xs text-muted-foreground">Label</Label>
          <Input id="mlabel" key={`${m.id}:${m.label}`} className="h-8" defaultValue={m.label} placeholder="What is here…" maxLength={120}
            onBlur={e => e.target.value !== m.label && set({ label: e.target.value })} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
        <div className="grid gap-1.5">
          <span className="text-xs text-muted-foreground">Colour</span>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Marker colour">
            {COLORS.map(c => (
              <button key={c} type="button" aria-label={c} aria-pressed={c === col} onClick={() => set({ color: c === DEFAULT_MARKER_COLOR ? undefined : c })}
                className={cn("size-6 rounded-full border-2", c === col ? "border-foreground" : "border-transparent")} style={{ background: c }} />
            ))}
            <input type="color" aria-label="Other colour" className="h-6 w-8 cursor-pointer rounded border bg-transparent" value={col} onChange={e => set({ color: e.target.value }, `mcol:${m.id}`)} />
          </div>
        </div>
      </Section>
      <Section title="Position">
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="mx" label="X (east)" unit="m" value={m.x} onCommit={x => set({ x }, `mx:${m.id}`)} />
          <NumberField id="my" label="Y (south)" unit="m" value={m.y} onCommit={y => set({ y }, `my:${m.id}`)} />
        </div>
        <p className="text-xs text-muted-foreground">
          {base.building
            ? <>On the roof of {base.building.name || USE_LABEL[base.building.use].toLowerCase()} ({base.building.height.toFixed(0)} m up in 3D). <button type="button" className="underline-offset-2 hover:underline" onClick={() => select({ kind: "building", id: base.building!.id })}>Open the building</button></>
            : "On the ground. Placed on a building, it stands on its roof in 3D."}
        </p>
      </Section>
    </div>
  );
}
