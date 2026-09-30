"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Gauge, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { compile, formatChange, OPTIMIZE_EFFORT, OPTIMIZE_TARGETS, type Control, type Network, type OptimizeEffort, type OptimizeProgress, type OptimizeResult, type OptimizeTarget, type Summary } from "@/engine";
import { junctionRefs } from "@/engine/refs";
import { commit, network$, settings$, ui } from "@/state/store";
import { startOptimizer } from "@/state/optimizer";
import { createPlanFrom } from "@/server/actions";
import { cn } from "@/lib/utils";
import { phaseName } from "./signal-groups";

type Stage = { kind: "setup" } | { kind: "running"; progress: OptimizeProgress | null; startedAt: number } | { kind: "done"; result: OptimizeResult; took: number } | { kind: "error"; message: string };

/** "Optimise signals": tunes the green times of chosen traffic lights by simulating candidates. */
const CONTROL_LABEL: Record<Control, string> = { priority: "Priority", free: "Free", stop: "All-way stop", lights: "Lights", roundabout: "Roundabout" };

export function OptimizeButton({ planId, planName }: { planId: string; planName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" title="Improve junctions by simulation"><Gauge /> Optimise</Button>
      </DialogTrigger>
      {open && <OptimizeContent planId={planId} planName={planName} close={() => setOpen(false)} />}
    </Dialog>
  );
}

