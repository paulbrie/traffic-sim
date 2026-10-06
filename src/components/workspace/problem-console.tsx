"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSubject } from "subjecto/react";
import { ClipboardCopy, History, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { SimProblem } from "@/engine/sim/base";
import type { SimMirror } from "@/engine/sim/mirror";
import { select, settings$, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { sendView } from "@/state/commands";

const LABEL: Record<SimProblem["kind"], string> = { towed: "Towed", breakdown: "Breakdown", wreck: "Wreck", removed: "Removed", overlap: "Overlap", stuck: "Stuck" };
const TONE: Record<SimProblem["kind"], string> = {
  towed: "bg-red-500/15 text-red-700 dark:text-red-300", removed: "bg-red-500/15 text-red-700 dark:text-red-300",
  overlap: "bg-amber-500/20 text-amber-800 dark:text-amber-300", stuck: "bg-amber-500/20 text-amber-800 dark:text-amber-300", breakdown: "bg-muted text-muted-foreground", wreck: "bg-muted text-muted-foreground",
};
type Show = "all" | "gone" | "overlap";
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** how many problems the running simulation has had (for the console's button), cleared ones left out */
export function useProblemCount() {
  useSubject(stats$);
  const sim = simController.sim;
  return sim ? shown(sim).length : 0;
}
// (cleared from view: the problems up to this moment of each run — a new run starts with none cleared)
const clearedAt = new WeakMap<object, number>();
const shown = (sim: SimMirror) => { const t = clearedAt.get(sim); return t === undefined ? sim.problems : sim.problems.filter(p => p.t > t); };

/**
 * The simulation's console, under the map: what went wrong while traffic ran — vehicles towed after being
 * stuck (and what they were waiting for), taken off with no way on, breakdowns and wrecks cleared, and
 * vehicles overlapping. Click a line to select the vehicle and go to it; copy the lines to paste them into a
 * conversation.
 */
export function ProblemConsole() {
  useSubject(stats$); // (refreshes with each snapshot, ~4×/s)
  const sim = simController.sim;
  const [show, setShow] = useState<Show>("all");
  const [filter, setFilter] = useState("");
  const [, refresh] = useState(0);
  const all = sim ? shown(sim) : [];
  const count = all.length;
  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return all.filter(p => (show === "all" || (show === "overlap" ? p.kind === "overlap" : p.kind !== "overlap"))
      && (!f || `#${p.veh} #${p.other ?? ""} ${p.at} ${p.detail} ${LABEL[p.kind]}`.toLowerCase().includes(f)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, show, filter, sim]);
  const byKind = useMemo(() => {
    const m = new Map<SimProblem["kind"], number>();
    for (const p of all) m.set(p.kind, (m.get(p.kind) ?? 0) + 1);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, sim]);
  // (stays at the newest line unless scrolled up)
  const list = useRef<HTMLDivElement>(null), stick = useRef(true);
  useEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [rows.length]);

  const rec = simController.rec;
  const go = (p: SimProblem) => {
    if (p.veh != null && sim?.vehicles.some(v => v.id === p.veh && !v.dead)) select({ kind: "vehicle", id: String(p.veh) });
    sendView("focus", p.x, p.y);
  };
  const replay = (p: SimProblem) => { simController.replayAt(Math.max(rec.from, Math.round(p.t * 10) - 50)); sendView("focus", p.x, p.y); };
  const copy = () => {
    const u = ui.getValue();
    const text = `Simulation console · plan ${u.planId} rev ${u.save.revision} · ${rows.length} problem${rows.length === 1 ? "" : "s"}\n\`\`\`json\n${JSON.stringify({ plan: u.planId, revision: u.save.revision, settings: settings$.getValue(), problems: rows })}\n\`\`\`\n`;
    navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${rows.length} line${rows.length === 1 ? "" : "s"}`), () => toast.error("Couldn't copy"));
  };

  return (
    <div className="flex h-56 shrink-0 flex-col border-t bg-background" role="region" aria-label="Simulation console">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">Console</span>
        <span className="text-xs text-muted-foreground tabular">
          {count ? [...byKind].map(([k, n]) => `${n} ${LABEL[k].toLowerCase()}`).join(" · ") : sim ? "nothing wrong so far" : "run traffic to see what goes wrong"}
        </span>
        <Select value={show} onValueChange={v => setShow(v as Show)}>
          <SelectTrigger size="sm" className="ml-auto h-7 w-40 text-xs" aria-label="Problems shown"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything</SelectItem>
            <SelectItem value="gone">Taken off or stuck</SelectItem>
            <SelectItem value="overlap">Overlapping vehicles</SelectItem>
          </SelectContent>
        </Select>
        <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter (#id, road, junction…)" aria-label="Filter the console" className="h-7 w-52 text-xs" />
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Copy the lines shown" title="Copy the lines shown, to paste into a conversation" disabled={!rows.length} onClick={copy}><ClipboardCopy /></Button>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Clear the console" title="Clear the console" disabled={!count} onClick={() => { if (sim) clearedAt.set(sim, sim.tick / 10); refresh(n => n + 1); }}><Trash2 /></Button>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Close the console" onClick={() => { ui.getValue().console = false; }}><X /></Button>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto font-mono text-xs" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {rows.length ? rows.map((p, i) => (
          <div key={i} className="group flex cursor-pointer items-start gap-2 border-b border-border/50 px-3 py-1 hover:bg-muted/60" onClick={() => go(p)} title="Select the vehicle and go to it">
            <span className="w-10 shrink-0 text-right text-muted-foreground tabular">{clock(p.t)}</span>
            <span className={`w-[72px] shrink-0 rounded px-1 text-center font-sans text-[11px] font-medium ${TONE[p.kind]}`}>{LABEL[p.kind]}</span>
            <span className="w-24 shrink-0 tabular">#{p.veh} {p.vkind}{p.other != null ? ` · #${p.other}` : ""}</span>
            <span className="w-56 shrink-0 truncate text-muted-foreground" title={p.at}>{p.at}</span>
            <span className="min-w-0 flex-1 font-sans">{p.detail}</span>
            {rec.frames > 1 && p.t * 10 >= rec.from && p.t * 10 <= rec.to && (
              <Button variant="ghost" size="icon-sm" className="size-6 opacity-0 group-hover:opacity-100" aria-label="Replay from just before" title="Replay from 5 s before"
                onClick={e => { e.stopPropagation(); replay(p); }}><History /></Button>
            )}
          </div>
        )) : <p className="px-3 py-2 font-sans text-muted-foreground">{count ? "No line matches." : "Vehicles towed or taken off, stuck in a jam for long, and overlapping show here as traffic runs."}</p>}
      </div>
    </div>
  );
}
