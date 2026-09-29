"use client";

import dynamic from "next/dynamic";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { GeoRef, Network } from "@/engine/types";
import { bboxProblem, bboxSize, DEFAULT_ROAD_CLASSES, ROAD_CLASSES, snapToAreas, type BBox, type RoadClass } from "@/lib/osm/area";
import type { ImportStats } from "@/lib/osm/convert";
import { importOsm, loadOsmArea } from "@/server/actions";

const AreaMap = dynamic(() => import("./area-map").then(m => m.AreaMap), {
  ssr: false,
  loading: () => <div className="grid h-full min-h-80 place-items-center rounded-lg border text-sm text-muted-foreground">Loading map…</div>,
});

export type OsmImportMode =
  | { kind: "city" }
  | { kind: "plan"; cityId: string }
  /** merge into the open plan: `onLoaded` gets the area in plan coordinates (origin = `origin`) */
  | { kind: "merge"; center: GeoRef | null; existing: BBox[]; origin: (area: BBox) => GeoRef; onLoaded: (net: Network, stats: ImportStats) => void };

export const describeStats = (s: ImportStats) =>
  [`${s.roads} road${s.roads === 1 ? "" : "s"} (${s.lengthKm} km)`, `${s.junctions} junctions`, s.signals ? `${s.signals} with lights` : "", s.roundabouts ? `${s.roundabouts} roundabouts` : "", `${s.entries} entry points`, s.buildings ? `${s.buildings} buildings` : ""].filter(Boolean).join(" · ");

/** Pick an area on an OpenStreetMap map and import its roads (and buildings). */
export function OsmImportDialog({ mode, trigger }: { mode: OsmImportMode; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      {/* the map is only mounted while the dialog is open */}
      {open && <ImportContent mode={mode} close={() => setOpen(false)} />}
    </Dialog>
  );
}

function ImportContent({ mode, close }: { mode: OsmImportMode; close: () => void }) {
  const router = useRouter();
  const [frame, setFrame] = useState<BBox | null>(null);
  // when adding to a plan, the frame lines up with the areas imported before
  const bbox = frame && mode.kind === "merge" ? snapToAreas(frame, mode.existing) : frame;
  const snapped = !!frame && !!bbox && (["south", "west", "north", "east"] as const).some(k => bbox[k] !== frame[k]);
  const [roads, setRoads] = useState<RoadClass[]>(DEFAULT_ROAD_CLASSES);
  const [buildings, setBuildings] = useState(true);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const problem = bbox ? bboxProblem(bbox) : "Loading the map…";
  const size = bbox ? bboxSize(bbox) : null;
  const nothing = !roads.length && !buildings;

  const title = mode.kind === "city" ? "New city from OpenStreetMap" : mode.kind === "plan" ? "New plan from OpenStreetMap" : "Add an area from OpenStreetMap";
  const blurb = mode.kind === "merge"
    ? "Adds the roads and buildings in the frame to this plan. Roads already in the plan are skipped, and roads that meet the plan's entry points are joined up, so you can import a city part by part."
    : "Move and zoom the map until the frame covers the streets you want. Roads leaving the frame become entry points.";

  function submit() {
    if (!bbox || problem || nothing) return;
    setError(null);
    start(async () => {
      try {
        const area = { bbox, roads, buildings };
        if (mode.kind === "merge") {
          const res = await loadOsmArea({ ...area, origin: mode.origin(bbox) });
          if (!res.ok) { setError(res.error); return; }
          mode.onLoaded(res.network, res.stats);
          close();
          return;
        }
        const target = mode.kind === "city" ? { kind: "city" as const, name } : { kind: "plan" as const, cityId: mode.cityId, name };
        const res = await importOsm({ ...area, target });
        if (!res.ok) { setError(res.error); return; }
        toast.success("Imported from OpenStreetMap", { description: describeStats(res.stats) });
        close();
        router.push(`/plans/${res.planId}`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The import failed.");
      }
    });
  }

  return (
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{blurb}</DialogDescription>
      </DialogHeader>
      <form
        className="grid min-h-0 flex-1 gap-4 md:grid-cols-[1fr_16rem]"
        onSubmit={e => { e.preventDefault(); submit(); }}
      >
        <div className="h-[min(60dvh,32rem)]">
          <AreaMap center={mode.kind === "merge" ? mode.center : null} existing={mode.kind === "merge" ? mode.existing : []} onChange={setFrame} onPlace={p => setName(n => n.trim() ? n : p)} />
        </div>
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
          {mode.kind !== "merge" && (
            <div className="grid gap-2">
              <Label htmlFor="osm-name">{mode.kind === "city" ? "City name" : "Plan name"}</Label>
              <Input id="osm-name" value={name} onChange={e => setName(e.target.value)} placeholder={mode.kind === "city" ? "e.g. Cluj-Napoca" : "e.g. Centre — current layout"} required />
            </div>
          )}
          <div className="grid gap-2">
            <div className="text-sm font-medium">Roads</div>
            {ROAD_CLASSES.map(c => (
              <label key={c.id} className="flex items-start justify-between gap-3 text-sm">
                <span>{c.label}<span className="block text-xs text-muted-foreground">{c.hint}</span></span>
                <Switch className="mt-0.5" checked={roads.includes(c.id)} onCheckedChange={v => setRoads(r => (v ? [...r, c.id] : r.filter(x => x !== c.id)))} />
              </label>
            ))}
          </div>
          <label className="flex items-start justify-between gap-3 text-sm">
            <span className="font-medium">Buildings<span className="block text-xs font-normal text-muted-foreground">Shown in 2D and 3D; trips start and end at them, by use and floor area.</span></span>
            <Switch className="mt-0.5" checked={buildings} onCheckedChange={setBuildings} />
          </label>
          <div className="mt-auto grid gap-1 text-xs">
            {size && <div className="font-mono tabular text-foreground">{(size.w / 1000).toFixed(2)} × {(size.h / 1000).toFixed(2)} km</div>}
            {snapped && <p className="text-muted-foreground">The frame is lined up with the area already in the plan (dashed), so roads crossing the edge join up.</p>}
            {problem && bbox && <p className="text-destructive">{problem}</p>}
            {nothing && <p className="text-destructive">Choose at least one kind of road, or buildings.</p>}
            {error && <p className="text-destructive" role="alert">{error}</p>}
            <p className="text-muted-foreground">Map data © OpenStreetMap contributors (ODbL). Large areas can take a minute or two.</p>
          </div>
        </div>
        <DialogFooter className="md:col-span-2">
          <Button type="button" variant="ghost" onClick={close}>Cancel</Button>
          <Button type="submit" disabled={pending || !!problem || nothing}>
            {pending ? <><Loader2 className="animate-spin" /> Importing…</> : mode.kind === "merge" ? "Add to plan" : "Import"}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
