"use client";

/**
 * A junction's traffic as it runs, in three small line charts sharing one time axis (ticket #109): vehicles through it, and
 * coming in and going out by lane, each in vehicles an hour over the last minute. A crosshair across all three with every
 * series' value, a legend under each, a table of the latest values; filtered by road and lane (one row above the charts); a
 * lane or road hovered in the legend, the table or the filters lit up on the map; opened in a window of its own, moved by its
 * title bar and sized by its edges. From the sim's own series (sampled every 5 s of simulated time in the worker, so it keeps up
 * at any speed), kept on sketches of up to 24 junctions.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, LineChart, Maximize2, Table2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { baseLaneId, roadOf, type Sketch } from "@/lib/lane-sketch";
import type { JunctionSample, JunctionSeries } from "@/lib/lane-sketch-sim";
import { ResizeEdges, useFloatingBox } from "@/components/workspace/floating-box";
import { InspectorPanel } from "./inspector-panel";

/** seconds of the rolling window the rates are over */
const WINDOW = 60;
/** the categorical palette (validated on the app's surfaces, light and dark); past 8 lanes, the rest fold into "Other" (gray) */
const SLOTS = 8;
const VARS = `.jlive{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;--other:#898781;--grid:#e1e0d9;--axis:#c3c2b7}
@media (prefers-color-scheme: dark){.jlive{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;--other:#898781;--grid:#2c2c2a;--axis:#383835}}`;

/** a line: its lanes (one, or those folded into "Other"), the colour it keeps whatever is filtered, its rates and its count so far */
interface Line { key: string; label: string; sub?: string; lanes: string[]; color: string; values: number[]; total: number }

