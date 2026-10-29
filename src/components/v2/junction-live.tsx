"use client";

/**
 * A junction's traffic as it runs, in three small line charts sharing one time axis (ticket #109): vehicles through it, and
 * coming in and going out by lane, each in vehicles an hour over the last minute. A crosshair across all three with every
 * series' value, a legend under each, a table of the latest values. From the sim's own series (sampled every 5 s of
 * simulated time in the worker, so it keeps up at any speed), kept on sketches of up to 24 junctions.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Table2, LineChart } from "lucide-react";
import { Button } from "@/components/ui/button";
import { baseLaneId, roadOf, type Sketch } from "@/lib/lane-sketch";
import type { JunctionSample, JunctionSeries } from "@/lib/lane-sketch-sim";
import { cn } from "@/lib/utils";
import { InspectorPanel } from "./inspector-panel";

/** seconds of the rolling window the rates are over */
const WINDOW = 60;
/** the categorical palette (validated on the app's surfaces, light and dark); past 8 lanes, the rest fold into "Other" (gray) */
const SLOTS = 8;
const VARS = `.jlive{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--s4:#eda100;--s5:#e87ba4;--s6:#008300;--s7:#6250d6;--s8:#e34948;--other:#898781;--grid:#e1e0d9;--axis:#c3c2b7}
@media (prefers-color-scheme: dark){.jlive{--s1:#3987e5;--s2:#d95926;--s3:#199e70;--s4:#c98500;--s5:#d55181;--s6:#008300;--s7:#9085e9;--s8:#e66767;--other:#898781;--grid:#2c2c2a;--axis:#383835}}`;

interface Line { key: string; label: string; sub?: string; color: string; values: number[]; total: number }

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

/** a lane's lines: by the order first seen (so a lane keeps its colour as others come), past `SLOTS` - 1 the rest summed as "Other" */
function laneLines(sk: Sketch, ids: string[], samples: JunctionSample[], side: "ins" | "outs"): Line[] {
  const name = (id: string) => roadOf(sk, baseLaneId(id))?.name;
  const one = (i: number) => (s: JunctionSample) => s[side][i] ?? 0;
  const fold = ids.length > SLOTS;
  const own = fold ? ids.slice(0, SLOTS - 1) : ids;
  const lines: Line[] = own.map((id, i) => ({ key: id, label: id, sub: name(id), color: `var(--s${i + 1})`, values: rates(samples, one(i)), total: samples.at(-1)?.[side][i] ?? 0 }));
  if (fold) {
    const rest = ids.slice(SLOTS - 1).map((_, k) => one(SLOTS - 1 + k)), sum = (s: JunctionSample) => rest.reduce((a, f) => a + f(s), 0);
    lines.push({ key: "other", label: "Other", sub: `${ids.length - SLOTS + 1} lanes`, color: "var(--other)", values: rates(samples, sum), total: samples.length ? sum(samples.at(-1)!) : 0 });
  }
  return lines;
}

const W = 300, H = 92, L = 30, R = 6, T = 6, B = 16;

/** the crosshair: a sample's index, shown on every chart, and the chart it is on (the one with its values' tooltip) */
type Hover = { i: number; on: string } | null;

