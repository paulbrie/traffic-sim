"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardCopy, History, TerminalSquare, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { roadOf, type JunctionContents, type Pt, type Sketch } from "@/lib/lane-sketch";
import type { SimProblem, SimStats, StuckCar } from "@/lib/lane-sketch-sim";
import type { SketchSimClient } from "@/state/sketch-sim-client";

type Kind = SimProblem["kind"] | "stuck";
const LABEL: Record<Kind, string> = { stuck: "Stuck", collision: "Collision", jump: "Jump", deadlock: "Deadlock", breakdown: "Breakdown", towed: "Towed" };
const TONE: Record<Kind, string> = {
  stuck: "bg-amber-500/20 text-amber-800 dark:text-amber-300", deadlock: "bg-amber-500/20 text-amber-800 dark:text-amber-300",
  collision: "bg-red-500/15 text-red-700 dark:text-red-300", jump: "bg-red-500/15 text-red-700 dark:text-red-300",
  breakdown: "bg-muted text-muted-foreground", towed: "bg-muted text-muted-foreground",
};
type Show = "all" | Kind;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
/** a line of the console: a problem the run had, or the cars stuck at one place now */
interface Row { t: number; kind: Kind; car: number; other?: number; x: number; y: number; place: string; detail: string }

/** how many problems the run has had and how many cars are stuck now (for the console's button), from the stats */
export const problemCount = (s: SimStats | null) => (s ? s.collisions + s.jumps + s.deadlocks + s.breakdowns + s.towed + (s.stuck ?? 0) : 0);


/**
 * The simulation's console, as V1's, under the map: what went wrong while the cars ran: cars stuck a minute or more now
 * (by place, with what they wait for), deadlocks broken, collisions, jumps, breakdowns and tows. A line takes the view
 * there (and picks the car, if it is still on the sketch); its clock button replays from 5 s before; copy the lines to
 * paste them into a conversation.
 */
