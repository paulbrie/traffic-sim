"use client";

import { createContext, Fragment, useContext, type ReactNode } from "react";
import { ClipboardCopy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { crossingWords, edgeName, explainText, headline, movingLoop, noRouteText, patienceNote, RULE_WORDS, tagWords, type CarExplain } from "@/lib/car-explain";
import { baseLaneId, type Sketch } from "@/lib/lane-sketch";

/** a place on the sketch a car's panel names: a road, a lane or a connector */
export type SketchPlace = { kind: "road" | "lane" | "connector"; id: string };
/** the editor the car's panel is in: its sketch, and how to go to a place on it (selected, the view moved to it) */
export const SketchGoContext = createContext<{ sketch: Sketch; go: (to: SketchPlace) => void } | null>(null);

const LINK = "underline decoration-dotted underline-offset-2 hover:decoration-solid";

/** an edge key ("lane:l5", "conn:c7") or a bare lane / connector id, as the place it is (null: not on the sketch) */
function placeOf(sk: Sketch, key: string): SketchPlace | null {
  const id = key.slice(key.indexOf(":") + 1), lane = baseLaneId(id);
  // (a lane both ways' way back: its lane, ticket #53)
  if (!key.startsWith("conn:") && sk.lanes.some(l => l.id === lane)) return { kind: "lane", id: lane };
  if (!key.startsWith("lane:") && sk.connectors.some(c => c.id === id)) return { kind: "connector", id };
  return null;
}

/** a place by name, as a link to it (plain text outside an editor, or when it isn't on the sketch any more) */
export function PlaceLink({ to, children, className }: { to: SketchPlace | null; children: ReactNode; className?: string }) {
  const ctx = useContext(SketchGoContext);
  if (!ctx || !to) return <span className={className}>{children}</span>;
  return <button type="button" className={`${LINK} ${className ?? ""}`} title="Select it and go to it" onClick={() => ctx.go(to)}>{children}</button>;
}

/** an edge ("lane:l5", "conn:c7"), named as `edgeName` does, as a link to it; on a road, its road's name before it */
export function EdgeLink({ edge, road = false, className }: { edge: string; road?: boolean; className?: string }) {
  const ctx = useContext(SketchGoContext), to = ctx && placeOf(ctx.sketch, edge);
  const rd = road && to?.kind === "lane" ? ctx!.sketch.roads.find(r => r.lanes.includes(to.id)) : undefined;
  return (
    <>
      {rd?.name && <><PlaceLink to={{ kind: "road", id: rd.id }}>{rd.name}</PlaceLink> · </>}
      <PlaceLink to={to} className={className}>{edgeName(edge)}</PlaceLink>
    </>
  );
}

/** the sim's words, with the lanes and connectors named in them ("lane l5", "connector c7") as links */
export function SketchText({ text }: { text: string }) {
  const ctx = useContext(SketchGoContext);
  if (!ctx) return <>{text}</>;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(/\b(lane|connector) ([A-Za-z0-9_]+)\b/g)) {
    const to = placeOf(ctx.sketch, `${m[1] === "lane" ? "lane" : "conn"}:${m[2]}`);
    if (!to) continue;
    if (m.index > last) out.push(<Fragment key={out.length}>{text.slice(last, m.index)}</Fragment>);
    out.push(<PlaceLink key={out.length} to={to}>{m[0]}</PlaceLink>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={out.length}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const one = (x: number) => x.toFixed(1);

/**
 * "Why" (T157): what holds the car picked, in plain words first, then the numbers: its speeds, the car ahead, the rule
 * and the car holding it, how far its stop point is, for how long; the chain of cars holding each other (a ring is a
 * deadlock), its plan and the gaps it turned down, its last decisions. Each car named is a link that picks it.
 */
export function CarWhy({ x, live, patience: firstCome, onPick }: {
  x: CarExplain | null; live: boolean;
  /** the plan's tuning "patience" (s): how long cars of equal standing wait before the one waiting longer goes */
  patience?: number;
  onPick: (id: number) => void;
}) {
  if (!x) return null;
  const h = headline(x), car = (id: number) => <button key={id} className="font-mono underline" onClick={() => onPick(id)} title={`Pick car ${id}`}>{id}</button>;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 text-right">{value}</span></div>
  );
  const ring = new Set(x.deadlock ?? []), patience = patienceNote(x, firstCome), lost = noRouteText(x);
  const copy = () => void navigator.clipboard.writeText(explainText(x, clock, firstCome)).then(() => toast.success(`Car ${x.car}'s explanation copied`), () => toast.error("Couldn't copy"));
  return (
    <div className="grid gap-1 rounded border bg-background/60 px-2 py-1.5 text-xs" aria-label="Why">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Why</span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={copy} title="Copy the explanation as plain text, to paste into a conversation"><ClipboardCopy className="size-3" /> Copy explanation</Button>
      </div>
      <p className={x.deadlock || h.text === lost ? "font-medium text-destructive" : "font-medium"}>
        {x.deadlock && <TriangleAlert className="mr-1 inline size-3.5" />}
        <SketchText text={h.text} />
      </p>
      {lost && h.text !== lost && <p className="text-[11px] font-medium text-destructive"><SketchText text={lost} /></p>}
      {patience && <p className="text-[11px] text-muted-foreground">{patience}</p>}
      {!x.traced && (
        <p className="text-[11px] text-muted-foreground">
          {live ? "Just picked, from the recording: its speeds, plan and the gaps it turns down are traced from the next step (Run)." : "From the recording (it wasn't picked then): its speeds, plan and the gaps it turned down weren't traced."}
        </p>
      )}
      {x.speed && row("Speed", <span className="font-mono tabular">{x.speed.kmh.toFixed(0)} now · {x.speed.desiredKmh.toFixed(0)} desired · {x.speed.targetKmh.toFixed(0)} target km/h</span>)}
      {x.leader && row("Leader", <>car {car(x.leader.car)} <span className="font-mono tabular">{one(x.leader.gap)} m ahead, {x.leader.kmh.toFixed(0)} km/h</span></>)}
      {x.rule && row("Rule", <>{RULE_WORDS[x.rule.kind]}{x.rule.edge && <> · <EdgeLink edge={x.rule.edge} /></>}{x.rule.detail ? ` (${x.rule.detail})` : ""} <span className="font-mono text-muted-foreground tabular">{one(x.since)} s</span></>)}
      {x.blocker && row("Held by", (
        <>car {car(x.blocker.car)} on <span className="font-mono"><EdgeLink edge={x.blocker.edge} /></span>
          {(() => {
            const b = x.blocker, cw = crossingWords(b);
            const parts = [b.gap !== undefined ? `gap ${one(b.gap)} m` : "", b.needGap !== undefined ? `needs ${one(b.needGap)} m` : "", ...cw.where, cw.need ? `needs ${cw.need}` : ""].filter(Boolean);
            return parts.length > 0 && <span className="block font-mono text-muted-foreground tabular">{parts.join(" · ")}</span>;
          })()}
        </>
      ))}
      {x.stopAt && row("Stops in", <span><span className="font-mono tabular">{one(x.stopAt.dist)} m</span> <span className="text-muted-foreground">(<SketchText text={tagWords(x.stopAt.why)} />)</span></span>)}
      {x.chain.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5" aria-label="Blocking chain">
          <span className="mr-1 text-muted-foreground">Chain</span>
          <span className="font-mono">{x.car}</span>
          {x.chain.map((id, i) => <span key={i} className={ring.has(id) ? "text-destructive" : ""}>→ {car(id)}</span>)}
          {x.deadlock && <span className="ml-1 rounded bg-destructive/15 px-1 font-medium text-destructive">Deadlock: {x.deadlock.join(", ")}</span>}
          {movingLoop(x) && <span className="ml-1 text-muted-foreground">(a loop, still moving: not a deadlock)</span>}
        </div>
      )}
      {x.plan && (
        <>
          {row("Next", <span className="font-mono">{x.plan.next ? <EdgeLink edge={x.plan.next} /> : "—"}</span>)}
          {x.plan.laneChange && row("Changing to", <span><span className="font-mono"><EdgeLink edge={x.plan.laneChange.to} /></span> <span className="text-muted-foreground">({x.plan.laneChange.why})</span></span>)}
          {x.plan.rejected.length > 0 && (
            <div>
              <span className="text-muted-foreground">Gaps turned down</span>
              <ul className="grid gap-px font-mono tabular">
                {x.plan.rejected.slice(-5).map((g, i) => (
                  <li key={i} className="flex justify-between gap-2"><span>{clock(g.t)} <EdgeLink edge={g.edge} />{g.car !== undefined && <> · {car(g.car)}</>}</span><span>{one(g.gap)} &lt; {one(g.need)} m</span></li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {x.log.length > 0 && (
        <details>
          <summary className="cursor-pointer text-muted-foreground">Recent decisions ({x.log.length})</summary>
          <ol className="mt-0.5 grid max-h-48 gap-px overflow-y-auto">
            {x.log.map((l, i) => (
              <li key={i} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.5">
                <span className="font-mono text-muted-foreground tabular">{clock(l.t)}</span>
                <span>{l.what}: <SketchText text={tagWords(l.text)} />{l.car !== undefined && <> ({car(l.car)})</>}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
