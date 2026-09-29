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

export type Tool = "select" | "road" | "segment" | "stop" | "pan" | "image";
export type Selection =
  | { kind: "node"; id: string }
  | { kind: "link"; id: string }
  | { kind: "stop"; id: string }
  | { kind: "line"; id: string }
  | { kind: "building"; id: string }
  | { kind: "vehicle"; id: string };
export type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";

export interface UiState {
  planId: string;
  tool: Tool;
  selection: Selection | null;
  view: "2d" | "3d";
  snap: { grid: boolean; step: number; angle: boolean };
  draft: { lanesF: number; lanesB: number; busF: boolean; busB: boolean; speed: number; curved: boolean };
  display: { bySpeed: boolean; reservations: boolean; labels: boolean; buildings: boolean; junctions: boolean };
  sim: { running: boolean; speed: number; epoch: number };
  save: { status: SaveStatus; revision: number; savedAt: string | null; message: string };
  cursor: { x: number; y: number; inside: boolean };
  panel: "inspect" | "traffic" | "lines" | "image";
  /** junction event log: record every junction, or just these node ids */
  eventLog: { all: boolean; nodes: string[] };
  /** segment tool: edit just the clicked segment or the whole road through its joints */
  segScope: "segment" | "road";
  /** scale calibration: pick two points on the reference image, then type their real distance */
  calib: { active: boolean; a: Vec | null; b: Vec | null };
  history: { canUndo: boolean; canRedo: boolean };
  /** opened with view-only access: edits are blocked and nothing is saved */
  readOnly: boolean;
}

export const ui = new DeepSubject<UiState>(
  {
    planId: "",
    tool: "select",
    selection: null,
    view: "2d",
    snap: { grid: true, step: 5, angle: true },
    draft: { lanesF: 1, lanesB: 1, busF: false, busB: false, speed: 50, curved: false },
    display: { bySpeed: false, reservations: true, labels: true, buildings: true, junctions: false },
    sim: { running: false, speed: 3, epoch: 0 },
    save: { status: "saved", revision: 1, savedAt: null, message: "" },
    cursor: { x: 0, y: 0, inside: false },
    panel: "inspect",
    segScope: "segment",
    eventLog: { all: false, nodes: [] },
    calib: { active: false, a: null, b: null },
    history: { canUndo: false, canRedo: false },
    readOnly: false,
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
  u.selection = sel ? { ...sel } : null;
}

function pruneSelection(net: Network) {
  const sel = ui.getValue().selection;
  if (!sel) return;
  const exists =
    sel.kind === "node" ? net.nodes.some(n => n.id === sel.id)
      : sel.kind === "link" ? net.links.some(l => l.id === sel.id)
        : sel.kind === "stop" ? net.stops.some(s => s.id === sel.id)
          : sel.kind === "line" ? net.lines.some(l => l.id === sel.id)
            : sel.kind === "building" ? (net.buildings ?? []).some(b => b.id === sel.id)
              : true;
  if (!exists) ui.getValue().selection = null;
}

export function setTool(tool: Tool) {
  const u = ui.getValue();
  if (u.tool !== tool) u.tool = tool;
}
