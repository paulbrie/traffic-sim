"use client";

import { useLayoutEffect, useState } from "react";
import { useDeepSubject } from "subjecto/react";
import Link from "next/link";
import { ArrowLeft, Eye, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserMenu, type MenuUser } from "@/components/auth/user-menu";
import { HistoryButton } from "@/components/workspace/history-dialog";
import { LaneSketch } from "@/components/workspace/lane-sketch";
import { FrameRate, SketchLayerPicker } from "./top-bar-tools";
import { SaveIndicator, useAutosave, useLive, type WorkspacePlan } from "@/components/workspace/workspace";
import { loadPlan, ui } from "@/state/store";
import { planSketch, scratchSketch, SketchStoreContext } from "@/state/lane-sketch";
import { startUnderlayImage } from "@/state/underlay-image";

/**
 * A plan on the V2 engine: the lane sketch is the plan, its editor the whole page (drawing, the cars,
 * the structure tree and the inspector), saved, versioned and shared as V1 plans are (its V1 network
 * stays empty). Its Sketch button opens V1's sketch window over it, for ideas sketched apart from the plan
 * (saved with it, in the sketch's `scratch`).
 */
export function WorkspaceV2({ plan, user }: { plan: WorkspacePlan; user: MenuUser }) {
  // load once per mount (keyed by plan id), before the editor reads the stores: in a layout effect, the page
  // shown only once it has run. (Not while rendering: going from one plan to another, this page renders while
  // the last one is still up, and loading then put the new sketch under the old plan's header and updated
  // the old editor from this render.)
  const [loaded, setLoaded] = useState(false);
  useLayoutEffect(() => {
    loadPlan(plan.id, plan.network, plan.settings, plan.revision, plan.updatedAt, plan.underlay, plan.access === "read", plan.sketch);
    startUnderlayImage();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the stores are outside React: loaded, the page can show
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useAutosave(plan.id);
  useLive(plan.id);
  if (!loaded) return null;
  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2">
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/cities/${plan.cityId}`} aria-label={`Back to ${plan.cityName}`}><ArrowLeft /> <span className="max-w-40 truncate">{plan.cityName}</span></Link>
          </Button>
          <Separator orientation="vertical" className="!h-5" />
          <h1 className="truncate px-1 text-sm font-semibold">{plan.name}</h1>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary" title="This plan uses the V2 engine: lanes, connectors and junctions drawn freely, and the newer simulation">V2</span>
          {plan.access === "read"
            ? <span className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground" title="You can simulate and try things, but nothing is saved"><Eye className="size-3.5" /> View only</span>
            : <SaveIndicator planId={plan.id} />}
          <HistoryButton planId={plan.id} canRestore={plan.access !== "read"} />
          <Separator orientation="vertical" className="!h-5" />
          <SketchButton />
          <SketchLayerPicker />
          <div className="ml-auto flex items-center gap-3">
            <FrameRate />
            <UserMenu user={user} />
          </div>
        </header>
        <main className="relative min-h-0 flex-1">
          <SketchStoreContext.Provider value={planSketch}>
            <LaneSketch page />
          </SketchStoreContext.Provider>
          <SketchWindow />
        </main>
      </div>
    </TooltipProvider>
  );
}

/** opens the sketch window, as V1's: lanes, rings and connectors drawn freely, apart from the plan */
function SketchButton() {
  const [open] = useDeepSubject(ui, "sketch");
  return (
    <Button size="sm" variant={open ? "secondary" : "ghost"} className="h-8" aria-pressed={open} onClick={() => { ui.getValue().sketch = !open; }}
      title="Sketch: try ideas in a window of their own (lanes, rings, connectors, junctions, cars), apart from the plan; saved with it. Copy and paste between them.">
      <PenLine /> Sketch
    </Button>
  );
}

/** the sketch window over the plan, on the ideas sketched apart */
function SketchWindow() {
  const [open] = useDeepSubject(ui, "sketch");
  if (!open) return null;
  return (
    <SketchStoreContext.Provider value={scratchSketch}>
      <LaneSketch />
    </SketchStoreContext.Provider>
  );
}
