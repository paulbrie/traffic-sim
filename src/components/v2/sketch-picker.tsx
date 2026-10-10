"use client";

/**
 * The Sketch window's sketches (T156): the one open's name, a menu of all the plan's saved sketches (each with what is
 * in it) to open one, and New, Duplicate, Rename (in place) and Delete (asked, then undoable from its message).
 */
import { useState } from "react";
import { useSubject } from "subjecto/react";
import { Check, ChevronDown, Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { contentOf, deleteSketch, duplicateSketch, emptyContent, newSketch, openSketch, renameSketch, sketchList, SKETCH_NAME_MAX } from "@/lib/sketch-list";
import type { Sketch } from "@/lib/lane-sketch";
import { changeSketches } from "@/state/lane-sketch";
import { laneSketch$ } from "@/state/store";

type View = { cx: number; cy: number; scale: number };
/** what is in a sketch, in a few words */
function what(k: Sketch | undefined) {
  if (emptyContent(k)) return "empty";
  const n = (x: number, one: string) => `${x} ${one}${x === 1 ? "" : "s"}`;
  return [n(k!.lanes.length, "lane"), k!.junctions.length ? n(k!.junctions.length, "junction") : ""].filter(Boolean).join(" · ");
}

export function SketchPicker({ view, readOnly }: { /** where the window's view is now (kept with the sketch put away) */ view: () => View; readOnly: boolean }) {
  useSubject(laneSketch$);
  const plan = laneSketch$.getValue(), { list, open } = sketchList(plan), cur = list.find(x => x.id === open)!;
  const [renaming, setRenaming] = useState<string | null>(null), [asking, setAsking] = useState(false);
  const now = () => Date.now();

  const rename = (name: string) => { setRenaming(null); changeSketches(k => renameSketch(k, open, name)); };
  const remove = () => {
    setAsking(false);
    const before = laneSketch$.getValue(), name = cur.name;
    changeSketches(k => deleteSketch(k, open));
    toast(`${name} deleted`, {
      description: list.length === 1 ? "The Sketch window is empty now." : `${sketchList(laneSketch$.getValue()).list.find(x => x.id === sketchList(laneSketch$.getValue()).open)?.name} is open.`,
      duration: 12_000,
      action: { label: "Undo", onClick: () => changeSketches(k => ({ ...k, scratch: before.scratch, sketches: before.sketches, sketchOpen: before.sketchOpen })) },
    });
  };

  if (renaming !== null) return (
    <Input autoFocus value={renaming} maxLength={SKETCH_NAME_MAX} aria-label="The sketch's name" className="h-7 w-48 text-sm" onFocus={e => e.currentTarget.select()}
      onChange={e => setRenaming(e.target.value)} onBlur={() => rename(renaming)}
      onKeyDown={e => { e.stopPropagation(); if (e.key === "Enter") rename(renaming); if (e.key === "Escape") setRenaming(null); }} />
  );
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" className="h-7 max-w-56 gap-1 px-2 text-sm font-medium" title="The plan's sketches: open another, or make a new one" onPointerDown={e => e.stopPropagation()}>
            <span className="truncate">{cur.name}</span><ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">The plan&apos;s sketches · saved with it, never part of it</DropdownMenuLabel>
          {list.map(x => (
            <DropdownMenuItem key={x.id} onSelect={() => changeSketches(k => openSketch(k, x.id, view()))}>
              <Check className={x.id === open ? "" : "invisible"} />
              <span className="min-w-0 flex-1 truncate">{x.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{what(contentOf(plan, x.id))}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={readOnly} onSelect={() => { changeSketches(k => newSketch(k, `Sketch ${sketchList(k).list.length + 1}`, now(), view()).sketch); }}><Plus /> New sketch</DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onSelect={() => { changeSketches(k => duplicateSketch(k, open, now(), view())?.sketch ?? k); }}><Copy /> Duplicate {cur.name}</DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onSelect={() => setRenaming(cur.name)}><Pencil /> Rename…</DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onSelect={() => setAsking(true)} className="text-destructive"><Trash2 /> Delete {cur.name}…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {cur.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {what(contentOf(plan, open)) === "empty" ? "It is empty." : `It has ${what(contentOf(plan, open))}.`} {list.length > 1 ? "The sketch before it opens instead." : "The Sketch window will be empty."} Its message offers Undo for a while; History keeps the plan&apos;s versions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
