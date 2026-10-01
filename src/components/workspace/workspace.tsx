"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import {
  ArrowLeft, Box, ChevronDown, Eye, Bus, Hand, Layers, Minus, Table2, Spline, Image as ImageIcon, Map as MapIcon, MapPlus, Maximize, MousePointer2, Pause, Play, Redo2, RotateCcw, Route, Undo2, Settings, ZoomIn, ZoomOut, Check, CloudOff, Loader2, TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { savePlan } from "@/server/actions";
import { MAX_LANES, type Network, type PlanSettings } from "@/engine/types";
import type { Underlay } from "@/lib/underlay";
import { allLayersOn, commit, LAYER_HIGHLIGHT_MAX, LAYERS, loadPlan, network$, redo, select, setSettings, setTool, settings$, stats$, ui, undo, underlay$, type LayerId, type Tool } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { sendView, viewport } from "@/state/commands";
import { OsmImportDialog, describeStats, type OsmImportMode } from "@/components/osm/osm-import-dialog";
import { bboxCenter, unproject, type BBox } from "@/lib/osm/area";
import { suggestSettings } from "@/lib/osm/convert";
import { startUnderlayImage } from "@/state/underlay-image";
import { SAT_ATTRIBUTION } from "@/render/satellite";
import { mergeSelectedRoads, smoothSelectedJoin } from "@/state/merge-roads";
import * as ops from "@/state/ops";
import { cn } from "@/lib/utils";
import { PlanCanvas } from "./plan-canvas";
import { PerfPanel } from "./perf-panel";
import { ReplayBar } from "./replay-bar";
import { CollapsibleSections } from "./fields";
import { Inspector } from "./inspector";
import { TrafficPanel } from "./traffic-panel";
import { LinesPanel } from "./lines-panel";
import { UnderlayPanel } from "./underlay-panel";
import { UserMenu, type MenuUser } from "@/components/auth/user-menu";
import { Stepper } from "./fields";
import { Compass } from "./compass";
import { HistoryButton } from "./history-dialog";
import { OptimizeButton } from "./optimize-dialog";
import { Dataview } from "./dataview";

const View3D = dynamic(() => import("./view-3d").then(m => m.View3D), { ssr: false, loading: () => <div className="grid h-full place-items-center text-sm text-muted-foreground">Loading 3D…</div> });

export interface WorkspacePlan {
  id: string; name: string; cityId: string; cityName: string;
  network: Network; settings: PlanSettings; underlay: Underlay | null; revision: number; updatedAt: string;
  /** what the signed-in user may do: owner / write edit and save, read only views and simulates */
  access: "owner" | "write" | "read";
}

