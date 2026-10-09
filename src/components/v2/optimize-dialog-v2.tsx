"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Gauge, Loader2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { groupOf, junctionContents, signalPlan, type Sketch } from "@/lib/lane-sketch";
import { DEFAULT_SIM } from "@/lib/lane-sketch-sim";
import { formatChange, OPTIMIZE_EFFORT, OPTIMIZE_TARGETS, type OptimizeEffort, type OptimizeProgress, type OptimizeResult, type OptimizeTarget, type Summary } from "@/lib/sketch-optimize";
import { cn } from "@/lib/utils";
import { useSketchStore } from "@/state/lane-sketch";
import { startSketchOptimizer } from "@/state/sketch-optimizer";
import { ui } from "@/state/store";
import { sketchUi, useEditorKind, useUiPath, type EditorUi } from "@/state/sketch-ui";

type Stage = { kind: "setup" } | { kind: "running"; progress: OptimizeProgress | null; startedAt: number } | { kind: "done"; result: OptimizeResult; took: number } | { kind: "error"; message: string };

/**
 * "Optimise timings" on a junction's lights, as V1's Optimise: tunes the chosen lights by simulating
 * candidates (see lib/sketch-optimize.ts), this junction chosen to start with.
 */
export function OptimizeLightsButton({ junction }: { junction: string }) {
  // (open or not, from which junction, and where it is: the editor's, in the V2 UI store)
  const kind = useEditorKind();
  const [o, setO] = useUiPath<EditorUi["dialogs"]["optimizer"]>(`editors/${kind}/dialogs/optimizer`);
  const open = o.open && o.junction === junction;
  const setOpen = (v: boolean) => setO(p => ({ ...p, open: v, junction: v ? junction : null, stage: "setup" }));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="h-7" title="Improve the lights' timings by simulating candidates"><Gauge /> Optimise timings</Button>
      </DialogTrigger>
      {open && <OptimizeContent first={junction} close={() => setOpen(false)} />}
    </Dialog>
  );
}

