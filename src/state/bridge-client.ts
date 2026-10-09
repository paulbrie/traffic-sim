"use client";

/**
 * The page's side of the Claude bridge (docs/claude-bridge.md): pairing, the stream of commands from the agent, running
 * them and answering, and what the user sends the agent. A small store the bridge's UI follows (useSyncExternalStore);
 * every command is in its log. Nothing runs until the user pairs the page.
 */
import { basePath } from "@/lib/base-path";
import { bridgeApp, bridgeCanvas, bridgeState } from "@/state/bridge-registry";
import { describe, find, isBridgeUi, snapshot, type Target } from "@/components/bridge/a11y";

export interface BridgeLogEntry { at: number; type: string; target: string; ok: boolean; error?: string }
export interface BridgeView {
  /** the panel shown */
  open: boolean;
  phase: "off" | "pairing" | "waiting" | "attached" | "lost";
  code: string | null;
  agent: string | null;
  log: BridgeLogEntry[];
  error: string | null;
  /** where the agent's cursor is (client px), and what it last did (shown a moment) */
  cursor: { x: number; y: number } | null;
  trace: { text: string; at: number } | null;
}
interface Pairing { pageId: string; pageToken: string; code: string }
interface Command { id: string; type: string; args?: Record<string, unknown> }

const KEY = "trafficsim:bridge";
let view: BridgeView = { open: false, phase: "off", code: null, agent: null, log: [], error: null, cursor: null, trace: null };
const listeners = new Set<() => void>();
const set = (patch: Partial<BridgeView>) => { view = { ...view, ...patch }; for (const f of listeners) f(); };
export const bridgeStore = {
  subscribe: (f: () => void) => { listeners.add(f); return () => listeners.delete(f); },
  get: () => view,
  /** the panel opened or closed (pairing stays as it is) */
  show: (open: boolean) => set({ open }),
};

let pairing: Pairing | null = null, stream: EventSource | null = null, failures = 0;
/** how to go to a page of the app (the provider's router) */
let navigateTo: ((path: string) => void) | null = null;
export const setBridgeNavigate = (f: (path: string) => void) => { navigateTo = f; };

const api = (path: string) => `${basePath}/api/bridge/page/${path}`;
// (every call of a paired page: its id in the body, its token in a header)
const post = (path: string, body: Record<string, unknown>) => fetch(api(path), {
  method: "POST", headers: { "Content-Type": "application/json", ...(pairing ? { "x-bridge-page": pairing.pageToken } : {}) }, body: JSON.stringify(pairing ? { pageId: pairing.pageId, ...body } : body),
});

/** pair the page: a code to give the agent, then the stream of its commands */
export async function bridgePair() {
  set({ phase: "pairing", error: null });
  try {
    const r = await fetch(api("pair"), { method: "POST" });
    if (!r.ok) throw new Error(r.status === 403 ? "Only admins can connect Claude." : `Pairing failed (${r.status})`);
    pairing = await r.json() as Pairing;
    sessionStorage.setItem(KEY, JSON.stringify(pairing));
    set({ phase: "waiting", code: pairing.code, agent: null });
    listen();
  } catch (e) { set({ phase: "off", error: e instanceof Error ? e.message : String(e) }); }
}
/** carried on after a reload of the page (the same tab), if it was paired */
export function bridgeResume() {
  if (pairing || typeof sessionStorage === "undefined") return;
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return;
  try { pairing = JSON.parse(raw) as Pairing; set({ phase: "waiting", code: pairing.code }); listen(); } catch { sessionStorage.removeItem(KEY); }
}
/** the agent let go and the pairing ended */
export async function bridgeDisconnect() {
  const was = pairing;
  stream?.close(); stream = null;
  if (was) await post("close", {}).catch(() => {});
  pairing = null; sessionStorage.removeItem(KEY);
  set({ phase: "off", code: null, agent: null, cursor: null });
}
/** where the page is now (on connecting, and on every navigation) */
export function bridgeHello() {
  if (pairing) void post("hello", { url: location.href, title: document.title }).catch(() => {});
}
/** the user to the agent: an annotation or a message */
export async function bridgeSend(event: Record<string, unknown>) {
  if (!pairing) throw new Error("Not connected");
  const r = await post("event", event);
  if (!r.ok) throw new Error(`Not sent (${r.status})`);
}