export function Workspace({ plan, user }: { plan: WorkspacePlan; user: MenuUser }) {
  // load once per mount (the component is keyed by plan id) before children read the stores
  useState(() => { simController.start(); loadPlan(plan.id, plan.network, plan.settings, plan.revision, plan.updatedAt, plan.underlay, plan.access === "read"); setSavedBuildings(plan.network.buildings); startUnderlayImage(); return plan.id; });
  useAutosave(plan.id);
  useShortcuts();
  const [view] = useDeepSubject(ui, "view");
  const [panel, setPanel] = useDeepSubject(ui, "panel");
  const [dataview] = useDeepSubject(ui, "dataview");

  return (
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <TopBar plan={plan} user={user} />
        <div className="flex min-h-0 flex-1">
          <ToolRail />
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative min-h-0 flex-1 bg-[var(--map-ground)]">
              {view === "2d" ? <PlanCanvas /> : <View3D />}
              <DraftBar />
              <LiveBadge />
              <Compass />
              <SatelliteCredit />
              <SpeedLegend />
              <PerfPanel />
              {view === "2d" && <ReplayBar />}
              <StatusBar />
            </div>
            {dataview && <Dataview />}
          </div>
          <aside className="flex w-80 shrink-0 flex-col border-l bg-background" aria-label="Plan details">
            <Tabs value={panel} onValueChange={v => setPanel(v as typeof panel)} className="min-h-0 flex-1 gap-0">
              <div className="border-b px-3 py-2">
                <TabsList className="w-full">
                  <TabsTrigger value="inspect">Inspect</TabsTrigger>
                  <TabsTrigger value="traffic">Traffic</TabsTrigger>
                  <TabsTrigger value="lines">Bus lines</TabsTrigger>
                  <TabsTrigger value="image">Image</TabsTrigger>
                </TabsList>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <TabsContent value="inspect"><CollapsibleSections.Provider value={true}><Inspector /></CollapsibleSections.Provider></TabsContent>
                <TabsContent value="traffic"><TrafficPanel /></TabsContent>
                <TabsContent value="lines"><LinesPanel /></TabsContent>
                <TabsContent value="image"><UnderlayPanel /></TabsContent>
              </div>
            </Tabs>
          </aside>
        </div>
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------- top bar
function TopBar({ plan, user }: { plan: WorkspacePlan; user: MenuUser }) {
  const [view, setView] = useDeepSubject(ui, "view");
  const [sim] = useDeepSubject(ui, "sim");
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2">
      <Button variant="ghost" size="sm" asChild>
        <Link href={`/cities/${plan.cityId}`} aria-label={`Back to ${plan.cityName}`}><ArrowLeft /> <span className="max-w-40 truncate">{plan.cityName}</span></Link>
      </Button>
      <Separator orientation="vertical" className="!h-5" />
      <h1 className="truncate px-1 text-sm font-semibold">{plan.name}</h1>
      {plan.access === "read"
        ? <span className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground" title="You can simulate and try things, but nothing is saved"><Eye className="size-3.5" /> View only</span>
        : <SaveIndicator planId={plan.id} />}
      <HistoryButton planId={plan.id} canRestore={plan.access !== "read"} />
      <OptimizeButton planId={plan.id} planName={plan.name} />
      <Separator orientation="vertical" className="!h-5" />
      <LayerPicker />
      <div className="ml-auto flex items-center gap-2">
        <ToggleGroup type="single" value={view} onValueChange={v => v && setView(v as "2d" | "3d")} aria-label="View">
          <ToggleGroupItem value="2d" aria-label="Plan view"><MapIcon /> Plan</ToggleGroupItem>
          <ToggleGroupItem value="3d" aria-label="3D view"><Box /> 3D</ToggleGroupItem>
        </ToggleGroup>
        <Separator orientation="vertical" className="!h-5" />
        <Tip label={sim.running ? "Pause traffic" : "Run traffic"} keys="P">
          <Button size="sm" variant={sim.running ? "secondary" : "default"} onClick={() => { ui.getValue().sim.running = !sim.running; }} className="w-24">
            {sim.running ? <><Pause /> Pause</> : <><Play /> Run</>}
          </Button>
        </Tip>
        <Select value={String(sim.speed)} onValueChange={v => { ui.getValue().sim.speed = Number(v); }}>
          <SelectTrigger size="sm" className="w-20" aria-label="Simulation speed"><SelectValue /></SelectTrigger>
          <SelectContent>{[1, 2, 3, 5, 10, 30].map(s => <SelectItem key={s} value={String(s)}>{s}×</SelectItem>)}</SelectContent>
        </Select>
        <ReachedSpeed asked={sim.speed} running={sim.running} />
        <Tip label="Restart traffic (clears vehicles)">
          <Button size="icon-sm" variant="ghost" onClick={() => { ui.getValue().sim.epoch++; }} aria-label="Restart traffic"><RotateCcw /></Button>
        </Tip>
        <Separator orientation="vertical" className="!h-5" />
        <SettingsMenu />
        <UserMenu user={user} />
      </div>
    </header>
  );
}

function SaveIndicator({ planId }: { planId: string }) {
  const [save] = useDeepSubject(ui, "save");
  const content = {
    saved: <><Check className="size-3.5" /> Saved</>,
    dirty: <><span className="size-1.5 rounded-full bg-amber-500" /> Unsaved changes</>,
    saving: <><Loader2 className="size-3.5 animate-spin" /> Saving…</>,
    error: <><CloudOff className="size-3.5" /> {save.message || "Couldn't save"}</>,
    conflict: <><TriangleAlert className="size-3.5" /> Changed elsewhere</>,
  }[save.status];
  return (
    <div className="flex items-center gap-2">
      <span className={cn("flex items-center gap-1.5 rounded-md px-2 py-1 text-xs", save.status === "error" || save.status === "conflict" ? "bg-destructive/10 text-destructive" : "text-muted-foreground")} role="status">{content}</span>
      {save.status === "conflict" && (
        <>
          <Button size="sm" variant="outline" className="h-7" onClick={() => location.reload()}>Load theirs</Button>
          <Button size="sm" variant="outline" className="h-7" onClick={() => doSave(planId, true)}>Keep mine</Button>
        </>
      )}
      {save.status === "error" && <Button size="sm" variant="outline" className="h-7" onClick={() => doSave(planId)}>Retry</Button>}
    </div>
  );
}

/** switch a layer on or off (Shift + its letter); `only`: just this one */
export function toggleLayer(id: LayerId, only = false) {
  const u = ui.getValue(), cur = u.layers;
  u.layers = only ? [id] : cur.includes(id) ? cur.filter(l => l !== id) : LAYERS.map(l => l.id).filter(l => l === id || cur.includes(l));
}
/** all layers on, or (when they all are) all off (Shift+A) */
export function toggleAllLayers() {
  const u = ui.getValue();
  u.layers = allLayersOn(u.layers) ? [] : LAYERS.map(l => l.id);
}

/** which kinds of object the map selects (any combination; highlighted once narrowed to a few), and the data table */
function LayerPicker() {
  const [layers] = useDeepSubject(ui, "layers");
  const [dataview, setDataview] = useDeepSubject(ui, "dataview");
  const [snap, setSnap] = useDeepSubject(ui, "snap");
  const [display, setDisplay] = useDeepSubject(ui, "display");
  const all = allLayersOn(layers);
  const label = all ? "All layers" : layers.length === 0 ? "No layers" : layers.length === 1 ? LAYERS.find(l => l.id === layers[0])!.label : `${layers.length} layers`;
  // (the menu stays open while switching layers on and off)
  const keep = (e: Event) => e.preventDefault();
  return (
    <div className="flex items-center gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-8 w-44 justify-start font-normal" aria-label={`Layers: what the map selects (${label})`}>
            <Layers className="size-3.5 text-muted-foreground" />
            <span className="flex-1 text-left">{label}</span>
            <ChevronDown className="size-4 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuCheckboxItem checked={all} onCheckedChange={toggleAllLayers} onSelect={keep}>
            All layers<Kbd className="ml-auto">⇧A</Kbd>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          {LAYERS.map(l => (
            <DropdownMenuCheckboxItem key={l.id} className="group" checked={layers.includes(l.id)} onCheckedChange={() => toggleLayer(l.id)} onSelect={keep}>
              {l.label}
              <button type="button" className="ml-auto rounded px-1 text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus:opacity-100 hover:bg-background hover:text-foreground"
                onClick={e => { e.stopPropagation(); e.preventDefault(); toggleLayer(l.id, true); }} aria-label={`Only ${l.label}`}>only</button>
              <Kbd>⇧{l.key}</Kbd>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Display</DropdownMenuLabel>
          <DropdownMenuCheckboxItem checked={snap.grid} onCheckedChange={v => setSnap({ ...snap, grid: !!v })} onSelect={keep}>
            Grid <span className="text-muted-foreground">(snap to grid)</span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={!display.maskRoads} onCheckedChange={v => setDisplay({ ...display, maskRoads: !v })} onSelect={keep}>
            Road surfaces<Kbd className="ml-auto">O</Kbd>
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
            Clicks on the map select objects of the layers that are on. With {LAYER_HIGHLIGHT_MAX} or fewer on, their objects are highlighted too.
          </DropdownMenuLabel>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tip label={dataview ? "Hide the data table" : "Data table"}>
        <Button size="icon-sm" variant={dataview ? "secondary" : "ghost"} aria-pressed={dataview} aria-label="Data table" onClick={() => setDataview(!dataview)}><Table2 /></Button>
      </Tip>
    </div>
  );
}

/** editor settings (in the top bar): the grid step for drawing and snapping */
function SettingsMenu() {
  const [snap, setSnap] = useDeepSubject(ui, "snap");
  const [record, setRecord] = useDeepSubject(ui, "record");
  const keep = (e: Event) => e.preventDefault();
  return (
    <DropdownMenu>
      <Tip label="Settings">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Settings"><Settings /></Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuCheckboxItem checked={record} onCheckedChange={v => setRecord(!!v)} onSelect={keep}>
          Record steps for replay
        </DropdownMenuCheckboxItem>
        <DropdownMenuLabel className="pt-0 text-[10px] font-normal text-muted-foreground">Keeps every simulation step (up to 512 MB) for the replay bar; on very big plans it slows the simulation by about a quarter.</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">Grid step (drawing and snapping)</DropdownMenuLabel>
        {[0.5, 1, 2, 5, 10, 20].map(st => (
          <DropdownMenuCheckboxItem key={st} checked={snap.step === st} onCheckedChange={() => setSnap({ ...snap, step: st })} onSelect={keep}>{st} m</DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------- tool rail
const TOOLS: { id: Tool; label: string; key: string; icon: React.ReactNode }[] = [
  { id: "select", label: "Select and move", key: "V", icon: <MousePointer2 /> },
  { id: "road", label: "Draw roads", key: "R", icon: <Route /> },
  { id: "stop", label: "Place bus stops", key: "B", icon: <Bus /> },
  { id: "image", label: "Move reference image", key: "I", icon: <ImageIcon /> },
  { id: "pan", label: "Pan", key: "H", icon: <Hand /> },
];

function ToolRail() {
  const [tool] = useDeepSubject(ui, "tool");
  const [view] = useDeepSubject(ui, "view");
  const [history] = useDeepSubject(ui, "history");
  const [readOnly] = useDeepSubject(ui, "readOnly");
  const editDisabled = view === "3d";
  const tools = readOnly ? TOOLS.filter(t => t.id === "select" || t.id === "pan") : TOOLS;
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r bg-background py-2" aria-label="Tools">
      {tools.map(t => (
        <Tip key={t.id} label={editDisabled && t.id !== "select" ? `${t.label} (plan view)` : t.label} keys={t.key} side="right">
          <Button
            variant={tool === t.id ? "default" : "ghost"} size="icon" aria-pressed={tool === t.id} aria-label={t.label}
            disabled={editDisabled && t.id !== "select"} onClick={() => { setTool(t.id); if (t.id === "image") ui.getValue().panel = "image"; }}
          >{t.icon}</Button>
        </Tip>
      ))}
      {!readOnly && <Separator className="my-1 !w-7" />}
      {!readOnly && <ImportAreaButton />}
      {!readOnly && <><Tip label="Undo" keys="⌘Z" side="right"><Button variant="ghost" size="icon" disabled={!history.canUndo} onClick={undo} aria-label="Undo"><Undo2 /></Button></Tip>
      <Tip label="Redo" keys="⇧⌘Z" side="right"><Button variant="ghost" size="icon" disabled={!history.canRedo} onClick={redo} aria-label="Redo"><Redo2 /></Button></Tip></>}
      <div className="mt-auto flex flex-col items-center gap-1">
        <Tip label="Zoom in" keys="+" side="right"><Button variant="ghost" size="icon" onClick={() => sendView("zoomIn")} aria-label="Zoom in"><ZoomIn /></Button></Tip>
        <Tip label="Zoom out" keys="−" side="right"><Button variant="ghost" size="icon" onClick={() => sendView("zoomOut")} aria-label="Zoom out"><ZoomOut /></Button></Tip>
        <Tip label="Fit plan" keys="F" side="right"><Button variant="ghost" size="icon" onClick={() => sendView("fit")} aria-label="Fit plan"><Maximize /></Button></Tip>
      </div>
    </nav>
  );
}

/** Add an OpenStreetMap area to the open plan (lined up with earlier imports when there are any). */
function ImportAreaButton() {
  const [net] = useSubject(network$);
  const geo = net.geo ?? null;
  const empty = !net.nodes.length && !net.buildings?.length;
  // the frames imported so far (or, for a plan placed on the map by hand, the extent of its content)
  let existing: BBox[] = geo?.areas ?? [];
  if (geo && !empty && !existing.length) {
    const b = simController.compiled.bounds;
    const nw = unproject(geo, { x: b.minX, y: b.minY }), se = unproject(geo, { x: b.maxX, y: b.maxY });
    existing = [{ south: se.lat, west: nw.lon, north: nw.lat, east: se.lon }];
  }
  const last = existing[existing.length - 1];
  const mode: OsmImportMode = {
    kind: "merge",
    center: last ? bboxCenter(last) : geo,
    existing,
    // plan point (0, 0): kept from earlier imports; for a hand-drawn plan, the new area lands in the middle of the view
    origin: area => geo ?? (empty ? bboxCenter(area) : unproject(bboxCenter(area), { x: -viewport.cx, y: -viewport.cy })),
    onLoaded: (add, stats) => {
      const cur = network$.getValue();
      const wasEmpty = !cur.nodes.length && !cur.buildings?.length;
      const [merged, rep] = ops.mergeNetwork(cur, add);
      commit(merged);
      if (wasEmpty) setSettings({ ...suggestSettings(merged), seed: settings$.getValue().seed });
      sendView("fit");
      toast.success(`Added ${rep.roads} road${rep.roads === 1 ? "" : "s"} and ${rep.buildings} building${rep.buildings === 1 ? "" : "s"}`, {
        description: [
          rep.joined ? `${rep.joined} joined to the plan's entry roads.` : "",
          rep.skippedRoads || rep.skippedBuildings ? `Skipped ${rep.skippedRoads} roads and ${rep.skippedBuildings} buildings already in the plan.` : "",
          `Area: ${describeStats(stats)}.`,
        ].filter(Boolean).join(" "),
      });
    },
  };
  return (
    <OsmImportDialog mode={mode} trigger={
      <Button variant="ghost" size="icon" aria-label="Add an area from OpenStreetMap" title="Add an area from OpenStreetMap"><MapPlus /></Button>
    } />
  );
}

function Tip({ label, keys, side = "bottom", children }: { label: string; keys?: string; side?: "right" | "bottom"; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2">{label}{keys && <Kbd className="border-background/30 bg-background/15 text-background">{keys}</Kbd>}</TooltipContent>
    </Tooltip>
  );
}

// ---------------------------------------------------------------- draft options (road tool)
function DraftBar() {
  const [tool] = useDeepSubject(ui, "tool");
  const [view] = useDeepSubject(ui, "view");
  const [draft, setDraft] = useDeepSubject(ui, "draft");
  if (view !== "2d" || tool !== "road") return null;
  return (
    <div className="absolute top-3 left-1/2 z-10 flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 overflow-x-auto rounded-lg border bg-background/95 px-3 py-1.5 text-sm whitespace-nowrap shadow-sm backdrop-blur">
      {tool === "road" && (
        <>
          <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">New roads</span>
          <ToggleGroup type="single" value={draft.curved ? "curved" : "straight"} onValueChange={v => v && setDraft({ ...draft, curved: v === "curved" })} aria-label="Road shape">
            <ToggleGroupItem value="straight" className="h-7 px-2 text-xs" aria-label="Straight segments"><Minus /> Straight</ToggleGroupItem>
            <ToggleGroupItem value="curved" className="h-7 px-2 text-xs" aria-label="Smooth curves"><Spline /> Curved</ToggleGroupItem>
          </ToggleGroup>
          <span className="flex items-center gap-1.5 text-xs">Forward <Stepper label="forward lanes" value={draft.lanesF} min={draft.lanesB === 0 ? 1 : 0} max={MAX_LANES} onChange={v => setDraft({ ...draft, lanesF: v })} /></span>
          <span className="flex items-center gap-1.5 text-xs">Back <Stepper label="backward lanes" value={draft.lanesB} min={draft.lanesF === 0 ? 1 : 0} max={MAX_LANES} onChange={v => setDraft({ ...draft, lanesB: v })} /></span>
          <Select value={String(draft.speed)} onValueChange={v => setDraft({ ...draft, speed: Number(v) })}>
            <SelectTrigger size="sm" className="h-7 w-28" aria-label="Speed limit for new roads"><SelectValue /></SelectTrigger>
            <SelectContent>{[30, 40, 50, 60, 70, 80, 90].map(s => <SelectItem key={s} value={String(s)}>{s} km/h</SelectItem>)}</SelectContent>
          </Select>
        </>
      )}
    </div>
  );
}

/** the speed the simulation really runs at, when a big plan can't keep up with the one chosen */
function ReachedSpeed({ asked, running }: { asked: number; running: boolean }) {
  useSubject(stats$); // refreshed with the live numbers (~4×/s)
  const r = simController.rate;
  if (!running || !r || r >= asked * 0.85) return null;
  return (
    <Tip label={`This plan is too big to simulate at ${asked}× on this computer: it runs at about ${r.toFixed(1)}× real time.`}>
      <span className="font-mono text-xs text-amber-600 tabular">≈{r < 10 ? r.toFixed(1) : Math.round(r)}×</span>
    </Tip>
  );
}

// ---------------------------------------------------------------- overlays
/** simulated time as m:ss, or h:mm:ss from an hour on */
const clock = (t: number) => {
  const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};
function LiveBadge() {
  const [stats] = useSubject(stats$);
  const [sim] = useDeepSubject(ui, "sim");
  const running = sim.running;
  if (!stats) return null;
  return (
    <div className="pointer-events-none absolute top-3 left-3 z-10 grid grid-cols-5 gap-3 rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-sm backdrop-blur">
      {[
        ["Elapsed", clock(simController.sim?.time ?? 0)],
        ["Vehicles", String(stats.count)],
        ["Avg km/h", stats.avgSpeed.toFixed(1)],
        ["Stopped", `${Math.round(stats.stopped * 100)}%`],
        ["Trips/min", String(Math.round(stats.tripsPerMin))],
      ].map(([k, v]) => (
        <div key={k}><div className="font-mono text-sm font-semibold tabular">{v}</div><div className="text-muted-foreground">{k}</div></div>
      ))}
      {!running && <div className="col-span-5 text-muted-foreground">Paused</div>}
    </div>
  );
}

/** what the vehicle colours mean when they show speed */
function SpeedLegend() {
  const [display] = useDeepSubject(ui, "display");
  const [view] = useDeepSubject(ui, "view");
  if (!display.bySpeed) return null;
  return (
    <div className={cn("pointer-events-none absolute left-16 z-10 flex items-center gap-2.5 rounded-md bg-background/90 px-2 py-1 text-[11px] shadow-sm", view === "3d" ? "bottom-3" : "bottom-9")}>
      <span className="text-muted-foreground">Speed</span>
      {([["var(--sig-stop)", "stopped"], ["var(--sig-slow)", "slow"], ["var(--sig-go)", "free flow"]] as const).map(([c, l]) => (
        <span key={l} className="flex items-center gap-1"><span className="size-2.5 rounded-sm" style={{ background: c }} />{l}</span>
      ))}
    </div>
  );
}

/** Esri's attribution, while its imagery is on screen */
function SatelliteCredit() {
  const [display] = useDeepSubject(ui, "display");
  const [net] = useSubject(network$);
  if (!display.satellite || !net.geo) return null;
  return <div className="pointer-events-none absolute bottom-3 left-16 z-10 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">{SAT_ATTRIBUTION}</div>;
}

function StatusBar() {
  const [cursor] = useDeepSubject(ui, "cursor");
  const [view] = useDeepSubject(ui, "view");
  const [tool] = useDeepSubject(ui, "tool");
  const [calib] = useDeepSubject(ui, "calib");
  const hint = calib.active && view === "2d" ? "Calibrating: click two points on the image whose real distance you know · Esc to cancel"
    : view === "3d"
    ? "Drag to orbit · right-drag to pan · scroll to zoom · click to select"
    : tool === "road" ? "Click to place points · C toggles curved · click a road to join it · Shift for 15° · Esc to finish"
      : tool === "stop" ? "Click the side of a road where buses should stop"
        : tool === "image" ? "Drag the image to move · corners scale · round handle rotates (Shift: 15°)"
        : "Double-click a road to add a bend point · scroll to pan · ⌘/Ctrl + scroll to zoom";
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 z-10 flex items-center gap-3 rounded-md bg-background/90 px-2.5 py-1 text-[11px] text-muted-foreground shadow-sm">
      <span>{hint}</span>
      {view === "2d" && cursor.inside && <span className="font-mono tabular text-foreground">x {cursor.x.toFixed(1)} · y {cursor.y.toFixed(1)} m</span>}
    </div>
  );
}

// ---------------------------------------------------------------- autosave
// Small plans save ~1 s after a change. Large plans (imported districts) save once editing pauses
// for a few seconds, at least every 30 s while editing continues, and right away when the tab is
// hidden. Buildings are only sent when they changed: the server keeps the ones it has.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = false, again = false;
/** when the oldest unsaved change was made (0 = none) */
let dirtySince = 0;
/** the buildings the server has for the open plan (same array = unchanged) */
let savedBuildings: Network["buildings"] = undefined;
export const setSavedBuildings = (b: Network["buildings"]) => { savedBuildings = b; };

const MAX_WAIT = 30_000;
function saveDelay() {
  const n = network$.getValue();
  return (n.buildings?.length ?? 0) > 2000 || n.links.length > 1500 ? 4000 : 900;
}

async function doSave(planId: string, force = false) {
  if (saving) { again = true; return; }
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saving = true; dirtySince = 0;
  const s = ui.getValue().save;
  s.status = "saving";
  try {
    const net = network$.getValue();
    // after a conflict ("keep mine") everything is sent, so their building edits can't survive
    const keepBuildings = !force && !!net.buildings?.length && net.buildings === savedBuildings;
    const res = await savePlan(planId, {
      network: keepBuildings ? { ...net, buildings: undefined } : net, keepBuildings,
      settings: settings$.getValue(), underlay: underlay$.getValue(), revision: s.revision, force,
    });
    if (res.ok) {
      savedBuildings = net.buildings;
      s.revision = res.revision; s.savedAt = res.savedAt; s.message = "";
      s.status = again ? "dirty" : "saved";
    } else if (res.reason === "forbidden") {
      s.status = "error"; s.message = "You no longer have edit access";
    } else if (res.reason === "conflict") {
      s.status = "conflict";
      toast.warning("Someone else saved this plan in the meantime (another person, tab or window).", { description: "Choose whose version to keep. Theirs stays in the history either way." });
    } else { s.status = "error"; s.message = "Plan no longer exists"; }
  } catch {
    s.status = "error"; s.message = "Couldn't save — check the database or sign in again";
  } finally {
    saving = false;
    if (again) { again = false; queueSave(planId); }
  }
}

/** (re)start the countdown to the next save; each change pushes it back, up to MAX_WAIT after the first */
function queueSave(planId: string) {
  if (!dirtySince) dirtySince = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  const wait = Math.max(0, Math.min(saveDelay(), dirtySince + MAX_WAIT - Date.now()));
  saveTimer = setTimeout(() => { saveTimer = null; doSave(planId); }, wait);
}

function useAutosave(planId: string) {
  useEffect(() => {
    const onChange = () => { if (ui.getValue().save.status === "dirty") queueSave(planId); };
    const subs = [ui.subscribe("save/status", onChange), network$.subscribe(onChange), settings$.subscribe(onChange), underlay$.subscribe(onChange)];
    const hide = () => { if (document.hidden && ui.getValue().save.status === "dirty") doSave(planId); };
    const unload = (e: BeforeUnloadEvent) => { const st = ui.getValue().save.status; if (st === "dirty" || st === "saving") { e.preventDefault(); } };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("beforeunload", unload);
    return () => {
      subs.forEach(x => x.unsubscribe());
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("beforeunload", unload);
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null; dirtySince = 0;
    };
  }, [planId]);
}

// ---------------------------------------------------------------- shortcuts
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.closest?.("input,textarea,select,[contenteditable],[role=combobox],[role=slider]")) return;
      const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), u = ui.getValue();
      if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && k === "y") { e.preventDefault(); redo(); return; }
      if (mod) return;
      // Shift + letter: a layer on or off (see LAYERS); Shift+A: all of them
      if (e.shiftKey && !e.altKey) {
        if (k === "a") { e.preventDefault(); toggleAllLayers(); return; }
        const layer = LAYERS.find(l => l.key.toLowerCase() === k);
        if (layer) { e.preventDefault(); toggleLayer(layer.id); return; }
      }
      if (k === "v") setTool("select");
      else if (k === "r" && u.view === "2d" && !u.readOnly) setTool("road");
      else if (k === "b" && u.view === "2d" && !u.readOnly) setTool("stop");
      else if (k === "i" && u.view === "2d" && !u.readOnly) { setTool("image"); u.panel = "image"; }
      else if (k === "c" && u.tool === "road") u.draft.curved = !u.draft.curved;
      else if (k === "h") setTool("pan");
      else if (k === "o" && u.view === "2d") u.display.maskRoads = !u.display.maskRoads;
      else if (k === "m" && !u.readOnly) mergeSelectedRoads();
      else if (k === "s" && !u.readOnly && u.multi.length) smoothSelectedJoin();
      else if (k === "p") u.sim.running = !u.sim.running;
      else if (k === "f") sendView("fit");
      else if (k === "+" || k === "=") sendView("zoomIn");
      else if (k === "-") sendView("zoomOut");
      else if (k === "escape") select(null);
      else if (k === "delete" || k === "backspace") {
        const sel = u.selection, net = network$.getValue();
        if (!sel) return;
        e.preventDefault();
        if (sel.kind === "node") commit(ops.deleteNode(net, sel.id));
        else if (sel.kind === "link") commit(ops.deleteLink(net, sel.id));
        else if (sel.kind === "stop") commit(ops.deleteStop(net, sel.id));
        else if (sel.kind === "line") commit(ops.deleteLine(net, sel.id));
        else if (sel.kind === "building") commit(ops.deleteBuilding(net, sel.id));
        else return;
        select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
