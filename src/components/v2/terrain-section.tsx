"use client";

/**
 * The Background panel's terrain (ticket #130): the ground's heights under the plan, fetched for where it is on Earth and
 * kept in the sketch; how high it goes, how fine, when fetched; fetched again (the plan grown past it, or moved), or removed.
 * A lane's ground can be set by hand in its inspector, over it.
 */
import { useState } from "react";
import { Loader2, Mountain, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { terrainArea, terrainOf, type Sketch } from "@/lib/lane-sketch";
import { TERRAIN_ATTRIBUTION, TERRAIN_MARGIN, terrainRange } from "@/lib/terrain";
import { fetchTerrain } from "@/server/terrain";
import { useSketchStore } from "@/state/lane-sketch";

export function TerrainSection({ sketch, planId, readOnly }: { sketch: Sketch; planId: string; readOnly: boolean }) {
  const { edit: editSketch } = useSketchStore();
  const [busy, setBusy] = useState(false);
  const t = sketch.terrain, fits = terrainOf(sketch), range = fits ? terrainRange(fits) : null;
  // (the lanes reach past the grid: fetched before they were drawn there)
  const area = terrainArea(sketch, 0), grown = !!fits && !!area && (area.minX < fits.x0 || area.minY < fits.y0 || area.maxX > fits.x0 + (fits.cols - 1) * fits.cell || area.maxY > fits.y0 + (fits.rows - 1) * fits.cell);

  async function fetchIt() {
    const geo = sketch.geo, a = terrainArea(sketch, TERRAIN_MARGIN);
    if (!geo || !a) return;
    setBusy(true);
    try {
      const r = await fetchTerrain(planId, geo, a);
      if (!r.ok) { toast.error(r.error); return; }
      editSketch(s => ({ ...s, terrain: r.terrain }));
      const rr = terrainRange(r.terrain);
      toast.success("Terrain fetched", { description: `${Math.round(rr.min)}–${Math.round(rr.max)} m above sea level, a point every ${r.terrain.cell} m. Hills count in the simulation (Simulation settings › Hills).` });
    } catch { toast.error("Couldn't fetch the terrain"); } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-1.5 border-t pt-2">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Mountain className="size-3.5" /> Terrain</span>
      {!sketch.geo ? (
        <span className="text-[11px] text-muted-foreground">Place the plan on the map to fetch the ground&apos;s heights under it.</span>
      ) : fits && range ? (
        <span className="text-xs">
          <span className="font-mono tabular">{Math.round(range.min)}–{Math.round(range.max)} m</span> above sea level, a point every {fits.cell} m
          {fits.at && <span className="text-muted-foreground"> · fetched {new Date(fits.at).toLocaleDateString()}</span>}
        </span>
      ) : t ? (
        <span className="text-[11px] text-amber-700 dark:text-amber-400">Fetched for another place: the plan has moved since. Put it back where it was (above), or fetch it again.</span>
      ) : (
        <span className="text-[11px] text-muted-foreground">None: the ground is flat. Fetched, cars slow down uphill (trucks most) and burn more fuel.</span>
      )}
      {grown && <span className="text-[11px] text-amber-700 dark:text-amber-400">Lanes reach past it: fetch it again to cover them.</span>}
      {!readOnly && sketch.geo && (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" disabled={busy || !sketch.lanes.length} onClick={() => void fetchIt()} title={sketch.lanes.length ? "The heights under the lanes and 150 m round them (AWS open terrain tiles)" : "Draw some lanes first"}>
            {busy ? <Loader2 className="animate-spin" /> : t ? <RefreshCw /> : <Mountain />} {t ? "Fetch again" : "Fetch terrain"}
          </Button>
          {t && <Button size="icon-sm" variant="ghost" className="size-8" aria-label="Remove the terrain" title="Remove the terrain (flat ground again; heights set by hand on lanes stay)" onClick={() => editSketch(s => { const n = { ...s }; delete n.terrain; return n; })}><Trash2 /></Button>}
        </div>
      )}
      {t && <p className="text-[10px] text-muted-foreground">{TERRAIN_ATTRIBUTION}</p>}
    </div>
  );
}
