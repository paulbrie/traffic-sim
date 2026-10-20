"use client";

import { useEffect, useState } from "react";
import { Loader2, Signpost } from "lucide-react";
import { toast } from "sonner";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { basePath } from "@/lib/base-path";
import { mergeStreets, type StreetNear } from "@/lib/osm/streets";

type Source = "nominatim" | "overpass";
type Answer = { streets: StreetNear[] } | { error: string };

async function ask(source: Source, lat: number, lon: number, signal: AbortSignal): Promise<Answer> {
  const res = await fetch(`${basePath}/api/streets?source=${source}&lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, { signal });
  const body = (await res.json().catch(() => ({}))) as Partial<{ streets: StreetNear[]; error: string }>;
  return res.ok && Array.isArray(body.streets) ? { streets: body.streets } : { error: body.error ?? `The lookup failed (${res.status}).` };
}

/**
 * The street names near a point (ticket #48), from OpenStreetMap: the nearest from Nominatim (fast), the others
 * within 200 m from Overpass (slower, and sometimes busy), merged as they come, nearest first.
 */
function useStreetsNear(lat: number, lon: number) {
  const [got, setGot] = useState<{ key: string; answers: Partial<Record<Source, Answer>> }>({ key: "", answers: {} });
  const key = `${lat},${lon}`;
  useEffect(() => {
    const ctl = new AbortController();
    for (const source of ["nominatim", "overpass"] as const) {
      ask(source, lat, lon, ctl.signal)
        .catch((): Answer => ({ error: "The street names couldn't be looked up just now." }))
        .then(a => { if (!ctl.signal.aborted) setGot(g => ({ key, answers: { ...(g.key === key ? g.answers : {}), [source]: a } })); });
    }
    return () => ctl.abort();
  }, [lat, lon, key]);
  const answers = got.key === key ? got.answers : {};
  const lists = Object.values(answers).flatMap(a => ("streets" in a ? [a.streets] : []));
  const done = !!answers.nominatim && !!answers.overpass;
  const errors = Object.values(answers).flatMap(a => ("error" in a ? [a.error] : []));
  return {
    streets: lists.reduce<StreetNear[]>((all, l) => mergeStreets(all, l), []),
    /** still waiting for one of the two */
    more: !done,
    /** both failed: the message to show */
    error: done && !lists.length ? errors[0] : undefined,
  };
}

const distanceText = (s: StreetNear) => (s.distance < 1 ? "here" : `${Math.round(s.distance)} m`);

/**
 * The street names near a right-click on the V2 map (ticket #48): items of its dropdown, nearest first. With a road
 * under the click (and the plan editable), a name names that road (`onName`, one undo step); otherwise it's copied.
 */
export function StreetNameItems({ lat, lon, road, readOnly, onName }: {
  lat: number; lon: number;
  /** the road of the lanes under the click, if they are in one */
  road: { id: string; name: string } | null;
  readOnly: boolean;
  onName: (roadId: string, name: string) => void;
}) {
  const { streets, more, error } = useStreetsNear(lat, lon);
  const canName = !!road && !readOnly;
  const pick = (s: StreetNear) => {
    if (canName && road) {
      onName(road.id, s.name);
      toast.success(`Road named “${s.name}”`, { description: road.name && road.name !== s.name ? `It was “${road.name}”. Undo puts it back.` : undefined });
    } else {
      void navigator.clipboard?.writeText(s.name).then(() => toast.success(`“${s.name}” copied`), () => toast.error("Couldn't copy the name"));
    }
  };
  return (
    <>
      <DropdownMenuLabel className="flex max-w-72 items-start gap-2 text-xs font-normal text-muted-foreground">
        <Signpost className="mt-0.5 size-3.5 shrink-0" />
        {canName ? <span className="min-w-0">Name <b className="font-semibold text-foreground">{road!.name || "this road"}</b> after a street nearby</span> : "Streets nearby (click to copy)"}
      </DropdownMenuLabel>
      {streets.map(s => (
        <DropdownMenuItem key={s.name} title={`${s.kind} · OpenStreetMap way ${s.wayId}`} onSelect={() => pick(s)}>
          <span className="max-w-56 truncate">{s.name}</span>
          <span className="ml-auto text-[11px] text-muted-foreground tabular">{distanceText(s)}</span>
        </DropdownMenuItem>
      ))}
      {more ? (
        <DropdownMenuItem disabled><Loader2 className="animate-spin" /> {streets.length ? "Looking for more…" : "Asking OpenStreetMap…"}</DropdownMenuItem>
      ) : error ? (
        <div className="max-w-64 px-2 py-1.5 text-xs text-destructive">{error}</div>
      ) : !streets.length ? (
        <DropdownMenuItem disabled>No named street within 200 m</DropdownMenuItem>
      ) : null}
      <div className="px-2 pb-1 text-[10px] text-muted-foreground">© OpenStreetMap contributors</div>
    </>
  );
}
