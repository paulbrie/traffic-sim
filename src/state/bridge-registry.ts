/**
 * What a page offers the Claude bridge (docs/claude-bridge.md) beyond its UI: actions (`app` commands: select,
 * goTo, view, run…) and state (`state` commands: sketch, selection, stats…, and `hitTest` for annotations on
 * the map), registered by whatever is on the page (the plan editor) and taken away when it goes. The bridge
 * itself knows nothing about the editor.
 */
type Fn = (args: Record<string, unknown>) => unknown;

function registry() {
  const fns = new Map<string, Fn>();
  return {
    /** offer `name` (until the function returned is called) */
    register(name: string, fn: Fn) {
      fns.set(name, fn);
      return () => { if (fns.get(name) === fn) fns.delete(name); };
    },
    get: (name: string) => fns.get(name),
    names: () => [...fns.keys()],
  };
}

/** actions an agent can ask for (`app` commands) */
export const bridgeApp = registry();
/** state an agent can read (`state` commands), and what is at a point of the map (`hitTest`, for annotations) */
export const bridgeState = registry();

/** the canvas `screenshot` takes for `map` (the editor's), if a page has one */
let mapCanvas: (() => HTMLCanvasElement | null) | null = null;
export const setBridgeCanvas = (get: () => HTMLCanvasElement | null) => { mapCanvas = get; return () => { if (mapCanvas === get) mapCanvas = null; }; };
export const bridgeCanvas = () => mapCanvas?.() ?? null;
/** a point of the page (client px) as a point of the map (world metres), if over the map */
type ToWorld = (x: number, y: number) => { x: number; y: number } | null;
let toWorld: ToWorld | null = null;
export const setBridgeToWorld = (f: ToWorld) => { toWorld = f; return () => { if (toWorld === f) toWorld = null; }; };
export const bridgeToWorld = (x: number, y: number) => toWorld?.(x, y) ?? null;

/**
 * The page's UI state, if it keeps one the bridge can read (a V2 plan: src/state/sketch-ui.ts): a copy of it (`state`
 * "ui", or a path), and a path's changes (`state` with `watch`, sent to the agent as "ui" events).
 */
export interface BridgeUi { snapshot: () => Record<string, unknown>; subscribe: (path: string, fn: (v: unknown) => void) => () => void }
let ui: BridgeUi | null = null;
export const setBridgeUi = (u: BridgeUi) => { ui = u; return () => { if (ui === u) ui = null; }; };
export const bridgeUi = () => ui;

/**
 * An action's argument checked as it must be (true or false, a string, a number), else an error saying so: nothing
 * like "yes" taken for true, or 42 for "42". `undefined` answered when it isn't there and isn't required.
 */
export function argOf(a: Record<string, unknown>, key: string, type: "boolean", required?: boolean): boolean | undefined;
export function argOf(a: Record<string, unknown>, key: string, type: "string", required?: boolean): string | undefined;
export function argOf(a: Record<string, unknown>, key: string, type: "number", required?: boolean): number | undefined;
export function argOf(a: Record<string, unknown>, key: string, type: "boolean" | "string" | "number", required = false): unknown {
  const v = a[key];
  if (v === undefined || v === null) { if (required) throw new Error(`"${key}" is needed (${type === "boolean" ? "true or false" : `a ${type}`})`); return undefined; }
  if (typeof v !== type || (type === "number" && !Number.isFinite(v as number))) throw new Error(`"${key}" must be ${type === "boolean" ? "true or false" : `a ${type}`}, not ${JSON.stringify(v)}`);
  return v;
}
