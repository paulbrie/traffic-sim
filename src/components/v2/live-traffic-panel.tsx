"use client";

import { useState } from "react";
import { Gauge, RefreshCw, TrafficCone, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { Sketch } from "@/lib/lane-sketch";
import { freeFlowLimits, sketchArea, LIMIT_MIN_COVER, TRAFFIC_BANDS, TRAFFIC_CLOSED, TRAFFIC_NO_DATA, type TrafficMatch } from "@/lib/tomtom";
import { cn } from "@/lib/utils";
import { fetchLiveTraffic } from "@/server/traffic";
import { useSketchStore } from "@/state/lane-sketch";
import { clearLiveTraffic, logTrafficPull, setLiveTraffic, type LiveTraffic } from "@/state/live-traffic";
import { InspectorPanel } from "./inspector-panel";

const ago = (iso: string) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ${m % 60} min ago`; };
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Live traffic from TomTom (ticket #33) for a V2 plan placed on the map: fetched on asking, kept in the page only. Shows
 * how much of the plan's roads TomTom covers, what the map's colours mean (the "Live traffic" layer), sets each covered
 * road's speed limit to its free-flow speed (one edit, undo brings it back). The incidents come with Live traffic sync
 * (Display options), on the same map layer.
 */
export function LiveTrafficPanel({ planId, sketch, live, match, readOnly }: {
  planId: string; sketch: Sketch; live: LiveTraffic | null; match: TrafficMatch | null; readOnly: boolean;
}) {
  const { edit: editSketch } = useSketchStore();
  const [busy, setBusy] = useState(false);
  const area = sketchArea(sketch);
  const fetchNow = async () => {
    if (!area) return;
    setBusy(true);
    try {
      const r = await fetchLiveTraffic(planId, area);
      if (r.ok) { setLiveTraffic(planId, r.snapshot); logTrafficPull({ what: "speeds", plan: planId, count: r.snapshot.speeds.length }); }
      else { toast.error("No live traffic", { description: r.error }); logTrafficPull({ what: "speeds", plan: planId, error: r.error }); }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      toast.error("No live traffic", { description: error });
      logTrafficPull({ what: "speeds", plan: planId, error });
    } finally { setBusy(false); }
  };
  const limits = match ? freeFlowLimits(sketch, match) : null;
  const setLimits = () => {
    if (!match) return;
    let n = 0;
    editSketch(sk => { const r = freeFlowLimits(sk, match); n = r.changed.length; return r.sketch; });
    toast.success(`Speed limits set on ${n} road${n === 1 ? "" : "s"}`, { description: "Each road's free-flow speed from TomTom, rounded to 5 km/h. Undo brings the old ones back." });
  };
  const snap = live?.snapshot;
  return (
    <InspectorPanel id="live-traffic" title="Live traffic" icon={<TrafficCone className="size-3.5 shrink-0 text-muted-foreground" />}
      actions={snap && <Button size="icon-sm" variant="ghost" aria-label="Clear the live traffic" title="Clear it (the map's colours go)" onClick={clearLiveTraffic}><X className="size-3.5" /></Button>}>
      {!area ? (
        <p className="text-[11px] text-muted-foreground">Place the plan on the map (Background) to get TomTom&apos;s live traffic for it.</p>
      ) : !snap ? (
        <>
          <p className="text-[11px] text-muted-foreground">TomTom&apos;s traffic now on the plan&apos;s roads: each road&apos;s speed, against its free-flow speed. Speeds only: TomTom doesn&apos;t count vehicles. (Jams, roadworks and closures: Live traffic sync, in Display options.)</p>
          <Button size="sm" variant="outline" disabled={busy} onClick={fetchNow}><RefreshCw className={cn(busy && "animate-spin")} /> {busy ? "Fetching…" : "Fetch live traffic"}</Button>
        </>
      ) : (
        <>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span title={new Date(snap.at).toLocaleString()}>TomTom at {hhmm(snap.at)} <span className="text-muted-foreground">({ago(snap.at)})</span></span>
            <Button size="icon-sm" variant="ghost" aria-label="Fetch it again" title="Fetch it again" disabled={busy} onClick={fetchNow}><RefreshCw className={cn("size-3.5", busy && "animate-spin")} /></Button>
          </div>
          {match && (
            <p className="text-[11px] text-muted-foreground">
              Covers {match.length ? Math.round((100 * match.covered) / match.length) : 0}% of the roads&apos; lanes ({(match.covered / 1000).toFixed(1)} of {(match.length / 1000).toFixed(1)} km, {match.roads.size} roads); minor streets mostly have no data.
            </p>
          )}
          <div className="grid gap-0.5" title="The map's Live traffic layer: each lane coloured by its speed now as a share of its free-flow speed">
            <span className="text-[11px] text-muted-foreground">Speed now, of free flow:</span>
            <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
              {[...TRAFFIC_BANDS].reverse().map(b => <span key={b.label} className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: b.color }} />{b.label}</span>)}
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: TRAFFIC_CLOSED }} />closed</span>
              <span className="flex items-center gap-1"><span className="inline-block h-1.5 w-3 rounded-sm" style={{ background: TRAFFIC_NO_DATA }} />no data</span>
            </div>
          </div>
          <Button size="sm" variant="outline" disabled={readOnly || !limits?.changed.length} onClick={setLimits}
            title={`Each road TomTom covers at least ${Math.round(LIMIT_MIN_COVER * 100)}% of gets its free-flow speed (rounded to 5 km/h) as its speed limit, the speed the cars want there. One edit: undo brings the old limits back.`}>
            <Gauge /> Speed limits from free flow{limits ? ` (${limits.changed.length} road${limits.changed.length === 1 ? "" : "s"})` : ""}
          </Button>
        </>
      )}
      <p className="text-[10px] text-muted-foreground">Traffic data © TomTom. Kept in this page only, never saved with the plan.</p>
    </InspectorPanel>
  );
}