function listen() {
  if (!pairing) return;
  stream?.close();
  stream = new EventSource(`${api("stream")}?pageId=${encodeURIComponent(pairing.pageId)}&t=${encodeURIComponent(pairing.pageToken)}`);
  stream.onopen = () => { failures = 0; bridgeHello(); };
  stream.addEventListener("agent", e => {
    const a = JSON.parse((e as MessageEvent).data) as { name: string } | null;
    set({ agent: a?.name ?? null, phase: a ? "attached" : "waiting" });
  });
  stream.addEventListener("command", e => { void run(JSON.parse((e as MessageEvent).data) as Command); });
  // (the pairing ended on the server: by the page, or idle too long)
  stream.addEventListener("closed", () => { stream?.close(); stream = null; pairing = null; sessionStorage.removeItem(KEY); set({ phase: "off", code: null, agent: null, cursor: null }); });
  // (gone for good, the pairing with it, after a few tries: the server restarted, or the pairing ended)
  stream.onerror = () => { if (++failures >= 4) { stream?.close(); stream = null; pairing = null; sessionStorage.removeItem(KEY); set({ phase: "lost", agent: null, cursor: null }); } };
}

const logged = (e: BridgeLogEntry) => set({ log: [...view.log.slice(-199), e] });
const trace = (text: string) => set({ trace: { text, at: Date.now() } });
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
/** the agent's cursor to the middle of `el`, a moment before it acts there (the user sees where) */
async function pointAt(el: Element) {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const b = el.getBoundingClientRect();
  set({ cursor: { x: b.left + b.width / 2, y: b.top + b.height / 2 } });
  await wait(320);
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}
const targetOf = (a: Record<string, unknown>): Target => ({ role: a.role as string | undefined, name: a.name as string | undefined, exact: !!a.exact, nth: a.nth as number | undefined, selector: a.selector as string | undefined, text: a.text as string | undefined });
const targetText = (a: Record<string, unknown>) => a.role ? `${a.role}${a.name ? ` "${a.name}"` : ""}` : a.selector ? String(a.selector) : a.text ? `text "${a.text}"` : "";

async function run(c: Command) {
  const args = c.args ?? {};
  let target = c.type === "app" ? String(args.action ?? "") : c.type === "state" ? (Array.isArray(args.keys) ? args.keys.join(", ") : "all") : c.type === "navigate" ? String(args.url ?? "") : c.type === "key" ? String(args.key ?? "") : targetText(args);
  try {
    const data = await exec(c.type, args, t => { target = t; });
    await post("result", { id: c.id, ok: true, data });
    logged({ at: Date.now(), type: c.type, target, ok: true });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await post("result", { id: c.id, ok: false, error }).catch(() => {});
    logged({ at: Date.now(), type: c.type, target, ok: false, error });
  }
}

