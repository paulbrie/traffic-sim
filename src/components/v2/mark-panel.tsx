"use client";

import { useRef, useState } from "react";
import { ClipboardCopy, MapPin, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isEnter } from "@/lib/enter-key";
import type { Sketch } from "@/lib/lane-sketch";
import { project, unproject } from "@/lib/osm/area";
import { formatLatLon, MARK_COLORS, parseCoordinates, updateMark, type SketchMark } from "@/lib/sketch-marks";
import { useSketchStore } from "@/state/lane-sketch";
import { InspectorPanel } from "./inspector-panel";

/**
 * A mark (ticket #289): its name, colour and where it is on Earth (copied, opened in Google Maps, or other
 * coordinates pasted in to move it there). Typing the name shows as it goes and is one undo step when left.
 */
export function MarkPanel({ sketch, mark, readOnly, onDelete, onMoved }: { sketch: Sketch; mark: SketchMark; readOnly: boolean; onDelete: () => void; onMoved: () => void }) {
  const { edit, show, record } = useSketchStore();
  const before = useRef<Sketch | null>(null);
  const [coords, setCoords] = useState<string | null>(null);
  const g = sketch.geo ? unproject(sketch.geo, mark.at) : null, here = g ? formatLatLon(g) : null;
  const moveTo = () => {
    const t = coords;
    setCoords(null);
    if (t === null || t.trim() === here || !sketch.geo) return;
    const to = parseCoordinates(t);
    if (!to) { toast.error("Those aren't coordinates", { description: "Latitude, longitude: 46.1347, 24.5012 (or as Google Maps copies them)." }); return; }
    const geo = sketch.geo;
    edit(sk => updateMark(sk, mark.id, { at: project(geo, to.lat, to.lon) }));
    onMoved();
  };
  const swatch = "size-6 rounded-full border-2 transition-transform motion-safe:hover:scale-110";
  return (
    <InspectorPanel id="mark" title={`Mark ${mark.id}`} icon={<MapPin className="size-3.5 shrink-0" style={{ color: mark.color }} />}
      actions={!readOnly && <Button size="icon-sm" variant="ghost" aria-label="Delete the mark" title="Delete it (Del)" onClick={onDelete}><Trash2 /></Button>}>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Name</span>
        <Input aria-label="Mark name" value={mark.name} className="h-8" disabled={readOnly}
          onFocus={() => { before.current = sketch; }} onBlur={() => { if (before.current) record(before.current); before.current = null; }}
          onChange={e => show(updateMark(sketch, mark.id, { name: e.target.value }))}
          onKeyDown={e => { if (isEnter(e)) e.currentTarget.blur(); }} />
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Colour</span>
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Mark colour">
          {MARK_COLORS.map(c => (
            <button key={c} type="button" role="radio" aria-checked={mark.color === c} aria-label={c} title={c} disabled={readOnly}
              onClick={() => edit(sk => updateMark(sk, mark.id, { color: c }))}
              className={cn(swatch, mark.color === c ? "border-foreground" : "border-transparent")} style={{ background: c }} />
          ))}
        </div>
      </div>
      {g && here ? (
        <div className="grid gap-1 text-xs">
          <span className="text-muted-foreground">Coordinates</span>
          <Input aria-label="Mark coordinates" value={coords ?? here} disabled={readOnly} className="h-8 font-mono text-xs tabular"
            title="Paste or type other coordinates and press Enter to move the mark there"
            onFocus={e => { setCoords(here); e.currentTarget.select(); }} onChange={e => setCoords(e.target.value)} onBlur={moveTo}
            onKeyDown={e => { e.stopPropagation(); if (isEnter(e)) e.currentTarget.blur(); if (e.key === "Escape") { setCoords(null); e.currentTarget.blur(); } }} />
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" className="h-7 flex-1 text-xs"
              onClick={() => void navigator.clipboard.writeText(here).then(() => toast.success("Coordinates copied", { description: here }), () => toast.error("Couldn't copy"))}>
              <ClipboardCopy /> Copy
            </Button>
            <Button size="sm" variant="outline" className="h-7 flex-1 text-xs" asChild>
              <a href={`https://www.google.com/maps/search/?api=1&query=${g.lat.toFixed(6)},${g.lon.toFixed(6)}`} target="_blank" rel="noopener noreferrer"><MapPin /> Google Maps</a>
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">The plan isn&apos;t placed on the map: no coordinates.</p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Drag it to move it. Paste coordinates anywhere on the map (Ctrl/Cmd+V) for another mark. Marks are only drawn: the cars don&apos;t see them.
      </p>
    </InspectorPanel>
  );
}
