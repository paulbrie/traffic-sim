"use client";

/**
 * The V2 editor's UI state in one place (as V1's `ui` in store.ts): what each editor on the page shows and does
 * (the plan's, and the Sketch window's over it): its tool, what is selected, the view, the cars running, the replay.
 * Components read it with `useEditorState` (or `useDeepSubject`) and change it through it; the plan itself stays in
 * the SketchStore, changed through its undo history. The Claude bridge reads it (docs/claude-bridge.md: `state` "ui",
 * a path, or watching paths), so an agent sees what the user sees without anything registered by hand.
 *
 * Kept small and cold: no plan data, no results, nothing private, nothing each frame (the view and the cars' clock
 * are copied in at most four times a second).
 */
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { DeepSubject } from "subjecto";
import type { Piece } from "@/lib/lane-sketch";
import { bridgeApp, setBridgeUi } from "@/state/bridge-registry";
import { ui } from "@/state/store";
import { SKETCH_LAYERS, setSketchLayers, sketchLayers$, type SketchLayers } from "@/state/sketch-layers";
import { loadSatOptions, saveSatOptions, type SatOptions } from "@/state/sat-options";

/** the drawing tools */
export type Tool = "select" | "lane" | "arc" | "circle" | "roundabout" | "connector" | "junction" | "slice" | "crossing";
/** what is selected: lanes, connectors and junctions (a road: its lanes, with its id), or a link, or a zebra crossing */
export type Sel = Piece & { road: string | null; link?: string | null; /** a zebra crossing, selected on its own */ crossing?: string | null };
export const NO_SEL: Sel = { lanes: [], connectors: [], junctions: [], road: null };

/** an editor's state: the plan's (`plan`; a V1 plan's sketch window: `whole`) or the Sketch window's (`scratch`) */
export interface EditorUi {
  tool: Tool;
  selection: Sel;
  /** a line lane's point picked (to curve or delete) */
  point: { lane: string; i: number } | null;
  /** the car picked (its number), and the view kept on it */
  car: number | null;
  follow: boolean;
  /** where the view is: its middle (metres) and zoom (px a metre), copied in at most 4 times a second */
  view: { cx: number; cy: number; scale: number };
  run: {
    running: boolean;
    /** the simulation speed (1, 3, 10, 30) */
    speed: number;
    /** the cars' clock (s), copied in at most 4 times a second */
    t: number;
    /** the moment replayed (null: live), playing it back or not, and the span kept */
    replayT: number | null;
    playing: boolean;
    kept: { from: number; to: number; frames: number; bytes: number } | null;
  };
  /** its dialogs and what is open under the map */
  dialogs: {
    /** the search (Cmd/Ctrl+K): open, and what is typed */
    search: { open: boolean; query: string };
    /** the problem console under the map: open, which kind shown ("all", "stuck", "collision"…), the text filter, cleared up to (s; -1: none) */
    console: { open: boolean; kind: string; text: string; clearedAt: number };
    /** the simulation settings open */
    settings: boolean;
    /** Optimise timings: open (from that junction's lights), the lights chosen, the effort, where it is */
    optimizer: { open: boolean; junction: string | null; chosen: string[]; effort: string; stage: "setup" | "running" | "done" | "error" };
  };
  /** the results tables: sorted by which column (or "name"), the other way or not, how many rows shown */
  tables: { junctions: TableUi; roads: TableUi };
}
export interface TableUi { by: string; flip: boolean; shown: number }
export type EditorKind = "plan" | "scratch" | "whole";
/** Test in Sketch's options (kept in the browser): how far out roads are cut, replacing what is in the Sketch or adding beside it, running at once */
export interface TestOptions { cut: number; mode: "replace" | "add"; run: boolean }
export interface SketchUiState {
  /** the editor the user is at: the Sketch window's while it is open and was last used, else the plan's */
  active: "plan" | "scratch";
  editors: Record<EditorKind, EditorUi>;
  /** the inspector's panels folded away (by id; kept in the browser, the same for both editors) */
  panels: { closed: Record<string, true> };
  /** the Sketch window over the plan: open; Test in Sketch's options and the last piece it took there */
  sketchWindow: { open: boolean; test: TestOptions; lastPiece: { junctions: number; lanes: number; mode: "replace" | "add"; at: number } | null };
  /** the layers shown (the editor's and the top bar's: sketch-layers.ts, kept in the browser; shown here as they are) */
  layers: SketchLayers;
  /** how the satellite imagery is shown (kept in the browser) */
  background: SatOptions;
}

const editor = (tool: Tool): EditorUi => ({
  tool, selection: NO_SEL, point: null, car: null, follow: false, view: { cx: 0, cy: 0, scale: 6 },
  run: { running: false, speed: 1, t: 0, replayT: null, playing: false, kept: null },
  dialogs: { search: { open: false, query: "" }, console: { open: false, kind: "all", text: "", clearedAt: -1 }, settings: false, optimizer: { open: false, junction: null, chosen: [], effort: "quick", stage: "setup" } },
  tables: { junctions: { by: "delay", flip: false, shown: 12 }, roads: { by: "delay", flip: false, shown: 12 } },
});
export const freshEditor = (): EditorUi => editor("lane");

