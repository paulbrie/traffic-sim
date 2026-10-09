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
import { emptySketch, type Sketch } from "@/lib/lane-sketch";
import type { SatSource } from "@/render/satellite";
import { mergeNetworks, mergeSettings, mergeSketch, mergeUnderlay } from "./merge";

export type Tool = "select" | "road" | "segment" | "stop" | "pan" | "image" | "marker" | "junction" | "crossing" | "parking" | "roundabout" | "ring";
/** the kinds of object the map shows and can select (TransModeler-style layers); any combination can be on */
export type LayerId = "roads" | "lanes" | "junctions" | "connectors" | "entries" | "signals" | "stops" | "counters" | "buildings" | "vehicles" | "zones" | "markers" | "crossings" | "parking";
/** `key`: Shift + this letter switches the layer on or off (Shift+A: all of them) */
export const LAYERS: { id: LayerId; label: string; key: string }[] = [
  { id: "roads", label: "Roads", key: "R" }, { id: "lanes", label: "Lanes", key: "L" }, { id: "junctions", label: "Junctions", key: "J" },
  { id: "connectors", label: "Lane connectors", key: "C" }, { id: "entries", label: "Entry / exit points", key: "E" }, { id: "signals", label: "Signals", key: "S" },
  { id: "stops", label: "Bus stops", key: "B" }, { id: "counters", label: "Traffic counters", key: "T" }, { id: "buildings", label: "Buildings", key: "U" },
  { id: "vehicles", label: "Vehicles", key: "V" }, { id: "zones", label: "Zones", key: "Z" }, { id: "markers", label: "Markers", key: "M" },
  { id: "crossings", label: "Zebra crossings", key: "X" }, { id: "parking", label: "Parking", key: "G" },
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
  | { kind: "marker"; id: string }
  | { kind: "crossing"; id: string }
  | { kind: "parking"; id: string }
  /** a junction group (Network.groups): its roads and junctions as one */
  | { kind: "group"; id: string }
  /** a junction standing on its own, no road joined yet (JunctionDef.outline) */
  | { kind: "junction"; id: string }
  /** a ring placed by hand (Network.rings) */
  | { kind: "ring"; id: string };
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
  display: { bySpeed: boolean; reservations: boolean; labels: boolean; buildings: boolean; junctions: boolean; satellite: boolean; connectors: boolean; maskRoads: boolean; /** satellite imagery brightness (0.3–1) */ satBrightness: number; /** where the satellite imagery comes from */ satSource: SatSource; /** the CPU / memory load panel */ perf: boolean };
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
  /** the simulation's console under the map: vehicles towed or taken off, vehicles overlapping */
  console: boolean;
  /** the search bar over the map (Cmd/Ctrl+K) */
  search: boolean;
  /** the lane sketch window (an experiment, see `laneSketch$`) */
  sketch: boolean;
  /** inside a junction group (double-click it): clicks pick its roads and junctions instead of the group */
  groupEdit: string | null;
  /** a junction being placed (pasted, or from the library): it follows the pointer, R turns it, a click puts it down */
  placing: { name: string; turn: number } | null;
  /** a slow edit under way (see busy()): what it is doing, shown over the map */
  busy: string | null;
  /** the last such note (kept while it fades out) */
  busyLabel: string;
  /** opened with view-only access: edits are blocked and nothing is saved */
  readOnly: boolean;
  /** junction editor: the junction whose outline is being edited, and a painted area being drawn */
  /** `paint` of kind "junction": the outline of a junction drawn by hand (Junction tool; `node` unused) */
  /** `paint` also holds a zebra crossing being drawn (its first end) and a row of parking bays (its first end) */
  shape: { edit: string | null; /** the outline point picked (being edited): Delete takes it out */ point?: number | null; paint: { node: string; kind: "hatch" | "island" | "junction" | "crossing" | "parking" | "roundabout"; pts: Vec[] } | null };
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
    display: { bySpeed: false, reservations: true, labels: true, buildings: true, junctions: false, satellite: true, connectors: false, maskRoads: false, satBrightness: 0.85, satSource: "esri", perf: false },
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
    console: false,
    search: false,
    sketch: false,
    groupEdit: null,
    placing: null,
    busy: null,
    busyLabel: "",
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
/** the lane sketch: lanes, connectors and roads drawn freely in their own window; in memory only (never saved) */
export const laneSketch$ = new Subject<Sketch>(emptySketch(), { name: "laneSketch", updateIfStrictlyEqual: false });
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
 * Actions taken since the plan was last saved (an undo step each: a drag or a typed value counts once; undo and
 * redo count too). The plan saves after a few (see useAutosave).
 */
export const edits = { n: 0 };

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
    edits.n++;
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
  edits.n++;
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
  edits.n++;
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

// ---------------------------------------------------------------- live updates
/** the plan as last loaded or saved here: what this page and the server both started from (for merging) */
let synced: { network: Network; settings: PlanSettings; underlay: Underlay | null; sketch: Sketch } = { network: emptyNetwork(), settings: DEFAULT_SETTINGS, underlay: null, sketch: laneSketch$.getValue() };
/** what was just saved is now what the server has */
export function markSynced(network: Network, settings: PlanSettings, underlay: Underlay | null, sketch: Sketch) { synced = { network, settings, underlay, sketch }; }
// (the lane sketch saves with the plan: any change to it but the one just loaded or merged in is unsaved)
// (and undone back to what was saved, it is saved again: the sketch shown as saved is kept when a change is made to it,
// and undo gives back the very pieces it had, so each is compared as it is, cheaply, even on a city; the plan saved only
// if nothing else differs either)
const sameSketch = (a: Sketch, b: Sketch) => a === b || (Object.keys({ ...a, ...b }) as (keyof Sketch)[]).every(k => a[k] === b[k]);
let shownSketch = laneSketch$.getValue(), savedSketch: Sketch | null = null;
laneSketch$.subscribe(k => {
  const s = ui.getValue().save;
  if (s.status === "saved") savedSketch = shownSketch;
  shownSketch = k;
  if (!sameSketch(k, synced.sketch) && !(savedSketch && sameSketch(k, savedSketch))) { markDirty(); return; }
  if (s.status === "dirty" && network$.getValue() === synced.network && settings$.getValue() === synced.settings && underlay$.getValue() === synced.underlay) s.status = "saved";
});
/** listeners told when the sketch is replaced by one loaded or merged in (its own undo history no longer applies) */
export const sketchReplaced = new Set<(why: "load" | "merge") => void>();

/**
 * A newer version saved elsewhere (another person, tab or window, or written to the database): taken in,
 * merged with what is not saved here yet (see ./merge), and the undo history rebased onto it, so undoing
 * still undoes only this page's own edits. Unsaved changes stay unsaved (the merged plan saves next).
 */
export function applyRemote(revision: number, savedAt: string, remote: { network: Network; settings: PlanSettings; underlay: Underlay | null; sketch: Sketch | null }) {
  const b = synced, mineN = network$.getValue(), mineS = settings$.getValue(), mineU = underlay$.getValue(), mineK = laneSketch$.getValue();
  const mineChanged = mineN !== b.network || mineS !== b.settings || mineU !== b.underlay || mineK !== b.sketch;
  const theirs = { ...remote, sketch: remote.sketch ?? emptySketch() };
  const net = mergeNetworks(b.network, mineN, theirs.network);
  for (let i = 0; i < past.length; i++) past[i] = mergeNetworks(b.network, past[i], theirs.network);
  for (let i = 0; i < future.length; i++) future[i] = mergeNetworks(b.network, future[i], theirs.network);
  synced = theirs;
  const s = ui.getValue().save;
  batch(() => {
    s.revision = revision; s.savedAt = savedAt; s.message = "";
    if (!mineChanged) s.status = "saved";
    else if (s.status === "conflict" || s.status === "saved") s.status = "dirty";
  });
  network$.next(net);
  settings$.next(mergeSettings(b.settings, mineS, theirs.settings));
  underlay$.next(mergeUnderlay(b.underlay, mineU, theirs.underlay));
  const k = mergeSketch(b.sketch, mineK, theirs.sketch);
  if (k !== mineK) { laneSketch$.next(k); sketchReplaced.forEach(f => f("merge")); }
  pruneSelection(net);
  syncHistoryFlags();
}

/** Load a plan into the stores (clears history). */
export function loadPlan(planId: string, network: Network, settings: PlanSettings, revision: number, savedAt: string, underlay: Underlay | null = null, readOnly = false, sketch: Sketch | null = null) {
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
  const k = sketch ?? emptySketch();
  synced = { network, settings, underlay, sketch: k };
  network$.next(network);
  settings$.next(settings);
  underlay$.next(underlay);
  laneSketch$.next(k);
  sketchReplaced.forEach(f => f("load"));
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
    if (u.shape.edit && u.shape.edit !== keep) { u.shape.edit = null; u.shape.point = null; }
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
                : sel.kind === "crossing" ? (net.crossings ?? []).some(x => x.id === sel.id)
                  : sel.kind === "parking" ? (net.parking ?? []).some(x => x.id === sel.id)
                    : sel.kind === "group" ? (net.groups ?? []).some(x => x.id === sel.id)
                    : sel.kind === "junction" ? (net.junctions ?? []).some(x => x.id === sel.id && !x.nodes.length)
                    : sel.kind === "ring" ? (net.rings ?? []).some(x => x.id === sel.id)
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

/** two animation frames: long enough for the browser to paint what was just changed */
const painted = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
/** how long the note takes to fade in or out (ms; the BusyNote's transition) */
export const BUSY_FADE = 150;
let busyRuns = 0;
/**
 * Run a slow edit with a "working" note over the map: the note is painted first (the edit itself blocks the
 * page), and stays until the map has been drawn again with the result.
 */
export async function busy<T>(label: string, work: () => T): Promise<T> {
  busyRuns++;
  const u = ui.getValue();
  u.busyLabel = label; u.busy = label;
  try {
    // (the note faded in before the edit blocks the page: a frozen half-faded note reads as a glitch)
    await painted();
    await new Promise(r => setTimeout(r, BUSY_FADE));
    const out = work();
    await painted();
    return out;
  } finally {
    if (--busyRuns === 0) ui.getValue().busy = null;
  }
}
