"use client";

import { useSubject } from "subjecto/react";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Network, NodeDef } from "@/engine/types";
import type { FlowStats } from "@/engine/sim";
import { commit, network$, select, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { NumberField, Section, compass } from "./fields";

/** "Bulevardul Eroilor, NE edge": an entry point by its road and which side of the plan it is on */
export function entryLabel(net: Network, id: string): string {
  const n = ops.nodeById(net, id);
  if (!n) return "removed entry point";
  const road = net.links.find(l => l.from === id || l.to === id)?.name;
  const b = simController.compiled.bounds, side = compass(n.x - (b.minX + b.maxX) / 2, n.y - (b.minY + b.maxY) / 2).name;
  return `${road || "Entry"}, ${side} edge`;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** one-line result of a flow, plus a warning when it cannot run */
function FlowResult({ f }: { f: FlowStats | null }) {
  if (!f) return null;
  if (f.noRoute > 0 && f.sent === 0) return <p className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-500"><TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> No route from this entry to that exit.</p>;
  return (
    <p className="text-xs text-muted-foreground tabular">
      Sent {f.sent} · arrived {f.arrived}{f.arrived ? ` (avg ${mmss(f.avgTravel)})` : ""} · driving {f.inPlan}
      {f.backlog ? ` · ${f.backlog} waiting to enter` : ""}{f.diverted ? ` · ${f.diverted} left elsewhere` : ""}{f.towed ? ` · ${f.towed} stuck` : ""}
    </p>
  );
}

/** transit flows starting at (and arriving at) an entry point */
export function FlowsSection({ net, node }: { net: Network; node: NodeDef }) {
  useSubject(stats$); // live results (~4×/s)
  const sim = simController.sim;
  const out = (net.flows ?? []).filter(f => f.from === node.id), inn = (net.flows ?? []).filter(f => f.to === node.id);
  const exits = ops.entryPoints(net).filter(n => n.id !== node.id);
  return (
    <Section title="Transit flows">
      <p className="text-xs text-muted-foreground">
        Vehicles entering here and leaving at a chosen exit, e.g. through traffic crossing the area. They come on top of the car and truck totals.
      </p>
      {out.map(f => (
        <div key={f.id} className="grid gap-2 rounded-lg border p-2.5">
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-xs text-muted-foreground">Leaving at</Label>
              <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Delete this flow" onClick={() => commit(ops.deleteFlow(net, f.id))}><Trash2 /></Button>
            </div>
            <Select value={f.to} onValueChange={v => commit(ops.updateFlow(net, f.id, { to: v }))}>
              <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{exits.map(n => <SelectItem key={n.id} value={n.id}>{entryLabel(net, n.id)}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumberField id={`fr-${f.id}`} label="Vehicles per hour" unit="/h" value={f.rate} min={0} max={10000} step={10} digits={0} onCommit={v => commit(ops.updateFlow(net, f.id, { rate: Math.round(v) }), `fr:${f.id}`)} />
            <NumberField id={`ft-${f.id}`} label="Trucks" unit="%" value={Math.round((f.trucks ?? 0) * 100)} min={0} max={100} step={5} digits={0} onCommit={v => commit(ops.updateFlow(net, f.id, { trucks: v / 100 }), `ft:${f.id}`)} />
          </div>
          {sim && <FlowResult f={sim.flow(f.id)} />}
        </div>
      ))}
      <Button variant="outline" size="sm" className="justify-self-start" disabled={!exits.length} onClick={() => commit(ops.addFlow(net, node.id)[0])}>
        <Plus /> Add a flow from here
      </Button>
      {inn.length > 0 && (
        <div className="grid gap-1 text-xs">
          <span className="text-muted-foreground">Arriving here:</span>
          {inn.map(f => <button key={f.id} type="button" className="text-left underline-offset-2 hover:underline" onClick={() => select({ kind: "node", id: f.from })}>from {entryLabel(net, f.from)} · {f.rate}/h</button>)}
        </div>
      )}
    </Section>
  );
}

/** every transit flow with its live results (Traffic panel) */
export function FlowsTable() {
  const [net] = useSubject(network$);
  useSubject(stats$);
  const sim = simController.sim;
  const flows = net.flows ?? [];
  if (!flows.length) return null;
  return (
    <Section title="Transit flows">
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-muted-foreground"><th className="pb-1 text-left font-normal">From → to</th><th className="pb-1 text-right font-normal">/h</th><th className="pb-1 text-right font-normal">Arrived</th><th className="pb-1 text-right font-normal">Avg</th></tr></thead>
        <tbody>
          {flows.map(f => {
            const r = sim?.flow(f.id) ?? null;
            return (
              <tr key={f.id} className="cursor-pointer border-t align-top hover:bg-accent" onClick={() => { select({ kind: "node", id: f.from }); ui.getValue().panel = "inspect"; }}
                title={r ? `sent ${r.sent}, driving ${r.inPlan}, waiting to enter ${r.backlog}, left elsewhere ${r.diverted}, stuck ${r.towed}` : undefined}>
                <td className="py-1 text-xs">{entryLabel(net, f.from)}<br /><span className="text-muted-foreground">→ {entryLabel(net, f.to)}</span></td>
                <td className="py-1 text-right font-mono tabular">{f.rate}</td>
                <td className="py-1 text-right font-mono tabular">{r ? (r.noRoute > 0 && r.sent === 0 ? "no route" : r.arrived) : "–"}</td>
                <td className="py-1 text-right font-mono tabular">{r && r.arrived ? mmss(r.avgTravel) : "–"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {!sim && <p className="text-xs text-muted-foreground">Run traffic to see the results. Select an entry point to add or change flows.</p>}
    </Section>
  );
}
