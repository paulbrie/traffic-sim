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
