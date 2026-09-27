"use client";

import { useDeepSubject, useSubject } from "subjecto/react";
import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { commit, network$, select, ui } from "@/state/store";
import * as ops from "@/state/ops";
import { cn } from "@/lib/utils";
import { Section } from "./fields";

export function LinesPanel() {
  const [net] = useSubject(network$);
  const [sel] = useDeepSubject(ui, "selection");
  const active = sel?.kind === "line" ? net.lines.find(l => l.id === sel.id) : null;
  return (
    <div>
      <Section title="Bus lines">
        {net.lines.length === 0 && <p className="text-sm text-muted-foreground">Place bus stops with the Bus stop tool, then create a line and add its stops in order.</p>}
        <ul className="grid gap-1">
          {net.lines.map(l => (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => select({ kind: "line", id: l.id })}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent", active?.id === l.id && "bg-accent")}
              >
                <span className="size-3 rounded-full" style={{ background: l.color }} />
                <span className="flex-1 truncate">{l.name}</span>
                <span className="text-xs text-muted-foreground tabular">{l.stops.length} stops · {l.buses} buses</span>
              </button>
            </li>
          ))}
        </ul>
        <Button variant="outline" size="sm" onClick={() => { const [n, line] = ops.addLine(net); commit(n); select({ kind: "line", id: line.id }); }}><Plus /> New line</Button>
      </Section>
      {active && (
        <Section title="Edit line">
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ln" className="text-xs text-muted-foreground">Name</Label>
              <Input id="ln" className="h-8" defaultValue={active.name} key={active.id} onBlur={e => e.target.value !== active.name && commit(ops.updateLine(net, active.id, { name: e.target.value }))} />
            </div>
            <input aria-label="Line colour" type="color" value={active.color} onChange={e => commit(ops.updateLine(net, active.id, { color: e.target.value }), `lc:${active.id}`)} className="h-8 w-10 cursor-pointer rounded-md border bg-transparent p-0.5" />
          </div>
          <div className="grid gap-2">
            <div className="flex justify-between text-sm"><span>Buses</span><span className="font-mono text-xs tabular">{active.buses}</span></div>
            <Slider min={0} max={20} step={1} value={[active.buses]} onValueChange={([v]) => commit(ops.updateLine(net, active.id, { buses: v }), `lb:${active.id}`)} />
          </div>
          <div className="grid gap-1">
            <div className="text-xs text-muted-foreground">Stops in order (buses loop back to the first)</div>
            <ol className="grid gap-1">
              {active.stops.map((sid, i) => {
                const s = net.stops.find(x => x.id === sid);
                const move = (d: number) => { const arr = active.stops.slice(); const j = i + d; [arr[i], arr[j]] = [arr[j], arr[i]]; commit(ops.updateLine(net, active.id, { stops: arr })); };
                return (
                  <li key={`${sid}-${i}`} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
                    <span className="w-5 font-mono text-xs text-muted-foreground tabular">{i + 1}</span>
                    <span className="flex-1 truncate">{s?.name ?? "?"}</span>
                    <Button variant="ghost" size="icon-sm" className="size-6" disabled={i === 0} onClick={() => move(-1)} aria-label="Move up"><ArrowUp /></Button>
                    <Button variant="ghost" size="icon-sm" className="size-6" disabled={i === active.stops.length - 1} onClick={() => move(1)} aria-label="Move down"><ArrowDown /></Button>
                    <Button variant="ghost" size="icon-sm" className="size-6" onClick={() => commit(ops.updateLine(net, active.id, { stops: active.stops.filter((_, k) => k !== i) }))} aria-label="Remove stop"><X /></Button>
                  </li>
                );
              })}
            </ol>
            {net.stops.length > 0 && (
              <Select value="" onValueChange={v => commit(ops.updateLine(net, active.id, { stops: [...active.stops, v] }))}>
                <SelectTrigger size="sm" className="w-full"><SelectValue placeholder="Add a stop…" /></SelectTrigger>
                <SelectContent>{net.stops.map(s => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {active.stops.length < 2 && <p className="text-xs text-muted-foreground">A line needs at least two stops before buses run.</p>}
          </div>
          <Button variant="ghost" size="sm" className="justify-start text-destructive" onClick={() => { commit(ops.deleteLine(net, active.id)); select(null); }}><Trash2 /> Delete line</Button>
        </Section>
      )}
    </div>
  );
}