/** vehicles an hour over the last `WINDOW` s at each sample, from the counts so far (`at`: a sample's count) */
function rates(samples: JunctionSample[], at: (s: JunctionSample) => number): number[] {
  let j = 0;
  return samples.map((s, i) => {
    while (j < i && samples[j + 1].t <= s.t - WINDOW) j++;
    // (before a whole window: since the start, from nothing at t = 0)
    const from = s.t - WINDOW >= samples[0].t - 0.01 && j < i ? samples[j] : null;
    const dt = from ? s.t - from.t : s.t, dc = at(s) - (from ? at(from) : 0);
    return dt > 0 ? (dc / dt) * 3600 : 0;
  });
}
/** a clean top for the y axis: 1, 2 or 5 × a power of ten, at least `v` */
function niceTop(v: number) {
  if (v <= 0) return 10;
  const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const compact = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K` : String(Math.round(v)));
const roadName = (sk: Sketch, id: string) => roadOf(sk, baseLaneId(id))?.name;

/**
 * A side's lines: each lane its colour by the order first seen (so it keeps it as others come, and whatever is filtered), past
 * `SLOTS` - 1 lanes the rest summed as "Other"; only the lanes shown (`shown`)
 */
function laneLines(sk: Sketch, ids: string[], samples: JunctionSample[], side: "ins" | "outs", shown: (id: string) => boolean): Line[] {
  const one = (i: number) => (s: JunctionSample) => s[side][i] ?? 0;
  const fold = ids.length > SLOTS, own = fold ? SLOTS - 1 : ids.length;
  const lines: Line[] = [];
  ids.forEach((id, i) => {
    if (i < own && shown(id)) lines.push({ key: id, label: id, sub: roadName(sk, id), lanes: [id], color: `var(--s${i + 1})`, values: rates(samples, one(i)), total: samples.at(-1)?.[side][i] ?? 0 });
  });
  const rest = ids.map((id, i) => ({ id, i })).filter(x => x.i >= own && shown(x.id));
  if (rest.length) {
    const sum = (s: JunctionSample) => rest.reduce((a, x) => a + one(x.i)(s), 0);
    lines.push({ key: "other", label: "Other", sub: `${rest.length} lanes`, lanes: rest.map(x => x.id), color: "var(--other)", values: rates(samples, sum), total: samples.length ? sum(samples.at(-1)!) : 0 });
  }
  return lines;
}

/** an element's size, as it changes */
function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

/** the crosshair: a sample's index, shown on every chart, and the chart it is on (the one with its values' tooltip) */
type Hover = { i: number; on: string } | null;
const L = 30, R = 6, T = 6, B = 16;

/**
 * one line chart, `width` × `height` px (its text the same size however big): its lines over the samples' times, the crosshair (its
 * tooltip if it's this chart's), the replay's moment at `cursor` (s); a legend under it (a lane hovered there lit up on the map)
 */
function Chart({ title, lines, times, width, height, hover: hv, setHover: setHv, cursor, single, onFocus }: {
  title: string; lines: Line[]; times: number[]; width: number; height: number; hover: Hover; setHover: (h: Hover) => void; cursor: number | null; single?: boolean;
  onFocus?: (lanes: string[] | null) => void;
}) {
  const hover = hv?.i ?? null, setHover = (i: number | null) => setHv(i === null ? null : { i, on: title });
  const box = useRef<HTMLDivElement | null>(null);
  const W = Math.max(120, width), H = Math.max(60, height);
  const t0 = times[0] ?? 0, t1 = Math.max(t0 + 1, times.at(-1) ?? 1);
  const top = niceTop(Math.max(1, ...lines.flatMap(l => l.values)));
  const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R), y = (v: number) => T + (1 - v / top) * (H - T - B);
  const pick = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r || !times.length) return;
    const tx = t0 + ((((clientX - r.left) / r.width) * W - L) / (W - L - R)) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - tx) < Math.abs(times[best] - tx)) best = i;
    setHover(best);
  };
  const tip = hover !== null && hover < times.length ? hover : null, mine = tip !== null && hv?.on === title;
  return (
    <div className="space-y-0.5">
      <div className="text-[11px] font-medium text-muted-foreground">{title}</div>
      <div ref={box} className="relative">
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="block max-w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring" role="img" tabIndex={0}
          aria-label={`${title}: ${lines.map(l => `${l.label} ${Math.round(l.values.at(-1) ?? 0)} vehicles an hour now`).join(", ") || "no lanes shown"}`}
          onPointerMove={e => pick(e.clientX)} onPointerLeave={() => setHover(null)}
          onKeyDown={e => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault(); e.stopPropagation();
            const i = tip ?? times.length - 1;
            setHover(Math.max(0, Math.min(times.length - 1, i + (e.key === "ArrowLeft" ? -1 : 1))));
          }}
          onBlur={() => setHover(null)}>
          {/* (gridlines and ticks: 0, half, top; the time at the ends) */}
          {[0, top / 2, top].map(v => (
            <g key={v}>
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} />
              <text x={L - 4} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">{compact(v)}</text>
            </g>
          ))}
          <text x={L} y={H - 3} className="fill-muted-foreground text-[9px] tabular-nums">{clock(t0)}</text>
          <text x={W - R} y={H - 3} textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">{clock(t1)}</text>
          {single && lines[0] && times.length > 1 && (
            <path d={`M${x(times[0])},${y(0)} ${lines[0].values.map((v, i) => `L${x(times[i])},${y(v)}`).join(" ")} L${x(times.at(-1)!)},${y(0)}Z`} fill={lines[0].color} opacity={0.1} />
          )}
          {lines.map(l => (
            <polyline key={l.key} points={l.values.map((v, i) => `${x(times[i])},${y(v)}`).join(" ")} fill="none" stroke={l.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {cursor !== null && cursor >= t0 && cursor <= t1 && <line x1={x(cursor)} x2={x(cursor)} y1={T} y2={H - B} stroke="var(--axis)" strokeWidth={1} />}
          {tip !== null && (
            <g>
              <line x1={x(times[tip])} x2={x(times[tip])} y1={T} y2={H - B} stroke="currentColor" className="text-muted-foreground" strokeWidth={1} />
              {lines.map(l => <circle key={l.key} cx={x(times[tip])} cy={y(l.values[tip])} r={4} fill={l.color} className="stroke-background" strokeWidth={2} />)}
            </g>
          )}
        </svg>
        {mine && (
          <div className="pointer-events-none absolute top-1 z-10 min-w-28 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-md"
            style={x(times[tip!]) / W > 0.55 ? { right: `${(1 - x(times[tip!]) / W) * 100 + 2}%` } : { left: `${(x(times[tip!]) / W) * 100 + 2}%` }}>
            <div className="text-muted-foreground tabular-nums">{clock(times[tip!])}</div>
            {[...lines].sort((a, b) => b.values[tip!] - a.values[tip!]).map(l => (
              <div key={l.key} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: l.color }} />
                <span className="font-semibold tabular-nums">{Math.round(l.values[tip!])}</span>
                <span className="truncate text-muted-foreground">{l.label}{l.sub ? ` · ${l.sub}` : ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {!single && (
        <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
          {lines.length ? lines.map(l => (
            <span key={l.key} className="flex cursor-default items-center gap-1 rounded px-0.5 hover:bg-muted hover:text-foreground" title={l.sub ? `${l.label} · ${l.sub}` : l.label}
              onPointerEnter={() => onFocus?.(l.lanes)} onPointerLeave={() => onFocus?.(null)}>
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: l.color }} />{l.label}{width > 420 && l.sub ? <span className="opacity-70"> · {l.sub}</span> : null}
            </span>
          )) : <span>No lanes shown: see the filters above.</span>}
        </div>
      )}
    </div>
  );
}

/** the filters, one row above the charts: roads (each all its lanes, in and out) and lanes, shown or not; one hovered lit up on the map */
function Filters({ sketch, ins, outs, hidden, setHidden, onFocus }: {
  sketch: Sketch; ins: string[]; outs: string[]; hidden: Set<string>; setHidden: (h: Set<string>) => void; onFocus?: (lanes: string[] | null) => void;
}) {
  const all = [...ins, ...outs];
  const roads = new Map<string, string[]>();
  for (const id of all) { const k = roadName(sketch, id) ?? "Lanes in no road"; roads.set(k, [...(roads.get(k) ?? []), id]); }
  const toggle = (ids: string[], show: boolean) => { const h = new Set(hidden); for (const id of ids) if (show) h.delete(id); else h.add(id); setHidden(h); };
  const item = (id: string) => (
    <DropdownMenuCheckboxItem key={id} checked={!hidden.has(id)} onCheckedChange={v => toggle([id], !!v)} onSelect={e => e.preventDefault()}
      onPointerEnter={() => onFocus?.([id])} onPointerLeave={() => onFocus?.(null)}>
      <span className="font-mono">{id}</span><span className="ml-1 truncate text-muted-foreground">{roadName(sketch, id) ?? ""}</span>
    </DropdownMenuCheckboxItem>
  );
  const shownRoads = [...roads].filter(([, ids]) => ids.some(id => !hidden.has(id))).length;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <DropdownMenu modal={false} onOpenChange={o => { if (!o) onFocus?.(null); }}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs">Roads <span className="text-muted-foreground">{shownRoads}/{roads.size}</span><ChevronDown className="size-3" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto" onPointerLeave={() => onFocus?.(null)}>
          <DropdownMenuLabel className="text-xs">Roads (their lanes in and out)</DropdownMenuLabel>
          {[...roads].map(([name, ids]) => (
            <DropdownMenuCheckboxItem key={name} checked={ids.every(id => !hidden.has(id)) ? true : ids.some(id => !hidden.has(id)) ? "indeterminate" : false}
              onCheckedChange={() => toggle(ids, !ids.every(id => !hidden.has(id)))} onSelect={e => e.preventDefault()}
              onPointerEnter={() => onFocus?.(ids)} onPointerLeave={() => onFocus?.(null)}>
              <span className="truncate">{name}</span><span className="ml-auto pl-2 text-[11px] text-muted-foreground">{ids.length} lane{ids.length === 1 ? "" : "s"}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu modal={false} onOpenChange={o => { if (!o) onFocus?.(null); }}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs">Lanes <span className="text-muted-foreground">{all.length - all.filter(id => hidden.has(id)).length}/{all.length}</span><ChevronDown className="size-3" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto" onPointerLeave={() => onFocus?.(null)}>
          <DropdownMenuLabel className="text-xs">Coming in from</DropdownMenuLabel>
          {ins.map(item)}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-xs">Going out onto</DropdownMenuLabel>
          {outs.map(item)}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={e => { e.preventDefault(); setHidden(new Set()); }}>Show all</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {hidden.size > 0 && <button type="button" className="text-[11px] text-primary hover:underline" onClick={() => setHidden(new Set())}>Show all</button>}
    </div>
  );
}

interface View { samples: JunctionSample[]; times: number[]; through: Line[]; ins: Line[]; outs: Line[] }

/** the charts (or the table), sized to the room they have: three short ones in the inspector, sharing the window's height in it */
function LiveBody({ v, table, replayT, fill, onFocus }: { v: View; table: boolean; replayT: number | null; fill: boolean; onFocus?: (lanes: string[] | null) => void }) {
  const [hover, setHover] = useState<Hover>(null);
  const [ref, size] = useSize<HTMLDivElement>();
  const now = (l: Line) => Math.round(l.values.at(-1) ?? 0);
  // (in the window, the three charts share its height after their titles and legends)
  const h = fill ? Math.max(70, Math.floor((size.h - 3 * 18 - 2 * 44) / 3)) : 92;
  if (table) return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">At {clock(v.times.at(-1)!)}: vehicles an hour over the last minute, and so far.</p>
      {([["Coming in", v.ins], ["Going out", v.outs]] as const).map(([head, rows]) => (
        <table key={head} className="w-full text-xs">
          <thead><tr className="text-[11px] text-muted-foreground"><th className="text-left font-normal">{head}</th><th className="text-right font-normal">veh/h</th><th className="text-right font-normal">so far</th></tr></thead>
          <tbody>
            {rows.map(l => (
              <tr key={l.key} className="border-t hover:bg-muted" onPointerEnter={() => onFocus?.(l.lanes)} onPointerLeave={() => onFocus?.(null)}>
                <td className="max-w-40 truncate py-0.5" title={l.sub}><span className="mr-1 inline-block h-0.5 w-3 rounded align-middle" style={{ background: l.color }} />{l.label}{l.sub && <span className="text-muted-foreground"> · {l.sub}</span>}</td>
                <td className="py-0.5 text-right font-mono tabular-nums">{now(l)}</td>
                <td className="py-0.5 text-right font-mono tabular-nums">{l.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      <p className="text-xs">Through: <span className="font-mono font-semibold tabular-nums">{now(v.through[0])}</span> veh/h, {v.through[0].total} so far</p>
    </div>
  );
  return (
    <div ref={ref} className={fill ? "min-h-0 flex-1 space-y-1.5" : "space-y-1.5"}>
      {size.w > 0 && (
        <>
          <Chart title={`Through: ${now(v.through[0])} veh/h now`} lines={v.through} times={v.times} width={size.w} height={h} hover={hover} setHover={setHover} cursor={replayT} single />
          <Chart title="Coming in, by lane (veh/h)" lines={v.ins} times={v.times} width={size.w} height={h} hover={hover} setHover={setHover} cursor={replayT} onFocus={onFocus} />
          <Chart title="Going out, by lane (veh/h)" lines={v.outs} times={v.times} width={size.w} height={h} hover={hover} setHover={setHover} cursor={replayT} onFocus={onFocus} />
        </>
      )}
    </div>
  );
}

/**
 * The live graphs' panel: of the junction selected, else the busiest; a picker when the sketch has more than one. `load` asks the
 * sim for a junction's series (null: no sim); asked again as the cars' time `t` passes each sample. `onFocus`: lanes to light up on
 * the map (null: none).
 */
export function JunctionLive({ sketch, junction, busiest, t, replayT, load, onFocus }: {
  sketch: Sketch; junction: string | null; busiest: string | null; t: number; replayT: number | null;
  load: ((id: string) => Promise<JunctionSeries | null>) | null; onFocus?: (lanes: string[] | null) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const id = junction ?? (own && sketch.junctions.some(j => j.id === own) ? own : busiest ?? sketch.junctions[0]?.id ?? null);
  const [got, setGot] = useState<JunctionSeries | null>(null);
  const [table, setTable] = useState(false);
  const [open, setOpen] = useState(false);
  // (the lanes hidden, per junction)
  const [hiddenBy, setHiddenBy] = useState<Record<string, string[]>>({});
  const hidden = useMemo(() => new Set(id ? hiddenBy[id] ?? [] : []), [hiddenBy, id]);
  const setHidden = (h: Set<string>) => { if (id) setHiddenBy(m => ({ ...m, [id]: [...h] })); };
  const bucket = Math.floor(t / 5);
  useEffect(() => {
    let live = true;
    if (!id || !load) return;
    void load(id).then(s => { if (live) setGot(s); });
    return () => { live = false; };
  }, [id, load, bucket]);
  // (the series of the junction shown: not one asked for before another was picked; none without the cars)
  const series = got && load && got.id === id ? got : null;
  const view = useMemo<View | null>(() => {
    if (!series || !series.samples.length) return null;
    const samples = series.samples, shown = (lane: string) => !hidden.has(lane);
    return {
      samples, times: samples.map(s => s.t),
      through: [{ key: "through", label: "Through", lanes: [], color: "var(--s1)", values: rates(samples, s => s.through), total: samples.at(-1)!.through }],
      ins: laneLines(sketch, series.ins, samples, "ins", shown), outs: laneLines(sketch, series.outs, samples, "outs", shown),
    };
  }, [sketch, series, hidden]);
  // (the window: moved by its title bar, sized by its edges, where it was left)
  const { panel, style, placed, start, reset } = useFloatingBox("junctionLive:box", 360, 320);
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);
  if (!id) return null;
  const name = sketch.junctions.find(j => j.id === id)?.name ?? id, many = sketch.junctions.length > 1;
  const picker = many && !junction ? (
    <select className="h-7 min-w-0 max-w-48 rounded-md border bg-background px-1.5 text-xs" value={id} aria-label="Junction" onChange={e => setOwn(e.target.value)}>
      {sketch.junctions.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
    </select>
  ) : <span className="truncate text-xs font-medium">{name}</span>;
  const empty = (
    <p className="text-[11px] text-muted-foreground">
      {sketch.junctions.length > 24 ? "Live graphs are kept on sketches of up to 24 junctions (this one has more): see the Junctions table for each one's results." : "Run the cars: every 5 s of their time, the vehicles through it, and coming in and going out on each lane."}
    </p>
  );
  const tableButton = view && (
    <Button size="icon-sm" variant="ghost" aria-label={table ? "Show the graphs" : "Show as a table"} title={table ? "Graphs" : "Table"} onClick={() => setTable(x => !x)}>
      {table ? <LineChart className="size-3.5" /> : <Table2 className="size-3.5" />}
    </Button>
  );
  const filters = view && series && <Filters sketch={sketch} ins={series.ins} outs={series.outs} hidden={hidden} setHidden={setHidden} onFocus={onFocus} />;
  return (
    <InspectorPanel id="junction-live" title="Live graph"
      actions={<>
        {tableButton}
        <Button size="icon-sm" variant="ghost" aria-label="Open in a window" title="Open in a window (drag it by its title, size it by its edges)" onClick={() => setOpen(true)}><Maximize2 className="size-3.5" /></Button>
      </>}>
      <style>{VARS}</style>
      <div className="jlive space-y-2">
        {picker}
        {filters}
        {view ? <LiveBody v={view} table={table} replayT={replayT} fill={false} onFocus={onFocus} /> : empty}
        {view && !table && <p className="text-[10px] text-muted-foreground">Vehicles an hour over the last minute, every 5 s of the cars&apos; time (a ring&apos;s laps not counted as going out and in). Hover a chart or use the arrow keys for the values; a lane in the legend to find it on the map.</p>}
      </div>
      {open && typeof document !== "undefined" && createPortal(
        <div className="pointer-events-none fixed inset-0 z-40">
          <div ref={panel} style={style} role="dialog" aria-label={`Live graph: ${name}`}
            className={`jlive pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border bg-background shadow-lg ${placed ? "" : "top-16 left-[max(1rem,calc(50%-360px))] h-[min(560px,calc(100%-6rem))] w-[min(720px,calc(100%-2rem))]"}`}>
            <ResizeEdges start={start} />
            <div className="flex cursor-move touch-none items-center gap-2 border-b px-3 py-2 select-none" title="Drag to move · double-click to put back"
              onPointerDown={e => { if (!(e.target as HTMLElement).closest("button,select")) start(e, null); }} onDoubleClick={e => { if (!(e.target as HTMLElement).closest("button,select")) reset(); }}>
              <LineChart className="size-4 text-muted-foreground" />
              <span className="text-sm font-medium">Live graph</span>
              {picker}
              <span className="ml-auto" />
              {tableButton}
              <Button size="icon-sm" variant="ghost" aria-label="Close" title="Close (Esc)" onClick={() => setOpen(false)}><X /></Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
              {filters}
              {view ? <LiveBody v={view} table={table} replayT={replayT} fill={!table} onFocus={onFocus} /> : empty}
            </div>
          </div>
        </div>,
        document.body,
      )}
    </InspectorPanel>
  );
}
