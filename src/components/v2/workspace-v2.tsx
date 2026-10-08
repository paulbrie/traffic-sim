"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserMenu, type MenuUser } from "@/components/auth/user-menu";
import { HistoryButton } from "@/components/workspace/history-dialog";
import { LaneSketch } from "@/components/workspace/lane-sketch";
import { FrameRate, SketchLayerPicker } from "./top-bar-tools";
import { SaveIndicator, useAutosave, useLive, type WorkspacePlan } from "@/components/workspace/workspace";
import { loadPlan } from "@/state/store";
import { startUnderlayImage } from "@/state/underlay-image";

/**
 * A plan on the V2 engine: the lane sketch is the plan, its editor the whole page (drawing, the cars,
 * the structure tree and the inspector), saved, versioned and shared as V1 plans are (its V1 network
 * stays empty).
 */
export function WorkspaceV2({ plan, user }: { plan: WorkspacePlan; user: MenuUser }) {
  // load once per mount (keyed by plan id), before the editor reads the stores
  useState(() => { loadPlan(plan.id, plan.network, plan.settings, plan.revision, plan.updatedAt, plan.underlay, plan.access === "read", plan.sketch); startUnderlayImage(); return plan.id; });
  useAutosave(plan.id);
  useLive(plan.id);
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
          <SketchLayerPicker />
          <div className="ml-auto flex items-center gap-3">
            <FrameRate />
            <UserMenu user={user} />
          </div>
        </header>
        <main className="min-h-0 flex-1">
          <LaneSketch page />
        </main>
      </div>
    </TooltipProvider>
  );
}
