"use client";

import { ClipboardCopy, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { edgeName, explainText, headline, patienceNote, RULE_WORDS, tagWords, type CarExplain } from "@/lib/car-explain";

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const one = (x: number) => x.toFixed(1);

/**
 * "Why" (T157): what holds the car picked, in plain words first, then the numbers: its speeds, the car ahead, the rule
 * and the car holding it, how far its stop point is, for how long; the chain of cars holding each other (a ring is a
 * deadlock), its plan and the gaps it turned down, its last decisions. Each car named is a link that picks it.
 */
export function CarWhy({ x, live, onPick }: { x: CarExplain | null; live: boolean; onPick: (id: number) => void }) {
  if (!x) return null;
  const h = headline(x), car = (id: number) => <button key={id} className="font-mono underline" onClick={() => onPick(id)} title={`Pick car ${id}`}>{id}</button>;
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-2"><span className="shrink-0 text-muted-foreground">{label}</span><span className="min-w-0 text-right">{value}</span></div>
  );
  const ring = new Set(x.deadlock ?? []), patience = patienceNote(x);
  const copy = () => void navigator.clipboard.writeText(explainText(x, clock)).then(() => toast.success(`Car ${x.car}'s explanation copied`), () => toast.error("Couldn't copy"));
  return (
    <div className="grid gap-1 rounded border bg-background/60 px-2 py-1.5 text-xs" aria-label="Why">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground">Why</span>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11px]" onClick={copy} title="Copy the explanation as plain text, to paste into a conversation"><ClipboardCopy className="size-3" /> Copy explanation</Button>
      </div>
      <p className={x.deadlock ? "font-medium text-destructive" : "font-medium"}>
        {x.deadlock && <TriangleAlert className="mr-1 inline size-3.5" />}
        {h.text}
      </p>
      {patience && <p className="text-[11px] text-muted-foreground">{patience}</p>}
      {!x.traced && (
        <p className="text-[11px] text-muted-foreground">
          {live ? "Just picked, from the recording: its speeds, plan and the gaps it turns down are traced from the next step (Run)." : "From the recording (it wasn't picked then): its speeds, plan and the gaps it turned down weren't traced."}
        </p>
      )}
      {x.speed && row("Speed", <span className="font-mono tabular">{x.speed.kmh.toFixed(0)} now · {x.speed.desiredKmh.toFixed(0)} desired · {x.speed.targetKmh.toFixed(0)} target km/h</span>)}
      {x.leader && row("Leader", <>car {car(x.leader.car)} <span className="font-mono tabular">{one(x.leader.gap)} m ahead, {x.leader.kmh.toFixed(0)} km/h</span></>)}
      {x.rule && row("Rule", <>{RULE_WORDS[x.rule.kind]}{x.rule.edge ? ` · ${edgeName(x.rule.edge)}` : ""}{x.rule.detail ? ` (${x.rule.detail})` : ""} <span className="font-mono text-muted-foreground tabular">{one(x.since)} s</span></>)}
      {x.blocker && row("Held by", (
        <>car {car(x.blocker.car)} on <span className="font-mono">{edgeName(x.blocker.edge)}</span>
          {(x.blocker.gap !== undefined || x.blocker.theirSec !== undefined) && (
            <span className="block font-mono text-muted-foreground tabular">
              {[x.blocker.gap !== undefined ? `gap ${one(x.blocker.gap)} m` : "", x.blocker.needGap !== undefined ? `needs ${one(x.blocker.needGap)} m` : "", x.blocker.theirSec !== undefined ? `it's there in ${one(x.blocker.theirSec)} s` : "", x.blocker.mySec !== undefined ? `clearing takes ${one(x.blocker.mySec)} s` : ""].filter(Boolean).join(" · ")}
            </span>
          )}
        </>
      ))}
      {x.stopAt && row("Stops in", <span><span className="font-mono tabular">{one(x.stopAt.dist)} m</span> <span className="text-muted-foreground">({tagWords(x.stopAt.why)})</span></span>)}
      {x.chain.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5" aria-label="Blocking chain">
          <span className="mr-1 text-muted-foreground">Chain</span>
          <span className="font-mono">{x.car}</span>
          {x.chain.map((id, i) => <span key={i} className={ring.has(id) ? "text-destructive" : ""}>→ {car(id)}</span>)}
          {x.deadlock && <span className="ml-1 rounded bg-destructive/15 px-1 font-medium text-destructive">Deadlock: {x.deadlock.join(", ")}</span>}
        </div>
      )}
      {x.plan && (
        <>
          {row("Next", <span className="font-mono">{x.plan.next ? edgeName(x.plan.next) : "—"}</span>)}
          {x.plan.laneChange && row("Changing to", <span><span className="font-mono">{edgeName(x.plan.laneChange.to)}</span> <span className="text-muted-foreground">({x.plan.laneChange.why})</span></span>)}
          {x.plan.rejected.length > 0 && (
            <div>
              <span className="text-muted-foreground">Gaps turned down</span>
              <ul className="grid gap-px font-mono tabular">
                {x.plan.rejected.slice(-5).map((g, i) => (
                  <li key={i} className="flex justify-between gap-2"><span>{clock(g.t)} {edgeName(g.edge)}{g.car !== undefined && <> · {car(g.car)}</>}</span><span>{one(g.gap)} &lt; {one(g.need)} m</span></li>
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
                <span>{l.what}: {tagWords(l.text)}{l.car !== undefined && <> ({car(l.car)})</>}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
