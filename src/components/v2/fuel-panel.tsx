"use client";

import type { FuelStats } from "@/lib/lane-sketch-sim";
import { InspectorPanel } from "./inspector-panel";

/** litres, or millilitres under one litre */
export const fmtFuel = (l: number) => (l < 1 ? `${Math.round(l * 1000)} mL` : `${l.toFixed(l < 10 ? 2 : 1)} L`);
/** kilograms, or grams under one */
const fmtKg = (kg: number) => (kg < 1 ? `${Math.round(kg * 1000)} g` : kg < 1000 ? `${kg.toFixed(kg < 10 ? 2 : 1)} kg` : `${(kg / 1000).toFixed(2)} t`);
const pct = (part: number, all: number) => (all > 0 ? `${Math.round((100 * part) / all)}%` : "–");

function Tile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md border px-2 py-1.5 text-center" title={title}>
      <div className="font-mono text-sm font-semibold tabular">{value}</div>
      <div className="text-[10px] text-muted-foreground">{label}</div>
    </div>
  );
}

/**
 * The V2 editor's fuel and emissions, as V1's Fuel section for the whole plan: what every vehicle burnt
 * since the cars started (from its speed and acceleration), the part standing still in traffic, per 100 km
 * and per trip, and the CO₂ from it. Idle rates and stop-start engines are in the simulation settings.
 */
export function FuelPanel({ fuel }: { fuel: FuelStats }) {
  const F = fuel;
  return (
    <InspectorPanel id="fuel" title="Fuel and emissions">
      <div className="grid grid-cols-2 gap-2">
        <Tile label="Burnt" value={fmtFuel(F.total)} title={`${F.km.toFixed(1)} km driven`} />
        <Tile label={`Standing still (${pct(F.idle, F.total)})`} value={fmtFuel(F.idle)} title={`${Math.round(F.idleTime / 60)} vehicle-minutes standing still in traffic`} />
        <Tile label="Per 100 km" value={F.km > 0.5 ? `${((100 * F.total) / F.km).toFixed(1)} L` : "–"} />
        <Tile label="Per trip" value={F.trips ? fmtFuel(F.tripFuel / F.trips) : "–"} title={`${F.trips} trips finished`} />
        <Tile label="CO₂" value={fmtKg(F.co2)} title="2.31 kg a litre of petrol (cars), 2.64 kg a litre of diesel (trucks)" />
        <Tile label="CO₂ per km" value={F.km > 0.5 ? `${Math.round((1000 * F.co2) / F.km)} g` : "–"} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Since the cars started, from each vehicle&apos;s speed and acceleration (V1&apos;s fuel model). Standing still: engines idling at red lights and in queues.
        Idle rates and stop-start engines are in the simulation settings.
      </p>
    </InspectorPanel>
  );
}
