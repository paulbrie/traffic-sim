/**
 * Client state for the plan workspace, built on subjecto.
 *  - `ui`       DeepSubject: tools, selection, view, snapping, sim controls, save status
 *  - `network$` Subject: the street network (immutable snapshots, so undo/redo is cheap)
 *  - `settings$` Subject: traffic densities for this plan
 *  - `stats$`   Subject: live simulation stats (published ~4×/s)
 *  - `underlay$` Subject: reference image placement (autosaved with the plan, not part of undo)
 */
import { DeepSubject, Subject, batch } from "subjecto";
import { DEFAULT_SETTINGS, emptyNetwork, type Network, type PlanSettings } from "@/engine/types";
import type { Stats } from "@/engine/sim";
import type { Vec } from "@/engine/types";
import type { Underlay } from "@/lib/underlay";

export type Tool = "select" | "road" | "segment" | "stop" | "pan" | "image" | "marker";
/** the kinds of object the map shows and can select (TransModeler-style layers); any combination can be on */
export type LayerId = "roads" | "lanes" | "junctions" | "connectors" | "entries" | "signals" | "stops" | "counters" | "buildings" | "vehicles" | "zones" | "markers";
/** `key`: Shift + this letter switches the layer on or off (Shift+A: all of them) */
export const LAYERS: { id: LayerId; label: string; key: string }[] = [
  { id: "roads", label: "Roads", key: "R" }, { id: "lanes", label: "Lanes", key: "L" }, { id: "junctions", label: "Junctions", key: "J" },
  { id: "connectors", label: "Lane connectors", key: "C" }, { id: "entries", label: "Entry / exit points", key: "E" }, { id: "signals", label: "Signals", key: "S" },
  { id: "stops", label: "Bus stops", key: "B" }, { id: "counters", label: "Traffic counters", key: "T" }, { id: "buildings", label: "Buildings", key: "U" },
  { id: "vehicles", label: "Vehicles", key: "V" }, { id: "zones", label: "Zones", key: "Z" }, { id: "markers", label: "Markers", key: "M" },
];
/** a layer's highlights (lane outlines, connectors, rings around junctions…) show when at most this many layers are on */
export const LAYER_HIGHLIGHT_MAX = 3;
export const allLayersOn = (layers: readonly LayerId[]) => LAYERS.every(l => layers.includes(l.id));
/** the layers whose highlights the map draws */
export const highlightedLayers = (layers: readonly LayerId[]): LayerId[] => (layers.length <= LAYER_HIGHLIGHT_MAX ? [...layers] : []);
export type Selection =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string }
  | { kind: "stop"; id: string }
  | { kind: "line"; id: string }
  | { kind: "building"; id: string }
  /** id "linkId|dir|lane" */
  | { kind: "lane"; id: string }
  /** id "nodeId|inEdgeKey|inLane|outEdgeKey|outLane" */
  | { kind: "connector"; id: string }
  | { kind: "zone"; id: string }
  | { kind: "vehicle"; id: string }
  | { kind: "marker"; id: string };
export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface UiState {
  planId: string;
  tool: Tool;
  selection: Selection | null;
  view: "2d" | "3d";
  snap: { grid: boolean; step: number; angle: boolean };
  draft: { lanesF: number; lanesB: number; busF: boolean; busB: boolean; speed: number; curved: boolean };
  /** more roads selected with the one in `selection` (Shift+click), e.g. to merge them */
  multi: string[];
  /** more objects of any kind selected with it (Shift+click, Shift+drag a box), e.g. to delete them together */
  extra: Selection[];
  /** picking a transit flow's exit on the map (the flow's id) */
  pickExit: string | null;
  /** route tracer: from an entry point to an exit, starting in an entry lane (null = the kerb-side one) */
  trace: { from: string | null; to: string | null; lane: number | null };
  display: { bySpeed: boolean; reservations: boolean; labels: boolean; buildings: boolean; junctions: boolean; satellite: boolean; connectors: boolean; maskRoads: boolean; /** satellite imagery brightness (0.3–1) */ satBrightness: number; /** the CPU / memory load panel */ perf: boolean };
  sim: { running: boolean; speed: number; epoch: number };
  save: { status: SaveStatus; revision: number; savedAt: string | null; message: string };
  cursor: { x: number; y: number; inside: boolean };
  panel: "inspect" | "traffic" | "lines" | "image";
  /** event logs: every junction, chosen junctions, chosen roads (by link id), chosen vehicles (by id; cleared when traffic restarts) */
  eventLog: { all: boolean; nodes: string[]; links: string[]; vehicles: number[] };
  /** segment tool: edit just the clicked segment or the whole road through its joints */
  segScope: "segment" | "road";
  /** scale calibration: pick two points on the reference image, then type their real distance */
  calib: { active: boolean; a: Vec | null; b: Vec | null };
  history: { canUndo: boolean; canRedo: boolean };
  /** layers whose objects the map draws and selects (all by default); their highlights show once narrowed to a few (see LAYER_HIGHLIGHT_MAX) */
  layers: LayerId[];
  /** the layer listed in the data table */
  tableLayer: LayerId;
  /** the data table under the map */
  dataview: boolean;
  /** opened with view-only access: edits are blocked and nothing is saved */
  readOnly: boolean;
  /** junction editor: the junction whose outline is being edited, and a painted area being drawn */
  shape: { edit: string | null; paint: { node: string; kind: "hatch" | "island"; pts: Vec[] } | null };
  /** drawing a lane connector: the lane it starts from ("linkId|dir|lane"); the next lane clicked on the map ends it */
  connectFrom: string | null;
  /** keep every simulation step for the replay bar (costs time and memory on big plans) */
  record: boolean;
  /** war mode available while flying: the helicopter's gun and rockets (off by default) */
  warMode: boolean;
}

