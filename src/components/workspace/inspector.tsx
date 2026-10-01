"use client";

import { Fragment } from "react";
import { toast } from "sonner";
import { useDeepSubject, useSubject } from "subjecto/react";
import { ArrowLeftRight, Footprints, Merge, Minus, Plus, Spline, TrafficCone, Trash2, TriangleAlert, Minus as StraightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Kbd } from "@/components/ui/kbd";
import { commit, network$, select, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { BUILDING_USES, LANE_WIDTH, LEVELS, MAX_BAYS, MAX_LANES, MAX_LANES_AT_LINE, MAX_MEDIAN, lanesAtLine, type Bays, type BuildingDef, type BuildingUse, type Control, type LinkDef, type Network, type NodeDef } from "@/engine/types";
import { FLOOR_HEIGHT, USE_LABEL, polyArea, tripWeight } from "@/engine/buildings";
import { IdChip, NumberField, Section, Stepper, compass } from "./fields";
import { SignalGroupSection } from "./signal-groups";
import { PhaseEditor } from "./phase-editor";
import { FlowsSection } from "./flows";
import { ConnectorInspector, LaneInspector } from "./object-inspectors";
import { ZonePicker, ZonesSection } from "./zones";
import { LaneArrowsEditor, SignPicker } from "./lane-arrows";
import { mergeSelectedRoads, smoothSelectedJoin } from "@/state/merge-roads";
import { junctionRefs } from "@/engine/refs";
import { arrowLetters } from "@/engine/compile";
import { JunctionEventLog, RoadEventLog, VehicleEventLog } from "./event-log";
import { LaneConnectionsSection } from "./lane-connections";
import { JunctionShapeSection } from "./junction-shape";

const CONTROL_LABEL: Record<Control, string> = { priority: "Priority (first come)", free: "Free (go when clear)", stop: "All-way stop", lights: "Traffic lights", roundabout: "Roundabout" };
const SPEEDS = [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 130];

export function Inspector() {
  const [sel] = useDeepSubject(ui, "selection");
  const [net] = useSubject(network$);
  if (!sel) return <PlanSummary net={net} />;
  if (sel.kind === "node") { const n = ops.nodeById(net, sel.id); return n ? <NodeInspector net={net} node={n} /> : <PlanSummary net={net} />; }
  if (sel.kind === "link") { const l = ops.linkById(net, sel.id); return l ? <LinkInspector net={net} link={l} /> : <PlanSummary net={net} />; }
  if (sel.kind === "stop") { const s = net.stops.find(x => x.id === sel.id); return s ? <StopInspector net={net} id={s.id} /> : <PlanSummary net={net} />; }
  if (sel.kind === "building") { const b = net.buildings?.find(x => x.id === sel.id); return b ? <BuildingInspector net={net} b={b} /> : <PlanSummary net={net} />; }
  if (sel.kind === "vehicle") return <VehicleInspector id={sel.id} />;
  if (sel.kind === "lane") return <LaneInspector id={sel.id} />;
  if (sel.kind === "zone") return <ZonesSection />;
  if (sel.kind === "connector") return <ConnectorInspector id={sel.id} />;
  return <PlanSummary net={net} />;
}

function Header({ title, kind, onDelete, id }: { title: string; kind: string; onDelete?: () => void; id?: string }) {
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {kind}
          {id && <IdChip id={id} />}
        </div>
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
          {!!net.buildings?.length && <><dt className="text-muted-foreground">Buildings</dt><dd className="text-right tabular">{net.buildings.length}</dd></>}
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
          <li>Layers (top bar) choose what clicks on the map select; all are on to start with. <Kbd>Shift</Kbd> + a letter switches one on or off: <Kbd>R</Kbd> roads, <Kbd>L</Kbd> lanes, <Kbd>J</Kbd> junctions… (<Kbd>A</Kbd> all). The letters are shown in the layer menu.</li>
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
  const customLights = node.control === "lights" && (node.phases?.length ?? 0) >= 2;
  return (
    <div>
      <Header kind={kind} id={node.id} title={`${node.x.toFixed(1)}, ${node.y.toFixed(1)}`} onDelete={() => { commit(ops.deleteNode(net, node.id)); select(null); }} />
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
                {customLights
                  ? "Custom phases, set lane by lane below. Yellow and all-red apply between every phase."
                  : crossing
                  ? "Both directions get green together, then everyone stops for the red phase (e.g. a pedestrian crossing). Min green sets how long the red phase lasts when Actuated is on."
                  : `${cn?.phases.length ?? 0} phases: ${cn?.phases.map(g => g.length === 0 ? "all red" : g.map(i => compass(cn.arms[i].u.x, cn.arms[i].u.y).name).join(" + ")).join(" → ")}. ${sig.separate ? "Each approach gets its own green." : "Opposite approaches share a green; left turns yield to oncoming traffic."}`}
              </p>
              <div className="grid grid-cols-2 gap-2">
                {!customLights && <NumberField id="sg" label="Green" unit="s" value={sig.green} min={3} max={180} step={1} digits={0} onCommit={v => set({ signal: { ...sig, green: v } }, `sg:${node.id}`)} />}
                {!customLights && <NumberField id="smg" label="Min green" unit="s" value={sig.minGreen} min={1} max={120} step={1} digits={0} onCommit={v => set({ signal: { ...sig, minGreen: v } }, `smg:${node.id}`)} />}
                <NumberField id="sy" label="Yellow" unit="s" value={sig.yellow} min={1} max={10} step={0.5} digits={1} onCommit={v => set({ signal: { ...sig, yellow: v } }, `sy:${node.id}`)} />
                <NumberField id="sr" label="All red" unit="s" value={sig.allRed} min={0} max={10} step={0.5} digits={1} onCommit={v => set({ signal: { ...sig, allRed: v } }, `sr:${node.id}`)} />
              </div>
              {!crossing && !customLights && (
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
          {node.control === "roundabout" && (
            <>
              <label className="flex items-center justify-between gap-2 text-sm">
                <span>Two circulating lanes</span>
                <Switch checked={node.ringLanes === 2} onCheckedChange={v => set({ ringLanes: v ? 2 : undefined })} aria-label="Two circulating lanes" />
              </label>
              <p className="text-xs text-muted-foreground">
                Ring radius {cn?.ringR.toFixed(1)} m. Entering traffic yields to the ring.
                {node.ringLanes === 2 ? " The outer lane is for the first exit, the inner lane for going further round; on roads with two or more lanes, the kerb lane is for the first exit." : ""}
              </p>
            </>
          )}
          {node.control === "stop" && <p className="text-xs text-muted-foreground">Every approach stops at the line, then vehicles go in arrival order.</p>}
          {node.control === "free" && <p className="text-xs text-muted-foreground">No signs, no queue order: any vehicle enters as soon as its path through the junction and its exit are clear, closest first.</p>}
          {node.control === "priority" && <p className="text-xs text-muted-foreground">Vehicles reserve their path through the junction first come, first served.</p>}
          {crossing && (
            <Button variant="outline" size="sm" onClick={() => set({ junction: false, control: "priority" })}><Minus /> Back to a plain road point</Button>
          )}
        </Section>
      )}
      {(degree >= 3 || crossing) && node.control === "lights" && cn && cn.controlled && <PhaseEditor net={net} node={node} cn={cn} />}
      {degree >= 3 && node.control === "priority" && cn && <ApproachSignsSection net={net} node={node} />}
      {(degree >= 3 || crossing) && node.control !== "roundabout" && cn && <PedestriansSection node={node} nodeIdx={cn.idx} set={set} />}
      {degree >= 3 && node.control !== "roundabout" && cn && <SlipLanesSection net={net} node={node} />}
      {(degree >= 3 || crossing) && <SignalGroupSection net={net} node={node} />}
      {degree >= 2 && node.control !== "roundabout" && <JunctionShapeSection net={net} node={node} />}
      {degree >= 2 && node.control !== "roundabout" && <LaneConnectionsSection net={net} node={node} />}
      {ref && cn && <JunctionLive net={net} nodeIdx={cn.idx} />}
      {ref && cn && <Section title="Event log"><JunctionEventLog nodeId={node.id} refName={ref} /></Section>}
      {degree === 2 && !crossing && (
        <Section title="Road joint">
          <p className="text-xs text-muted-foreground">A bend point on a road. Drag it to reshape the road, or double-click a road to add more.</p>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={() => set({ junction: true, control: "lights" })}><TrafficCone /> Make junction here</Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => set({ junction: true, control: "priority", peds: 300 })}><Footprints /> Zebra crossing</Button>
          </div>
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
      {degree === 1 && node.gateway && <GateCounter node={node} />}
      {degree === 1 && node.gateway && <InflowSection node={node} set={set} />}
      {degree === 1 && node.gateway && <FlowsSection net={net} node={node} />}
      {degree === 1 && node.gateway && <Section title="Zone"><ZonePicker net={net} kind="entry" id={node.id} /></Section>}
    </div>
  );
}

function InflowSection({ node, set }: { node: NodeDef; set: (patch: Partial<NodeDef>, key?: string) => void }) {
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
    </Section>
  );
}

/** live counts at an entry / exit point: vehicles that came in and left, in total and per hour */
function GateCounter({ node }: { node: NodeDef }) {
  useSubject(stats$); // live readings (~4×/s)
  const sim = simController.sim;
  if (!sim) return <Section title="Counter"><p className="text-xs text-muted-foreground">Run traffic to count the vehicles entering and leaving here.</p></Section>;
  const [inH, outH] = sim.gateRates.get(node.id) ?? [0, 0];
  const hours = sim.time / 3600;
  const rows = [["Entered", sim.entered.get(node.id) ?? 0, inH], ["Left", sim.exited.get(node.id) ?? 0, outH]] as const;
  return (
    <Section title="Counter">
      <table className="w-full text-sm">
        <thead><tr className="text-xs text-muted-foreground"><th className="pb-1 text-left font-normal" /><th className="pb-1 text-right font-normal">Vehicles</th><th className="pb-1 text-right font-normal">Per hour</th><th className="pb-1 text-right font-normal">Average / h</th></tr></thead>
        <tbody>
          {rows.map(([label, total, perH]) => (
            <tr key={label} className="border-t">
              <td className="py-1">{label}</td>
              <td className="py-1 text-right font-mono tabular">{total}</td>
              <td className="py-1 text-right font-mono tabular">{Math.round(perH)}</td>
              <td className="py-1 text-right font-mono tabular">{hours > 0.01 ? Math.round(total / hours) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">Per hour: the rate over the last 5 minutes. Average: since the start of the run.</p>
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
  const [multi, setMulti] = useDeepSubject(ui, "multi");
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
  const lanesRow = (d: 1 | -1, label: string, lanes: number, bus: boolean, onLanes: (n: number) => void, onBus: (b: boolean) => void, other: number) => {
    const bays: Bays = (d === 1 ? link.baysF : link.baysB) ?? { left: 0, leftLen: 60, right: 0, rightLen: 40 };
    const setB = (patch: Partial<Bays>) => commit(ops.setBays(net, link.id, d, { ...bays, ...patch }));
    const room = MAX_LANES_AT_LINE - lanes;
    return (
      <div className="grid gap-2 rounded-md border p-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">{label}</span>
          <Stepper label="lanes" value={lanes} min={other === 0 ? 1 : 0} max={MAX_LANES} onChange={onLanes} />
        </div>
        <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{lanes === 1 ? "Buses only (no cars this way)" : "Kerb lane for buses only"}</span>
          <Switch checked={bus && lanes >= 1} disabled={lanes < 1} onCheckedChange={onBus} />
        </label>
        {lanes >= 2 && (
          <div className="grid gap-1.5 border-t pt-2">
            <span className="text-xs text-muted-foreground">A lane ends (merges into the lane beside it)</span>
            <div className="grid grid-cols-[1fr_5.5rem] items-center gap-2">
              <Select value={(d === 1 ? link.dropF : link.dropB)?.side ?? "none"} onValueChange={v => set(d === 1 ? { dropF: v === "none" ? null : { side: v as "left" | "right", len: link.dropF?.len ?? 80 }, turnsF: null } : { dropB: v === "none" ? null : { side: v as "left" | "right", len: link.dropB?.len ?? 80 }, turnsB: null })}>
                <SelectTrigger size="sm" className="w-full" aria-label="Lane that ends"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No lane ends</SelectItem>
                  <SelectItem value="right">Right lane merges left</SelectItem>
                  <SelectItem value="left">Left lane merges right</SelectItem>
                </SelectContent>
              </Select>
              {(d === 1 ? link.dropF : link.dropB) ? (
                <NumberField id={`drop${d}`} label="Merge length" hideLabel unit="m" value={(d === 1 ? link.dropF : link.dropB)!.len} min={10} max={300} step={10} digits={0}
                  onCommit={v => set(d === 1 ? { dropF: { ...link.dropF!, len: Math.round(v) } } : { dropB: { ...link.dropB!, len: Math.round(v) } })} />
              ) : <span />}
            </div>
          </div>
        )}
        {lanes > 0 && (
          <div className="grid gap-1.5 border-t pt-2">
            <span className="text-xs text-muted-foreground">Turn bays before the junction ahead</span>
            <div className="grid grid-cols-[1fr_auto_5.5rem] items-center gap-x-2 gap-y-1.5 text-xs">
              <span>Left</span>
              <Stepper label="left turn bays" value={bays.left} min={0} max={Math.min(MAX_BAYS, room - bays.right)} onChange={v => setB({ left: v })} />
              <NumberField id={`bl${d}`} label="Left bay length" hideLabel unit="m" value={bays.leftLen} min={10} max={400} step={5} digits={0} className={bays.left ? "" : "invisible"} onCommit={v => setB({ leftLen: Math.round(v) })} />
              <span>Right{bus ? " (not with a bus lane)" : ""}</span>
              <Stepper label="right turn bays" value={bays.right} min={0} max={bus ? 0 : Math.min(MAX_BAYS, room - bays.left)} onChange={v => setB({ right: v })} />
              <NumberField id={`br${d}`} label="Right bay length" hideLabel unit="m" value={bays.rightLen} min={10} max={400} step={5} digits={0} className={bays.right ? "" : "invisible"} onCommit={v => setB({ rightLen: Math.round(v) })} />
            </div>
          </div>
        )}
      </div>
    );
  };
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
        onChange={t => {
          // lane arrows set now win over lane connections set by hand at that junction for turns they leave out
          let next = ops.updateLink(net, L.id, F ? { turnsF: t } : { turnsB: t });
          const node = net.nodes.find(x => x.id === a.e.to.def.id), list = a.e.to.moves.get(a.e.idx) ?? [];
          if (t && node?.laneMap) {
            for (const key of Object.keys(node.laneMap)) {
              if (!key.startsWith(`${a.e.key}>`)) continue;
              const m = list.find(x => `${a.e.key}>${x.out.key}` === key);
              const ls = m ? arrowLetters(list, m) : null;
              if (!ls || !t.some(lt => [...ls].some(x => lt.includes(x)))) next = ops.setLaneMap(next, node.id, key, null);
            }
          }
          commit(next);
        }}
        onSign={x => upd(F ? { signF: x } : { signB: x })}
        onSplit={x => upd(F ? { splitF: x } : { splitB: x })}
      />,
    ];
  });
  return (
    <div>
      <Header kind="Road" id={link.id} title={link.name || "Unnamed road"} onDelete={() => { commit(ops.deleteLink(net, link.id)); select(null); }} />
      {multi.length > 0 && (
        <Section>
          <p className="text-sm">{multi.length + 1} roads selected <span className="text-muted-foreground">(Shift+click to add or remove)</span></p>
          <div className="flex flex-wrap gap-1">{[link.id, ...multi].map(id => <IdChip key={id} id={id} />)}</div>
          <div className="flex gap-2">
            <Button size="sm" className="flex-1" onClick={mergeSelectedRoads}><Merge /> Merge into one road <Kbd className="ml-1">M</Kbd></Button>
            <Button size="sm" variant="ghost" onClick={() => setMulti([])}>Clear</Button>
          </div>
          {multi.length === 1 && (
            <Button size="sm" variant="outline" className="justify-start" onClick={smoothSelectedJoin} title="Make the two roads flow into each other where they meet, keeping them separate"><Spline /> Smooth the join between them <Kbd className="ml-1">S</Kbd></Button>
          )}
        </Section>
      )}
      <Section>
        <div className="grid gap-1.5">
          <Label htmlFor="lname" className="text-xs text-muted-foreground">Name</Label>
          <Input id="lname" key={`${link.id}:${link.name}`} className="h-8" defaultValue={link.name} placeholder="Strada …" onBlur={e => e.target.value !== link.name && set({ name: e.target.value })} onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        </div>
      </Section>
      <Section title="Lanes">
        {lanesRow(1, `Towards ${dir.name} (${dir.deg.toFixed(0)}°)`, link.lanesF, link.busF, n => set({ lanesF: n, busF: n >= 1 && link.busF, turnsF: null, greenF: ops.resizeGreens(link.greenF, lanesAtLine({ ...link, lanesF: n }, 1)) }), b => set({ busF: b, ...(b && link.baysF?.right ? { baysF: link.baysF.left ? { ...link.baysF, right: 0 } : null, turnsF: null } : {}) }), link.lanesB)}
        {lanesRow(-1, `Towards ${back.name} (${back.deg.toFixed(0)}°)`, link.lanesB, link.busB, n => set({ lanesB: n, busB: n >= 1 && link.busB, turnsB: null, greenB: ops.resizeGreens(link.greenB, lanesAtLine({ ...link, lanesB: n }, -1)) }), b => set({ busB: b, ...(b && link.baysB?.right ? { baysB: link.baysB.left ? { ...link.baysB, right: 0 } : null, turnsB: null } : {}) }), link.lanesF)}
        {link.lanesF > 0 && link.lanesB > 0 && (
          <div className="grid gap-2 rounded-md border p-2.5">
            <div className="grid grid-cols-[1fr_5.5rem] items-center gap-2">
              <span className="text-sm">Median</span>
              <NumberField id="lmed" label="Median width" hideLabel unit="m" value={link.median ?? 0} min={0} max={MAX_MEDIAN} step={0.5} digits={1} onCommit={v => set({ median: v > 0 ? Math.round(v * 10) / 10 : undefined, ...(v > 0 ? { medianKind: link.medianKind ?? "painted" } : { medianKind: undefined }) })} />
            </div>
            {(link.median ?? 0) > 0 && (
              <ToggleGroup type="single" className="w-full" value={link.medianKind ?? "painted"} onValueChange={v => v && set({ medianKind: v as "painted" | "raised" })} aria-label="Median type">
                <ToggleGroupItem value="painted" className="h-7 flex-1 text-xs">Painted</ToggleGroupItem>
                <ToggleGroupItem value="raised" className="h-7 flex-1 text-xs">Raised (kerbed)</ToggleGroupItem>
              </ToggleGroup>
            )}
            <p className="text-[11px] text-muted-foreground">Left turn bays open into the median; before they open their space is hatched{(link.medianKind === "raised" && (link.median ?? 0) > 0) ? " or kerbed" : ""}.</p>
          </div>
        )}
        <div className="grid grid-cols-[1fr_5.5rem] items-center gap-2">
          <span className="text-sm">Lane width</span>
          <NumberField id="llw" label="Lane width" hideLabel unit="m" value={link.laneWidth ?? LANE_WIDTH.default} min={LANE_WIDTH.min} max={LANE_WIDTH.max} step={0.1} digits={1} onCommit={v => set({ laneWidth: Math.abs(v - LANE_WIDTH.default) < 0.01 ? undefined : Math.round(v * 10) / 10 })} />
        </div>
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
      <CounterSection link={link} towards={[dir.name, back.name]} onChange={on => set({ counter: on || undefined })} />
      <Section title="Event log"><RoadEventLog linkId={link.id} /></Section>
      <Section title="Elevation">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm">Level</span>
          <Stepper label="levels" value={link.level ?? 0} min={LEVELS.min} max={LEVELS.max} onChange={v => set({ level: v || undefined })} />
        </div>
        <p className="text-xs text-muted-foreground">
          {(link.level ?? 0) > 0 ? `A bridge, ${link.level} level${link.level === 1 ? "" : "s"} up: drawn over the roads it crosses; roads joining it ramp up to it in 3D.`
            : (link.level ?? 0) < 0 ? "Below ground (an underpass or tunnel): drawn faded, under the roads it crosses."
              : "Ground level. Raise it to make a bridge over the roads it crosses, or lower it for an underpass. Roads only meet at junctions, never where they cross at different levels."}
        </p>
      </Section>
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
            <>
              <Button variant="outline" size="sm" className="flex-1" onClick={() => commit(ops.smoothChain(net, link.id))}><Spline /> Smooth whole road</Button>
              {!multi.length && <Button variant="outline" size="sm" className="flex-1" onClick={mergeSelectedRoads} title="Merge the road's pieces into one (M)"><Merge /> Merge its pieces</Button>}
            </>
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

// ---------------------------------------------------------------- pedestrians
/** people crossing the roads at a junction (or a zebra on a plain road), and how they fare */
function PedestriansSection({ node, nodeIdx, set }: { node: NodeDef; nodeIdx: number; set: (patch: Partial<NodeDef>) => void }) {
  useSubject(stats$);
  const s = node.peds ? simController.sim?.pedStats(nodeIdx) : null;
  return (
    <Section title="Pedestrians">
      <div className="grid grid-cols-[1fr_7rem] items-center gap-2">
        <span className="text-sm">People crossing each road</span>
        <NumberField id="peds" label="Pedestrians per hour" hideLabel unit="/h" value={node.peds ?? 0} min={0} max={3000} step={50} digits={0} onCommit={v => set({ peds: v > 0 ? Math.round(v) : null })} />
      </div>
      <p className="text-xs text-muted-foreground">
        {node.control === "lights" ? "They cross a road while its traffic has red; vehicles turning into that road wait for them." : "They have priority on the zebra: vehicles stop for anyone waiting or crossing."}
      </p>
      {s && (
        <p className="text-xs tabular text-muted-foreground">{s.crossed} crossed so far, waiting {s.avgWait.toFixed(0)} s on average{s.waiting ? ` · ${s.waiting} waiting now` : ""}</p>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- signs
/** give-way / stop signs on each road arriving at a priority junction */
function ApproachSignsSection({ net, node }: { net: Network; node: NodeDef }) {
  const cn = simController.compiled.nodeById.get(node.id);
  const arriving = cn?.arms.filter(a => a.inEdge) ?? [];
  if (!arriving.length) return null;
  return (
    <Section title="Signs">
      <p className="text-xs text-muted-foreground">Traffic on a road with a give-way or stop sign waits for traffic on the roads without one.</p>
      {arriving.map(a => {
        const e = a.inEdge!, l = e.link, sign = (e.dir === 1 ? l.signF : l.signB) ?? null;
        return (
          <SignPicker
            key={e.key} control={node.control} sign={sign} label={l.name ? `${l.name}, from the ${compass(a.u.x, a.u.y).name}` : `Road from the ${compass(a.u.x, a.u.y).name}`}
            onSign={x => commit(ops.updateLink(net, l.id, e.dir === 1 ? { signF: x } : { signB: x }))}
          />
        );
      })}
    </Section>
  );
}

// ---------------------------------------------------------------- slip lanes
/** free right turns that bypass the junction on a lane of their own, round a kerbed island */
function SlipLanesSection({ net, node }: { net: Network; node: NodeDef }) {
  const c = simController.compiled, cn = c.nodeById.get(node.id);
  if (!cn) return null;
  const name = (l: LinkDef) => l.name || compassOf(net, l, node.id);
  const existing = net.links.filter(l => l.slip === node.id);
  // right turns this junction still makes
  const rights = [...cn.moves.values()].flat().filter(m => m.turn === "R");
  const add = (inId: string, outId: string) => {
    const [n2, err] = ops.addSlipLane(net, node.id, inId, outId);
    if (err) toast.error(err); else commit(n2);
  };
  if (!existing.length && !rights.length) return null;
  return (
    <Section title="Slip lanes">
      <p className="text-xs text-muted-foreground">A slip lane lets right-turning traffic bypass the junction round a kerbed island and give way where it joins. Drag its end points to shape it.</p>
      {existing.map(l => (
        <div key={l.id} className="flex items-center justify-between gap-2 text-sm">
          <button type="button" className="truncate text-left underline-offset-2 hover:underline" onClick={() => select({ kind: "link", id: l.id })}>{l.name || "Slip lane"}</button>
          <Button variant="ghost" size="icon-sm" className="size-7 shrink-0" aria-label="Remove slip lane" onClick={() => commit(ops.deleteLink(net, l.id))}><Trash2 /></Button>
        </div>
      ))}
      {rights.map(m => (
        <Button key={`${m.in.key}>${m.out.key}`} variant="outline" size="sm" className="justify-start" onClick={() => add(m.in.link.id, m.out.link.id)}>
          <Plus /> From {name(m.in.link)} into {name(m.out.link)}
        </Button>
      ))}
    </Section>
  );
}
/** "road to the NE" for an unnamed road at a node */
function compassOf(net: Network, l: LinkDef, nodeId: string) {
  const here = ops.nodeById(net, nodeId), other = ops.nodeById(net, l.from === nodeId ? l.to : l.from);
  return here && other ? `the road to the ${compass(other.x - here.x, other.y - here.y).name}` : "road";
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
      <Header kind="Bus stop" id={stop.id} title={stop.name} onDelete={() => { commit(ops.deleteStop(net, stop.id)); select(null); }} />
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

// ---------------------------------------------------------------- traffic counter
/** switch a road's traffic counter on or off, and show its readings while traffic runs */
function CounterSection({ link, towards, onChange }: { link: LinkDef; towards: [string, string]; onChange: (on: boolean) => void }) {
  useSubject(stats$); // live readings (~4×/s)
  const sim = simController.sim;
  const on = link.counter === true;
  const dirs = ([[1, link.lanesF, towards[0]], [-1, link.lanesB, towards[1]]] as const).filter(([, lanes]) => lanes > 0);
  return (
    <Section title="Traffic counter">
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Count traffic on this road</span>
        <Switch checked={on} onCheckedChange={onChange} aria-label="Count traffic on this road" />
      </label>
      {on && (sim ? (
        <table className="w-full text-sm">
          <thead><tr className="text-xs text-muted-foreground"><th className="pb-1 text-left font-normal">Towards</th><th className="pb-1 text-right font-normal">Vehicles</th><th className="pb-1 text-right font-normal">Per hour</th><th className="pb-1 text-right font-normal">km/h</th></tr></thead>
          <tbody>
            {dirs.map(([d, , name]) => {
              const c = sim.counter(link.id, d);
              return (
                <tr key={d} className="border-t" title={c ? `${c.cars} cars, ${c.trucks} trucks, ${c.buses} buses` : undefined}>
                  <td className="py-1">{name}</td>
                  <td className="py-1 text-right font-mono tabular">{c?.total ?? 0}</td>
                  <td className="py-1 text-right font-mono tabular">{c ? Math.round(c.perHour) : 0}</td>
                  <td className="py-1 text-right font-mono tabular">{c && c.total ? c.avgSpeed.toFixed(0) : "–"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : <p className="text-xs text-muted-foreground">Counts the vehicles passing the middle of the road, each direction apart. Run traffic to see the readings.</p>)}
      {on && sim && <p className="text-[11px] text-muted-foreground">Per hour: the rate over the last 5 minutes. Hover a row for cars, trucks and buses.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------- building
function BuildingInspector({ net, b }: { net: Network; b: BuildingDef }) {
  const set = (patch: Partial<BuildingDef>, key?: string) => commit(ops.updateBuilding(net, b.id, patch), key);
  const c = simController.compiled;
  const place = c.places.find(p => p.building.id === b.id);
  const total = c.places.reduce((a, p) => a + p.w, 0);
  const auto = tripWeight({ ...b, trips: null });
  const floors = Math.max(1, Math.round(b.height / FLOOR_HEIGHT));
  const osm = /^([wr])(\d+)/.exec(b.id);
  return (
    <div>
      <Header kind="Building" id={b.id} title={b.name || USE_LABEL[b.use]} onDelete={() => { commit(ops.deleteBuilding(net, b.id)); select(null); }} />
      <Section>
        <div className="grid gap-1.5">
          <Label htmlFor="buse" className="text-xs text-muted-foreground">Use</Label>
          <Select value={b.use} onValueChange={v => set({ use: v as BuildingUse })}>
            <SelectTrigger id="buse" size="sm" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{BUILDING_USES.map(u => <SelectItem key={u} value={u}>{USE_LABEL[u]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumberField id="bheight" label="Height" unit="m" value={b.height} digits={1} min={2} max={400} onCommit={v => set({ height: v })} />
          <div className="grid gap-1.5">
            <span className="text-xs text-muted-foreground">Footprint</span>
            <span className="flex h-8 items-center font-mono text-sm tabular">{Math.round(polyArea(b.pts))} m² · {floors} fl.</span>
          </div>
        </div>
      </Section>
      <Section title="Traffic">
        <ZonePicker net={net} kind="building" id={b.id} />
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Set trips by hand</span>
          <Switch checked={typeof b.trips === "number"} onCheckedChange={v => set({ trips: v ? auto : null })} />
        </label>
        {typeof b.trips === "number"
          ? <NumberField id="btrips" label="Trip weight (0 = no traffic)" value={b.trips} digits={1} min={0} max={100000} onCommit={v => set({ trips: v })} />
          : <p className="text-sm text-muted-foreground">Trip weight {auto} (from use and floor area).</p>}
        {place
          ? <p className="text-sm text-muted-foreground">{total > 0 ? `${((place.w / total) * 100).toFixed(place.w / total < 0.01 ? 2 : 1)}% of trips inside the plan start or end here` : ""}, on {place.opts[0].edge.link.name || "an unnamed road"} (dashed line).</p>
          : <p className="text-sm text-muted-foreground">{tripWeight(b) > 0 ? "No road within 150 m that cars can stop on, so no trips start or end here." : "Generates no traffic."}</p>}
      </Section>
      {osm && (
        <Section>
          <a className="text-sm text-primary underline-offset-4 hover:underline" href={`https://www.openstreetmap.org/${osm[1] === "w" ? "way" : "relation"}/${osm[2]}`} target="_blank" rel="noreferrer">View on OpenStreetMap</a>
        </Section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- vehicle
function VehicleInspector({ id }: { id: string }) {
  useSubject(stats$); // re-render with the stats cadence (~4×/s)
  const sim = simController.sim;
  // details come with the simulation's snapshots (the worker sends them for the selected vehicle)
  const v = sim?.vehicle && String(sim.vehicle.id) === id && sim.vehicles.some(x => x.id === sim.vehicle!.id) ? sim.vehicle : null;
  const [log] = useDeepSubject(ui, "eventLog");
  const recording = (log.vehicles ?? []).includes(Number(id));
  if (!v) return (
    <div>
      <Header kind="Vehicle" id={`#${id}`} title={`#${id}`} />
      <Section><p className="text-sm text-muted-foreground">{sim?.vehicles.some(x => String(x.id) === id) ? "Loading…" : "This vehicle has left the plan."}</p></Section>
      {/* a recording stays readable (and downloadable) after the vehicle has gone */}
      {recording && <Section title="Event log"><VehicleEventLog vehId={Number(id)} /></Section>}
    </div>
  );
  const rows: [string, string][] = [
    ["Speed", `${(v.v * 3.6).toFixed(1)} km/h`],
    ["Desired here", `${(v.v0 * 3.6).toFixed(0)} km/h`],
    ["Acceleration", `${v.acc.toFixed(2)} m/s²`],
    ["Gap ahead", Number.isFinite(v.gap) && v.gap < 100 ? `${v.gap.toFixed(1)} m` : "clear"],
    ["Road", v.road],
    ["Lane", v.lane !== null && v.lanes !== null ? `${v.lane + 1} of ${v.lanes}` : "–"],
    ["Heading to", v.heading],
    ["Waiting", `${v.wait.toFixed(0)} s`],
    ["Lane changes", String(v.laneChanges)],
    ["Re-routes", String(v.reroutes)],
    ["Max accel / braking", `${v.a.toFixed(1)} / ${v.b.toFixed(1)} m/s²`],
  ];
  if (v.kind === "bus") rows.push(["Passengers", `${v.pax} / ${v.cap}`]);
  const nt = v.nextTurn;
  if (nt) {
    const ref = junctionRefs(simController.compiled).get(nt.node);
    const turn = ({ L: "left", S: "ahead", R: "right", U: "U-turn" } as const)[nt.turn];
    rows.splice(6, 0, ["Next turn", `${turn}${ref ? ` at ${ref}` : ""}`], ["Lanes for it", nt.lo === nt.hi ? `${nt.lo + 1}` : `${nt.lo + 1}–${nt.hi + 1}`]);
  }
  const myEvents = sim!.events.filter(x => x.veh === v.id).slice(-12).reverse();
  return (
    <div>
      <Header kind={v.kind === "car" ? "Car" : v.kind === "truck" ? "Truck" : "Bus"} id={`#${v.id}`} title={v.road} />
      <Section>
        <Badge variant="secondary" className="w-fit">{v.state}</Badge>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
          {rows.map(([k, val]) => (<Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-mono text-xs leading-5 tabular">{val}</dd></Fragment>))}
        </dl>
        <p className="text-[10px] text-muted-foreground">Lanes are counted from 1 = leftmost (next to the centre line).</p>
      </Section>
      <Section><VehicleEventLog vehId={v.id} /></Section>
      {!recording && myEvents.length > 0 && (
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
