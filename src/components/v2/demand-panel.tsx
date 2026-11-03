"use client";

/**
 * Where the traffic comes from and goes to: each way in (an entry lane, or a road's entry lanes
 * together) with the vehicles per hour coming in on it, and each way out with its share of the trips
 * that end there. Cars take the shortest way to the exit they are going to. Journeys (as V1's transit
 * flows): vehicles going from a particular way in to a particular way out, on top of those. Demand matrices
 * (ticket #113): several kept, each edited as a spreadsheet (demand-matrix-dialog.tsx), one in use or each in
 * its period of the day, instead of the ways' rates and shares.
 */
import { useState } from "react";
import { ChevronDown, ChevronUp, CopyPlus, Plus, Table2, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { NumberField } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import { addJourney, deleteJourney, demandWays, laneInRate, laneOutWeight, laneById, setInRate, setOutWeight, updateJourney, type DemandWay, type Pt, type Sketch, type SketchJourney } from "@/lib/lane-sketch";
import type { JourneyStats, SimStats } from "@/lib/lane-sketch-sim";
import { MATRIX_BY_TIME, uncovered, addMatrix, deleteMatrix, demandMode, duplicateMatrix, hhmm, matrixGrid, moveMatrix, overlaps, periodText, setStartClock, startClock, setMatrixOn } from "@/lib/demand-matrix";
import { MatrixDialog, TimeField } from "./demand-matrix-dialog";
import { useSketchStore } from "@/state/lane-sketch";
import { compassNames } from "./compass-names";
import { InspectorPanel } from "./inspector-panel";

export function DemandPanel({ sketch, readOnly, onFocus, results, heldBack, onGo, now }: {
  sketch: Sketch; readOnly: boolean; onFocus?: (lanes: string[] | null) => void;
  /** the view glided to a way in or out (where its lanes start or end) */
  onGo?: (at: Pt) => void;
  /** the journeys' results so far, while the cars run (by journey id) */
  results?: JourneyStats[] | null;
  /** while the cars run: arrivals that couldn't come in so far, by entry lane */
  heldBack?: Record<string, number> | null;
  /** while the cars run: the demand matrix in use, the time of day */
  now?: SimStats["demand"] | null;
}) {
  const { edit: editSketch } = useSketchStore();
  const { entries, exits } = distinctNames(demandWays(sketch));
  // (long lists: the first ways only, more on asking)
  const [shown, setShown] = useState({ in: 12, out: 12 });
  if (!entries.length && !exits.length) return null;
  const lane = (id: string) => laneById(sketch, id)!;
  const total = (ids: string[]) => ids.reduce((a, id) => a + laneInRate(lane(id), sketch), 0);
  const own = (ids: string[]) => ids.some(id => lane(id).inRate !== undefined);
  const weight = (ids: string[]) => laneOutWeight(lane(ids[0]));
  const sumW = exits.reduce((a, w) => a + w.lanes.reduce((b, id) => b + laneOutWeight(lane(id)), 0), 0);
  const row = "flex items-center gap-2 rounded px-1 text-xs hover:bg-muted";
  return (
    <InspectorPanel id="demand" title="Demand">
      <Matrices sketch={sketch} entries={entries} exits={exits} readOnly={readOnly} now={now} />
      <p className="text-[11px] text-muted-foreground">Cars come in on the ways in at their rate, go to a way out (more often to those with a larger share), and take the shortest way there.
        {(() => { const mode = demandMode(sketch); return mode.kind === "matrix" ? " Not used while a matrix is in use (kept as they are)." : mode.kind === "time" ? " Used at the times of day no matrix covers." : ""; })()}</p>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
        <span className="text-xs font-medium">Ways in <span className="font-normal text-muted-foreground">· veh/h</span></span>
        {entries.slice(0, shown.in).map(w => (
          <div key={w.key} className={row} onMouseEnter={() => onFocus?.(w.lanes)} onMouseLeave={() => onFocus?.(null)}>
            <button type="button" onClick={() => onGo?.(w.at)} className={cn("min-w-0 flex-1 truncate text-left hover:underline", !own(w.lanes) && "text-muted-foreground")}
              title={`${w.name}: ${w.lanes.join(", ")}${own(w.lanes) ? "" : " (the sketch's rate per lane)"} · click to go there`}>{w.name}</button>
            {(() => {
              const n = w.lanes.reduce((a, id) => a + (heldBack?.[id] ?? 0), 0);
              return n > 0 && <span className="font-mono text-[11px] text-amber-700 tabular dark:text-amber-500" title={`${n} arrivals couldn't come in here: no room where the lanes start (a queue back to them, or a crossing there kept clear)`}>−{n}</span>;
            })()}
            {readOnly ? <span className="font-mono tabular">{Math.round(total(w.lanes))}</span> : (
              <NumberField id={`dm-in-${w.key}`} label={`${w.name} vehicles per hour`} hideLabel unit="veh/h" digits={0} min={0} max={5000} step={50} className="w-32 min-w-20 shrink"
                value={total(w.lanes)} onCommit={v => editSketch(s => setInRate(s, w.lanes, v))} />
            )}
          </div>
        ))}
      </div>
      {entries.length > shown.in && <button className="justify-self-start px-1 text-[11px] text-primary hover:underline" onClick={() => setShown(x => ({ ...x, in: x.in + 50 }))}>Show {Math.min(50, entries.length - shown.in)} more ({entries.length - shown.in} of {entries.length} ways in not shown yet)</button>}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
        <span className="text-xs font-medium">Ways out <span className="font-normal text-muted-foreground">· share of trips</span></span>
        {exits.slice(0, shown.out).map(w => {
          const ws = w.lanes.reduce((b, id) => b + laneOutWeight(lane(id)), 0), pct = sumW > 0 ? Math.round((ws / sumW) * 100) : 0;
          return (
            <div key={w.key} className={row} onMouseEnter={() => onFocus?.(w.lanes)} onMouseLeave={() => onFocus?.(null)}>
              <button type="button" onClick={() => onGo?.(w.at)} className={cn("min-w-0 flex-1 truncate text-left hover:underline", weight(w.lanes) === 0 && "text-muted-foreground line-through")}
                title={`${w.name}: ${w.lanes.join(", ")} · click to go there`}>{w.name}</button>
              <span className="w-9 text-right font-mono text-[11px] text-muted-foreground tabular">{pct}%</span>
              {readOnly ? <span className="font-mono tabular">×{weight(w.lanes)}</span> : (
                <NumberField id={`dm-out-${w.key}`} label={`${w.name} share of trips`} hideLabel unit="×" digits={1} min={0} max={100} step={0.5} className="w-24 min-w-16 shrink"
                  value={weight(w.lanes)} onCommit={v => editSketch(s => setOutWeight(s, w.lanes, v))} />
              )}
            </div>
          );
        })}
        {exits.length > shown.out && <button className="justify-self-start px-1 text-[11px] text-primary hover:underline" onClick={() => setShown(x => ({ ...x, out: x.out + 50 }))}>Show {Math.min(50, exits.length - shown.out)} more ({exits.length - shown.out} of {exits.length} ways out not shown yet)</button>}
      </div>
      <Journeys sketch={sketch} entries={entries} exits={exits} readOnly={readOnly} onFocus={onFocus} results={results} />
    </InspectorPanel>
  );
}

/**
 * The demand matrices (ticket #113): which demand the cars run on (the ways' rates and shares, one matrix, or by the time of
 * day, each matrix in its period from the simulation's start), each matrix (its period, its total, to edit, copy, order or
 * delete), new ones; while the cars run, the time of day and the matrix in use
 */
function Matrices({ sketch, entries, exits, readOnly, now }: { sketch: Sketch; entries: DemandWay[]; exits: DemandWay[]; readOnly: boolean; now?: SimStats["demand"] | null }) {
  const { edit: editSketch } = useSketchStore();
  const [open, setOpen] = useState<string | null>(null);
  const ms = sketch.matrices ?? [], mode = demandMode(sketch);
  const value = mode.kind === "ways" ? "ways" : mode.kind === "time" ? MATRIX_BY_TIME : mode.matrix.id;
  const add = (from: "current" | "empty") => {
    let made: string | null = null;
    editSketch(s => { const r = addMatrix(s, from); if (!r) return s; made = r[1].id; return r[0]; });
    if (made) setOpen(made); else toast.error("No room for another matrix", { description: "A sketch keeps 30 at most." });
  };
  const clash = overlaps(sketch), gap = uncovered(sketch);
  // (the times no matrix covers, and what comes in then: ticket #123, a run past the last period emptied without a word)
  const gapText = gap.gaps.map(g => `${hhmm(g.start)}–${hhmm(g.end)}`).join(", "), none = gap.fallback === 0;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs font-medium">Demand from</span>
        <Select value={value} disabled={readOnly} onValueChange={v => editSketch(s => setMatrixOn(s, v === "ways" ? null : v))}>
          <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label="Demand from"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ways" className="text-xs">Each way&apos;s rate and share (below)</SelectItem>
            {ms.length > 0 && <SelectItem value={MATRIX_BY_TIME} className="text-xs">Matrices by the time of day</SelectItem>}
            {ms.map(m => <SelectItem key={m.id} value={m.id} className="text-xs">{m.name} · {periodText(m)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {ms.length > 0 && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span title="The simulation's clock: this time of day at its start, on as it runs (by the time of day, each matrix is used in its period)">Simulation starts at</span>
          <TimeField label="Simulation starts at" value={startClock(sketch)} disabled={readOnly} onCommit={v => editSketch(s => setStartClock(s, v))} />
        </div>
      )}
      {now && (
        <p className="text-[11px] text-muted-foreground">
          Now <span className="font-mono tabular">{hhmm(now.clock)}</span> · {now.matrix ? <>matrix <span className="font-medium text-foreground">{ms.find(m => m.id === now.matrix)?.name ?? now.matrix}</span></> : mode.kind === "ways" ? "each way's rate and share" : none ? <span className="text-amber-700 dark:text-amber-500">no matrix for this time, and the ways&apos; own rates are 0: no cars come in</span> : "no matrix for this time: each way's rate and share"}
          {now.noRoute > 0 && <span className="text-amber-700 dark:text-amber-500"> · {now.noRoute} sent with no way to their way out</span>}
        </p>
      )}
      {ms.map((m, i) => {
        const total = Math.round(matrixGrid(sketch, m).total), on = mode.kind === "matrix" ? mode.matrix.id === m.id : mode.kind === "time";
        return (
          <div key={m.id} className={cn("flex items-center gap-1 rounded px-1 text-xs hover:bg-muted", now?.matrix === m.id && "bg-primary/10")}>
            <button type="button" className={cn("min-w-0 flex-1 truncate text-left hover:underline", !on && "text-muted-foreground")} onClick={() => setOpen(m.id)} title={`${m.name}: edit it`}>{m.name}</button>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular">{periodText(m)}</span>
            <span className="w-14 shrink-0 text-right font-mono text-[11px] tabular" title="Vehicles per hour in all">{total}/h</span>
            <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={`Edit ${m.name}`} title="Edit it as a spreadsheet" onClick={() => setOpen(m.id)}><Table2 className="size-3.5" /></Button>
            {!readOnly && <>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={`Move ${m.name} up`} title="Earlier in the list (by the time of day, where periods overlap the first listed is used)" disabled={i === 0} onClick={() => editSketch(s => moveMatrix(s, m.id, -1))}><ChevronUp className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={`Move ${m.name} down`} title="Later in the list" disabled={i === ms.length - 1} onClick={() => editSketch(s => moveMatrix(s, m.id, 1))}><ChevronDown className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={`Duplicate ${m.name}`} title="A copy of it (for another period, say)" onClick={() => editSketch(s => duplicateMatrix(s, m.id)?.[0] ?? s)}><CopyPlus className="size-3.5" /></Button>
              <Button variant="ghost" size="icon" className="size-6 shrink-0" aria-label={`Delete ${m.name}`} title="Delete it (undo brings it back)" onClick={() => editSketch(s => deleteMatrix(s, m.id))}><Trash2 className="size-3.5" /></Button>
            </>}
          </div>
        );
      })}
      {gap.gaps.length > 0 && (
        <p className={cn("flex gap-1.5 text-[11px]", none ? "text-amber-700 dark:text-amber-500" : "text-muted-foreground")}>
          {none && <TriangleAlert className="mt-0.5 size-3 shrink-0" />}
          <span>No matrix covers {gapText}. Then each way&apos;s own rate and share is used{none ? ": 0 veh/h here, so no cars come in (those already in drive off). Add a matrix for those hours, make one all day, or set the ways' rates below." : ` (${Math.round(gap.fallback)} veh/h in all).`}</span>
        </p>
      )}
      {clash.length > 0 && <p className="flex gap-1.5 text-[11px] text-amber-700 dark:text-amber-500"><TriangleAlert className="mt-0.5 size-3 shrink-0" /> Periods overlap ({clash.map(([a, b]) => `${a} and ${b}`).join("; ")}): by the time of day, the one listed first is used.</p>}
      {!readOnly && (
        <div className="flex gap-1.5">
          <Button variant="outline" size="sm" className="h-7" disabled={!entries.length || !exits.length} title="A matrix of the demand now: each way in's rate over the ways out it can reach, by their shares" onClick={() => add("current")}><Plus /> Matrix from the demand now</Button>
          <Button variant="ghost" size="sm" className="h-7" disabled={!entries.length || !exits.length} onClick={() => add("empty")}>Empty</Button>
        </div>
      )}
      {open && sketch.matrices?.some(m => m.id === open) && <MatrixDialog sketch={sketch} id={open} entries={entries} exits={exits} readOnly={readOnly} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** the ways named so they can be told apart (two roads both called Drumul Cetății: "(N)", "(S)"); copies, the ways themselves are shared */
function distinctNames({ entries, exits }: { entries: DemandWay[]; exits: DemandWay[] }) {
  const name = (ways: DemandWay[]) => { const ns = compassNames(ways, w => w.name, w => w.at); return ways.map((w, i) => (ns[i] === w.name ? w : { ...w, name: ns[i] })); };
  return { entries: name(entries), exits: name(exits) };
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/** the journeys: from a way in to a way out, vehicles per hour and the trucks among them; their results while the cars run */
function Journeys({ sketch, entries, exits, readOnly, onFocus, results }: {
  sketch: Sketch; entries: DemandWay[]; exits: DemandWay[]; readOnly: boolean; onFocus?: (lanes: string[] | null) => void; results?: JourneyStats[] | null;
}) {
  const { edit: editSketch } = useSketchStore();
  const js = sketch.journeys ?? [];
  const wayOf = (ways: DemandWay[], lane: string) => ways.find(w => w.lanes.includes(lane)) ?? null;
  const set = (j: SketchJourney, patch: Partial<Omit<SketchJourney, "id">>) => editSketch(s => updateJourney(s, j.id, patch));
  const pick = (label: string, ways: DemandWay[], lane: string, onPick: (lane: string) => void) => {
    const w = wayOf(ways, lane);
    return (
      <Select value={w?.key ?? ""} disabled={readOnly} onValueChange={k => { const x = ways.find(y => y.key === k); if (x) onPick(x.lanes[0]); }}>
        <SelectTrigger size="sm" className="h-7 min-w-0 flex-1 text-xs" aria-label={label}><SelectValue placeholder="a way that is gone" /></SelectTrigger>
        <SelectContent>{ways.map(x => <SelectItem key={x.key} value={x.key} className="text-xs">{x.name}</SelectItem>)}</SelectContent>
      </Select>
    );
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
      <span className="text-xs font-medium">Journeys <span className="font-normal text-muted-foreground">· from a way in to a way out, on top of the above</span></span>
      {js.map(j => {
        const a = wayOf(entries, j.from), b = wayOf(exits, j.to), r = results?.find(x => x.id === j.id);
        return (
          <div key={j.id} className="grid grid-cols-[minmax(0,1fr)] gap-1.5 rounded-md border p-2" onMouseEnter={() => onFocus?.([...(a?.lanes ?? []), ...(b?.lanes ?? [])])} onMouseLeave={() => onFocus?.(null)}>
            <div className="flex items-center gap-1.5">
              <span className="w-8 shrink-0 text-[11px] text-muted-foreground">From</span>
              {pick(`Journey ${j.id} from`, entries, j.from, from => set(j, { from }))}
              {!readOnly && <Button variant="ghost" size="icon" className="size-7 shrink-0" aria-label={`Delete journey ${j.id}`} title="Delete this journey" onClick={() => editSketch(s => deleteJourney(s, j.id))}><Trash2 className="size-3.5" /></Button>}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-8 shrink-0 text-[11px] text-muted-foreground">To</span>
              {pick(`Journey ${j.id} to`, exits, j.to, to => set(j, { to }))}
            </div>
            {readOnly ? <p className="text-xs tabular">{j.rate} veh/h{j.trucks ? ` · ${j.trucks}% trucks` : ""}</p> : (
              <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-1.5">
                <NumberField id={`dm-j-${j.id}`} label="Vehicles per hour" unit="veh/h" digits={0} min={0} max={5000} step={50} value={j.rate} onCommit={v => set(j, { rate: Math.round(v) })} />
                <NumberField id={`dm-jt-${j.id}`} label="Trucks" unit="%" digits={0} min={0} max={100} step={5} value={j.trucks ?? 0} onCommit={v => set(j, { trucks: Math.round(v) })} />
              </div>
            )}
            {(!a || !b) && <p className="flex gap-1.5 text-[11px] text-amber-700 dark:text-amber-500"><TriangleAlert className="mt-0.5 size-3 shrink-0" /> {!a ? "Its way in" : "Its way out"} is gone: pick another.</p>}
            {r && (r.noRoute && !r.sent
              ? <p className="flex gap-1.5 text-[11px] text-amber-700 dark:text-amber-500"><TriangleAlert className="mt-0.5 size-3 shrink-0" /> No way from there to that way out.</p>
              : <p className="text-[11px] text-muted-foreground tabular">Sent {r.sent} · arrived {r.arrived}{r.arrived ? ` (mean ${mmss(r.meanTrip)})` : ""} · driving {r.driving}{r.waiting ? ` · ${r.waiting} waiting to come in` : ""}</p>)}
          </div>
        );
      })}
      {!readOnly && (
        <Button variant="outline" size="sm" className="h-7 justify-self-start" disabled={!entries.length || !exits.length}
          onClick={() => { const a = entries[0], b = exits.find(x => !x.lanes.some(l => a.lanes.includes(l))) ?? exits[0]; editSketch(s => addJourney(s, a.lanes[0], b.lanes[0])[0]); }}>
          <Plus /> Add a journey
        </Button>
      )}
    </div>
  );
}
