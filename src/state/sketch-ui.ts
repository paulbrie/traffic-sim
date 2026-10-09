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
import { useCallback, useMemo } from "react";
import { DeepSubject } from "subjecto";
import { useDeepSubject } from "subjecto/react";
import type { Piece } from "@/lib/lane-sketch";
import { setBridgeUi } from "@/state/bridge-registry";

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
}
export type EditorKind = "plan" | "scratch" | "whole";
export interface SketchUiState {
  /** the editor the user is at: the Sketch window's while it is open and was last used, else the plan's */
  active: "plan" | "scratch";
  editors: Record<EditorKind, EditorUi>;
}

const editor = (tool: Tool): EditorUi => ({
  tool, selection: NO_SEL, point: null, car: null, follow: false, view: { cx: 0, cy: 0, scale: 6 },
  run: { running: false, speed: 1, t: 0, replayT: null, playing: false, kept: null },
});
export const freshEditor = (): EditorUi => editor("lane");

export const sketchUi = new DeepSubject<SketchUiState>({ active: "plan", editors: { plan: freshEditor(), scratch: freshEditor(), whole: freshEditor() } }, { name: "sketchUi" });

type Fields = Omit<EditorUi, "run">;
/**
 * A field of an editor's state, as useState gives one: its value and a setter (taking a value or a function of the
 * last). `run/…` for the cars' fields.
 */
export function useEditorState<K extends keyof Fields>(kind: EditorKind, key: K): [Fields[K], (v: Fields[K] | ((p: Fields[K]) => Fields[K])) => void];
export function useEditorState<K extends keyof EditorUi["run"]>(kind: EditorKind, key: `run/${K}`): [EditorUi["run"][K], (v: EditorUi["run"][K] | ((p: EditorUi["run"][K]) => EditorUi["run"][K])) => void];
export function useEditorState(kind: EditorKind, key: string): [unknown, (v: unknown) => void] {
  const path = `editors/${kind}/${key}`;
  const [proxied] = useDeepSubject(sketchUi, path as never) as [unknown, unknown];
  // (a plain copy, made again only when it changed: the drawing reads the selection's lists thousands of times a frame,
  // a proxy's every read would cost)
  const value = useMemo(() => plain(proxied), [proxied]);
  const set = useCallback((v: unknown) => {
    const parts = path.split("/"), last = parts.pop()!;
    let o = sketchUi.getValue() as unknown as Record<string, unknown>;
    for (const p of parts) o = o[p] as Record<string, unknown>;
    const next = typeof v === "function" ? (v as (p: unknown) => unknown)(o[last]) : v;
    if (next !== o[last]) o[last] = next;
  }, [path]);
  return [value, set];
}
const plain = (v: unknown): unknown => (v !== null && typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v);
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
/** offered to the bridge while a V2 plan is open (see WorkspaceV2) */
export function offerSketchUiToBridge() {
  return setBridgeUi({
    snapshot: sketchUiSnapshot,
    subscribe: (path, fn) => { const h = sketchUi.subscribe(path, v => fn(v), { skipInitialCall: true }); return () => h.unsubscribe(); },
  });
}
