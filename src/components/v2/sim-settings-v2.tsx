"use client";

import { useState } from "react";
import { Dices, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { resolveTuning, sanitizeTuning, TUNE_GROUPS, TUNING, type TuneInfo, type Tuning } from "@/lib/sketch-tuning";
import type { SimParams } from "@/lib/lane-sketch-sim";

const digits = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
const fmt = (t: TuneInfo, v: number) => `${v.toFixed(digits(t.step))}${t.unit ? ` ${t.unit}` : ""}`;

/**
 * The V2 simulation's settings (as V1's Simulation settings): a button in the Traffic panel opening them beside
 * the map. Saved with the plan, applied to the running cars straight away; the seed when the cars restart.
 */
export function SimSettingsButton({ params, setParams, readOnly }: { params: SimParams; setParams: (p: SimParams) => void; readOnly: boolean }) {
  const [open, setOpen] = useState(false);
  const changed = Object.keys(params.tune ?? {}).length + (params.seed !== undefined && params.seed !== 1 ? 1 : 0);
  return (
    <>
      <Button variant="outline" size="sm" className="h-8 w-full justify-start" onClick={() => setOpen(true)}>
        <SlidersHorizontal /> Simulation settings{changed ? <span className="ml-auto text-xs text-muted-foreground">{changed} changed</span> : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} modal={false}>
        <DialogContent overlay={false} className="top-16 right-4 left-auto max-h-[calc(100vh-6rem)] translate-x-0 translate-y-0 overflow-y-auto sm:max-w-md"
          onInteractOutside={e => e.preventDefault()}>
          <SimSettings params={params} setParams={setParams} readOnly={readOnly} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function SimSettings({ params, setParams, readOnly }: { params: SimParams; setParams: (p: SimParams) => void; readOnly: boolean }) {
  const T = resolveTuning(params.tune), changed = Object.keys(params.tune ?? {}).length;
  const set = (patch: Partial<Tuning>) => { const tune = sanitizeTuning({ ...T, ...patch }); const { tune: _, ...rest } = params; setParams(tune ? { ...rest, tune } : rest); };
  const [seedText, setSeedText] = useState(String(params.seed ?? 1));
  const setSeed = (n: number) => { const seed = Math.max(1, Math.min(1e9, Math.round(n))); setSeedText(String(seed)); setParams({ ...params, seed }); };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Simulation settings</DialogTitle>
        <DialogDescription>Saved with the plan and applied to the running cars straight away. A new seed gives another run of the same traffic; it applies when the cars restart (↺).</DialogDescription>
      </DialogHeader>
      <div className="flex items-end gap-2">
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="sim-seed" className="text-sm">Random seed</Label>
          <Input id="sim-seed" inputMode="numeric" className="h-8 font-mono" disabled={readOnly} value={seedText}
            onChange={e => setSeedText(e.target.value)} onBlur={() => { const n = Number(seedText); if (Number.isFinite(n) && n >= 1) setSeed(n); else setSeedText(String(params.seed ?? 1)); }}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </div>
        <Button variant="outline" size="sm" className="h-8" disabled={readOnly} title="Another seed, at random" onClick={() => setSeed(1 + Math.floor(Math.random() * 99999))}><Dices /> New seed</Button>
        <Button variant="ghost" size="sm" className="h-8" disabled={readOnly || !changed} onClick={() => { const { tune: _, ...rest } = params; setParams(rest); }}>
          <RotateCcw /> Reset all
        </Button>
      </div>
      <div className="grid gap-5 pt-1">
        {TUNE_GROUPS.map(g => (
          <section key={g} className="grid gap-3">
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</h3>
            {TUNING.filter(t => t.group === g).map(t => {
              const v = T[t.key], isDef = v === t.def, id = `tune-${t.key}`;
              return (
                <div key={t.key} className="grid gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={id} className="text-sm">{t.label}</Label>
                    <span className="flex items-center gap-1">
                      <span className={`font-mono text-xs tabular ${isDef ? "text-muted-foreground" : "font-semibold"}`}>{fmt(t, v)}</span>
                      <Button variant="ghost" size="icon" className="size-6" disabled={readOnly || isDef} aria-label={`Reset ${t.label} to ${fmt(t, t.def)}`} title={`Default ${fmt(t, t.def)}`}
                        onClick={() => set({ [t.key]: t.def })}><RotateCcw className="size-3" /></Button>
                    </span>
                  </div>
                  <Slider id={id} aria-label={`${t.label}${t.unit ? ` (${t.unit})` : ""}`} disabled={readOnly} min={t.min} max={t.max} step={t.step} value={[v]} onValueChange={([x]) => set({ [t.key]: +x.toFixed(digits(t.step)) })} />
                  <p className="text-xs text-muted-foreground">{t.help}</p>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}