async function exec(type: string, a: Record<string, unknown>, said: (t: string) => void): Promise<unknown> {
  switch (type) {
    case "snapshot": {
      const root = a.root ? document.querySelector(String(a.root)) : document.body;
      if (!root) throw new Error(`nothing matches ${a.root}`);
      return { url: location.href, title: document.title, tree: snapshot(root) };
    }
    case "screenshot": {
      const c = bridgeCanvas();
      if (!c) throw new Error("this page has no map to take (a picture of the whole page isn't available yet)");
      const max = Number(a.maxWidth) || 1400, k = Math.min(1, max / c.width);
      const out = document.createElement("canvas");
      out.width = Math.round(c.width * k); out.height = Math.round(c.height * k);
      out.getContext("2d")!.drawImage(c, 0, 0, out.width, out.height);
      let dataUrl: string;
      // (imagery from elsewhere without leave to be read back leaves the map's picture unreadable)
      try { dataUrl = out.toDataURL("image/png"); } catch { throw new Error("the map's picture can't be read back (the background imagery doesn't allow it): turn the imagery off and ask again"); }
      trace("took a picture of the map");
      return { dataUrl, ...(a.target === "page" ? { note: "the map only: a picture of the whole page isn't available yet" } : {}) };
    }
    case "state": {
      const keys = Array.isArray(a.keys) && a.keys.length ? a.keys.map(String) : bridgeState.names().filter(k => k !== "hitTest" && k !== "sketchJson");
      const out: Record<string, unknown> = {};
      for (const k of keys) { const f = bridgeState.get(k); out[k] = f ? await f({}) : { error: "not offered on this page" }; }
      return out;
    }
    case "click": {
      const el = find(targetOf(a));
      said(describe(el));
      const { x, y } = await pointAt(el);
      const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true, view: window };
      // (as a mouse would: menus open on the press, buttons act on the click)
      el.dispatchEvent(new PointerEvent("pointerdown", o)); el.dispatchEvent(new MouseEvent("mousedown", o));
      if (el instanceof HTMLElement) el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent("pointerup", { ...o, buttons: 0 })); el.dispatchEvent(new MouseEvent("mouseup", { ...o, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("click", { ...o, buttons: 0 }));
      trace(`clicked ${describe(el)}`);
      return { clicked: describe(el) };
    }
    case "type": {
      // (the field named, or the one with the focus; `text` is what to type, not where)
      const el = a.role || a.selector ? find({ ...targetOf(a), text: undefined }) : document.activeElement;
      if (!el || isBridgeUi(el)) throw new Error("say which field (role and name, or selector), or click in it first");
      if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error(`${describe(el)} isn't a field to type in`);
      if (el instanceof HTMLInputElement && el.type === "password") throw new Error("the agent doesn't type in password fields");
      said(describe(el));
      await pointAt(el);
      el.focus();
      const text = String(a.text ?? ""), proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      // (the native setter, so React sees the change)
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (a.submit) { press(el, "Enter"); el.form?.requestSubmit(); }
      trace(`typed in ${describe(el)}`);
      return { typed: text };
    }
    case "key": {
      const at = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      if (isBridgeUi(at)) throw new Error("the bridge's own panel has the focus: click somewhere in the app first");
      await pointAt(at === document.body ? document.querySelector("main") ?? document.body : at);
      press(at, String(a.key ?? ""));
      trace(`pressed ${a.key}`);
      return {};
    }
    case "navigate": {
      const u = new URL(String(a.url ?? ""), location.href);
      if (u.origin !== location.origin) throw new Error("only pages of this app");
      const path = u.pathname.startsWith(basePath) ? u.pathname.slice(basePath.length) || "/" : u.pathname;
      if (path === "/api" || path.startsWith("/api/")) throw new Error("only pages of this app, not its API");
      if (!navigateTo) throw new Error("the page isn't ready to navigate yet");
      navigateTo(path + u.search + u.hash);
      trace(`went to ${path}`);
      return { url: u.href };
    }
    case "app": {
      const f = bridgeApp.get(String(a.action ?? ""));
      if (!f) throw new Error(`"${a.action}" isn't offered here (offered: ${bridgeApp.names().join(", ") || "nothing"})`);
      const r = await f((a.args ?? {}) as Record<string, unknown>);
      trace(`${a.action}${a.args ? ` ${JSON.stringify(a.args)}` : ""}`);
      return r ?? {};
    }
    default: throw new Error(`unknown command "${type}"`);
  }
}

/** a key pressed on `el`, as "Control+Shift+k" */
function press(el: Element, combo: string) {
  const parts = combo.split("+"), key = parts.pop() ?? "", mods = new Set(parts.map(p => p.toLowerCase()));
  const o = {
    key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true,
    ctrlKey: mods.has("control") || mods.has("ctrl"), metaKey: mods.has("meta") || mods.has("cmd"), shiftKey: mods.has("shift"), altKey: mods.has("alt"),
  };
  el.dispatchEvent(new KeyboardEvent("keydown", o));
  el.dispatchEvent(new KeyboardEvent("keyup", o));
}
