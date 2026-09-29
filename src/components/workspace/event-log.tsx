"use client";

import { useDeepSubject, useSubject } from "subjecto/react";
import { Download, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { junctionRefs } from "@/engine/refs";
import type { JunctionEvent } from "@/engine/sim";

const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Save events as CSV (opens in any spreadsheet) or JSON lines (easy to read back or share). */
export function downloadEvents(events: JunctionEvent[], format: "csv" | "jsonl", name: string) {
  const refs = junctionRefs(simController.compiled);
  const rows = events.map(e => ({
    time_s: e.t, junction: refs.get(e.node) ?? e.node, vehicle: e.veh ?? "", type: e.vkind ?? "", event: e.kind,
    turn: e.data?.turn ?? "", lane: e.data?.lane ?? "", allowed_lanes: e.data?.lo ? `${e.data.lo}-${e.data.hi}` : "", out_lane: e.data?.outLane ?? "",
    light: e.data?.sig ?? "", reason: e.data?.code ?? "", detail: e.detail,
  }));
  const body = format === "csv"
    ? [Object.keys(rows[0] ?? { time_s: 0 }).join(","), ...rows.map(r => Object.values(r).map(csvCell).join(","))].join("\n")
    : rows.map(r => JSON.stringify(r)).join("\n");
  const blob = new Blob([body], { type: format === "csv" ? "text/csv" : "application/x-ndjson" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const KIND_STYLE: Partial<Record<JunctionEvent["kind"], string>> = {
  deny: "text-amber-600 dark:text-amber-400", revoke: "text-amber-600 dark:text-amber-400",
  "wrong-lane": "text-destructive", "turn-changed": "text-destructive", towed: "text-destructive", reroute: "text-destructive",
  grant: "text-[var(--sig-go)]", signal: "text-primary",
};

/** Per-junction recorder: switch, latest events, downloads. */
export function JunctionEventLog({ nodeId, refName }: { nodeId: string; refName: string }) {
  useSubject(stats$);
  const [log] = useDeepSubject(ui, "eventLog");
  const on = log.all || log.nodes.includes(nodeId);
  const sim = simController.sim;
  const events = sim ? sim.events.filter(e => e.node === nodeId) : [];
  const latest = events.slice(-60).reverse();
  const toggle = (v: boolean) => {
    const cur = ui.getValue().eventLog;
    cur.nodes = v ? [...new Set([...cur.nodes, nodeId])] : cur.nodes.filter(id => id !== nodeId);
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Event log</h4>
        <label className="flex items-center gap-2 text-xs">
          Record {refName}
          <Switch checked={on} disabled={log.all} onCheckedChange={toggle} aria-label={`Record events at ${refName}`} />
        </label>
      </div>
      {on ? (
        <>
          <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-1.5 font-mono text-[10.5px] leading-snug">
            {latest.length === 0 ? <p className="p-1 text-muted-foreground">Recording… run traffic to see events here.</p> : latest.map((e, i) => (
              <div key={i} className="grid grid-cols-[3.2rem_2.6rem_1fr] gap-1.5 border-b border-border/40 py-0.5 last:border-0">
                <span className="text-muted-foreground tabular">{e.t.toFixed(1)}s</span>
                <span className="tabular">{e.veh != null ? `#${e.veh}` : ""}</span>
                <span><span className={KIND_STYLE[e.kind] ?? ""}>{e.kind}</span> {e.detail}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!events.length} onClick={() => downloadEvents(events, "csv", `${refName}-events`)}><Download /> CSV</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!events.length} onClick={() => downloadEvents(events, "jsonl", `${refName}-events`)}><Download /> JSON</Button>
            <span className="self-center text-[10px] text-muted-foreground">{events.length} events · newest first · vehicle numbers match the one shown when you click a car</span>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Turn on to record every request, grant, refusal (with the reason), lane change, turn change and light change here.</p>
      )}
    </div>
  );
}

/** Global recorder in the Traffic tab. */
export function EventLogPanel() {
  useSubject(stats$);
  const [log] = useDeepSubject(ui, "eventLog");
  const sim = simController.sim;
  const n = sim?.events.length ?? 0;
  return (
    <div className="grid gap-2">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Record events at every junction</span>
        <Switch checked={log.all} onCheckedChange={v => { ui.getValue().eventLog.all = v; }} />
      </label>
      <p className="text-xs text-muted-foreground">
        {log.all ? "Recording all junctions." : log.nodes.length ? `Recording ${log.nodes.length} junction${log.nodes.length > 1 ? "s" : ""} (switch on in each junction's panel).` : "Or switch recording on for single junctions in their panel."}
        {" "}Keeps the latest 50,000 events; restarting traffic starts a new log.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!n} onClick={() => sim && downloadEvents(sim.events, "csv", "junction-events")}><Download /> CSV</Button>
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!n} onClick={() => sim && downloadEvents(sim.events, "jsonl", "junction-events")}><Download /> JSON</Button>
        <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={!n} onClick={() => { simController.clearEvents(); stats$.next(stats$.getValue()); }}><Trash2 /> Clear</Button>
        <span className="text-[10px] text-muted-foreground tabular">{n} events</span>
      </div>
    </div>
  );
}
