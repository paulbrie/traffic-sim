"use client";

import { Fragment } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { ArrowLeftRight, Minus, Spline, TrafficCone, Trash2, TriangleAlert, Minus as StraightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { commit, network$, select, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import type { Control, LinkDef, Network, NodeDef } from "@/engine/types";
import { NumberField, Section, Stepper, compass } from "./fields";
import { SignalGroupSection } from "./signal-groups";
import { LaneArrowsEditor } from "./lane-arrows";
import { junctionRefs } from "@/engine/refs";
import { JunctionEventLog } from "./event-log";

const CONTROL_LABEL: Record<Control, string> = { priority: "Priority (first come)", free: "Free (go when clear)", stop: "All-way stop", lights: "Traffic lights", roundabout: "Roundabout" };
const SPEEDS = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 130];

export function Inspector() {
  const [sel] = useDeepSubject(ui, "selection");
  const [net] = useSubject(network$);
  if (!sel) return <PlanSummary net={net} />;
  if (sel.kind === "node") { const n = ops.nodeById(net, sel.id); return n ? <NodeInspector net={net} node={n} /> : <PlanSummary net={net} />; }
  if (sel.kind === "link") { const l = ops.linkById(net, sel.id); return l ? <LinkInspector net={net} link={l} /> : <PlanSummary net={net} />; }
  if (sel.kind === "stop") { const s = net.stops.find(x => x.id === sel.id); return s ? <StopInspector net={net} id={s.id} /> : <PlanSummary net={net} />; }
  if (sel.kind === "vehicle") return <VehicleInspector id={sel.id} />;
  return <PlanSummary net={net} />;
}

function Header({ title, kind, onDelete }: { title: string; kind: string; onDelete?: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{kind}</div>
        <div className="truncate font-medium">{title}</div>
      </div>
      {onDelete && <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Delete ${kind.toLowerCase()}`}><Trash2 /></Button>}
    </div>
  );
}

// ---------------------------------------------------------------- summary
function PlanSummary({ net }: { net: Network }) {
  const c = simController.compiled;
  const lengthKm = net.links.reduce((acc, l) => {
    const A = ops.nodeById(net, l.from), B = ops.nodeById(net, l.to);
    return A && B ? acc + ops.linkLength(l, A, B) * (l.lanesF + l.lanesB) : acc;
  }, 0) / 1000;
  const junctions = c.nodes.filter(n => n.degree >= 3 || (n.degree === 2 && n.controlled));
  const count = (k: Control) => junctions.filter(n => n.def.control === k).length;
  return (
    <div>
      <Section title="Plan">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">Roads</dt><dd className="text-right tabular">{net.links.length}</dd>
          <dt className="text-muted-foreground">Lane length</dt><dd className="text-right tabular">{lengthKm.toFixed(2)} km</dd>
          <dt className="text-muted-foreground">Junctions</dt><dd className="text-right tabular">{junctions.length}</dd>
          <dt className="text-muted-foreground">· with lights</dt><dd className="text-right tabular">{count("lights")}</dd>
          <dt className="text-muted-foreground">· roundabouts</dt><dd className="text-right tabular">{count("roundabout")}</dd>
          <dt className="text-muted-foreground">· stop signs</dt><dd className="text-right tabular">{count("stop")}</dd>
          <dt className="text-muted-foreground">Entry / exit points</dt><dd className="text-right tabular">{c.nodes.filter(n => n.gateway).length}</dd>
          <dt className="text-muted-foreground">Bus stops</dt><dd className="text-right tabular">{net.stops.length}</dd>
        </dl>
      </Section>
      {c.warnings.length > 0 && (
        <Section title="Check">
          <ul className="grid gap-2 text-sm">
            {c.warnings.slice(0, 8).map((w, i) => <li key={i} className="flex gap-2"><TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />{w}</li>)}
          </ul>
        </Section>
      )}
      <Section title="Drawing">
        <ul className="grid gap-2 text-sm text-muted-foreground">
          <li><Kbd>R</Kbd> Road tool: click to place points, click an existing road to join it, <Kbd>Esc</Kbd> to finish. Hold <Kbd>Shift</Kbd> for 15° angles.</li>
          <li><Kbd>V</Kbd> Select: drag junctions, drag the square handle to curve a road, then fine-tune the two curve handles.</li>
          <li><Kbd>B</Kbd> Bus stop: click the side of the road the bus drives on.</li>
          <li>Type exact coordinates, lengths and bearings in this panel. Arrow keys nudge by one step, <Kbd>Shift</Kbd> by ten.</li>
          <li>Dead ends where traffic enters and leaves the plan are shown as squares.</li>
        </ul>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- node
function NodeInspector({ net, node }: { net: Network; node: NodeDef }) {
  const cn = simController.compiled.nodeById.get(node.id);
  const degree = net.links.filter(l => l.from === node.id || l.to === node.id).length;
  const set = (patch: Partial<NodeDef>, key?: string) => commit(ops.updateNode(net, node.id, patch), key);
  const crossing = degree === 2 && node.junction === true;
  const ref = cn ? junctionRefs(simController.compiled).get(node.id) : undefined;
  const kind = (ref ? `${ref} · ` : "") + (degree >= 3 ? `${degree}-way junction` : crossing ? "Junction on a road" : degree === 2 ? "Road joint" : degree === 1 ? (node.gateway ? "Entry / exit point" : "Dead end") : "Point");
  const sig = node.signal;
  return (
    <div>
      <Header kind={kind} title={`${node.x.toFixed(1)}, ${node.y.toFixed(1)}`} onDelete={() => { commit(ops.deleteNode(net, node.id)); select(null); }} />
      <Section title="Position">
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="nx" label="X (east)" unit="m" value={node.x} onCommit={x => commit(ops.moveNode(net, node.id, { x, y: node.y }), `nx:${node.id}`)} />
          <NumberField id="ny" label="Y (south)" unit="m" value={node.y} onCommit={y => commit(ops.moveNode(net, node.id, { x: node.x, y }), `ny:${node.id}`)} />
        </div>
      </Section>
      {(degree >= 3 || crossing) && (
        <Section title="Control">
          <Select value={crossing && node.control === "roundabout" ? "priority" : node.control} onValueChange={v => set({ control: v as Control })}>
            <SelectTrigger className="w-full" aria-label="Junction control"><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(CONTROL_LABEL) as Control[]).filter(k => !(crossing && k === "roundabout")).map(k => <SelectItem key={k} value={k}>{CONTROL_LABEL[k]}</SelectItem>)}</SelectContent>
          </Select>
          {node.control === "lights" && (
            <div className="grid gap-3">
              <p className="text-xs text-muted-foreground">
                {crossing
                  ? "Both directions get green together, then everyone stops for the red phase (e.g. a pedestrian crossing). Min green sets how long the red phase lasts when Actuated is on."
                  : `${cn?.phases.length ?? 0} phases: ${cn?.phases.map(g => g.length === 0 ? "all red" : g.map(i => compass(cn.arms[i].u.x, cn.arms[i].u.y).name).join(" + ")).join(" → ")}. ${sig.separate ? "Each approach gets its own green." : "Opposite approaches share a green; left turns yield to oncoming traffic."}`}
              </p>
              <div className="grid grid-cols-2 gap-2">
                <NumberField id="sg" label="Green" unit="s" value={sig.green} min={3} max={180} step={1} digits={0} onCommit={v => set({ signal: { ...sig, green: v } }, `sg:${node.id}`)} />
                <NumberField id="smg" label="Min green" unit="s" value={sig.minGreen} min={1} max={120} step={1} digits={0} onCommit={v => set({ signal: { ...sig, minGreen: v } }, `smg:${node.id}`)} />
                <NumberField id="sy" label="Yellow" unit="s" value={sig.yellow} min={1} max={10} step={0.5} digits={1} onCommit={v => set({ signal: { ...sig, yellow: v } }, `sy:${node.id}`)} />
                <NumberField id="sr" label="All red" unit="s" value={sig.allRed} min={0} max={10} step={0.5} digits={1} onCommit={v => set({ signal: { ...sig, allRed: v } }, `sr:${node.id}`)} />
              </div>
              {!crossing && (
                <label className="flex items-center justify-between gap-2 text-sm">
                  <span>Separate green per approach</span>
                  <Switch checked={!!sig.separate} onCheckedChange={v => set({ signal: { ...sig, separate: v } })} />
                </label>
              )}
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Actuated <span className="text-muted-foreground">(end idle greens early)</span></span>
                <Switch checked={sig.actuated} onCheckedChange={v => set({ signal: { ...sig, actuated: v } })} />
              </label>
            </div>
          )}
          {node.control !== "roundabout" && degree >= 3 && (
            <label className="flex items-center justify-between gap-2 text-sm">
              <span>Rounded kerbs <span className="text-muted-foreground">(merges, slip roads)</span></span>
              <Switch checked={!!node.smooth} onCheckedChange={v => set({ smooth: v })} aria-label="Rounded kerbs" />
            </label>
          )}
          {node.control === "roundabout" && <p className="text-xs text-muted-foreground">Ring radius {cn?.ringR.toFixed(1)} m. Entering traffic yields to the ring.</p>}
          {node.control === "stop" && <p className="text-xs text-muted-foreground">Every approach stops at the line, then vehicles go in arrival order.</p>}
          {node.control === "free" && <p className="text-xs text-muted-foreground">No signs, no queue order: any vehicle enters as soon as its path through the junction and its exit are clear, closest first.</p>}
          {node.control === "priority" && <p className="text-xs text-muted-foreground">Vehicles reserve their path through the junction first come, first served.</p>}
          {crossing && (
            <Button variant="outline" size="sm" onClick={() => set({ junction: false, control: "priority" })}><Minus /> Back to a plain road point</Button>
          )}
        </Section>
      )}
      {(degree >= 3 || crossing) && <SignalGroupSection net={net} node={node} />}
      {ref && cn && <JunctionLive net={net} nodeIdx={cn.idx} />}
      {degree === 2 && !crossing && (
        <Section title="Road joint">
          <p className="text-xs text-muted-foreground">A bend point on a road. Drag it to reshape the road, or double-click a road to add more.</p>
          <Button size="sm" onClick={() => set({ junction: true, control: "lights" })}><TrafficCone /> Make junction here</Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={() => commit(ops.smoothAt(net, node.id))}><Spline /> Smooth here</Button>
            <Button variant="outline" size="sm" className="flex-1" onClick={() => {
              const ls = ops.linksAt(net, node.id);
              commit(ls.reduce((n, l) => ops.updateLink(n, l.id, { c1: null, c2: null }), net));
            }}><StraightIcon /> Sharp corner</Button>
          </div>
        </Section>
      )}
      {degree === 1 && (
        <Section title="Dead end">
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>Traffic enters and leaves here</span>
            <Switch checked={node.gateway} onCheckedChange={v => set({ gateway: v })} />
          </label>
          <p className="text-xs text-muted-foreground">{node.gateway ? "This point connects the plan to the rest of the city." : "Vehicles turn around here."}</p>
        </Section>
      )}
      {degree === 1 && node.gateway && <InflowSection node={node} set={set} />}
    </div>
  );
}

function InflowSection({ node, set }: { node: NodeDef; set: (patch: Partial<NodeDef>, key?: string) => void }) {
  useSubject(stats$); // refresh the measured flow while traffic runs
  const sim = simController.sim;
  const entered = sim?.entered.get(node.id) ?? 0;
  const minutes = sim ? sim.time / 60 : 0;
  const manual = node.inflow != null;
  return (
    <Section title="Traffic in and out">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Set a flow for this entrance</span>
        <Switch checked={manual} onCheckedChange={v => set({ inflow: v ? 10 : null })} />
      </label>
      {manual ? (
        <>
          <NumberField id="inflow" label="Vehicles per minute" unit="veh/min" value={node.inflow ?? 0} min={0} max={120} step={1} digits={1} onCommit={v => set({ inflow: v }, `inflow:${node.id}`)} />
          <p className="text-xs text-muted-foreground">
            Arrivals are random around this average ({Math.round((node.inflow ?? 0) * 60)} per hour) and wait in line if the road is full. They come on top of the car and truck totals in the Traffic tab; set those to 0 to drive the plan only from entrance flows. 0 = vehicles only leave here.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">Automatic: entrances share the car and truck totals from the Traffic tab.</p>
      )}
      <NumberField
        id="exitw" label="Share of trips leaving here" unit="×" value={node.exitWeight ?? 1} min={0} max={100} step={0.5} digits={1}
        onCommit={v => set({ exitWeight: v === 1 ? null : v }, `exitw:${node.id}`)}
      />
      <p className="text-xs text-muted-foreground">1 = normal. 3 means three times as many trips end here as at a normal exit; 0 means nobody leaves here.</p>
      {sim && minutes > 0.2 && (
        <p className="text-xs tabular">Entered so far: <span className="font-mono">{entered}</span> · <span className="font-mono">{(entered / minutes).toFixed(1)}</span> veh/min</p>
      )}
    </Section>
  );
}

/** live counts for a junction: throughput, queues per approach, turns taken */
function JunctionLive({ net, nodeIdx }: { net: Network; nodeIdx: number }) {
  useSubject(stats$);
  const sim = simController.sim;
  if (!sim) return (
    <Section title="Live">
      <p className="text-xs text-muted-foreground">Run traffic to see what happens at this junction.</p>
      <JunctionEventLog nodeId={simController.compiled.nodes[nodeIdx].def.id} refName={junctionRefs(simController.compiled).get(simController.compiled.nodes[nodeIdx].def.id) ?? "junction"} />
    </Section>
  );
  const st = sim.junctionStats(nodeIdx);
  const n = simController.compiled.nodes[nodeIdx];
  const name = (l: LinkDef, dir: 1 | -1) => {
    const A = ops.nodeById(net, dir === 1 ? l.from : l.to), B = ops.nodeById(net, dir === 1 ? l.to : l.from);
    const h = A && B ? compass(B.x - A.x, B.y - A.y).name : "";
    return `${l.name || "Road"} (heading ${h})`;
  };
  return (
    <Section title="Live">
      <div className="grid grid-cols-3 gap-2 text-center">
        {[["Vehicles/min", st.perMin.toFixed(1)], ["Crossed", String(st.through)], ["Waiting", String(st.waiting)]].map(([k, v]) => (
          <div key={k} className="rounded-md border px-2 py-1.5"><div className="font-mono text-sm font-semibold tabular">{v}</div><div className="text-[10px] text-muted-foreground">{k}</div></div>
        ))}
      </div>
      <div className="grid gap-1.5">
        {st.approaches.map((a, i) => {
          const e = n.arms.filter(x => x.inEdge)[i]?.inEdge;
          const moves = e ? n.moves.get(e.idx) ?? [] : [];
          const counts = moves.map(m => sim.turnCounts.get(`${m.in.idx}>${m.out.idx}`) ?? 0);
          const total = counts.reduce((x, y) => x + y, 0);
          return (
            <div key={i} className="rounded-md border p-2 text-xs">
              <div className="flex justify-between gap-2"><span className="truncate font-medium">{name(a.link, a.dir)}</span><span className="shrink-0 font-mono tabular">{a.waiting} waiting{a.queueM > 0 ? ` · ${Math.round(a.queueM)} m` : ""}</span></div>
              {total > 0 && (
                <div className="mt-1 flex flex-wrap gap-x-3 text-muted-foreground">
                  {moves.map((m, j) => <span key={j} className="font-mono tabular">{({ L: "←", S: "↑", R: "→", U: "↶" })[m.turn]} {Math.round((100 * counts[j]) / total)}%</span>)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {n.def.control === "lights" && n.phases.length >= 2 && <LightCycles net={net} nodeIdx={nodeIdx} name={name} />}
      <JunctionEventLog nodeId={n.def.id} refName={junctionRefs(simController.compiled).get(n.def.id) ?? "junction"} />
    </Section>
  );
}

/** vehicles let through by each light, green by green */
function LightCycles({ nodeIdx, name }: { net: Network; nodeIdx: number; name: (l: LinkDef, dir: 1 | -1) => string }) {
  const sim = simController.sim!;
  const rows = sim.lightCycles(nodeIdx).filter((r): r is NonNullable<typeof r> => !!r);
  return (
    <div className="grid gap-1.5">
      <h4 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Cars per green</h4>
      {rows.map(r => {
        const last = r.history.slice(-12);
        const max = Math.max(1, ...last.map(h => h.n), r.current ?? 0);
        return (
          <div key={r.arm} className="rounded-md border p-2 text-xs">
            <div className="flex justify-between gap-2">
              <span className="truncate font-medium">{name(r.link, r.dir)}</span>
              <span className="shrink-0 font-mono tabular">
                {r.current != null ? <span className="text-[var(--sig-go)]">now {r.current} · </span> : null}
                avg {r.avg.toFixed(1)}
              </span>
            </div>
            {last.length > 0 ? (
              <>
                <div className="mt-1.5 flex h-8 items-end gap-0.5" aria-label={`Last ${last.length} greens: ${last.map(h => h.n).join(", ")}`}>
                  {last.map((h, i) => (
                    <div key={i} className="flex flex-1 flex-col items-center justify-end" title={`${h.n} cars in ${h.green.toFixed(0)} s of green`}>
                      <span className="font-mono text-[9px] leading-none text-muted-foreground tabular">{h.n}</span>
                      <div className="mt-0.5 w-full rounded-sm bg-primary/70" style={{ height: `${Math.max(2, (h.n / max) * 18)}px` }} />
                    </div>
                  ))}
                </div>
                <div className="mt-1 text-[10px] text-muted-foreground tabular">
                  last {last.length} greens · avg green {r.avgGreen.toFixed(0)} s{r.avg > 0 ? ` · ${(r.avgGreen / r.avg).toFixed(1)} s of green per car` : ""}
                </div>
              </>
            ) : <div className="mt-1 text-[10px] text-muted-foreground">No finished green yet.</div>}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- link
function LinkInspector({ net, link }: { net: Network; link: LinkDef }) {
  const A = ops.nodeById(net, link.from)!, B = ops.nodeById(net, link.to)!;
  const len = ops.linkLength(link, A, B);
  const chord = Math.hypot(B.x - A.x, B.y - A.y);
  const dir = compass(B.x - A.x, B.y - A.y), back = compass(A.x - B.x, A.y - B.y);
  const set = (patch: Partial<LinkDef>, key?: string) => commit(ops.updateLink(net, link.id, patch), key);

  /** move the `to` node so the straight distance becomes `L` along the current bearing */
  const setLength = (L: number) => {
    if (chord < 1e-6) return;
    const f = L / chord;
    commit(ops.moveNode(net, B.id, { x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f }), `len:${link.id}`);
  };
  const setBearing = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    commit(ops.moveNode(net, B.id, { x: A.x + Math.sin(r) * chord, y: A.y - Math.cos(r) * chord }), `brg:${link.id}`);
  };
  const lanesRow = (label: string, lanes: number, bus: boolean, onLanes: (n: number) => void, onBus: (b: boolean) => void, other: number) => (
    <div className="grid gap-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">{label}</span>
        <Stepper label="lanes" value={lanes} min={other === 0 ? 1 : 0} max={4} onChange={onLanes} />
      </div>
      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{lanes === 1 ? "Buses only (no cars this way)" : "Kerb lane for buses only"}</span>
        <Switch checked={bus && lanes >= 1} disabled={lanes < 1} onCheckedChange={onBus} />
      </label>
    </div>
  );
  const compiled = simController.compiled;
  const roadName = (id: string) => {
    const l = ops.linkById(net, id);
    if (!l) return "road";
    if (l.name) return l.name;
    const P = ops.nodeById(net, l.from), Q = ops.nodeById(net, l.to);
    return P && Q ? `road ${compass(Q.x - P.x, Q.y - P.y).name}/${compass(P.x - Q.x, P.y - Q.y).name}` : "road";
  };
  // the junction this road leads to, following the road through bend points / road joints
  const approach = (d: 1 | -1) => {
    let e = compiled.edges.find(x => x.link.id === link.id && x.dir === d);
    let hops = 0;
    while (e && !(e.to.controlled && e.to.degree >= 3) && e.to.degree === 2 && hops++ < 60) {
      const cur: typeof e = e;
      const nextArm = cur.to.arms.find(a => a.link.id !== cur.link.id);
      e = nextArm?.outEdge ?? undefined;
    }
    return e && e.to.controlled && e.to.degree >= 3 ? { e, hops } : null;
  };
  const refs = junctionRefs(compiled);
  const laneArrows = ([1, -1] as const).flatMap(d => {
    const a = approach(d);
    if (!a) return [];
    const L = a.e.link, dd = a.e.dir;
    const upd = (patch: Partial<LinkDef>) => commit(ops.updateLink(net, L.id, patch));
    const F = dd === 1;
    const heading = (d === 1 ? dir : back).name + (refs.get(a.e.to.def.id) ? ` → ${refs.get(a.e.to.def.id)}` : "") + (a.hops ? ` (${a.hops} bend${a.hops > 1 ? "s" : ""} ahead)` : "");
    return [
      <LaneArrowsEditor
        key={d} compiled={compiled} link={L} dir={dd} heading={heading} roadName={roadName}
        onChange={t => upd(F ? { turnsF: t } : { turnsB: t })}
        onSign={x => upd(F ? { signF: x } : { signB: x })}
        onSplit={x => upd(F ? { splitF: x } : { splitB: x })}
      />,
    ];
  });
  return (
    <div>
      <Header kind="Road" title={link.name || "Unnamed road"} onDelete={() => { commit(ops.deleteLink(net, link.id)); select(null); }} />
      <Section>
        <div className="grid gap-1.5">
          <Label htmlFor="lname" className="text-xs text-muted-foreground">Name</Label>
          <Input id="lname" key={`${link.id}:${link.name}`} className="h-8" defaultValue={link.name} placeholder="Strada …" onBlur={e => e.target.value !== link.name && set({ name: e.target.value })} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
      </Section>
      <Section title="Lanes">
        {lanesRow(`Towards ${dir.name} (${dir.deg.toFixed(0)}°)`, link.lanesF, link.busF, n => set({ lanesF: n, busF: n >= 1 && link.busF, turnsF: null }), b => set({ busF: b }), link.lanesB)}
        {lanesRow(`Towards ${back.name} (${back.deg.toFixed(0)}°)`, link.lanesB, link.busB, n => set({ lanesB: n, busB: n >= 1 && link.busB, turnsB: null }), b => set({ busB: b }), link.lanesF)}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{link.lanesF === 0 || link.lanesB === 0 ? "One-way street" : `${link.lanesF}:${link.lanesB} lanes`}</span>
          <Button variant="outline" size="sm" onClick={() => commit(ops.reverseLink(net, link.id))}><ArrowLeftRight /> Swap sides</Button>
        </div>
      </Section>
      {laneArrows.some(Boolean) && (
        <Section title="At the junction ahead">
          <p className="text-xs text-muted-foreground">Lane arrows set where each lane may go. A give-way or stop sign makes this approach wait for traffic on roads without a sign. Turning shares set how traffic splits between the exits.</p>
          {laneArrows}
        </Section>
      )}
      <Section title="Speed limit">
        <Select value={String(link.speed)} onValueChange={v => set({ speed: Number(v) })}>
          <SelectTrigger className="w-full" aria-label="Speed limit"><SelectValue /></SelectTrigger>
          <SelectContent>{SPEEDS.map(s => <SelectItem key={s} value={String(s)}>{s} km/h</SelectItem>)}</SelectContent>
        </Select>
      </Section>
      <Section title="Geometry">
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="llen" label={link.c1 ? "Chord length" : "Length"} unit="m" value={chord} min={1} step={1} onCommit={setLength} />
          <NumberField id="lbrg" label="Bearing" unit="°" value={dir.deg} step={1} digits={1} onCommit={v => setBearing(((v % 360) + 360) % 360)} />
        </div>
        {link.c1 && <p className="text-xs text-muted-foreground tabular">Along the curve: {len.toFixed(1)} m</p>}
        <div className="flex gap-2">
          {link.c1 ? (
            <Button variant="outline" size="sm" className="flex-1" onClick={() => set({ c1: null, c2: null })}><StraightIcon /> Straighten</Button>
          ) : (
            <Button variant="outline" size="sm" className="flex-1" onClick={() => {
              const nx = -(B.y - A.y) * 0.2, ny = (B.x - A.x) * 0.2;
              set({ c1: { x: ops.round(A.x + (B.x - A.x) / 3 + nx), y: ops.round(A.y + (B.y - A.y) / 3 + ny) }, c2: { x: ops.round(A.x + ((B.x - A.x) * 2) / 3 + nx), y: ops.round(A.y + ((B.y - A.y) * 2) / 3 + ny) } });
            }}><Spline /> Make curve</Button>
          )}
          {ops.chainJoints(net, link.id).length > 0 && (
            <Button variant="outline" size="sm" className="flex-1" onClick={() => commit(ops.smoothChain(net, link.id))}><Spline /> Smooth whole road</Button>
          )}
        </div>
        {link.c1 && link.c2 && (
          <div className="grid grid-cols-2 gap-2">
            <NumberField id="c1x" label="Handle 1 X" unit="m" value={link.c1.x} onCommit={x => set({ c1: { x, y: link.c1!.y } }, `c1x:${link.id}`)} />
            <NumberField id="c1y" label="Handle 1 Y" unit="m" value={link.c1.y} onCommit={y => set({ c1: { x: link.c1!.x, y } }, `c1y:${link.id}`)} />
            <NumberField id="c2x" label="Handle 2 X" unit="m" value={link.c2.x} onCommit={x => set({ c2: { x, y: link.c2!.y } }, `c2x:${link.id}`)} />
            <NumberField id="c2y" label="Handle 2 Y" unit="m" value={link.c2.y} onCommit={y => set({ c2: { x: link.c2!.x, y } }, `c2y:${link.id}`)} />
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- stop
function StopInspector({ net, id }: { net: Network; id: string }) {
  const stop = net.stops.find(s => s.id === id)!;
  const link = ops.linkById(net, stop.link);
  if (!link) return null;
  const A = ops.nodeById(net, link.from)!, B = ops.nodeById(net, link.to)!;
  const heading = stop.dir === 1 ? compass(B.x - A.x, B.y - A.y) : compass(A.x - B.x, A.y - B.y);
  const lines = net.lines;
  return (
    <div>
      <Header kind="Bus stop" title={stop.name} onDelete={() => { commit(ops.deleteStop(net, stop.id)); select(null); }} />
      <Section>
        <div className="grid gap-1.5">
          <Label htmlFor="sname" className="text-xs text-muted-foreground">Name</Label>
          <Input id="sname" key={`${stop.id}:${stop.name}`} className="h-8" defaultValue={stop.name} onBlur={e => e.target.value !== stop.name && commit(ops.updateStop(net, stop.id, { name: e.target.value }))} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
        <div className="flex items-center justify-between text-sm">
          <span>Serves buses heading {heading.name}</span>
          <Button variant="outline" size="sm" disabled={(stop.dir === 1 ? link.lanesB : link.lanesF) === 0}
            onClick={() => commit(ops.updateStop(net, stop.id, { dir: stop.dir === 1 ? -1 : 1 }))}><ArrowLeftRight /> Other side</Button>
        </div>
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">Position along {link.name || "the road"}: {(stop.pos * 100).toFixed(0)}%</Label>
          <Slider min={5} max={95} step={1} value={[Math.round(stop.pos * 100)]} onValueChange={([v]) => commit(ops.updateStop(net, stop.id, { pos: v / 100 }), `spos:${stop.id}`)} />
        </div>
      </Section>
      <Section title="Lines">
        {lines.length === 0 && <p className="text-sm text-muted-foreground">No bus lines yet. Create one in the Lines tab.</p>}
        {lines.map(l => {
          const on = l.stops.includes(stop.id);
          return (
            <label key={l.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2"><span className="size-3 rounded-full" style={{ background: l.color }} />{l.name}</span>
              <Switch checked={on} onCheckedChange={v => commit(ops.updateLine(net, l.id, { stops: v ? [...l.stops, stop.id] : l.stops.filter(s => s !== stop.id) }))} />
            </label>
          );
        })}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- vehicle
function VehicleInspector({ id }: { id: string }) {
  useSubject(stats$); // re-render with the stats cadence (~4×/s)
  const sim = simController.sim;
  const v = sim?.vehicles.find(x => String(x.id) === id && !x.dead);
  if (!v) return (
    <div>
      <Header kind="Vehicle" title={`#${id}`} />
      <Section><p className="text-sm text-muted-foreground">This vehicle has left the plan.</p></Section>
    </div>
  );
  const e = v.piece.kind === "lane" ? v.piece.edge : null;
  const dest = v.dest.kind === "gateway" ? "leaving the plan" : v.dest.kind === "stop" ? `stop ${v.dest.stop.def.name}` : `${v.dest.edge.link.name || "a road"}`;
  const rows: [string, string][] = [
    ["Speed", `${(v.v * 3.6).toFixed(1)} km/h`],
    ["Desired here", `${(v.v0 * 3.6).toFixed(0)} km/h`],
    ["Acceleration", `${v.acc.toFixed(2)} m/s²`],
    ["Gap ahead", Number.isFinite(v.gap) && v.gap < 100 ? `${v.gap.toFixed(1)} m` : "clear"],
    ["Road", e ? e.link.name || "unnamed" : v.piece.kind === "ring" ? "roundabout" : "junction"],
    ["Lane", e ? `${v.lane + 1} of ${e.n}` : "–"],
    ["Heading to", dest],
    ["Waiting", `${v.wait.toFixed(0)} s`],
    ["Lane changes", String(v.laneChanges)],
    ["Re-routes", String(v.reroutes)],
    ["Max accel / braking", `${v.a.toFixed(1)} / ${v.b.toFixed(1)} m/s²`],
  ];
  if (v.kind === "bus") rows.push(["Passengers", `${v.pax} / ${v.cap}`]);
  const nt = sim!.nextTurn(v);
  if (nt) {
    const ref = junctionRefs(simController.compiled).get(nt.node.def.id);
    const turn = ({ L: "left", S: "ahead", R: "right", U: "U-turn" } as const)[nt.move.turn];
    rows.splice(6, 0, ["Next turn", `${turn}${ref ? ` at ${ref}` : ""}`], ["Lanes for it", nt.move.lo === nt.move.hi ? `${nt.move.lo + 1}` : `${nt.move.lo + 1}–${nt.move.hi + 1}`]);
  }
  const myEvents = sim!.events.filter(x => x.veh === v.id).slice(-12).reverse();
  return (
    <div>
      <Header kind={v.kind === "car" ? "Car" : v.kind === "truck" ? "Truck" : "Bus"} title={`#${v.id}`} />
      <Section>
        <Badge variant="secondary" className="w-fit">{v.state}</Badge>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          {rows.map(([k, val]) => (<Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-mono text-xs leading-5 tabular">{val}</dd></Fragment>))}
        </dl>
        <p className="text-[10px] text-muted-foreground">Lanes are counted from 1 = leftmost (next to the centre line).</p>
      </Section>
      {myEvents.length > 0 && (
        <Section title="Junction events">
          <div className="grid gap-0.5 font-mono text-[10.5px] leading-snug">
            {myEvents.map((x, i) => (
              <div key={i} className="grid grid-cols-[3.2rem_2rem_1fr] gap-1.5">
                <span className="text-muted-foreground tabular">{x.t.toFixed(1)}s</span>
                <span>{junctionRefs(simController.compiled).get(x.node) ?? ""}</span>
                <span>{x.kind} {x.detail}</span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