/** one small line chart: its lines over the samples' times, the crosshair (its tooltip if it's this chart's), the replay's moment at `cursor` (s) */
function Chart({ title, lines, times, hover: hv, setHover: setHv, cursor, single }: {
  title: string; lines: Line[]; times: number[]; hover: Hover; setHover: (h: Hover) => void; cursor: number | null; single?: boolean;
}) {
  const hover = hv?.i ?? null, setHover = (i: number | null) => setHv(i === null ? null : { i, on: title });
  const box = useRef<HTMLDivElement | null>(null);
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
        <svg viewBox={`0 0 ${W} ${H}`} className="block w-full touch-none outline-none focus-visible:ring-2 focus-visible:ring-ring" role="img" tabIndex={0}
          aria-label={`${title}: ${lines.map(l => `${l.label} ${Math.round(l.values.at(-1) ?? 0)} vehicles an hour now`).join(", ")}`}
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
              <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={v === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <text x={L - 4} y={y(v) + 3} textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">{compact(v)}</text>
            </g>
          ))}
          <text x={L} y={H - 3} className="fill-muted-foreground text-[9px] tabular-nums">{clock(t0)}</text>
          <text x={W - R} y={H - 3} textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">{clock(t1)}</text>
          {single && lines[0] && times.length > 1 && (
            <path d={`M${x(times[0])},${y(0)} ${lines[0].values.map((v, i) => `L${x(times[i])},${y(v)}`).join(" ")} L${x(times.at(-1)!)},${y(0)}Z`} fill={lines[0].color} opacity={0.1} />
          )}
          {lines.map(l => (
            <polyline key={l.key} points={l.values.map((v, i) => `${x(times[i])},${y(v)}`).join(" ")} fill="none" stroke={l.color} strokeWidth={2}
              strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          ))}
          {cursor !== null && cursor >= t0 && cursor <= t1 && <line x1={x(cursor)} x2={x(cursor)} y1={T} y2={H - B} stroke="var(--axis)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
          {tip !== null && (
            <g>
              <line x1={x(times[tip])} x2={x(times[tip])} y1={T} y2={H - B} stroke="currentColor" className="text-muted-foreground" strokeWidth={1} vectorEffect="non-scaling-stroke" />
              {lines.map(l => <circle key={l.key} cx={x(times[tip])} cy={y(l.values[tip])} r={4} fill={l.color} className="stroke-background" strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
            </g>
          )}
        </svg>
        {mine && (
          <div className="pointer-events-none absolute top-1 z-10 min-w-28 rounded-md border bg-popover px-2 py-1 text-[11px] shadow-md"
            style={x(times[tip]) / W > 0.55 ? { right: `${(1 - x(times[tip]) / W) * 100 + 2}%` } : { left: `${(x(times[tip]) / W) * 100 + 2}%` }}>
            <div className="text-muted-foreground tabular-nums">{clock(times[tip])}</div>
            {[...lines].sort((a, b) => b.values[tip] - a.values[tip]).map(l => (
              <div key={l.key} className="flex items-center gap-1.5">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: l.color }} />
                <span className="font-semibold tabular-nums">{Math.round(l.values[tip])}</span>
                <span className="truncate text-muted-foreground">{l.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {!single && (
        <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[10px] text-muted-foreground">
          {lines.map(l => (
            <span key={l.key} className="flex items-center gap-1" title={l.sub}>
              <span className="inline-block h-0.5 w-3 rounded" style={{ background: l.color }} />{l.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The live graphs' panel: of the junction selected, else the busiest; a picker when the sketch has more than one. `load` asks the
 * sim for a junction's series (null: no sim); asked again as the cars' time `t` passes each sample.
 */
export function JunctionLive({ sketch, junction, busiest, t, replayT, load, onPick }: {
  sketch: Sketch; junction: string | null; busiest: string | null; t: number; replayT: number | null;
  load: ((id: string) => Promise<JunctionSeries | null>) | null; onPick?: (id: string) => void;
}) {
  const [own, setOwn] = useState<string | null>(null);
  const id = junction ?? (own && sketch.junctions.some(j => j.id === own) ? own : busiest ?? sketch.junctions[0]?.id ?? null);
  const [got, setGot] = useState<JunctionSeries | null>(null);
  const [hover, setHover] = useState<Hover>(null);
  const [table, setTable] = useState(false);
  const bucket = Math.floor(t / 5);
  useEffect(() => {
    let live = true;
    if (!id || !load) return;
    void load(id).then(s => { if (live) setGot(s); });
    return () => { live = false; };
  }, [id, load, bucket]);
  // (the series of the junction shown: not one asked for before another was picked; none without the cars)
  const series = got && load && got.id === id ? got : null;
  const samples = useMemo(() => series?.samples ?? [], [series]);
  const times = useMemo(() => samples.map(s => s.t), [samples]);
  const through = useMemo<Line[]>(() => [{ key: "through", label: "Through", color: "var(--s1)", values: rates(samples, s => s.through), total: samples.at(-1)?.through ?? 0 }], [samples]);
  const ins = useMemo(() => (series ? laneLines(sketch, series.ins, samples, "ins") : []), [sketch, series, samples]);
  const outs = useMemo(() => (series ? laneLines(sketch, series.outs, samples, "outs") : []), [sketch, series, samples]);
  if (!id) return null;
  const name = sketch.junctions.find(j => j.id === id)?.name ?? id, many = sketch.junctions.length > 1;
  const now = (l: Line) => Math.round(l.values.at(-1) ?? 0);
  return (
    <InspectorPanel id="junction-live" title="Live graph"
      actions={samples.length > 0 && (
        <Button size="icon-sm" variant="ghost" aria-label={table ? "Show the graphs" : "Show as a table"} title={table ? "Graphs" : "Table"} onClick={() => setTable(x => !x)}>
          {table ? <LineChart className="size-3.5" /> : <Table2 className="size-3.5" />}
        </Button>
      )}>
      <style>{VARS}</style>
      <div className="jlive space-y-2">
        <div className="flex items-center gap-2 text-xs">
          {many && !junction ? (
            <select className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-xs" value={id} aria-label="Junction" onChange={e => { setOwn(e.target.value); onPick?.(e.target.value); }}>
              {sketch.junctions.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
            </select>
          ) : <span className="truncate font-medium">{name}</span>}
        </div>
        {!samples.length ? (
          <p className="text-[11px] text-muted-foreground">
            {sketch.junctions.length > 24 ? "Live graphs are kept on sketches of up to 24 junctions (this one has more): see the Junctions table for each one's results." : "Run the cars: every 5 s of their time, the vehicles through it, and coming in and going out on each lane."}
          </p>
        ) : table ? (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground">At {clock(times.at(-1)!)}: vehicles an hour over the last minute, and so far.</p>
            {([["Coming in", ins], ["Going out", outs]] as const).map(([head, rows]) => (
              <table key={head} className="w-full text-xs">
                <thead><tr className="text-[11px] text-muted-foreground"><th className="text-left font-normal">{head}</th><th className="text-right font-normal">veh/h</th><th className="text-right font-normal">so far</th></tr></thead>
                <tbody>
                  {rows.map(l => (
                    <tr key={l.key} className="border-t">
                      <td className="max-w-40 truncate py-0.5" title={l.sub}>{l.label}{l.sub && <span className="text-muted-foreground"> · {l.sub}</span>}</td>
                      <td className="py-0.5 text-right font-mono tabular-nums">{now(l)}</td>
                      <td className="py-0.5 text-right font-mono tabular-nums">{l.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
            <p className="text-xs">Through: <span className="font-mono font-semibold tabular-nums">{now(through[0])}</span> veh/h, {through[0].total} so far</p>
          </div>
        ) : (
          <>
            <Chart title={`Through: ${now(through[0])} veh/h now`} lines={through} times={times} hover={hover} setHover={setHover} cursor={replayT} single />
            <Chart title="Coming in, by lane (veh/h)" lines={ins} times={times} hover={hover} setHover={setHover} cursor={replayT} />
            <Chart title="Going out, by lane (veh/h)" lines={outs} times={times} hover={hover} setHover={setHover} cursor={replayT} />
            <p className={cn("text-[10px] text-muted-foreground")}>Vehicles an hour over the last minute, every 5 s of the cars&apos; time (a ring&apos;s laps not counted as going out and in). Hover or use the arrow keys for the values; the table button for all of them.</p>
          </>
        )}
      </div>
    </InspectorPanel>
  );
}
