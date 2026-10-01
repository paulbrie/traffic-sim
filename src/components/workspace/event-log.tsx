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
    time_s: e.t, junction: refs.get(e.node) ?? e.node, road: e.link ?? "", vehicle: e.veh ?? "", type: e.vkind ?? "", event: e.kind,
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
  grant: "text-[var(--sig-go)]", signal: "text-primary", "enter-road": "text-[var(--sig-go)]", appear: "text-[var(--sig-go)]", state: "text-primary",
};

/** Per-junction recorder: switch, latest events, downloads. */
export function JunctionEventLog({ nodeId, refName }: { nodeId: string; refName: string }) {
  useSubject(stats$);
  const [log] = useDeepSubject(ui, "eventLog");
  const sim = simController.sim;
  return (
    <LogBox
      on={log.all || log.nodes.includes(nodeId)} disabled={log.all} label={refName}
      events={sim ? sim.events.filter(e => e.node === nodeId) : []}
      toggle={v => { const cur = ui.getValue().eventLog; cur.nodes = v ? [...new Set([...cur.nodes, nodeId])] : cur.nodes.filter(id => id !== nodeId); }}
      hint="Turn on to record every request, grant, refusal (with the reason), lane change, turn change and light change here."
    />
  );
}

/** Per-road recorder: what vehicles do on this road (both directions). */
export function RoadEventLog({ linkId }: { linkId: string }) {
  useSubject(stats$);
  const [log] = useDeepSubject(ui, "eventLog");
  const sim = simController.sim;
  return (
    <LogBox
      on={(log.links ?? []).includes(linkId)} label={linkId}
      events={sim ? sim.events.filter(e => e.link === linkId) : []}
      toggle={v => { const cur = ui.getValue().eventLog; const l = cur.links ?? []; cur.links = v ? [...new Set([...l, linkId])] : l.filter(id => id !== linkId); }}
      hint="Turn on to record what vehicles do on this road: appearing or entering (and their next turn), lane changes (and why), changes of state (free, following, queued, at a red light, yielding…), leaving, arriving and being removed."
    />
  );
}

/** Per-vehicle recorder: everything one vehicle does, at every junction and on every road, until it leaves. */
export function VehicleEventLog({ vehId }: { vehId: number }) {
  useSubject(stats$);
  const [log] = useDeepSubject(ui, "eventLog");
  const sim = simController.sim;
  const c = simController.compiled, refs = junctionRefs(c);
  const roadName = (id: string) => c.edges.find(x => x.link.id === id)?.link.name || id;
  return (
    <LogBox
      on={(log.vehicles ?? []).includes(vehId)} label={`#${vehId}`} file={`vehicle-${vehId}`}
      events={sim ? sim.events.filter(e => e.veh === vehId) : []}
      where={e => (e.node ? refs.get(e.node) ?? e.node : e.link ? roadName(e.link) : "")}
      toggle={v => { const cur = ui.getValue().eventLog; const l = cur.vehicles ?? []; cur.vehicles = v ? [...new Set([...l, vehId])] : l.filter(id => id !== vehId); }}
      hint="Turn on to record everything this vehicle does from now on, wherever it goes: requests, grants and refusals at junctions (with the reason), lane changes, turn changes, changes of state (free, following, queued, at a red light, yielding…), roads entered and left, and how it leaves the plan. Restarting traffic stops the recording."
    />
  );
}

function LogBox({ on, disabled, label, file, events, where, toggle, hint }: {
  on: boolean; disabled?: boolean; label: string; file?: string; events: JunctionEvent[];
  /** second column: where it happened (vehicle logs) instead of which vehicle */
  where?: (e: JunctionEvent) => string;
  toggle: (v: boolean) => void; hint: string;
}) {
  const latest = events.slice(-60).reverse();
  const name = `${file ?? label}-events`;
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Event log</h4>
        <label className="flex items-center gap-2 text-xs">
          Record {label}
          <Switch checked={on} disabled={disabled} onCheckedChange={toggle} aria-label={`Record events at ${label}`} />
        </label>
      </div>
      {on ? (
        <>
          <div className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 p-1.5 font-mono text-[10.5px] leading-snug">
            {latest.length === 0 ? <p className="p-1 text-muted-foreground">Recording… run traffic to see events here.</p> : latest.map((e, i) => (
              <div key={i} className={`grid ${where ? "grid-cols-[3.2rem_5.5rem_1fr]" : "grid-cols-[3.2rem_2.6rem_1fr]"} gap-1.5 border-b border-border/40 py-0.5 last:border-0`}>
                <span className="text-muted-foreground tabular">{e.t.toFixed(1)}s</span>
                {where ? <span className="truncate" title={e.link ?? e.node}>{where(e)}</span> : <span className="tabular">{e.veh != null ? `#${e.veh}` : ""}</span>}
                <span><span className={KIND_STYLE[e.kind] ?? ""}>{e.kind}</span> {e.detail}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!events.length} onClick={() => downloadEvents(events, "csv", name)}><Download /> CSV</Button>
            <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!events.length} onClick={() => downloadEvents(events, "jsonl", name)}><Download /> JSON</Button>
            <span className="self-center text-[10px] text-muted-foreground">{events.length} events · newest first{where ? "" : " · vehicle numbers match the one shown when you click a car"}</span>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{hint}</p>
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
        {log.links?.length ? ` Recording ${log.links.length} road${log.links.length > 1 ? "s" : ""} too (switch on in each road's panel).` : ""}
        {log.vehicles?.length ? ` Recording ${log.vehicles.length} vehicle${log.vehicles.length > 1 ? "s" : ""} too (switch on in each vehicle's panel).` : ""}
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
