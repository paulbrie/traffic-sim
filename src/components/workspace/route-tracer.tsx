"use client";

import { useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { toast } from "sonner";
import { Car, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { routeBetween, routeShape } from "@/engine/route";
import type { Compiled } from "@/engine/compile";
import { network$, select, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { Section, compass } from "./fields";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** entry / exit points with a name: their road, and which side of the plan they are on */
function entryPoints(c: Compiled) {
  const b = c.bounds, cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return c.nodes.filter(n => n.gateway).map(n => {
    const road = n.arms[0]?.link.name || "Road";
    return { id: n.def.id, label: `${road} · ${compass(n.pos.x - cx, n.pos.y - cy).name}`, lanes: n.arms[0]?.outEdge };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Route tracer: pick an entry point, an exit and the lane to start in; the fastest free-flow route
 * is drawn on the map, and a test vehicle can be sent along it (it is then followed in the inspector).
 */
export function RouteTracer() {
  useSubject(network$);
  useSubject(stats$);
  const [trace, setTrace] = useDeepSubject(ui, "trace");
  const [busy, setBusy] = useState(false);
  const c = simController.compiled, points = entryPoints(c);
  if (points.length < 2) return null;
  const from = points.find(p => p.id === trace.from), route = trace.from && trace.to ? routeBetween(c, trace.from, trace.to) : null;
  const shape = route ? routeShape(route) : null;
  const e = from?.lanes;
  const lanes = e ? Array.from({ length: e.thru }, (_, k) => e.left + k).filter(k => !(e.bus && k === e.kerb)) : [];
  const tests = (simController.sim?.tests ?? []).slice(-5).reverse();
  const name = (id: string) => points.find(p => p.id === id)?.label ?? "?";
  const send = async () => {
    if (!trace.from || !trace.to) return;
    setBusy(true);
    const r = await simController.sendTest(trace.from, trace.to, trace.lane);
    setBusy(false);
    if ("error" in r) { toast.error(r.error); return; }
    ui.getValue().sim.running = true;
    select({ kind: "vehicle", id: String(r.id) });
  };
  const pick = (label: string, value: string | null, on: (v: string) => void) => (
    <Select value={value ?? ""} onValueChange={on}>
      <SelectTrigger size="sm" className="w-full" aria-label={label}><SelectValue placeholder={label} /></SelectTrigger>
      <SelectContent>{points.map(p => <SelectItem key={p.id} value={p.id}>{p.label}</SelectItem>)}</SelectContent>
    </Select>
  );
  return (
    <Section title="Route tracer">
      <p className="text-xs text-muted-foreground">Check how traffic gets from one entry point to another: the fastest route is drawn on the map, and a test vehicle can drive it with the traffic.</p>
      <div className="grid grid-cols-[3rem_1fr] items-center gap-2 text-sm">
        <span className="text-muted-foreground">From</span>{pick("From", trace.from, v => setTrace({ ...trace, from: v, lane: null }))}
        <span className="text-muted-foreground">To</span>{pick("To", trace.to, v => setTrace({ ...trace, to: v }))}
        {lanes.length > 1 && (
          <>
            <span className="text-muted-foreground">Lane</span>
            <Select value={String(trace.lane ?? lanes[lanes.length - 1])} onValueChange={v => setTrace({ ...trace, lane: Number(v) })}>
              <SelectTrigger size="sm" className="w-full" aria-label="Lane to start in"><SelectValue /></SelectTrigger>
              <SelectContent>{lanes.map((k, i) => <SelectItem key={k} value={String(k)}>Lane {k + 1}{i === 0 ? " (left / inner)" : i === lanes.length - 1 ? " (right / outer)" : ""}</SelectItem>)}</SelectContent>
            </Select>
          </>
        )}
      </div>
      {trace.from && trace.to && (
        shape ? (
          <p className="text-xs text-muted-foreground tabular">{(shape.length / 1000).toFixed(2)} km · {shape.junctions} junction{shape.junctions === 1 ? "" : "s"} · {mmss(shape.time)} with no traffic</p>
        ) : <p className="text-xs text-destructive">There is no way from there to there.</p>
      )}
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" disabled={!shape || busy} onClick={send}><Car /> Send a test vehicle</Button>
        {(trace.from || trace.to) && <Button size="sm" variant="ghost" aria-label="Clear the route" onClick={() => setTrace({ from: null, to: null, lane: null })}><X /></Button>}
      </div>
      {tests.length > 0 && (
        <table className="w-full text-xs">
          <tbody>
            {tests.map(t => (
              <tr key={t.id} className="border-t">
                <td className="py-1"><button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => select({ kind: "vehicle", id: String(t.id) })}>{name(t.from)} → {name(t.to)}</button></td>
                <td className="py-1 text-right text-muted-foreground">{t.done === null ? "driving" : t.done === "arrived" ? `arrived in ${mmss(t.time)}` : t.done === "stuck" ? "got stuck" : "ended elsewhere"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}
