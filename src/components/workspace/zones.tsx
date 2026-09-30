"use client";

import { useSubject } from "subjecto/react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { polyCentroid } from "@/engine/buildings";
import type { Network } from "@/engine/types";
import { commit, network$, stats$ } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { viewport } from "@/state/commands";
import * as ops from "@/state/ops";
import { IdChip, Section } from "./fields";

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const NEW = "__new__", NONE = "__none__";

/** which zone an entry point or building is in; can start a new zone */
export function ZonePicker({ net, kind, id }: { net: Network; kind: "entry" | "building"; id: string }) {
  const zones = net.zones ?? [];
  const cur = zones.find(z => z.members.some(m => m.kind === kind && m.id === id));
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs text-muted-foreground">Zone (for zone-to-zone demand)</Label>
      <Select
        value={cur?.id ?? NONE}
        onValueChange={v => {
          if (v === NEW) { const [n2, z] = ops.addZone(net); commit(ops.setZone(n2, [{ kind, id }], z.id)); }
          else commit(ops.setZone(net, [{ kind, id }], v === NONE ? null : v));
        }}
      >
        <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>No zone</SelectItem>
          {zones.map(z => <SelectItem key={z.id} value={z.id}><span className="mr-1.5 inline-block size-2.5 rounded-full" style={{ background: z.color }} />{z.name}</SelectItem>)}
          <SelectItem value={NEW}>New zone…</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

/** zones, what's in them, and the demand between them (vehicles per hour) with live results */
export function ZonesSection() {
  const [net] = useSubject(network$);
  useSubject(stats$);
  const sim = simController.sim;
  const zones = net.zones ?? [], demand = net.zoneFlows ?? [];
  const rate = (a: string, b: string) => demand.find(f => f.from === a && f.to === b)?.rate ?? 0;
  /** every building whose centre is in the visible part of the map */
  const buildingsInView = () => {
    const x0 = viewport.cx - viewport.wm / 2, x1 = viewport.cx + viewport.wm / 2, y0 = viewport.cy - viewport.hm / 2, y1 = viewport.cy + viewport.hm / 2;
    return (net.buildings ?? []).filter(b => { const c = polyCentroid(b.pts); return c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1; });
  };
  return (
    <Section title="Zones and demand">
      <p className="text-xs text-muted-foreground">
        A zone groups entry points and buildings where trips start and end. Put them in a zone from their inspector (or add the buildings in view here), then set how many
        vehicles per hour travel from each zone to each other. Trips start and end at the zone&apos;s entry points and buildings (buildings by trip weight).
      </p>
      {zones.map(z => {
        const entries = z.members.filter(m => m.kind === "entry").length, bld = z.members.length - entries;
        return (
          <div key={z.id} className="grid gap-1.5 rounded-lg border p-2">
            <div className="flex items-center gap-2">
              <input type="color" value={z.color} aria-label={`Colour of ${z.name}`} className="size-6 shrink-0 cursor-pointer rounded border-none bg-transparent p-0" onChange={e => commit(ops.updateZone(net, z.id, { color: e.target.value }), `zc:${z.id}`)} />
              <Input key={`${z.id}:${z.name}`} defaultValue={z.name} aria-label="Zone name" className="h-7 text-sm" onBlur={e => e.target.value.trim() && e.target.value !== z.name && commit(ops.updateZone(net, z.id, { name: e.target.value.trim().slice(0, 60) }))} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
              <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" aria-label={`Delete ${z.name}`} onClick={() => commit(ops.deleteZone(net, z.id))}><Trash2 /></Button>
            </div>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><IdChip id={z.id} /> {entries} entry point{entries === 1 ? "" : "s"} · {bld} building{bld === 1 ? "" : "s"}</span>
              {!!net.buildings?.length && (
                <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => commit(ops.setZone(net, buildingsInView().map(b => ({ kind: "building" as const, id: b.id })), z.id))}>Add buildings in view</Button>
              )}
            </div>
          </div>
        );
      })}
      <Button variant="outline" size="sm" className="justify-self-start" onClick={() => commit(ops.addZone(net)[0])}><Plus /> New zone</Button>

      {zones.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-xs font-medium">Vehicles per hour, from (rows) to (columns)</span>
          <div className="overflow-x-auto">
            <table className="text-xs">
              <thead>
                <tr><th />{zones.map(z => <th key={z.id} className="px-1 pb-1 text-center font-normal"><span className="inline-block size-2 rounded-full" style={{ background: z.color }} /> {z.name}</th>)}</tr>
              </thead>
              <tbody>
                {zones.map(a => (
                  <tr key={a.id}>
                    <th className="pr-2 text-left font-normal whitespace-nowrap"><span className="inline-block size-2 rounded-full" style={{ background: a.color }} /> {a.name}</th>
                    {zones.map(b => (
                      <td key={b.id} className="p-0.5">
                        <Input
                          key={`${a.id}:${b.id}:${rate(a.id, b.id)}`} defaultValue={rate(a.id, b.id) || ""} placeholder="0" inputMode="numeric" aria-label={`Vehicles per hour from ${a.name} to ${b.name}`}
                          className="h-7 w-16 px-1.5 text-right font-mono text-xs tabular"
                          onBlur={e => { const v = Math.max(0, Math.round(Number(e.target.value) || 0)); if (v !== rate(a.id, b.id)) commit(ops.setZoneFlow(net, a.id, b.id, v)); }}
                          onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {demand.length > 0 && sim && (
        <table className="w-full text-xs">
          <thead><tr className="text-muted-foreground"><th className="text-left font-normal">Trips</th><th className="text-right font-normal">/h</th><th className="text-right font-normal">Arrived</th><th className="text-right font-normal">Avg</th><th className="text-right font-normal">Queued</th></tr></thead>
          <tbody>
            {demand.map(f => {
              const r = sim.zoneFlow(f.id), za = zones.find(z => z.id === f.from), zb = zones.find(z => z.id === f.to);
              return (
                <tr key={f.id} className="border-t" title={r ? `sent ${r.sent}, driving ${r.inPlan}, ended elsewhere ${r.diverted}, stuck ${r.towed}${r.noRoute ? `, ${r.noRoute} attempts without a route` : ""}` : undefined}>
                  <td className="py-0.5">{za?.name} → {zb?.name}</td>
                  <td className="text-right font-mono tabular">{f.rate}</td>
                  <td className="text-right font-mono tabular">{r?.arrived ?? 0}</td>
                  <td className="text-right font-mono tabular">{r && r.arrived ? mmss(r.avgTravel) : "–"}</td>
                  <td className="text-right font-mono tabular">{r?.backlog ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Section>
  );
}