function OptimizeContent({ first, close }: { first: string; close: () => void }) {
  const store = useSketchStore();
  // (the sketch as it is when the dialog opens: the result applies to this one)
  const [sketch] = useState<Sketch>(() => store.sketch$.getValue());
  const params = sketch.traffic ?? DEFAULT_SIM, readOnly = ui.getValue().readOnly;
  const lit = useMemo(() => sketch.junctions.flatMap(j => {
    if (!j.lights) return [];
    const plan = signalPlan(sketch, j, junctionContents(sketch, j));
    return plan && plan.phases.length >= 2 ? [{ id: j.id, name: j.name, phases: plan.phases.length, custom: plan.custom, actuated: plan.actuated, group: groupOf(sketch, j.id)?.name ?? null }] : [];
  }), [sketch]);
  const nameOf = (id: string) => sketch.junctions.find(j => j.id === id)?.name ?? id;
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(lit.some(l => l.id === first && !l.group) ? [first] : []));
  const [targets, setTargets] = useState<Set<OptimizeTarget>>(() => new Set(["greens", "actuated"]));
  const [effort, setEffort] = useState<OptimizeEffort>("quick");
  const [stage, setStage] = useState<Stage>({ kind: "setup" });
  // (shown in the V2 UI store, for agents: what is chosen and where it is; the progress and results stay here)
  const ek = useEditorKind();
  useEffect(() => {
    const d = sketchUi.getValue().editors[ek].dialogs.optimizer;
    if (d.stage !== stage.kind) d.stage = stage.kind;
    if (d.effort !== effort) d.effort = effort;
    const c = [...chosen];
    if (c.length !== d.chosen.length || c.some((x, i) => x !== d.chosen[i])) d.chosen = c;
  }, [ek, stage.kind, effort, chosen]);
  const runRef = useRef<ReturnType<typeof startSketchOptimizer> | null>(null);
  const cores = typeof navigator !== "undefined" ? Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)) : 3;
  const cfg = OPTIMIZE_EFFORT[effort];
  const perMin = (x: Summary) => x.trips / (cfg.spec.measure / 60);

  function start() {
    const started = Date.now();
    setStage({ kind: "running", progress: null, startedAt: started });
    const run = startSketchOptimizer(sketch, params, [...chosen], [...targets], effort, p => setStage(s => (s.kind === "running" ? { ...s, progress: p } : s)));
    runRef.current = run;
    run.done
      .then(result => setStage({ kind: "done", result, took: Date.now() - started }))
      .catch(e => setStage(e instanceof DOMException && e.name === "AbortError" ? { kind: "setup" } : { kind: "error", message: e instanceof Error ? e.message : "The optimisation failed" }));
  }
  useEffect(() => () => runRef.current?.cancel(), []);
  function apply(r: OptimizeResult) {
    const now = store.sketch$.getValue();
    // (only if those lights are as they were when it started)
    if (Object.keys(r.lights).some(id => now.junctions.find(j => j.id === id)?.lights !== sketch.junctions.find(j => j.id === id)?.lights)) {
      toast.error("Those lights changed while optimising: run it again on them as they are now.");
      return;
    }
    store.edit(s => ({ ...s, junctions: s.junctions.map(j => (r.lights[j.id] ? { ...j, lights: r.lights[j.id] } : j)) }));
    toast.success("Timings applied", { description: "Undo with ⌘Z if you change your mind." });
    close();
  }

  return (
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl" onInteractOutside={e => stage.kind === "running" && e.preventDefault()}>
      <DialogHeader>
        <DialogTitle>Optimise traffic lights</DialogTitle>
        <DialogDescription>
          Tries changes to the chosen lights, running this sketch&apos;s traffic ({params.rate} veh/h at each way in) round them on several random seeds, and keeps a
          change only when it clearly helps and still does on a second set of seeds. The result is checked on fresh seeds before you decide.
        </DialogDescription>
      </DialogHeader>

      {stage.kind === "setup" && (
        <div className="grid min-h-0 gap-4 overflow-y-auto">
          {!lit.length ? <p className="text-sm text-muted-foreground">No junction here has lights with two phases or more.</p> : (
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Junctions with lights</span>
                <span className="flex gap-1">
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setChosen(new Set(lit.filter(l => !l.group).map(l => l.id)))}>All</Button>
                  <Button variant="ghost" size="sm" className="h-7" onClick={() => setChosen(new Set())}>None</Button>
                </span>
              </div>
              <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border p-2">
                {lit.map(l => (
                  <label key={l.id} className={cn("flex items-center gap-3 rounded px-1 py-1 text-sm hover:bg-accent", l.group && "opacity-60")} title={l.group ? `In ${l.group}: the group times it` : undefined}>
                    <Switch disabled={!!l.group} checked={chosen.has(l.id)} onCheckedChange={v => setChosen(s => { const n = new Set(s); if (v) n.add(l.id); else n.delete(l.id); return n; })} />
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    <span className="text-xs text-muted-foreground">{l.group ? `in ${l.group}` : `${l.phases} phases${l.custom ? " by hand" : ""} · ${l.actuated ? "actuated" : "fixed"}`}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          <div className="grid gap-2">
            <span className="text-sm font-medium">What may change</span>
            <div className="grid gap-1.5 sm:grid-cols-3">
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
              Each candidate runs on {cfg.seeds.length} seeds: {cfg.spec.warmup / 60} min to fill the roads, then {cfg.spec.measure / 60} min measured. A winner must win again on
              {" "}{cfg.confirmSeeds.length} other seeds; up to {cfg.rounds} passes, then a check on {cfg.holdoutSeeds.length} fresh seeds.
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            Only the roads within about 600 m of the chosen junctions are simulated (traffic comes in where they are cut off), so a city stays quick. Runs in this tab on {cores} CPU
            core{cores === 1 ? "" : "s"}; keep it open. Lights with phases worked out get them set by hand, so each phase can have its own green. Nothing changes until you apply the result.
          </p>
          {(!chosen.size || !targets.size) && (() => {
            // (why Start can't be pressed, and what can be done)
            const own = lit.find(l => l.id === first), free = lit.filter(l => !l.group);
            const why = !chosen.size
              ? own?.group
                ? `${own.name} is in ${own.group}: the group times it (one cycle, each member's offset), so its own timings can't be optimised here. ${free.length ? `Choose other lights above (${free.length} not in a group), or set the group's timing in its panel.` : "Every junction with lights is in a group: set the group's cycle and offsets in its panel."}`
                : free.length ? "Choose at least one junction with lights above." : "No junction with lights of two phases or more to optimise."
              : "Choose at least one thing that may change.";
            return <p className="rounded-md bg-amber-500/10 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-300" role="status">{why}</p>;
          })()}
          <DialogFooter>
            <Button variant="ghost" onClick={close}>Cancel</Button>
            <Button onClick={start} disabled={!chosen.size || !targets.size}>Start</Button>
          </DialogFooter>
        </div>
      )}

      {stage.kind === "running" && (() => {
        const p = stage.progress, pct = p ? Math.min(100, (p.evaluations / Math.max(1, p.total)) * 100) : 0;
        return (
          <div className="grid gap-3">
            <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
            <p className="flex items-center gap-2 text-sm"><Loader2 className="size-4 animate-spin" /> {p ? `Pass ${Math.max(1, p.round)} of ${p.rounds} · ${p.step}` : "Starting the simulations…"}</p>
            {p?.baseline && p.best && (
              <p className="text-sm text-muted-foreground">
                Now: {perMin(p.baseline).toFixed(1)} trips/min · best so far: {perMin(p.best).toFixed(1)} trips/min
                {p.best.score > p.baseline.score ? ` (+${(((p.best.score - p.baseline.score) / Math.max(1, Math.abs(p.baseline.score))) * 100).toFixed(1)}%)` : ""}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{p ? `${p.evaluations} candidates simulated` : ""} · <Elapsed since={stage.startedAt} /></p>
            <DialogFooter><Button variant="outline" onClick={() => { runRef.current?.cancel(); runRef.current = null; }}>Stop</Button></DialogFooter>
          </div>
        );
      })()}

      {stage.kind === "error" && (
        <div className="grid gap-3">
          <p className="flex gap-2 text-sm text-destructive"><TriangleAlert className="mt-0.5 size-4 shrink-0" /> {stage.message}</p>
          <DialogFooter><Button variant="outline" onClick={() => setStage({ kind: "setup" })}>Back</Button></DialogFooter>
        </div>
      )}

      {stage.kind === "done" && <Result r={stage.result} took={stage.took} nameOf={nameOf} perMin={perMin} readOnly={readOnly} onApply={() => apply(stage.result)} onAgain={() => setStage({ kind: "setup" })} onClose={close} />}
    </DialogContent>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")} elapsed</>;
}

function Result({ r, took, nameOf, perMin, readOnly, onApply, onAgain, onClose }: {
  r: OptimizeResult; took: number; nameOf: (id: string) => string; perMin: (x: Summary) => number; readOnly: boolean; onApply: () => void; onAgain: () => void; onClose: () => void;
}) {
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
      {r.changes.length === 0 ? <p className="text-sm">No change clearly beat the lights as they are: they are about as good as this search can find for this traffic.</p> : (
        <div className="grid gap-1">
          <span className="text-sm font-medium">Changes</span>
          <ul className="grid gap-1 text-sm">{r.changes.map((c, i) => <li key={i} className="border-t pt-1">{formatChange(c, nameOf)}</li>)}</ul>
        </div>
      )}
      <div className="grid gap-1">
        <span className="text-sm font-medium">Check on {of} fresh seeds</span>
        <table className="text-sm">
          <thead><tr className="text-xs text-muted-foreground"><th /><th className="pb-1 text-right font-normal">Now</th><th className="pb-1 text-right font-normal">With the changes</th></tr></thead>
          <tbody>
            {row("Trips per minute", perMin(b).toFixed(1), perMin(a).toFixed(1), a.trips === b.trips ? null : a.trips > b.trips)}
            {row("Mean speed", `${b.meanSpeed.toFixed(1)} km/h`, `${a.meanSpeed.toFixed(1)} km/h`, a.meanSpeed === b.meanSpeed ? null : a.meanSpeed > b.meanSpeed)}
            {row("Stuck a minute or more", b.stuck.toFixed(1), a.stuck.toFixed(1), a.stuck === b.stuck ? null : a.stuck < b.stuck)}
          </tbody>
        </table>
        {r.changes.length > 0 && (
          <p className={cn("text-sm", holds ? "text-[var(--sig-go)]" : "text-amber-700 dark:text-amber-500")}>
            {holds
              ? `Better on ${better} of ${of} fresh seeds (${gain >= 0 ? "+" : ""}${gain.toFixed(1)}% overall).`
              : `Better on only ${better} of ${of} fresh seeds (${gain >= 0 ? "+" : ""}${gain.toFixed(1)}%): the gain found in the search did not hold up, so applying it is not recommended. Try more effort.`}
          </p>
        )}
      </div>
      <DialogFooter className="flex-wrap gap-2">
        <Button variant="ghost" onClick={onAgain}>Run again</Button>
        {readOnly || r.changes.length === 0 ? <Button onClick={onClose}>Close</Button> : <Button onClick={onApply} variant={holds ? "default" : "outline"}>Apply</Button>}
      </DialogFooter>
    </div>
  );
}
