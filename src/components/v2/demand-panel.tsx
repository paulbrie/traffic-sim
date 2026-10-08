"use client";

/**
 * Where the traffic comes from and goes to: each way in (an entry lane, or a road's entry lanes
 * together) with the vehicles per hour coming in on it, and each way out with its share of the trips
 * that end there. Cars take the shortest way to the exit they are going to.
 */
import { NumberField } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import { demandWays, laneInRate, laneOutWeight, laneById, setInRate, setOutWeight, type Sketch } from "@/lib/lane-sketch";
import { editSketch } from "@/state/lane-sketch";

export function DemandPanel({ sketch, readOnly, onFocus }: { sketch: Sketch; readOnly: boolean; onFocus?: (lanes: string[] | null) => void }) {
  const { entries, exits } = demandWays(sketch);
  if (!entries.length && !exits.length) return null;
  const lane = (id: string) => laneById(sketch, id)!;
  const total = (ids: string[]) => ids.reduce((a, id) => a + laneInRate(lane(id), sketch), 0);
  const own = (ids: string[]) => ids.some(id => lane(id).inRate !== undefined);
  const weight = (ids: string[]) => laneOutWeight(lane(ids[0]));
  const sumW = exits.reduce((a, w) => a + w.lanes.reduce((b, id) => b + laneOutWeight(lane(id)), 0), 0);
  const row = "flex items-center gap-2 rounded px-1 text-xs hover:bg-muted";
  return (
    <section className="grid gap-2 border-b p-3">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Demand</h3>
      <p className="text-[11px] text-muted-foreground">Cars come in on the ways in at their rate, go to a way out (more often to those with a larger share), and take the shortest way there.</p>
      <div className="grid gap-1">
        <span className="text-xs font-medium">Ways in <span className="font-normal text-muted-foreground">· veh/h</span></span>
        {entries.map(w => (
          <div key={w.key} className={row} onMouseEnter={() => onFocus?.(w.lanes)} onMouseLeave={() => onFocus?.(null)}>
            <span className={cn("min-w-0 flex-1 truncate", !own(w.lanes) && "text-muted-foreground")} title={`${w.name}: ${w.lanes.join(", ")}${own(w.lanes) ? "" : " (the sketch's rate per lane)"}`}>{w.name}</span>
            {readOnly ? <span className="font-mono tabular">{Math.round(total(w.lanes))}</span> : (
              <NumberField id={`dm-in-${w.key}`} label={`${w.name} vehicles per hour`} hideLabel unit="veh/h" digits={0} min={0} max={5000} step={50} className="w-32"
                value={total(w.lanes)} onCommit={v => editSketch(s => setInRate(s, w.lanes, v))} />
            )}
          </div>
        ))}
      </div>
      <div className="grid gap-1">
        <span className="text-xs font-medium">Ways out <span className="font-normal text-muted-foreground">· share of trips</span></span>
        {exits.map(w => {
          const ws = w.lanes.reduce((b, id) => b + laneOutWeight(lane(id)), 0), pct = sumW > 0 ? Math.round((ws / sumW) * 100) : 0;
          return (
            <div key={w.key} className={row} onMouseEnter={() => onFocus?.(w.lanes)} onMouseLeave={() => onFocus?.(null)}>
              <span className={cn("min-w-0 flex-1 truncate", weight(w.lanes) === 0 && "text-muted-foreground line-through")} title={`${w.name}: ${w.lanes.join(", ")}`}>{w.name}</span>
              <span className="w-9 text-right font-mono text-[11px] text-muted-foreground tabular">{pct}%</span>
              {readOnly ? <span className="font-mono tabular">×{weight(w.lanes)}</span> : (
                <NumberField id={`dm-out-${w.key}`} label={`${w.name} share of trips`} hideLabel unit="×" digits={1} min={0} max={100} step={0.5} className="w-24"
                  value={weight(w.lanes)} onCommit={v => editSketch(s => setOutWeight(s, w.lanes, v))} />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
