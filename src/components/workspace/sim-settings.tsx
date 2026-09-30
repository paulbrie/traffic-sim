"use client";

import { useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PARAM_GROUPS, PARAMS, type ParamGroup, resolveParams, sanitizeParams, type ParamInfo, type SimParams } from "@/engine/params";
import { setSettings, settings$, ui } from "@/state/store";

const TABS: { id: string; label: string; groups: ParamGroup[] }[] = [
  { id: "traffic", label: "Traffic", groups: PARAM_GROUPS.filter(g => g !== "Junctions") },
  { id: "junctions", label: "Junctions", groups: ["Junctions"] },
];
const digits = (step: number) => (step >= 1 ? 0 : step >= 0.1 ? 1 : 2);
const fmt = (p: ParamInfo, v: number) => `${v.toFixed(digits(p.step))}${p.unit ? ` ${p.unit}` : ""}`;

/** the simulation's parameters, grouped; changes apply to the running simulation at once */
export function SimSettingsButton() {
  const [open, setOpen] = useState(false);
  const [settings] = useSubject(settings$);
  const changed = Object.keys(settings.params ?? {}).length;
  return (
    <>
      <Button variant="outline" size="sm" className="h-8 w-full justify-start" onClick={() => setOpen(true)}>
        <SlidersHorizontal /> Simulation settings{changed ? <span className="ml-auto text-xs text-muted-foreground">{changed} changed</span> : null}
      </Button>
      <Dialog open={open} onOpenChange={setOpen} modal={false}>
        <DialogContent
          overlay={false}
          className="top-16 right-4 left-auto max-h-[calc(100vh-6rem)] translate-x-0 translate-y-0 overflow-y-auto sm:max-w-md"
          onInteractOutside={e => e.preventDefault()}
        >
          <SimSettings />
        </DialogContent>
      </Dialog>
    </>
  );
}

function SimSettings() {
  const [settings] = useSubject(settings$);
  const [readOnly] = useDeepSubject(ui, "readOnly");
  const P = resolveParams(settings.params);
  const changed = Object.keys(settings.params ?? {}).length;
  const set = (patch: Partial<SimParams>) => setSettings({ ...settings, params: sanitizeParams({ ...P, ...patch }) });
  return (
    <>
      <DialogHeader>
        <DialogTitle>Simulation settings</DialogTitle>
        <DialogDescription>
          Saved with the plan and applied to the running simulation straight away. Driver and truck settings apply to
          vehicles that enter from now on (Restart to apply them to everyone).
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" disabled={readOnly || !changed} onClick={() => setSettings({ ...settings, params: undefined })}>
          <RotateCcw /> Reset all to defaults
        </Button>
      </div>
      <Tabs defaultValue="traffic">
        <TabsList className="w-full">
          {TABS.map(t => <TabsTrigger key={t.id} value={t.id}>{t.label}</TabsTrigger>)}
        </TabsList>
        {TABS.map(t => (
          <TabsContent key={t.id} value={t.id} className="grid gap-5 pt-2">
          {PARAM_GROUPS.filter(g => t.groups.includes(g)).map(g => (
            <section key={g} className="grid gap-3">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g}</h3>
              {PARAMS.filter(p => p.group === g).map(p => {
                const v = P[p.key], isDef = v === p.def, id = `param-${p.key}`;
                return (
                  <div key={p.key} className="grid gap-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={id} className="text-sm">{p.label}</Label>
                      <span className="flex items-center gap-1">
                        <span className={`font-mono text-xs tabular ${isDef ? "text-muted-foreground" : "font-semibold"}`}>{fmt(p, v)}</span>
                        <Button
                          variant="ghost" size="icon" className="size-6" disabled={readOnly || isDef}
                          aria-label={`Reset ${p.label} to ${fmt(p, p.def)}`} title={`Default ${fmt(p, p.def)}`}
                          onClick={() => set({ [p.key]: p.def })}
                        >
                          <RotateCcw className="size-3" />
                        </Button>
                      </span>
                    </div>
                    <Slider id={id} disabled={readOnly} min={p.min} max={p.max} step={p.step} value={[v]} onValueChange={([x]) => set({ [p.key]: +x.toFixed(digits(p.step)) })} />
                    <p className="text-xs text-muted-foreground">{p.help}</p>
                  </div>
                );
              })}
            </section>
          ))}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
