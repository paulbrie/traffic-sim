"use client";

/**
 * The Background panel's buildings (ticket #267): OpenStreetMap's footprints round the plan, fetched for where it is on
 * Earth and kept in the sketch, shown in 3D (and on the plan view) with the Buildings layer; how many, how many of their
 * heights OSM gives (the rest guessed from their kind and size); fetched again, or removed.
 */
import { useState } from "react";
import { Building2, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { buildingsOf, terrainArea, type Sketch } from "@/lib/lane-sketch";
import { BUILDINGS_ATTRIBUTION, BUILDINGS_MARGIN } from "@/lib/sketch-buildings";
import { fetchBuildings } from "@/server/buildings";
import { useSketchStore } from "@/state/lane-sketch";

export function BuildingsSection({ sketch, planId, readOnly }: { sketch: Sketch; planId: string; readOnly: boolean }) {
  const { edit: editSketch } = useSketchStore();
  const [busy, setBusy] = useState(false);
  const b = sketch.buildings, fits = buildingsOf(sketch), tagged = fits ? fits.list.filter(x => x.tagged).length : 0;

  async function fetchIt() {
    const geo = sketch.geo, a = terrainArea(sketch, BUILDINGS_MARGIN);
    if (!geo || !a) return;
    setBusy(true);
    try {
      const r = await fetchBuildings(planId, geo, a);
      if (!r.ok) { toast.error(r.error); return; }
      editSketch(s => ({ ...s, buildings: r.buildings }));
      const n = r.buildings.list.length;
      toast.success(n ? `${n.toLocaleString()} buildings fetched` : "No buildings there on OpenStreetMap", {
        description: n ? `${r.capped ? "The largest kept. " : ""}OpenStreetMap gives the height of ${r.tagged.toLocaleString()}; the others' are guessed from their kind and size. Shown in 3D (layer Buildings).` : undefined,
      });
    } catch { toast.error("Couldn't fetch the buildings"); } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-1.5 border-t pt-2">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Building2 className="size-3.5" /> Buildings</span>
      {!sketch.geo ? (
        <span className="text-[11px] text-muted-foreground">Place the plan on the map to fetch the buildings round it.</span>
      ) : fits ? (
        <span className="text-xs">
          <span className="font-mono tabular">{fits.list.length.toLocaleString()}</span> from OpenStreetMap, {tagged.toLocaleString()} with their height (the others&apos; guessed)
          {fits.at && <span className="text-muted-foreground"> · fetched {new Date(fits.at).toLocaleDateString()}</span>}
        </span>
      ) : b ? (
        <span className="text-[11px] text-amber-700 dark:text-amber-400">Fetched for another place: the plan has moved since. Put it back where it was (above), or fetch them again.</span>
      ) : (
        <span className="text-[11px] text-muted-foreground">None. Fetched, OpenStreetMap&apos;s buildings round the lanes stand in the 3D view.</span>
      )}
      {!readOnly && sketch.geo && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" disabled={busy || !sketch.lanes.length} onClick={() => void fetchIt()} title={sketch.lanes.length ? `The buildings under the lanes and ${BUILDINGS_MARGIN} m round them (OpenStreetMap)` : "Draw some lanes first"}>
            {busy ? <Loader2 className="animate-spin" /> : b ? <RefreshCw /> : <Building2 />} {b ? "Fetch again" : "Fetch buildings"}
          </Button>
          {b && <Button size="icon-sm" variant="ghost" className="size-8" aria-label="Remove the buildings" title="Remove the buildings" onClick={() => editSketch(s => { const n = { ...s }; delete n.buildings; return n; })}><Trash2 /></Button>}
        </div>
      )}
      {b && <p className="text-[10px] text-muted-foreground">{BUILDINGS_ATTRIBUTION}</p>}
    </div>
  );
}