export function ProblemConsole({ sim, stats, sketch, contents, onGo, onReplay, replayFrom }: {
  /** the cars' simulation, if there is one (asked for when wanted) */
  sim: () => SketchSimClient | null; stats: SimStats | null; sketch: Sketch; contents: Map<string, JunctionContents>;
  /** the view to `p`, the car picked if it is still there */
  onGo: (p: Pt, car: number) => void;
  /** replay from `t`; `replayFrom`: the earliest moment kept (null: nothing kept) */
  onReplay: (t: number) => void; replayFrom: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [show, setShow] = useState<Show>("all");
  const [filter, setFilter] = useState("");
  const [data, setData] = useState<{ problems: SimProblem[]; stuck: StuckCar[] } | null>(null);
  // (cleared from view: the problems up to this moment of the run; a run started again (its time back) has none cleared)
  const [clearedAt, setClearedAt] = useState(-1);
  const count = problemCount(stats);
  // (asked for while open, again as the stats change: about every quarter of a second while the cars run)
  useEffect(() => {
    const client = sim();
    if (!open || !client) return;
    let gone = false;
    void client.problems().then(d => { if (!gone) setData(d); });
    return () => { gone = true; };
  }, [open, sim, stats]);

  // a place's name: a lane's road (or the lane), a connector's junction (or the connector)
  const place = useMemo(() => {
    const onJ = new Map<string, string>();
    for (const j of sketch.junctions) { const c = contents.get(j.id); if (c) for (const id of [...c.connectors, ...c.lanes]) onJ.set(id, j.name); }
    return (edge: string) => {
      const [kind, id] = edge.split(":");
      if (onJ.has(id)) return onJ.get(id)!;
      return kind === "lane" ? roadOf(sketch, id)?.name ?? `Lane ${id}` : `Connector ${id}`;
    };
  }, [sketch, contents]);

  const cleared = stats && stats.t >= clearedAt ? clearedAt : -1;
  const rows = useMemo(() => {
    const out: Row[] = [];
    // (the cars stuck now, one line per place: how many, the longest, what they wait for)
    const at = new Map<string, StuckCar[]>();
    for (const c of data?.stuck ?? []) { const k = place(c.edge); at.set(k, [...(at.get(k) ?? []), c]); }
    for (const [k, cs] of at) {
      const longest = cs.reduce((a, b) => (b.still > a.still ? b : a)), why = [...new Set(cs.map(c => c.why ?? "nothing said"))].slice(0, 3).join("; ");
      out.push({ t: stats?.t ?? 0, kind: "stuck", car: longest.car, x: longest.x, y: longest.y, place: k, detail: `${cs.length} car${cs.length === 1 ? "" : "s"} still for ${longest.still} s at most, waiting for: ${why}` });
    }
    for (const p of data?.problems ?? []) if (p.t > cleared) out.push({ t: p.t, kind: p.kind, car: p.car, other: p.other, x: p.x, y: p.y, place: place(p.edge), detail: p.detail });
    const f = filter.trim().toLowerCase();
    return out.filter(r => (show === "all" || r.kind === show) && (!f || `#${r.car} #${r.other ?? ""} ${r.place} ${r.detail} ${LABEL[r.kind]}`.toLowerCase().includes(f)));
  }, [data, place, cleared, show, filter, stats?.t]);
  const byKind = useMemo(() => {
    const m = new Map<Kind, number>();
    for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    return m;
  }, [rows]);
  // (stays at the newest line unless scrolled up)
  const list = useRef<HTMLDivElement>(null), stick = useRef(true);
  useEffect(() => { const el = list.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [rows.length]);

  const copy = () => {
    const text = `Lane sketch console at ${clock(stats?.t ?? 0)} · ${rows.length} line${rows.length === 1 ? "" : "s"}\n` +
      rows.map(r => `${clock(r.t)}  ${LABEL[r.kind].padEnd(9)}  #${r.car}${r.other != null ? ` · #${r.other}` : ""}  ${r.place} (${r.x}, ${r.y}) — ${r.detail}`).join("\n");
    navigator.clipboard.writeText(text).then(() => toast.success(`Copied ${rows.length} line${rows.length === 1 ? "" : "s"}`), () => toast.error("Couldn't copy"));
  };

  if (!open) return (
    <Button size="sm" variant="outline" className="absolute bottom-6 left-2 z-10 h-7 gap-1.5 bg-background/95 text-xs shadow-sm" onClick={() => setOpen(true)}
      title="The problems the cars have had: stuck, deadlocks, collisions, jumps, breakdowns">
      <TerminalSquare className="size-3.5" /> Console
      {count > 0 && <span className="rounded-full bg-amber-500/20 px-1.5 font-mono text-[10px] text-amber-800 tabular-nums dark:text-amber-300">{count}</span>}
    </Button>
  );
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex h-56 flex-col border-t bg-background" role="region" aria-label="Simulation console">
      <div className="flex items-center gap-2 border-b px-3 py-1.5">
        <span className="text-sm font-medium">Console</span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {rows.length ? [...byKind].map(([k, n]) => `${n} ${LABEL[k].toLowerCase()}`).join(" · ") : stats ? "nothing wrong so far" : "run the cars to see what goes wrong"}
        </span>
        <Select value={show} onValueChange={v => setShow(v as Show)}>
          <SelectTrigger size="sm" className="ml-auto h-7 w-36 text-xs" aria-label="Problems shown"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything</SelectItem>
            {(Object.keys(LABEL) as Kind[]).map(k => <SelectItem key={k} value={k}>{LABEL[k]}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter (#id, road, junction…)" aria-label="Filter the console" className="h-7 w-52 text-xs" />
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Copy the lines shown" title="Copy the lines shown, as text, to paste into a conversation" disabled={!rows.length} onClick={copy}><ClipboardCopy /></Button>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Clear the console" title="Clear the problems so far (the cars stuck now stay)" disabled={!data?.problems.length}
          onClick={() => setClearedAt(stats?.t ?? 0)}><Trash2 /></Button>
        <Button variant="ghost" size="icon-sm" className="size-7" aria-label="Close the console" onClick={() => setOpen(false)}><X /></Button>
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto font-mono text-xs" onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}>
        {rows.length ? rows.map((r, i) => (
          <div key={i} className="group flex cursor-pointer items-start gap-2 border-b border-border/50 px-3 py-1 hover:bg-muted/60" onClick={() => onGo({ x: r.x, y: r.y }, r.car)} title="Go there (and pick the car, if it is still there)">
            <span className="w-10 shrink-0 text-right text-muted-foreground tabular-nums">{clock(r.t)}</span>
            <span className={cn("w-[72px] shrink-0 rounded px-1 text-center font-sans text-[11px] font-medium", TONE[r.kind])}>{LABEL[r.kind]}</span>
            <span className="w-24 shrink-0 tabular-nums">#{r.car}{r.other != null ? ` · #${r.other}` : ""}</span>
            <span className="w-48 shrink-0 truncate text-muted-foreground" title={r.place}>{r.place}</span>
            <span className="min-w-0 flex-1 font-sans">{r.detail}</span>
            {r.kind !== "stuck" && replayFrom !== null && r.t - 5 >= replayFrom && (
              <Button variant="ghost" size="icon-sm" className="size-6 opacity-0 group-hover:opacity-100" aria-label="Replay from just before" title="Replay from 5 s before"
                onClick={e => { e.stopPropagation(); onReplay(r.t - 5); onGo({ x: r.x, y: r.y }, r.car); }}><History /></Button>
            )}
          </div>
        )) : <p className="px-3 py-2 font-sans text-muted-foreground">{data?.problems.length || data?.stuck.length ? "No line matches." : "Cars stuck a minute or more, deadlocks broken, collisions, jumps, breakdowns and tows show here as the cars run."}</p>}
      </div>
    </div>
  );
}