// (kept in the browser: the panels folded away, Test in Sketch's options)
const PANELS_KEY = "trafficsim:v2-closed-panels", TEST_KEY = "laneSketch:testInSketch";
const stored = <T,>(key: string, fallback: T): T => {
  if (typeof localStorage === "undefined") return fallback;
  try { const v = localStorage.getItem(key); return v ? { ...fallback, ...(JSON.parse(v) as T) } : fallback; } catch { return fallback; }
};
const store = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode: this session only */ } };

export const sketchUi = new DeepSubject<SketchUiState>({
  active: "plan",
  editors: { plan: freshEditor(), scratch: freshEditor(), whole: freshEditor() },
  panels: { closed: stored<Record<string, true>>(PANELS_KEY, {}) },
  sketchWindow: { open: false, test: stored<TestOptions>(TEST_KEY, { cut: 70, mode: "replace", run: true }), lastPiece: null },
  layers: sketchLayers$.getValue(),
  background: typeof localStorage === "undefined" ? { brightness: 0.85, source: "esri" } : loadSatOptions(),
}, { name: "sketchUi" });
sketchUi.subscribe("background", v => saveSatOptions(JSON.parse(JSON.stringify(v)) as SatOptions), { skipInitialCall: true });
// (the layers: sketch-layers.ts's, as they change)
sketchLayers$.subscribe(l => { sketchUi.getValue().layers = { ...l }; });
sketchUi.subscribe("panels/closed", v => store(PANELS_KEY, v), { skipInitialCall: true });
sketchUi.subscribe("sketchWindow/test", v => store(TEST_KEY, v), { skipInitialCall: true });
// (the Sketch window opens and closes through V1's ui, as before: shown here too)
ui.subscribe("sketch", v => { const w = sketchUi.getValue().sketchWindow; if (w.open !== !!v) w.open = !!v; });

/** the editor a component is in (the plan's, or the Sketch window's): its dialogs are that one's */
export const EditorKindContext = createContext<EditorKind>("plan");
export const useEditorKind = () => useContext(EditorKindContext);

type Fields = Omit<EditorUi, "run">;
/**
 * A field of an editor's state, as useState gives one: its value and a setter (taking a value or a function of the
 * last). `run/…` for the cars' fields.
 */
export function useEditorState<K extends keyof Fields>(kind: EditorKind, key: K): [Fields[K], (v: Fields[K] | ((p: Fields[K]) => Fields[K])) => void];
export function useEditorState<K extends keyof EditorUi["run"]>(kind: EditorKind, key: `run/${K}`): [EditorUi["run"][K], (v: EditorUi["run"][K] | ((p: EditorUi["run"][K]) => EditorUi["run"][K])) => void];
export function useEditorState(kind: EditorKind, key: string): [unknown, (v: unknown) => void] {
  return useUiPath(`editors/${kind}/${key}`);
}
/** any part of the store, as useState gives one (a plain copy, and a setter taking a value or a function of the last) */
export function useUiPath<T>(path: string): [T, (v: T | ((p: T) => T)) => void];
export function useUiPath(path: string): [unknown, (v: unknown) => void] {
  // (followed by its text: a part changed in place keeps its proxy, which React would take for no change; and a plain
  // copy, made again only when that text changed: the drawing reads the selection's lists thousands of times a frame,
  // a proxy's every read would cost)
  const subscribe = useCallback((f: () => void) => { const h = sketchUi.subscribe(path, f, { skipInitialCall: true }); return () => h.unsubscribe(); }, [path]);
  const read = useCallback(() => { const v = at(path); return v !== null && typeof v === "object" ? OBJ + JSON.stringify(v) : v; }, [path]);
  const snap = useSyncExternalStore(subscribe, read, read);
  const value = useMemo(() => (typeof snap === "string" && snap.startsWith(OBJ) ? JSON.parse(snap.slice(OBJ.length)) : snap), [snap]);
  const set = useCallback((v: unknown) => {
    const parts = path.split("/"), last = parts.pop()!;
    let o = sketchUi.getValue() as unknown as Record<string, unknown>;
    for (const p of parts) o = o[p] as Record<string, unknown>;
    const next = typeof v === "function" ? (v as (p: unknown) => unknown)(o[last]) : v;
    if (next !== o[last]) o[last] = next;
  }, [path]);
  return [value, set];
}
/** (marks an object's text in a snapshot: no string kept in the store starts so) */
const OBJ = "\u0000obj:";
/** what is at a path of the store now (slashes) */
const at = (path: string): unknown => path.split("/").reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), sketchUi.getValue());
/** an editor's state now (outside React: handlers, frames) */
export const editorUi = (kind: EditorKind) => sketchUi.getValue().editors[kind];
/** an editor's state back to how a new one starts (it went: the Sketch window closed, the page left) */
export function resetEditor(kind: EditorKind) { sketchUi.getValue().editors[kind] = freshEditor(); }

