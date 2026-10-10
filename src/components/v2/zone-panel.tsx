"use client";

import { useRef } from "react";
import { Pentagon, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { Sketch } from "@/lib/lane-sketch";
import { formatArea, updateZone, ZONE_COLORS, zoneArea, type SketchZone } from "@/lib/sketch-zones";
import { useSketchStore } from "@/state/lane-sketch";
import { InspectorPanel } from "./inspector-panel";

/**
 * A zone (T129): its name (the label on the map), colour, note and area. Typing shows as it goes and
 * becomes one undo step when the field is left; a colour is one step at once.
 */
export function ZonePanel({ sketch, zone, readOnly, onDelete }: { sketch: Sketch; zone: SketchZone; readOnly: boolean; onDelete: () => void }) {
  const { edit, show, record } = useSketchStore();
  // (the sketch as it was when a field was entered: leaving it makes the typing one undo step)
  const before = useRef<Sketch | null>(null);
  const typing = {
    onFocus: () => { before.current = sketch; },
    onBlur: () => { if (before.current) record(before.current); before.current = null; },
  };
  return (
    <InspectorPanel id="zone" title={`Zone ${zone.id}`} icon={<Pentagon className="size-3.5 shrink-0" style={{ color: zone.color }} />}
      actions={!readOnly && <Button size="icon-sm" variant="ghost" aria-label="Delete the zone" title="Delete it (Del)" onClick={onDelete}><Trash2 /></Button>}>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Name (its label on the map)</span>
        <Input aria-label="Zone name" value={zone.name} className="h-8" disabled={readOnly} {...typing}
          onChange={e => show(updateZone(sketch, zone.id, { name: e.target.value }))} />
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Colour</span>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Zone colour">
          {ZONE_COLORS.map(c => (
            <button key={c} type="button" role="radio" aria-checked={zone.color === c} aria-label={c} title={c} disabled={readOnly}
              onClick={() => edit(sk => updateZone(sk, zone.id, { color: c }))}
              className={cn("size-6 rounded-full border-2 transition-transform hover:scale-110", zone.color === c ? "border-foreground" : "border-transparent")}
              style={{ background: c }} />
          ))}
        </div>
      </div>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Note</span>
        <Textarea aria-label="Zone note" value={zone.note ?? ""} rows={3} className="text-xs" disabled={readOnly} {...typing}
          placeholder="What this area is, who it's for…" onChange={e => show(updateZone(sketch, zone.id, { note: e.target.value }))} />
      </label>
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Area</span>
        <span className="font-mono tabular">{formatArea(zoneArea(zone.outline))}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Drag it to move it, or a corner to move that corner (Shift: off the half-metre grid). Double-click its border to add a corner, or a
        corner to take it out. Zones are for reading the plan: the cars don&apos;t see them.
      </p>
    </InspectorPanel>
  );
}