export const ui = new DeepSubject<UiState>(
  {
    planId: "",
    tool: "select",
    selection: null,
    view: "2d",
    snap: { grid: false, step: 5, angle: true },
    draft: { lanesF: 1, lanesB: 1, busF: false, busB: false, speed: 50, curved: false },
    trace: { from: null, to: null, lane: null },
    multi: [],
    extra: [],
    pickExit: null,
    display: { bySpeed: false, reservations: true, labels: true, buildings: true, junctions: false, satellite: true, connectors: false, maskRoads: false, satBrightness: 0.85, perf: false },
    sim: { running: false, speed: 3, epoch: 0 },
    save: { status: "saved", revision: 1, savedAt: null, message: "" },
    cursor: { x: 0, y: 0, inside: false },
    panel: "inspect",
    segScope: "segment",
    eventLog: { all: false, nodes: [], links: [], vehicles: [] },
    calib: { active: false, a: null, b: null },
    history: { canUndo: false, canRedo: false },
    layers: LAYERS.map(l => l.id),
    tableLayer: "roads",
    dataview: false,
    readOnly: false,
    shape: { edit: null, paint: null },
    connectFrom: null,
    record: true,
    warMode: false,
  },
  { name: "ui" },
);

export const network$ = new Subject<Network>(emptyNetwork(), { name: "network", updateIfStrictlyEqual: false });
export const settings$ = new Subject<PlanSettings>(DEFAULT_SETTINGS, { name: "settings", updateIfStrictlyEqual: false });
export const stats$ = new Subject<Stats | null>(null, { name: "stats" });
export const underlay$ = new Subject<Underlay | null>(null, { name: "underlay", updateIfStrictlyEqual: false });

// ---------------------------------------------------------------- history
const past: Network[] = [];
const future: Network[] = [];
let coalesceKey: string | null = null;
let coalesceAt = 0;
const MAX_HISTORY = 200;

function syncHistoryFlags() {
  const h = ui.getValue().history;
  if (h.canUndo !== past.length > 0 || h.canRedo !== future.length > 0) {
    batch(() => { h.canUndo = past.length > 0; h.canRedo = future.length > 0; });
  }
}

function markDirty() {
  if (ui.getValue().readOnly) return;
  const s = ui.getValue().save;
  if (s.status !== "dirty") s.status = "dirty";
}

/**
 * Apply a change to the network. Edits sharing a `key` within 800 ms (e.g. a
 * node drag, typing in a field) collapse into one undo step.
 */
export function commit(next: Network, key?: string) {
  if (ui.getValue().readOnly) return;
  const prev = network$.getValue();
  if (next === prev) return;
  const now = performance.now();
  if (!(key && key === coalesceKey && now - coalesceAt < 800)) {
    past.push(prev);
    if (past.length > MAX_HISTORY) past.shift();
  }
  coalesceKey = key ?? null;
  coalesceAt = now;
  future.length = 0;
  network$.next(next);
  markDirty();
  syncHistoryFlags();
}

/** Close the current coalescing window so the next edit starts a new undo step. */
export function endGesture() { coalesceKey = null; }

export function undo() {
  const prev = past.pop();
  if (!prev) return;
  future.push(network$.getValue());
  coalesceKey = null;
  network$.next(prev);
  pruneSelection(prev);
  markDirty();
  syncHistoryFlags();
}

export function redo() {
  const next = future.pop();
  if (!next) return;
  past.push(network$.getValue());
  coalesceKey = null;
  network$.next(next);
  pruneSelection(next);
  markDirty();
  syncHistoryFlags();
}

export function setSettings(next: PlanSettings) {
  settings$.next(next);
  markDirty();
}

/** Update the reference image placement (pass a function to patch the current one). */
export function setUnderlay(next: Underlay | null | ((cur: Underlay) => Underlay)) {
  const cur = underlay$.getValue();
  const value = typeof next === "function" ? (cur ? next(cur) : null) : next;
  underlay$.next(value);
  markDirty();
}

