"use client";

import { useSubject } from "subjecto/react";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { commit, settings$, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import type { LinkDef, Network, ReversibleDef, ReversibleMode } from "@/engine/types";
import { cn } from "@/lib/utils";
import { NumberField, Section, compass } from "./fields";

const MODES: { id: ReversibleMode; label: string; help: string }[] = [
  { id: "timer", label: "Timer", help: "Opens one way, then the other, for set times." },
  { id: "dynamic", label: "Traffic", help: "Detectors along the road: opens to the busier direction once it is busy, and switches when the other way gets clearly busier." },
  { id: "manual", label: "By hand", help: "Stays as set here; switch it with the buttons while traffic runs." },
];

/**
 * A road's reversible middle lane (the corridor it belongs to): add one, its directions and live state,
 * switching it by hand, how it decides (timer, traffic, by hand), and its roads.
 */
export function ReversibleSection({ net, link }: { net: Network; link: LinkDef }) {
  if (link.lanesF === 0 || link.lanesB === 0) return null;
  const def = link.rev ? net.reversibles?.find(r => r.id === link.rev) : undefined;
  return <Section title="Reversible lane">{def ? <CorridorPanel net={net} link={link} def={def} /> : <AddReversible net={net} link={link} />}</Section>;
}

function AddReversible({ net, link }: { net: Network; link: LinkDef }) {
  const chain = ops.straightChain(net, link.id).filter(id => !ops.linkById(net, id)?.rev);
  const km = chain.reduce((a, id) => { const l = ops.linkById(net, id)!, A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!; return a + ops.linkLength(l, A, B); }, 0) / 1000;
  const add = (whole: boolean) => { const [n2] = ops.addReversible(net, link.id, whole); commit(n2); };
  return (
    <>
      <p className="text-xs text-muted-foreground">A middle lane opened to one direction at a time, with lane signs over every lane (green arrow, red X, yellow arrow to move over). Turns are made from the fixed lanes.</p>
      <div className="grid gap-1.5">
        {chain.length > 1 && <Button size="sm" onClick={() => add(true)}>Along the whole road ({chain.length} roads, {km.toFixed(km < 10 ? 2 : 1)} km)</Button>}
        <Button size="sm" variant={chain.length > 1 ? "outline" : "default"} onClick={() => add(false)}>On this road only</Button>
      </div>
      {chain.length > 1 && <p className="text-[11px] text-muted-foreground">The whole road runs straight on through its junctions, up to a roundabout or the edge of the plan.</p>}
    </>
  );
}

function CorridorPanel({ net, link, def }: { net: Network; link: LinkDef; def: ReversibleDef }) {
  useSubject(stats$); // live state (~4×/s)
  const [settings] = useSubject(settings$);
  const hold = settings.revHold?.[def.id] ?? null, readOnly = ui.getValue().readOnly;
  const c = simController.compiled.corridors.find(x => x.def.id === def.id);
  const set = (patch: Partial<Omit<ReversibleDef, "id">>, key?: string) => commit(ops.updateReversible(net, def.id, patch), key);
  const roads = net.links.filter(l => l.rev === def.id);
  const first = c?.nodes[0], last = c?.nodes[c.nodes.length - 1];
  const d1 = first && last ? compass(last.pos.x - first.pos.x, last.pos.y - first.pos.y).name : "1";
  const d2 = first && last ? compass(first.pos.x - last.pos.x, first.pos.y - last.pos.y).name : "2";
  const name = (d: "1" | "2") => `towards ${d === "1" ? d1 : d2}`;
  const sim = simController.sim, live = c && sim ? sim.rev[c.idx] : undefined;
  const status = !live ? null : (["Closed", `Open ${name("1")}`, `Closing (was ${name("1")})`, `Open ${name("2")}`, `Closing (was ${name("2")})`] as const)[live.state];
  const tone = !live ? "" : live.state === 1 || live.state === 3 ? "text-[var(--sig-go)]" : live.state === 0 ? "text-destructive" : "text-amber-600 dark:text-amber-400";
  const cmd = (x: "closed" | "1" | "2" | "auto") => simController.reversibleCommand(def.id, x);
  const atEnd = c ? c.links[0].id === link.id || c.links[c.links.length - 1].id === link.id : true;
  const extended = ops.extendReversible(net, def.id);
  const min = (s: number) => Math.round((s / 60) * 10) / 10;
  return (
    <>
      <Input key={`${def.id}:${def.name}`} className="h-8" defaultValue={def.name} aria-label="Name of the reversible lane"
        onBlur={e => e.target.value.trim() && e.target.value !== def.name && set({ name: e.target.value.trim().slice(0, 80) })} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      {c ? (
        <p className="text-xs text-muted-foreground">{roads.length} road{roads.length === 1 ? "" : "s"}, {(c.length / 1000).toFixed(2)} km. Direction 1 runs {name("1")}, direction 2 {name("2")}.</p>
      ) : (
        <p className="text-xs text-destructive">Its roads don&apos;t make one continuous road, so the lane stays closed. Take out the road that breaks it, or remove the lane.</p>
      )}

      {c && (
        <div className="grid gap-2 rounded-md border p-2.5">
          <div className="flex items-baseline justify-between gap-2">
            <span className={cn("text-sm font-medium", tone)}>{status ?? "Traffic not running"}</span>
            <span className="text-[11px] text-muted-foreground tabular">{live ? `${Math.round(live.t)} s` : ""}{hold ? `${live ? " · " : ""}set by hand: ${hold === "closed" ? "closed" : `open ${name(hold)}`}` : ""}</span>
          </div>
          {live && (live.state === 2 || live.state === 4) && <p className="text-xs text-muted-foreground">Entries shut; {live.inside} vehicle{live.inside === 1 ? "" : "s"} still driving out of the lane.</p>}
          {live && def.mode === "dynamic" && <p className="text-[11px] text-muted-foreground tabular">Traffic: {live.density[0].toFixed(0)} vehicles/km per lane {name("1")}, {live.density[1].toFixed(0)} {name("2")}.</p>}
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant={hold === "1" ? "secondary" : "outline"} className="h-7 text-xs" disabled={readOnly} aria-pressed={hold === "1"} onClick={() => cmd("1")}>Open {name("1")}</Button>
            <Button size="sm" variant={hold === "2" ? "secondary" : "outline"} className="h-7 text-xs" disabled={readOnly} aria-pressed={hold === "2"} onClick={() => cmd("2")}>Open {name("2")}</Button>
            <Button size="sm" variant={hold === "closed" ? "secondary" : "outline"} className="h-7 text-xs" disabled={readOnly} aria-pressed={hold === "closed"} onClick={() => cmd("closed")}>Close</Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={readOnly || !hold} onClick={() => cmd("auto")}>Back to {MODES.find(m => m.id === def.mode)!.label.toLowerCase()}</Button>
          </div>
          <p className="text-[11px] text-muted-foreground">Set by hand, it stays so (saved with the plan, also after a restart) until handed back. Switching always goes through closing: entries shut, the lane empties, then it stays closed for the gap below.</p>
        </div>
      )}

      <div className="grid gap-2">
        <ToggleGroup type="single" className="w-full" value={def.mode} onValueChange={v => v && set({ mode: v as ReversibleMode })} aria-label="How the lane is switched">
          {MODES.map(m => <ToggleGroupItem key={m.id} value={m.id} className="h-7 flex-1 text-xs">{m.label}</ToggleGroupItem>)}
        </ToggleGroup>
        <p className="text-[11px] text-muted-foreground">{MODES.find(m => m.id === def.mode)!.help}</p>
        {def.mode === "timer" && (
          <div className="grid grid-cols-2 gap-2">
            <NumberField id="rv-open1" label={`Open ${name("1")}`} unit="min" value={min(def.open1)} min={0} max={240} step={1} digits={1} onCommit={v => set({ open1: Math.round(v * 60) }, `rv1:${def.id}`)} />
            <NumberField id="rv-open2" label={`Open ${name("2")}`} unit="min" value={min(def.open2)} min={0} max={240} step={1} digits={1} onCommit={v => set({ open2: Math.round(v * 60) }, `rv2:${def.id}`)} />
          </div>
        )}
        {def.mode === "dynamic" && (
          <div className="grid grid-cols-2 gap-2">
            <NumberField id="rv-dens" label="Busy from" unit="veh/km" value={def.minDensity} min={1} max={150} step={1} digits={0} onCommit={v => set({ minDensity: v }, `rvd:${def.id}`)} />
            <NumberField id="rv-ratio" label="Switch when busier by" unit="×" value={def.ratio} min={1.05} max={10} step={0.1} digits={2} onCommit={v => set({ ratio: v }, `rvr:${def.id}`)} />
            <NumberField id="rv-minopen" label="Open at least" unit="min" value={min(def.minOpen)} min={0.5} max={60} step={0.5} digits={1} onCommit={v => set({ minOpen: Math.round(v * 60) }, `rvm:${def.id}`)} />
          </div>
        )}
        {def.mode === "manual" && (
          <Select value={def.initial} onValueChange={v => set({ initial: v as ReversibleDef["initial"] })}>
            <SelectTrigger size="sm" className="w-full" aria-label="Set to"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="1">Open {name("1")}</SelectItem>
              <SelectItem value="2">Open {name("2")}</SelectItem>
            </SelectContent>
          </Select>
        )}
        <NumberField id="rv-gap" label="Closed between directions" unit="s" value={def.gap} min={0} max={600} step={5} digits={0} onCommit={v => set({ gap: Math.round(v) }, `rvg:${def.id}`)} />
      </div>

      <div className="flex flex-wrap gap-1.5">
        {c && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => set({ start: last!.def.id })}><ArrowLeftRight /> Swap directions 1 and 2</Button>}
        {extended !== net && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => commit(extended)}>Extend along the road</Button>}
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!atEnd} title={atEnd ? undefined : "Only a road at either end can be taken out (the rest must stay one road)"} onClick={() => commit(ops.leaveReversible(net, link.id))}>Take this road out</Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => commit(ops.deleteReversible(net, def.id))}><Trash2 /> Remove the lane</Button>
      </div>
    </>
  );
}
