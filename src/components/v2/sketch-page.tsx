"use client";

import { useLayoutEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserMenu, type MenuUser } from "@/components/auth/user-menu";
import { HistoryButton } from "@/components/workspace/history-dialog";
import { AgentPatchesButton } from "@/components/workspace/agent-patches";
import { LaneSketch } from "@/components/workspace/lane-sketch";
import { FrameRate, MemoryGauge, SketchLayerPicker } from "./top-bar-tools";
import { SaveIndicator, useAutosave, useLive, type WorkspacePlan } from "@/components/workspace/workspace";
import { loadPlan } from "@/state/store";
import { scratchSketch, SketchStoreContext } from "@/state/lane-sketch";
import { startUnderlayImage } from "@/state/underlay-image";

/**
 * The Sketch window's own page (T156 follow-up): the same ideas sketched apart from the plan, as a page of their own
 * rather than a window over it — room enough to work in for a while, its own address to come back to. The plan's
 * network loads alongside it (the sketch is saved with the plan, not apart from it), but only `scratchSketch` is
 * edited here; `planSketch` stays loaded for anything that reads across both (a route traced, say).
 */
export function SketchPageClient({ plan, user }: { plan: WorkspacePlan; user: MenuUser }) {
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
            <Link href={`/plans/${plan.id}`} aria-label={`Back to ${plan.name}`}><ArrowLeft /> <span className="max-w-40 truncate">{plan.name}</span></Link>
          </Button>
          <Separator orientation="vertical" className="!h-5" />
          <h1 className="truncate px-1 text-sm font-semibold">Sketch</h1>
          <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary" title="Ideas sketched apart from the plan: lanes, rings, connectors, junctions, cars — saved with the plan, never part of it">apart from the plan</span>
          {plan.access === "read"
            ? <span className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground" title="You can simulate and try things, but nothing is saved"><Eye className="size-3.5" /> View only</span>
            : <SaveIndicator planId={plan.id} />}
          <HistoryButton planId={plan.id} canRestore={plan.access !== "read"} />
          <AgentPatchesButton planId={plan.id} canApply={plan.access !== "read"} />
          <SketchLayerPicker />
          <div className="ml-auto flex items-center gap-3">
            <FrameRate />
            <MemoryGauge />
            <UserMenu user={user} />
          </div>
        </header>
        <main className="relative min-h-0 flex-1">
          <SketchStoreContext.Provider value={scratchSketch}>
            <LaneSketch page />
          </SketchStoreContext.Provider>
        </main>
      </div>
    </TooltipProvider>
  );
}