/** Load a plan into the stores (clears history). */
export function loadPlan(planId: string, network: Network, settings: PlanSettings, revision: number, savedAt: string, underlay: Underlay | null = null, readOnly = false) {
  past.length = 0; future.length = 0; coalesceKey = null;
  batch(() => {
    const u = ui.getValue();
    u.planId = planId;
    u.readOnly = readOnly;
    u.selection = null;
    u.tool = "select";
    u.sim.running = false;
    u.sim.epoch++;
    u.save.status = "saved";
    u.save.revision = revision;
    u.save.savedAt = savedAt;
    u.save.message = "";
    u.calib.active = false; u.calib.a = null; u.calib.b = null;
  });
  network$.next(network);
  settings$.next(settings);
  underlay$.next(underlay);
  syncHistoryFlags();
}

export function select(sel: Selection | null) {
  const u = ui.getValue();
  const cur = u.selection;
  if (cur === sel || (cur && sel && cur.kind === sel.kind && cur.id === sel.id)) return;
  batch(() => {
    u.selection = sel ? { ...sel } : null; if (u.multi.length) u.multi = []; if (u.extra.length) u.extra = [];
    if (u.pickExit) u.pickExit = null;
    // (the junction editor belongs to its junction: selecting something else ends it)
    const keep = sel?.kind === "node" ? sel.id : null;
    if (u.shape.edit && u.shape.edit !== keep) u.shape.edit = null;
    if (u.shape.paint && u.shape.paint.node !== keep) u.shape.paint = null;
    // (drawing a connector starts from the selected lane: selecting something else ends it)
    if (u.connectFrom && !(sel?.kind === "lane" && sel.id === u.connectFrom)) u.connectFrom = null;
  });
}

/** Shift+click on a road: add it to the selected roads, or take it out again */
export function toggleRoad(id: string) {
  const u = ui.getValue(), cur = u.selection;
  if (cur?.kind !== "link") { select({ kind: "link", id }); return; }
  batch(() => {
    if (cur.id === id) {
      // taking out the first one: the next becomes the main selection
      if (u.multi.length) { u.selection = { kind: "link", id: u.multi[0] }; u.multi = u.multi.slice(1); }
      else u.selection = null;
    } else u.multi = u.multi.includes(id) ? u.multi.filter(x => x !== id) : [...u.multi, id];
  });
}

const sameSel = (a: Selection, b: Selection) => a.kind === b.kind && a.id === b.id;
/** everything selected: the main selection, the roads with it, and the rest */
export function selectedAll(u: UiState = ui.getValue()): Selection[] {
  return u.selection ? [u.selection, ...u.multi.map(id => ({ kind: "link", id }) as Selection), ...u.extra] : [];
}
/** select these together (the first is the one the inspector shows; roads after a road stay "more roads", for merging) */
export function selectMany(list: Selection[]) {
  const u = ui.getValue(), uniq: Selection[] = [];
  for (const x of list) if (!uniq.some(y => sameSel(x, y))) uniq.push({ ...x });
  const [first, ...rest] = uniq;
  if (!first) { select(null); return; }
  if (!u.selection || !sameSel(u.selection, first)) select(first);
  batch(() => {
    const roads = first.kind === "link" ? rest.filter(x => x.kind === "link").map(x => x.id) : [];
    u.multi = roads;
    u.extra = rest.filter(x => !(x.kind === "link" && roads.includes(x.id)));
  });
}
/** Shift+click: add this to what is selected, or take it out again */
export function toggleSelect(sel: Selection) {
  const all = selectedAll();
  selectMany(all.some(x => sameSel(x, sel)) ? all.filter(x => !sameSel(x, sel)) : [...all, sel]);
}

function pruneSelection(net: Network) {
  // what is selected and no longer exists (deleted, undone) goes; the next one left takes its place
  const alive = (sel: Selection) =>
    sel.kind === "node" ? net.nodes.some(n => n.id === sel.id)
      : sel.kind === "link" ? net.links.some(l => l.id === sel.id)
        : sel.kind === "stop" ? net.stops.some(s => s.id === sel.id)
          : sel.kind === "line" ? net.lines.some(l => l.id === sel.id)
            : sel.kind === "building" ? (net.buildings ?? []).some(b => b.id === sel.id)
              : sel.kind === "marker" ? (net.markers ?? []).some(m => m.id === sel.id)
                : true;
  const all = selectedAll();
  if (all.every(alive)) return;
  const left = all.filter(alive);
  if (left.length) selectMany(left); else ui.getValue().selection = null;
}

export function setTool(tool: Tool) {
  const u = ui.getValue();
  if (u.tool !== tool) u.tool = tool;
}