function OptimizeContent({ planId, planName, close }: { planId: string; planName: string; close: () => void }) {
  const router = useRouter();
  // the plan as it is when the dialog opens: results apply to this version
  const [net] = useState<Network>(() => network$.getValue());
  const [settings] = useState(() => settings$.getValue());
  const readOnly = ui.getValue().readOnly;
  const info = useMemo(() => {
    const c = compile(net, { outlines: false }), refs = junctionRefs(c);
    const junctions = [...refs].map(([id, ref]) => ({ id, ref, n: c.nodeById.get(id)! }))
      .map(x => ({ id: x.id, ref: x.ref, roads: [...new Set(x.n.arms.map(a => a.link.name || "unnamed road"))].join(" × "), control: x.n.def.control, phases: x.n.phases.length, custom: x.n.customPhases }));
    return { refs, junctions };
  }, [net]);
  const sel = ui.getValue().selection;
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(sel?.kind === "node" && info.junctions.some(l => l.id === sel.id) ? [sel.id] : info.junctions.map(l => l.id)));
  const [targets, setTargets] = useState<Set<OptimizeTarget>>(() => new Set(OPTIMIZE_TARGETS.map(t => t.id)));
  const [effort, setEffort] = useState<OptimizeEffort>("standard");
  const [stage, setStage] = useState<Stage>({ kind: "setup" });
  const [saving, setSaving] = useState(false);
  const runRef = useRef<ReturnType<typeof startOptimizer> | null>(null);
  const cores = typeof navigator !== "undefined" ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 3;
  const cfg = OPTIMIZE_EFFORT[effort];
  const label = (s: string) => s.replace(/n_[a-z0-9]+/g, id => info.refs.get(id) ?? "a junction");
  const perMin = (x: Summary) => x.trips / (cfg.spec.measure / 60);

  function start() {
    const nodes = [...chosen];
    const started = Date.now();
    setStage({ kind: "running", progress: null, startedAt: started });
    const run = startOptimizer(net, settings, nodes, [...targets], effort, p => setStage(s => (s.kind === "running" ? { ...s, progress: p } : s)));
    runRef.current = run;
    run.done
      .then(result => setStage({ kind: "done", result, took: Date.now() - started }))
      .catch(e => setStage(e instanceof DOMException && e.name === "AbortError" ? { kind: "setup" } : { kind: "error", message: e instanceof Error ? e.message : "The optimisation failed" }));
  }
  function cancel() { runRef.current?.cancel(); runRef.current = null; }

  function apply(r: OptimizeResult) {
    if (network$.getValue() !== net) { toast.error("The plan changed while optimising; run it again on the current plan."); return; }
    commit(r.network);
    toast.success("Changes applied", { description: "Undo with ⌘Z if you change your mind." });
    close();
  }
  async function saveAsNew(r: OptimizeResult, name: string) {
    setSaving(true);
    try {
      const id = await createPlanFrom(planId, { name, description: `Junctions optimised from “${planName}”.`, network: r.network, settings });
      toast.success("Saved as a new plan");
      close();
      router.push(`/plans/${id}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save the plan"); } finally { setSaving(false); }
  }

  return (
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl" onInteractOutside={e => stage.kind === "running" && e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>Optimise junctions</DialogTitle>
        <DialogDescription>
          Tries changes at the chosen junctions, running this plan&apos;s traffic ({settings.cars} cars, {settings.trucks} trucks) on several random seeds,
          and keeps a change only when it clearly helps and still does on a second set of seeds. The result is checked on fresh seeds before you decide.
        </DialogDescription>
      </DialogHeader>

      {stage.kind === "setup" && (
        <div className="grid min-h-0 gap-4 overflow-y-auto">
          {info.junctions.length === 0 ? (
            <p className="text-sm text-muted-foreground">This plan has no junctions yet.</p>
          ) : (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Junctions</span>
                <span className="flex gap-1">
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setChosen(new Set(info.junctions.map(l => l.id)))}>All</Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setChosen(new Set())}>None</Button>
                </span>
              </div>
              <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-2">
                {info.junctions.map(l => (
                  <label key={l.id} className="flex items-center gap-3 rounded px-1 py-1 text-sm hover:bg-accent">
                    <Switch checked={chosen.has(l.id)} onCheckedChange={v => setChosen(s => { const n = new Set(s); if (v) n.add(l.id); else n.delete(l.id); return n; })} />
                    <span className="w-8 font-mono text-xs font-semibold">{l.ref}</span>
                    <span className="min-w-0 flex-1 truncate">{l.roads}</span>
                    <span className="text-xs text-muted-foreground">{CONTROL_LABEL[l.control]}{l.control === "lights" ? ` · ${l.phases} phases${l.custom ? " per lane" : ""}` : ""}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <span className="text-sm font-medium">What may change</span>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {OPTIMIZE_TARGETS.map(t => (
                <label key={t.id} className="flex items-start gap-2 text-sm">
                  <Switch className="mt-0.5" checked={targets.has(t.id)} onCheckedChange={v => setTargets(s => { const n = new Set(s); if (v) n.add(t.id); else n.delete(t.id); return n; })} />
                  <span>{t.label}<span className="block text-xs text-muted-foreground">{t.hint}</span></span>
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-2">
            <span className="text-sm font-medium">Effort</span>
            <ToggleGroup type="single" value={effort} onValueChange={v => v && setEffort(v as OptimizeEffort)} className="justify-start">
              {(Object.keys(OPTIMIZE_EFFORT) as OptimizeEffort[]).map(k => <ToggleGroupItem key={k} value={k} className="px-3">{OPTIMIZE_EFFORT[k].label}</ToggleGroupItem>)}
            </ToggleGroup>
            <p className="text-xs text-muted-foreground">
              Each candidate runs on {cfg.seeds.length} seeds: {cfg.spec.warmup / 60} min to fill the network, then {cfg.spec.measure / 60} min measured. A winner must win again on
              {" "}{cfg.confirmSeeds.length} other seeds; up to {cfg.rounds} passes, then a check on {cfg.holdoutSeeds.length} fresh seeds. More seeds tell real gains from luck better.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Runs in this browser tab on {cores} CPU core{cores === 1 ? "" : "s"}; keep the tab open. Traffic lights on automatic phases get the same phases set per lane, so each
            phase can have its own green time. Nothing changes until you apply the result.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button onClick={start} disabled={!chosen.size || !targets.size}>Start</Button>
          </DialogFooter>
        </div>
      )}

      {stage.kind === "running" && (() => {
        const p = stage.progress;
        const pct = p ? Math.min(100, (p.evaluations / Math.max(1, p.total)) * 100) : 0;
        return (
          <div className="grid gap-3">
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
            <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> {p ? `Pass ${Math.max(1, p.round)} of ${p.rounds} · ${label(p.step)}` : "Starting the simulations…"}</p>
            {p?.baseline && p.best && (
              <p className="text-sm text-muted-foreground">
                Now: {perMin(p.baseline).toFixed(1)} trips/min · best so far: {perMin(p.best).toFixed(1)} trips/min
                {p.best.score > p.baseline.score ? ` (+${(((p.best.score - p.baseline.score) / Math.max(1, Math.abs(p.baseline.score))) * 100).toFixed(1)}%)` : ""}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{p ? `${p.evaluations} candidates simulated` : ""} · <Elapsed since={stage.startedAt} /></p>
            <DialogFooter><Button variant="outline" onClick={cancel}>Stop</Button></DialogFooter>
          </div>
        );
      })()}

      {stage.kind === "error" && (
        <div className="grid gap-3">
          <p className="flex gap-2 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-4 shrink-0" /> {stage.message}</p>
          <DialogFooter><Button variant="outline" onClick={() => setStage({ kind: "setup" })}>Back</Button></DialogFooter>
        </div>
      )}

      {stage.kind === "done" && (
        <Result
          r={stage.result} took={stage.took} refs={info.refs} perMin={perMin} readOnly={readOnly} saving={saving} planName={planName}
          onApply={() => apply(stage.result)} onSave={name => saveAsNew(stage.result, name)} onAgain={() => setStage({ kind: "setup" })} onClose={close}
        />
      )}
    </DialogContent>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} elapsed</>;
}

function Result({ r, took, refs, perMin, readOnly, saving, planName, onApply, onSave, onAgain, onClose }: {
  r: OptimizeResult; took: number; refs: Map<string, string>; perMin: (x: Summary) => number; readOnly: boolean; saving: boolean; planName: string;
  onApply: () => void; onSave: (name: string) => void; onAgain: () => void; onClose: () => void;
}) {
  const [name, setName] = useState(`${planName} — optimised junctions`);
  const compiled = useMemo(() => compile(r.network, { outlines: false }), [r.network]);
  const { baseline: b, best: a, better, of } = r.check;
  const gain = ((a.score - b.score) / Math.max(1, Math.abs(b.score))) * 100;
  const holds = r.changes.length > 0 && a.score > b.score && better > of / 2;
  const row = (k: string, before: string, after: string, good: boolean | null) => (
    <tr className="border-t"><td className="py-1 pr-3 text-muted-foreground">{k}</td><td className="py-1 pr-3 text-right font-mono tabular">{before}</td>
      <td className={cn("py-1 text-right font-mono tabular", good === true && "text-[var(--sig-go)]", good === false && "text-destructive")}>{after}</td></tr>
  );
  return (
    <div className="grid min-h-0 gap-4 overflow-y-auto">
      <p className="text-sm text-muted-foreground">Simulated {r.evaluations} candidates in {(took / 60000).toFixed(1)} min.</p>
      {r.changes.length === 0 ? (
        <p className="text-sm">No change clearly beat the current junctions. They are already about as good as this search can find for this traffic.</p>
      ) : (
        <div className="grid gap-1">
          <span className="text-sm font-medium">Changes</span>
          <ul className="grid gap-1 text-sm">
            {r.changes.map((c, i) => {
              const cn2 = c.kind === "green" ? compiled.nodeById.get(c.node) : undefined;
              return (
                <li key={i} className="border-t pt-1">
                  {formatChange(c, id => refs.get(id) ?? "junction")}
                  {cn2 && c.kind === "green" ? <span className="text-muted-foreground"> · green for {phaseName(cn2, c.phase).replace(/^phase \d+ \((.*)\)$/, "$1")}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="grid gap-1">
        <span className="text-sm font-medium">Check on {of} fresh seeds</span>
        <table className="text-sm">
          <thead><tr className="text-xs text-muted-foreground"><th /><th className="pb-1 text-right font-normal">Now</th><th className="pb-1 text-right font-normal">With the changes</th></tr></thead>
          <tbody>
            {row("Trips per minute", perMin(b).toFixed(1), perMin(a).toFixed(1), a.trips === b.trips ? null : a.trips > b.trips)}
            {row("Average speed", `${b.avgSpeed.toFixed(1)} km/h`, `${a.avgSpeed.toFixed(1)} km/h`, a.avgSpeed === b.avgSpeed ? null : a.avgSpeed > b.avgSpeed)}
            {row("Vehicles stopped", `${(b.stopped * 100).toFixed(0)}%`, `${(a.stopped * 100).toFixed(0)}%`, a.stopped === b.stopped ? null : a.stopped < b.stopped)}
            {row("Stuck vehicles removed", b.towed.toFixed(1), a.towed.toFixed(1), a.towed === b.towed ? null : a.towed < b.towed)}
          </tbody>
        </table>
        {r.changes.length > 0 && (
          <p className={cn("text-sm", holds ? "text-[var(--sig-go)]" : "text-amber-700 dark:text-amber-500")}>
            {holds
              ? `Better on ${better} of ${of} fresh seeds (${gain >= 0 ? "+" : ""}${gain.toFixed(1)}% overall).`
              : `Better on only ${better} of ${of} fresh seeds (${gain >= 0 ? "+" : ""}${gain.toFixed(1)}%): the gain found in the search did not hold up, so applying it is not recommended. Try more effort or more junctions.`}
          </p>
        )}
      </div>
      {!readOnly && r.changes.length > 0 && (
        <div className="grid gap-2">
          <Label htmlFor="opt-name" className="text-xs text-muted-foreground">Name if saved as a new plan</Label>
          <Input id="opt-name" value={name} onChange={e => setName(e.target.value)} />
        </div>
      )}
      <DialogFooter className="flex-wrap gap-2">
        <Button variant="ghost" onClick={onAgain}>Run again</Button>
        {readOnly || r.changes.length === 0 ? <Button onClick={onClose}>Close</Button> : (
          <>
            <Button variant="outline" disabled={saving} onClick={() => onSave(name)}>{saving ? <Loader2 className="animate-spin" /> : null} Save as new plan</Button>
            <Button onClick={onApply} variant={holds ? "default" : "outline"}>Apply to this plan</Button>
          </>
        )}
      </DialogFooter>
    </div>
  );
}
