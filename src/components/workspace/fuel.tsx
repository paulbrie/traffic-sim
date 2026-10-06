"use client";

import { useDeepSubject, useSubject } from "subjecto/react";
import { Switch } from "@/components/ui/switch";
import { FUEL_APPROACH } from "@/engine/sim";
import type { Network, NodeDef } from "@/engine/types";
import { setSettings, settings$, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { Section, compass } from "./fields";

/** litres, or millilitres under one litre */
export const fmtFuel = (l: number) => (l < 1 ? `${Math.round(l * 1000)} mL` : `${l.toFixed(l < 10 ? 2 : 1)} L`);
const pct = (part: number, all: number) => (all > 0 ? `${Math.round((100 * part) / all)}%` : "–");

function Tile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md border px-2 py-1.5 text-center" title={title}>
      <div className="font-mono text-sm font-semibold tabular">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

/** Traffic panel: measure the whole plan's fuel, and what was burnt so far */
export function PlanFuelSection() {
  const [settings] = useSubject(settings$);
  const [stats] = useSubject(stats$);
  const on = settings.fuel === true, F = on ? stats?.fuel : undefined;
  return (
    <Section title="Fuel">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Measure fuel for the whole plan</span>
        <Switch checked={on} onCheckedChange={v => setSettings({ ...settings, fuel: v || undefined })} aria-label="Measure fuel for the whole plan" />
      </label>
      {F ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Burnt" value={fmtFuel(F.total)} title={`${F.km.toFixed(1)} km driven`} />
            <Tile label={`Standing still (${pct(F.idle, F.total)})`} value={fmtFuel(F.idle)} title={`${Math.round(F.idleTime / 60)} vehicle-minutes standing still in traffic`} />
            <Tile label="Per 100 km" value={F.km > 0.5 ? `${((100 * F.total) / F.km).toFixed(1)} L` : "–"} />
            <Tile label="Per trip" value={F.trips ? fmtFuel(F.tripFuel / F.trips) : "–"} title={`${F.trips} trips finished since fuel was switched on`} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Since it was switched on. Standing still: engines idling in traffic (at red lights, in queues), not buses at stops. Idle rates and
            stop-start engines are in the simulation settings.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {on ? "Run traffic to see the readings." : "Works out what every vehicle burns from its speed and acceleration, and how much of it standing still. To measure only some junctions, switch fuel on in their inspector."}
        </p>
      )}
    </Section>
  );
}

/** Junction inspector: measure fuel here, and what was burnt on the roads leading in and in the junction */
export function JunctionFuelSection({ net, node, nodeIdx }: { net: Network; node: NodeDef; nodeIdx: number }) {
  useSubject(stats$); // live readings (~4×/s)
  const [settings] = useSubject(settings$);
  const [readOnly] = useDeepSubject(ui, "readOnly");
  const sim = simController.sim, all = settings.fuel === true, mine = settings.fuelNodes?.includes(node.id) ?? false, on = all || mine;
  // (a plan setting: the running traffic carries on, measuring here from now)
  const toggle = (v: boolean) => {
    const rest = (settings.fuelNodes ?? []).filter(id => id !== node.id), next = v ? [...rest, node.id] : rest;
    setSettings({ ...settings, fuelNodes: next.length ? next : undefined });
  };
  const f = on && sim ? sim.junctionFuel(nodeIdx) : null;
  const ins = simController.compiled.nodes[nodeIdx]?.arms.filter(a => a.inEdge).map(a => a.inEdge!) ?? [];
  const name = (i: number) => {
    const e = ins[i]; if (!e) return "Road";
    const A = ops.nodeById(net, e.dir === 1 ? e.link.from : e.link.to), B = ops.nodeById(net, e.dir === 1 ? e.link.to : e.link.from);
    return `${e.link.name || "Road"}${A && B ? ` (heading ${compass(B.x - A.x, B.y - A.y).name})` : ""}`;
  };
  return (
    <Section title="Fuel">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Measure fuel at this junction</span>
        <Switch checked={on} disabled={all || readOnly} onCheckedChange={toggle} aria-label="Measure fuel at this junction" />
      </label>
      {all && <p className="text-xs text-muted-foreground">Measured at every junction: fuel is on for the whole plan (Traffic panel).</p>}
      {on && (f ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <Tile label="Burnt" value={fmtFuel(f.total)} title={`${fmtFuel(f.inside)} of it crossing the junction`} />
            <Tile label={`Standing still (${pct(f.idle, f.total)})`} value={fmtFuel(f.idle)} title={`${Math.round(f.idleTime / 60)} vehicle-minutes standing still`} />
            <Tile label="Idling per vehicle" value={f.crossed ? `${((1000 * f.idle) / f.crossed).toFixed(1)} mL` : "–"} title={`${f.crossed} vehicles crossed${f.crossed ? `, each standing still ${(f.idleTime / f.crossed).toFixed(0)} s on average` : ""}`} />
          </div>
          <table className="w-full text-xs">
            <thead><tr className="text-muted-foreground"><th className="pb-1 text-left font-normal">Road leading in</th><th className="pb-1 text-right font-normal">Burnt</th><th className="pb-1 text-right font-normal">Standing still</th></tr></thead>
            <tbody>
              {f.approaches.map((a, i) => (
                <tr key={i} className="border-t">
                  <td className="truncate py-1">{name(i)}</td>
                  <td className="py-1 text-right font-mono tabular">{fmtFuel(a.total)}</td>
                  <td className="py-1 text-right font-mono tabular">{fmtFuel(a.idle)}</td>
                </tr>
              ))}
              <tr className="border-t"><td className="py-1">In the junction</td><td className="py-1 text-right font-mono tabular">{fmtFuel(f.inside)}</td><td /></tr>
            </tbody>
          </table>
          <p className="text-[11px] text-muted-foreground">
            On the last {FUEL_APPROACH} m of each road leading in, and crossing. Standing still: waiting for green or in the queue, engine idling.
          </p>
        </>
      ) : <p className="text-xs text-muted-foreground">{sim ? "Waiting for the first reading…" : `Run traffic to see what vehicles burn on the last ${FUEL_APPROACH} m before this junction, and how much of it waiting.`}</p>)}
    </Section>
  );
}
