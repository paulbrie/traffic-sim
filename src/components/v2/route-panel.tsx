"use client";

/**
 * The route tracer (as V1's route-tracer.tsx): from a way in to a way out, the way the cars would go, the V2
 * simulation's own shortest way (lib/route-trace.ts): its lanes, connectors and lane changes in order, shown on the
 * map, with its length and its time at the speed limits; or why there is none. Chosen here (the ways in and out as
 * Demand lists them) or from a lane's menu on the map ("Route from here", "Route to here"). In the V2 UI store.
 */
import { useEffect, useMemo } from "react";
import { Car, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { demandWays, type Sketch } from "@/lib/lane-sketch";
import { traceRoute, traceToWay } from "@/lib/route-trace";
import { useEditorKind, useUiPath, type RouteUi } from "@/state/sketch-ui";
import { compassNames } from "./compass-names";
import { InspectorPanel } from "./inspector-panel";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const m = (x: number) => (x >= 1000 ? `${(x / 1000).toFixed(2)} km` : `${Math.round(x)} m`);

export function RoutePanel({ sketch, onGo, onSendTest }: {
  sketch: Sketch; onGo: (step: { kind: "lane" | "connector"; id: string }) => void;
  /** a test car sent on the route (the cars run, the view follows it) */
  onSendTest: () => void;
}) {
  const [route, setRoute] = useUiPath<RouteUi>(`editors/${useEditorKind()}/route`);
  const ways = useMemo(() => {
    const { entries, exits } = demandWays(sketch);
    const ni = compassNames(entries, w => w.name, w => w.at), no = compassNames(exits, w => w.name, w => w.at);
    return { entries: entries.map((w, i) => ({ ...w, name: ni[i] })), exits: exits.map((w, i) => ({ ...w, name: no[i] })) };
  }, [sketch]);
  const inWay = ways.entries.find(w => route.from && w.lanes.includes(route.from)) ?? null;
  const outWay = ways.exits.find(w => route.to && w.lanes.includes(route.to)) ?? null;
  // (worked out again as the sketch or the choice changes; kept in the store for the map and for agents)
  const result = useMemo<RouteUi["result"]>(() => {
    if (!route.from || !route.to) return null;
    // (to a way out of several lanes: whichever of them the cars would take; to a lane in none, that lane)
    const r = outWay && outWay.lanes.length > 1 ? traceToWay(sketch, route.from, outWay.lanes) : traceRoute(sketch, route.from, route.to);
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true, steps: r.route.steps.map(x => (x.kind === "change" ? x : { kind: x.kind, id: x.id })), length: Math.round(r.route.length * 10) / 10, freeTime: Math.round(r.route.freeTime * 10) / 10 };
  }, [sketch, route.from, route.to, outWay]);
  useEffect(() => {
    // (a test car sent on another route is no test of this one)
    if (JSON.stringify(result) !== JSON.stringify(route.result)) setRoute(r => ({ ...r, result, test: null }));
  }, [result, route.result, setRoute]);
  if (!ways.entries.length || !ways.exits.length) return null;
  const pick = (label: string, list: typeof ways.entries, way: (typeof ways.entries)[number] | null, set: (lane: string) => void) => (
    <Select value={way?.key ?? ""} onValueChange={k => { const w = list.find(x => x.key === k); if (w) set(w.lanes[0]); }}>
      <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label={label}><SelectValue placeholder="choose…" /></SelectTrigger>
      <SelectContent>{list.map(w => <SelectItem key={w.key} value={w.key} className="text-xs">{w.name}</SelectItem>)}</SelectContent>
    </Select>
  );
  return (
    <InspectorPanel id="route" title="Route"
      actions={route.from || route.to ? <Button size="icon-sm" variant="ghost" aria-label="Clear the route" title="Clear the route" onClick={() => setRoute({ from: null, to: null, result: null, test: null })}><X /></Button> : undefined}>
      <p className="text-[11px] text-muted-foreground">The way the cars would go from a way in to a way out: the shortest (the simulation doesn&apos;t route round queues; cars kept waiting may look for another way).</p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
        <div className="flex items-center gap-1.5"><span className="w-8 shrink-0 text-[11px] text-muted-foreground">From</span>{pick("Route from", ways.entries, inWay, lane => setRoute(r => ({ ...r, from: lane })))}</div>
        {inWay && inWay.lanes.length > 1 && (
          <div className="flex items-center gap-1.5"><span className="w-8 shrink-0 text-[11px] text-muted-foreground">Lane</span>
            <Select value={route.from ?? ""} onValueChange={lane => setRoute(r => ({ ...r, from: lane }))}>
              <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label="Route from lane"><SelectValue /></SelectTrigger>
              <SelectContent>{inWay.lanes.map((id, i) => <SelectItem key={id} value={id} className="text-xs">{id} · lane {i + 1}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        )}
        <div className="flex items-center gap-1.5"><span className="w-8 shrink-0 text-[11px] text-muted-foreground">To</span>{pick("Route to", ways.exits, outWay, lane => setRoute(r => ({ ...r, to: lane })))}</div>
      </div>
      {result && !result.ok && <p className="text-xs text-amber-700 dark:text-amber-500">No route: {result.reason}.</p>}
      {result?.ok && (
        <>
          <p className="text-xs"><span className="font-mono tabular">{m(result.length)}</span> · <span className="font-mono tabular">{mmss(result.freeTime)}</span> <span className="text-muted-foreground">at the speed limits, {result.steps.filter(x => x.kind === "change").length} lane change{result.steps.filter(x => x.kind === "change").length === 1 ? "" : "s"}</span></p>
          <ol className="grid max-h-40 grid-cols-[minmax(0,1fr)] overflow-y-auto text-[11px]">
            {result.steps.map((x, i) => (
              <li key={i}>
                {x.kind === "change"
                  ? <span className="px-1 text-muted-foreground">↷ change to {x.to}</span>
                  : <button type="button" className="w-full truncate rounded px-1 text-left hover:bg-muted" onClick={() => onGo(x)}>{x.kind === "lane" ? "lane" : "connector"} {x.id}{x.kind === "lane" && sketch.roads.find(r => r.lanes.includes(x.id)) ? ` · ${sketch.roads.find(r => r.lanes.includes(x.id))!.name}` : ""}</button>}
              </li>
            ))}
          </ol>
          <Button size="sm" variant="outline" onClick={onSendTest} title="Send one car on this route now (the cars run), follow it, and see how long it takes and how often it stops">
            <Car /> Send a test car
          </Button>
          {route.test && <TestResult test={route.test} freeTime={result.freeTime} />}
        </>
      )}
    </InspectorPanel>
  );
}

/** how the test car did: on its way (how long so far), arrived (its time, its stops, against the time at the limits), or gone */
function TestResult({ test, freeTime }: { test: NonNullable<RouteUi["test"]>; freeTime: number }) {
  const text = test.state === "arrived" ? `arrived in ${mmss(test.time ?? 0)} (${mmss(freeTime)} at the limits), ${test.stops} stop${test.stops === 1 ? "" : "s"}`
    : test.state === "gone" ? "left the plan elsewhere (or was towed, or its lane was edited away)"
    : `on its way${test.time !== null ? ` (${mmss(test.time)} so far)` : ""}, ${test.stops} stop${test.stops === 1 ? "" : "s"}`;
  return (
    <div className="grid gap-0.5 rounded-md border p-1.5 text-xs" aria-label="Test car">
      <span><span className="font-medium">Test car {Math.abs(test.car)}</span> · {text}</span>
      {test.otherWay && <span className="text-[11px] text-amber-700 dark:text-amber-500">It went a longer way than the one traced (as a car looking for another way after waiting does): its way shows in blue.</span>}
    </div>
  );
}
