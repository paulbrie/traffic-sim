"use client";

import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { sanitizeNetwork } from "@/engine/validate";
import type { WalkStep } from "@/lib/walkthrough";
import { sendFrame } from "@/state/commands";
import { commit, network$, selectMany, type Selection } from "@/state/store";
import { ChatMarkdown } from "./chat-markdown";
import { resolve } from "./linked-text";

/** take the map to a step's ids (framed, all in view) and select them */
function showStep(step: WalkStep) {
  const sels: Selection[] = [], xs: number[] = [], ys: number[] = [];
  for (const id of step.focus) {
    const r = resolve(id);
    if (!r) continue;
    sels.push(r.sel);
    for (const p of r.pts) { xs.push(p.x); ys.push(p.y); }
  }
  if (sels.length) selectMany(sels);
  if (xs.length) sendFrame(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
}

/**
 * The assistant's walkthrough of a change: one step at a time, each taking the map to what it is about. A step
 * that changes the plan can be made from here (in order, an undo step each); `made` is how many steps are done
 * (steps without a change count as done once passed).
 */
export function Walkthrough({ steps, made, readOnly, onMade }: {
  steps: WalkStep[]; made: number; readOnly: boolean;
  /** the steps up to `upTo` (exclusive) are made; `all`: the plan is now the assistant's whole change */
  onMade: (upTo: number, all: boolean) => void;
}) {
  const [at, setAt] = useState<number | null>(null);
  const go = (i: number) => { setAt(i); showStep(steps[i]); };
  const lastChange = steps.findLastIndex(s => s.network);

  if (at === null) return (
    <Button size="sm" variant="outline" className="h-7 w-full" onClick={() => go(0)}>
      <LocateFixed /> Show me step by step ({steps.length} steps)
    </Button>
  );

  const step = steps[at];
  // (a change can be made once the changes before it are)
  const pendingBefore = steps.slice(0, at).some((s, i) => s.network && i >= made);
  const make = () => {
    if (!step.network || readOnly) return;
    // (buildings weren't sent: keep the plan's own)
    commit({ ...sanitizeNetwork(step.network), buildings: network$.getValue().buildings });
    onMade(at + 1, at >= lastChange);
    // (the step's ids may only exist now: frame them once the plan is rebuilt)
    requestAnimationFrame(() => showStep(step));
  };

  return (
    <div className="space-y-1.5 rounded-md border bg-muted/50 px-2.5 py-2 text-xs">
      <div className="flex items-center gap-1">
        <span className="flex-1 font-medium">Step {at + 1} of {steps.length}{step.title ? ` · ${step.title}` : ""}</span>
        <Button size="icon-sm" variant="ghost" aria-label="Show on the map" title="Show on the map again" onClick={() => showStep(step)}><LocateFixed /></Button>
      </div>
      {step.text && <ChatMarkdown text={step.text} />}
      <div className="flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-7" disabled={at === 0} onClick={() => go(at - 1)}><ChevronLeft /> Back</Button>
        <span className="flex-1" />
        {!!step.network && (at < made
          ? <span className="flex items-center gap-1 text-muted-foreground"><Check className="size-3.5" /> Done</span>
          : <Button size="sm" className="h-7" disabled={readOnly || pendingBefore}
              title={readOnly ? "This plan is view-only for you" : pendingBefore ? "Make the steps before this one first" : "Change the plan as this step says (can be undone)"}
              onClick={make}>Make this step</Button>)}
        <Button size="sm" variant={step.network && at >= made ? "ghost" : "outline"} className="h-7" disabled={at === steps.length - 1} onClick={() => go(at + 1)}>Next <ChevronRight /></Button>
      </div>
    </div>
  );
}