// ---------------------------------------------------------------- what the bridge sees

/** the state as plain data (a copy), long lists cut to their first 200 with how many there were */
export function sketchUiSnapshot(): Record<string, unknown> {
  const all = JSON.parse(JSON.stringify(sketchUi.getValue(), (_k, v: unknown) => (Array.isArray(v) && v.length > 200 ? { first: v.slice(0, 200), count: v.length } : v))) as SketchUiState;
  // (a V2 page's editors: the plan's and the Sketch window's; `whole` is a V1 plan's sketch window)
  const { whole: _, ...editors } = all.editors;
  return { ...all, editors };
}
/** the problem console's kinds of line */
const CONSOLE_KINDS = ["all", "stuck", "collision", "jump", "deadlock", "breakdown", "towed"];
/** the editor an action is for: `editor` if given, else the one the user is at */
const editorFor = (a: Record<string, unknown>): EditorUi => {
  const k = a.editor === undefined ? sketchUi.getValue().active : String(a.editor);
  if (k !== "plan" && k !== "scratch") throw new Error(`no editor "${k}": plan or scratch`);
  if (k === "scratch" && !sketchUi.getValue().sketchWindow.open) throw new Error("the Sketch window isn't open");
  return sketchUi.getValue().editors[k];
};
/** offered to the bridge while a V2 plan is open (the plan's editor): the state to read, and a few changes to it an agent may ask for (no others) */
export function offerSketchUiToBridge() {
  const offs = [
    setBridgeUi({
      snapshot: sketchUiSnapshot,
      subscribe: (path, fn) => { const h = sketchUi.subscribe(path, v => fn(v), { skipInitialCall: true }); return () => h.unsubscribe(); },
    }),
    // a panel of the inspector folded away or opened: { id, open }
    bridgeApp.register("panel", a => {
      const id = String(a.id ?? ""), open = a.open !== false;
      if (!id) throw new Error("which panel? { id, open }");
      const p = sketchUi.getValue().panels, next = { ...p.closed };
      if (open) delete next[id]; else next[id] = true;
      p.closed = next;
      return { id, open };
    }),
    // the problem console: { open?, kind?, text?, editor? }
    bridgeApp.register("console", a => {
      const d = editorFor(a).dialogs.console;
      if (a.kind !== undefined) { const k = String(a.kind); if (!CONSOLE_KINDS.includes(k)) throw new Error(`kind: one of ${CONSOLE_KINDS.join(", ")}`); d.kind = k; }
      if (a.text !== undefined) d.text = String(a.text);
      if (a.open !== undefined) d.open = !!a.open;
      return { ...d };
    }),
    // layers shown or not: { set: { id: boolean } } (ids as in `layers`)
    bridgeApp.register("layers", a => {
      const set = a.set as Record<string, unknown> | undefined, ids = SKETCH_LAYERS.map(l => l.id) as string[];
      if (!set || typeof set !== "object") throw new Error(`which? { set: { id: true|false } }, ids: ${ids.join(", ")}`);
      const bad = Object.keys(set).filter(k => !ids.includes(k));
      if (bad.length) throw new Error(`no layer ${bad.join(", ")}: ${ids.join(", ")}`);
      const next = { ...sketchLayers$.getValue(), ...Object.fromEntries(Object.entries(set).map(([k, v]) => [k, !!v])) } as SketchLayers;
      setSketchLayers(next);
      return next;
    }),
    // a results table sorted: { table: "junctions" | "roads", by, flip?, editor? }
    bridgeApp.register("sort", a => {
      const table = String(a.table), by = String(a.by);
      const cols: Record<string, string[]> = { junctions: ["name", "rate", "delay", "queue", "fuel"], roads: ["name", "rate", "speed", "delay", "queue"] };
      if (!cols[table]) throw new Error("table: junctions or roads");
      if (!cols[table].includes(by)) throw new Error(`by: one of ${cols[table].join(", ")}`);
      const t = editorFor(a).tables[table as "junctions" | "roads"];
      t.by = by; t.flip = !!a.flip;
      return { ...t };
    }),
    // the Sketch window over the plan opened or closed: { open }, as the top bar's Sketch button does
    bridgeApp.register("sketchWindow", a => {
      const open = a.open === undefined ? !ui.getValue().sketch : !!a.open;
      ui.getValue().sketch = open;
      return { open };
    }),
    // the search box (Cmd/Ctrl+K): { open, query?, editor? }
    bridgeApp.register("search", a => {
      const d = editorFor(a).dialogs.search;
      if (a.query !== undefined) d.query = String(a.query);
      if (a.open !== undefined) d.open = !!a.open;
      return { ...d };
    }),
  ];
  return () => { for (const off of offs) off(); };
}
