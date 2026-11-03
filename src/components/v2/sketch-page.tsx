"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { laneSketch$, loadPlan } from "@/state/store";
import { changeSketches, scratchSketch, SketchStoreContext, takeSketchPut } from "@/state/lane-sketch";
import { openSketch, sketchBySlug, sketchList, sketchSlug } from "@/lib/sketch-list";
import { startUnderlayImage } from "@/state/underlay-image";

/**
 * The Sketch window's own page (T156 follow-up): the same ideas sketched apart from the plan, as a page of their own
 * rather than a window over it — room enough to work in for a while, its own address to come back to. The plan's
 * network loads alongside it (the sketch is saved with the plan, not apart from it), but only `scratchSketch` is
 * edited here; `planSketch` stays loaded for anything that reads across both (a route traced, say).
 */
export function SketchPageClient({ plan, user, want }: { plan: WorkspacePlan; user: MenuUser; /** (ticket #120) the sketch the address names (its part of it) */ want?: string }) {
  const [loaded, setLoaded] = useState(false);
  // (what "Test in Sketch" on the plan's page sent here, put in once the plan is loaded; kept for Strict Mode's second run, which loads it again)
  const put = useRef<(() => void) | null | undefined>(undefined);
  useLayoutEffect(() => {
    loadPlan(plan.id, plan.network, plan.settings, plan.revision, plan.updatedAt, plan.underlay, plan.access === "read", plan.sketch);
    if (put.current === undefined) put.current = takeSketchPut(plan.id);
    put.current?.();
    // (the sketch the address names opened, as the picker would; one there is none of: said, the one open kept)
    if (want) {
      const k = laneSketch$.getValue(), { list, open } = sketchList(k), id = sketchBySlug(list, want);
      if (id && id !== open) changeSketches(x => openSketch(x, id));
      else if (!id) setTimeout(() => toast.error(`This plan has no sketch "${decodeURIComponentSafe(want)}"`, { description: `Showing ${list.find(x => x.id === open)?.name ?? "the one open"} instead.` }), 0);
    }
    startUnderlayImage();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the stores are outside React: loaded, the page can show
    setLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useAutosave(plan.id);
  useLive(plan.id);
  // (ticket #120) the address shows the sketch open, /plans/<plan>/sketch/<its name>, as it changes (the picker): a link to it, or
  // the page loaded again, opens that one; the address put in place, the page not loaded again (Next's router keeps up)
  useEffect(() => {
    if (!loaded) return;
    const sync = () => {
      const { list, open } = sketchList(laneSketch$.getValue()), base = `/plans/${plan.id}/sketch`, at = location.pathname.indexOf(base);
      if (at < 0 || !list.some(x => x.id === open)) return;
      const path = `${location.pathname.slice(0, at)}${base}/${sketchSlug(list, open)}`;
      if (path !== location.pathname) window.history.replaceState(null, "", path + location.search + location.hash);
      // (and the tab's title, as the server puts it)
      const title = `${list.find(x => x.id === open)!.name} · Sketch · ${plan.name} · ${plan.cityName} — Gridlock`;
      if (document.title !== title) document.title = title;
    };
    sync();
    const sub = laneSketch$.subscribe(sync);
    return () => sub.unsubscribe();
  }, [loaded, plan.id, plan.name, plan.cityName]);
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

const decodeURIComponentSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

