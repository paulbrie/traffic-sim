"use client";

import { useRef } from "react";
import { Shapes, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { NumberField } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import type { Sketch } from "@/lib/lane-sketch";
import { formatArea } from "@/lib/sketch-zones";
import { MIN_OPACITY, SHAPE_BORDER, SHAPE_COLORS, shapeArea, shapeOpacity, updateShape, type SketchShape } from "@/lib/sketch-shapes";
import { useSketchStore } from "@/state/lane-sketch";
import { InspectorPanel } from "./inspector-panel";

/**
 * A shape (ticket #268): its name, fill colour (a swatch or any colour), how see-through it is, its border, and its
 * area. Typing, a colour picked in the picker and the opacity slid show as they go and become one undo step when let
 * go; a swatch or the border switched is one step at once.
 */
export function ShapePanel({ sketch, shape, readOnly, onDelete }: { sketch: Sketch; shape: SketchShape; readOnly: boolean; onDelete: () => void }) {
  const { edit, show, record } = useSketchStore();
  // (the sketch as it was when a field was entered, or a slide began: letting go makes it one undo step)
  const before = useRef<Sketch | null>(null);
  const start = () => { if (!before.current) before.current = sketch; };
  const done = () => { if (before.current) record(before.current); before.current = null; };
  const live = { onFocus: start, onBlur: done };
  const set = (patch: Parameters<typeof updateShape>[2]) => show(updateShape(sketch, shape.id, patch));
  const opacity = shapeOpacity(shape), border = shape.border;
  const swatch = "size-6 rounded-full border-2 transition-transform hover:scale-110";
  return (
    <InspectorPanel id="shape" title={`Shape ${shape.id}`} icon={<Shapes className="size-3.5 shrink-0" style={{ color: shape.color }} />}
      actions={!readOnly && <Button size="icon-sm" variant="ghost" aria-label="Delete the shape" title="Delete it (Del)" onClick={onDelete}><Trash2 /></Button>}>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Name</span>
        <Input aria-label="Shape name" value={shape.name} className="h-8" disabled={readOnly} {...live} onChange={e => set({ name: e.target.value })} />
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Colour</span>
        <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Shape colour">
          {SHAPE_COLORS.map(c => (
            <button key={c} type="button" role="radio" aria-checked={shape.color === c} aria-label={c} title={c} disabled={readOnly}
              onClick={() => edit(sk => updateShape(sk, shape.id, { color: c }))}
              className={cn(swatch, shape.color === c ? "border-foreground" : "border-transparent")} style={{ background: c }} />
          ))}
          <input type="color" aria-label="Any colour" title="Any colour" value={shape.color} disabled={readOnly} {...live}
            className={cn("h-6 w-8 cursor-pointer rounded border bg-transparent p-0", !(SHAPE_COLORS as readonly string[]).includes(shape.color) && "ring-2 ring-foreground")}
            onChange={e => { start(); set({ color: e.target.value.toLowerCase() }); }} />
        </div>
      </div>
      <div className="grid gap-1.5 text-xs">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">Opacity</span>
          <span className="font-mono tabular">{Math.round(opacity * 100)}%</span>
        </div>
        <Slider aria-label="Shape opacity" min={MIN_OPACITY * 100} max={100} step={5} value={[Math.round(opacity * 100)]} disabled={readOnly}
          onValueChange={([v]) => { start(); set({ opacity: v / 100 }); }} onValueCommit={done} />
      </div>
      <div className="grid gap-1.5 text-xs">
        <label className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Border</span>
          <Switch aria-label="Border" checked={!!border} disabled={readOnly} onCheckedChange={on => edit(sk => updateShape(sk, shape.id, { border: on ? { ...SHAPE_BORDER } : null }))} />
        </label>
        {border && (
          <div className="grid grid-cols-[auto_1fr] items-end gap-2">
            <input type="color" aria-label="Border colour" title="Border colour" value={border.color} disabled={readOnly} {...live}
              className="mb-1 h-6 w-8 cursor-pointer rounded border bg-transparent p-0" onChange={e => { start(); set({ border: { ...border, color: e.target.value.toLowerCase() } }); }} />
            <NumberField id={`shape-${shape.id}-bw`} label="Width" unit="m" digits={2} value={border.width} min={0.05} max={5} step={0.05}
              onCommit={width => edit(sk => updateShape(sk, shape.id, { border: { ...border, width } }))} />
          </div>
        )}
      </div>
      <div className="flex justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Area</span>
        <span className="font-mono tabular">{formatArea(shapeArea(shape))}</span>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Drag it to move it, or a point to move that point (Shift: off the half-metre grid). Double-click its border to add a point, or a
        point to take it out. Shapes are only drawn, under the roads: the cars don&apos;t see them.
      </p>
    </InspectorPanel>
  );
}
