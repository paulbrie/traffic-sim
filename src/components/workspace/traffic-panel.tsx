"use client";

import { useEffect, useRef } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { select, setSettings, settings$, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { sendView } from "@/state/commands";
import { junctionRefs } from "@/engine/refs";
import { EventLogPanel } from "./event-log";
import { NumberField, Section } from "./fields";

export function TrafficPanel() {
  const [settings] = useSubject(settings$);
  const [display, setDisplay] = useDeepSubject(ui, "display");
  const [stats] = useSubject(stats$);
  // slider for quick changes, plus a box to type any amount up to `hardMax`
  const slider = (id: string, label: string, value: number, max: number, step: number, hardMax: number, on: (v: number) => void) => (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-sm">{label}</Label>
        <Input
          key={`${id}:${value}`} defaultValue={String(value)} inputMode="numeric" aria-label={`${label} (number)`}
          className="h-7 w-20 text-right font-mono text-xs tabular"
          onBlur={e => { const n = Math.round(Math.max(0, Math.min(hardMax, Number(e.target.value) || 0))); if (n !== value) on(n); }}
          onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <Slider id={id} min={0} max={Math.max(max, value)} step={step} value={[value]} onValueChange={([v]) => on(v)} />
    </div>
  );
  return (
    <div>
      <Section title="Demand">
        {slider("cars", "Cars in the plan", settings.cars, 2000, 10, 5000, v => setSettings({ ...settings, cars: v }))}
        {slider("trucks", "Trucks", settings.trucks, 400, 2, 1000, v => setSettings({ ...settings, trucks: v }))}
        <div className="grid grid-cols-[1fr_auto] items-end gap-2">
          <NumberField id="seed" label="Random seed" value={settings.seed} digits={0} min={1} onCommit={v => setSettings({ ...settings, seed: Math.round(v) })} />
          <Button variant="outline" size="sm" className="h-8" onClick={() => { ui.getValue().sim.epoch++; }}><RotateCcw /> Restart</Button>
        </div>
        <p className="text-xs text-muted-foreground">Vehicles enter at the square entry points and at random along roads. Same seed and same plan give the same run.</p>
      </Section>
      <Section title="Live">
        {stats ? (
          <>
            <div className="grid grid-cols-3 gap-2">
              <Stat label="Vehicles" value={String(stats.count)} />
              <Stat label="Avg km/h" value={stats.avgSpeed.toFixed(1)} />
              <Stat label="Stopped" value={`${Math.round(stats.stopped * 100)}%`} />
              <Stat label="Trips/min" value={String(Math.round(stats.tripsPerMin))} />
              <Stat label="Boarded" value={String(stats.boarded)} />
              <Stat label="Towed" value={String(stats.towed)} />
            </div>
            <Spark data={stats.history.map(h => h.speed)} />
          </>
        ) : <p className="text-sm text-muted-foreground">Press play to run traffic on this plan.</p>}
      </Section>
      <JunctionTable />
      <Section title="Event log"><EventLogPanel /></Section>
      <Section title="Display">
        {([
          ["bySpeed", "Colour vehicles by speed"],
          ["reservations", "Show junction reservations"],
          ["labels", "Show stop names"],
          ["junctions", "Show junction numbers and stats"],
        ] as const).map(([k, label]) => (
          <label key={k} className="flex items-center justify-between gap-2 text-sm">
            <span>{label}</span>
            <Switch checked={display[k]} onCheckedChange={v => setDisplay({ ...display, [k]: v })} />
          </label>
        ))}
      </Section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/60 px-2 py-1.5">
      <div className="font-mono text-base font-semibold tabular">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  );
}

function Spark({ data }: { data: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1), W = c.clientWidth, H = 64;
    c.width = W * dpr; c.height = H * dpr;
    const g = c.getContext("2d")!; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const cs = getComputedStyle(c), col = cs.getPropertyValue("--primary").trim() || "#1f7a5a", grid = cs.getPropertyValue("--border").trim() || "#ddd", muted = cs.getPropertyValue("--muted-foreground").trim() || "#888";
    const top = Math.max(30, Math.ceil(Math.max(0, ...data) / 10) * 10), y = (v: number) => H - 12 - (v / top) * (H - 20), pad = 22;
    g.strokeStyle = grid; g.lineWidth = 1; g.fillStyle = muted; g.font = "10px ui-monospace, monospace"; g.textBaseline = "middle";
    for (const v of [0, top / 2, top]) { g.beginPath(); g.moveTo(pad, y(v)); g.lineTo(W, y(v)); g.stroke(); g.fillText(String(v), 0, y(v)); }
    if (data.length < 2) return;
    const x = (i: number) => pad + (i / 179) * (W - pad - 4);
    g.beginPath(); g.moveTo(x(0), y(0)); data.forEach((v, i) => g.lineTo(x(i), y(v))); g.lineTo(x(data.length - 1), y(0)); g.closePath();
    g.globalAlpha = 0.15; g.fillStyle = col; g.fill(); g.globalAlpha = 1;
    g.beginPath(); data.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.strokeStyle = col; g.lineWidth = 1.6; g.stroke();
  }, [data]);
  return (
    <div>
      <div className="mb-1 text-[11px] text-muted-foreground">Average speed, last 3 min (km/h)</div>
      <canvas ref={ref} className="block h-16 w-full" aria-label="Average speed over the last three minutes" />
    </div>
  );
}

/** every junction with its reference and live numbers; click a row to jump to it */
function JunctionTable() {
  useSubject(stats$);
  const sim = simController.sim, c = simController.compiled;
  const refs = junctionRefs(c);
  if (!refs.size) return null;
  const rows = c.nodes.filter(n => refs.has(n.def.id)).map(n => ({ n, ref: refs.get(n.def.id)!, st: sim ? sim.junctionStats(n.idx) : null }));
  if (sim) rows.sort((a, b) => b.st!.waiting - a.st!.waiting);
  const ctl = { priority: "priority", stop: "all-way stop", lights: "lights", roundabout: "roundabout" } as const;
  return (
    <Section title="Junctions">
      <div className="overflow-hidden rounded-md border text-xs">
        <table className="w-full">
          <thead className="bg-muted/50 text-left text-[10px] text-muted-foreground">
            <tr><th className="px-2 py-1 font-medium">Ref</th><th className="px-2 py-1 font-medium">Control</th><th className="px-2 py-1 text-right font-medium">/min</th><th className="px-2 py-1 text-right font-medium">Waiting</th></tr>
          </thead>
          <tbody>
            {rows.map(({ n, ref, st }) => (
              <tr
                key={n.def.id} className="cursor-pointer border-t hover:bg-muted/50"
                onClick={() => { select({ kind: "node", id: n.def.id }); sendView("focus", n.pos.x, n.pos.y); ui.getValue().panel = "inspect"; }}
              >
                <td className="px-2 py-1 font-mono font-semibold">{ref}</td>
                <td className="px-2 py-1 text-muted-foreground">{ctl[n.def.control]}</td>
                <td className="px-2 py-1 text-right font-mono tabular">{st ? st.perMin.toFixed(0) : "–"}</td>
                <td className={"px-2 py-1 text-right font-mono tabular" + (st && st.waiting >= 12 ? " font-semibold text-destructive" : "")}>{st ? st.waiting : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">Sorted by vehicles waiting. Click a row to select the junction; turn on the map labels below to see these numbers on the plan.</p>
    </Section>
  );
}
