"use client";

/**
 * The page's side of the Claude bridge (docs/claude-bridge.md): pairing, the stream of commands from the agent, running
 * them and answering, and what the user sends the agent. A small store the bridge's UI follows (useSyncExternalStore);
 * every command is in its log. Nothing runs until the user pairs the page.
 *
 * Two kinds of page: the hub (paired by the user with "Connect Claude"), which can let agents open tabs of their own and
 * opens them for them; and an agent's tab (opened by the hub with a ticket in its address), which pairs as that agent's,
 * shows whose it is, and can be taken over by the user.
 */
import { basePath } from "@/lib/base-path";
import { bridgeApp, bridgeCanvas, bridgeState, bridgeUi } from "@/state/bridge-registry";
import { describe, find, isBridgeUi, snapshot, type Target } from "@/components/bridge/a11y";

export interface BridgeLogEntry { at: number; type: string; target: string; ok: boolean; error?: string }
export interface BridgeAgent { id: string; name: string; color: string; hub: boolean }
export interface BridgeTab { pageId: string; ticket: string; agent: string; agentName: string; color: string; label: string; task: string; url: string; title: string; connected: boolean; paused: boolean; left: boolean }
/** a tab an agent asked for that the browser wouldn't open by itself (pop-ups blocked): the user opens it, or not */
export interface BridgeRequest { ticket: string; url: string; label: string; task: string; agent: string; color: string }
export interface BridgeView {
  /** the panel shown */
  open: boolean;
  phase: "off" | "pairing" | "waiting" | "attached" | "lost";
  /** a hub, or an agent's tab */
  mode: "hub" | "tab";
  code: string | null;
  agent: string | null;
  agentColor: string | null;
  log: BridgeLogEntry[];
  error: string | null;
  /** where the agent's cursor is (client px), and what it last did (shown a moment) */
  cursor: { x: number; y: number } | null;
  trace: { text: string; at: number } | null;
  // the hub's
  allowTabs: boolean; agents: BridgeAgent[]; tabs: BridgeTab[]; requests: BridgeRequest[];
  /** a code for another agent (Add agent), while it lasts */
  agentCode: string | null;
  // an agent's tab's
  tab: { agent: string; color: string; label: string; task: string; paused: boolean; left: boolean; closed: boolean } | null;
}
interface Pairing { pageId: string; pageToken: string; code?: string; mode: "hub" | "tab" }
interface Command { id: string; type: string; args?: Record<string, unknown> }

const KEY = "trafficsim:bridge";
let view: BridgeView = { open: false, phase: "off", mode: "hub", code: null, agent: null, agentColor: null, log: [], error: null, cursor: null, trace: null, allowTabs: false, agents: [], tabs: [], requests: [], agentCode: null, tab: null };
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
/** (the hub's) the windows it opened for agents, by the ticket they were opened with */
const windows = new Map<string, Window>();

const api = (path: string) => `${basePath}/api/bridge/page/${path}`;
// (every call of a paired page: its id in the body, its token in a header)
const post = (path: string, body: Record<string, unknown>) => fetch(api(path), {
  method: "POST", headers: { "Content-Type": "application/json", ...(pairing ? { "x-bridge-page": pairing.pageToken } : {}) }, body: JSON.stringify(pairing ? { pageId: pairing.pageId, ...body } : body),
});
const keep = () => { if (pairing) sessionStorage.setItem(KEY, JSON.stringify(pairing)); else sessionStorage.removeItem(KEY); };
const gone = (phase: BridgeView["phase"]) => { unwatch(); stream?.close(); stream = null; pairing = null; keep(); set({ phase, code: null, agent: null, cursor: null, agents: [], tabs: [], requests: [], agentCode: null }); };

// ---- the UI state the agent watches (a V2 plan's: see bridgeUi): its changes sent as "ui" events, at most 4 a second
// (the page's own list, gone when the pairing ends or another agent takes it over)
const UI_EVERY = 250;
let watching: { paths: string[]; offs: (() => void)[] } | null = null, changed: Record<string, unknown> = {}, sentAt = 0, flush: ReturnType<typeof setTimeout> | null = null;
const plainOf = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
/** what is at `path` ("editors.plan.selection", or with slashes) in a copy of the UI state (undefined: nothing) */
const at = (snap: unknown, path: string) => path.split(/[./]/).filter(Boolean).reduce<unknown>((o, k) => (o !== null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), snap);
const noPath = (path: string, snap: Record<string, unknown>) => new Error(`no "${path}" in the UI state: its top-level keys are ${Object.keys(snap).join(", ")}`);
function unwatch() {
  watching?.offs.forEach(f => f());
  watching = null; changed = {};
  if (flush) { clearTimeout(flush); flush = null; }
}
function watch(paths: string[]) {
  const u = bridgeUi();
  if (!u) throw new Error("this page keeps no UI state to watch (a V2 plan's editor does)");
  const snap = u.snapshot();
  for (const p of paths) if (at(snap, p) === undefined) throw noPath(p, snap);
  unwatch();
  const send = () => {
    flush = null; sentAt = Date.now();
    const c = changed; changed = {};
    if (pairing && Object.keys(c).length) void post("event", { kind: "ui", changed: c }).catch(() => {});
  };
  // (array items aren't watched by themselves: their list is)
  watching = { paths, offs: paths.map(p => u.subscribe(p.split(/[./]/).filter(k => k && !/^\d+$/.test(k)).join("/"), v => {
    changed[p] = plainOf(v);
    flush ??= setTimeout(send, Math.max(0, sentAt + UI_EVERY - Date.now()));
  })) };
}

/** pair the page as a hub: a code to give the agent, then the stream of its commands */
export async function bridgePair() {
  set({ phase: "pairing", error: null });
  try {
    const r = await fetch(api("pair"), { method: "POST" });
    if (!r.ok) throw new Error(r.status === 403 ? "Only admins can connect Claude." : `Pairing failed (${r.status})`);
    pairing = { ...(await r.json() as Omit<Pairing, "mode">), mode: "hub" };
    keep();
    set({ phase: "waiting", mode: "hub", code: pairing.code ?? null, agent: null, tab: null });
    listen();
  } catch (e) { set({ phase: "off", error: e instanceof Error ? e.message : String(e) }); }
}
/**
 * On loading a page: opened for an agent (a ticket in the address), it pairs as that agent's tab (the ticket taken out of
 * the address); else it carries on after a reload of the same tab, if it was paired. (A tab opened by the hub starts with a
 * copy of the hub's session storage: the ticket wins.)
 */
export async function bridgeResume() {
  if (pairing || typeof sessionStorage === "undefined") return;
  const ticket = /[#&]bridge-ticket=([\w-]+)/.exec(location.hash)?.[1];
  if (ticket) {
    const h = location.hash.replace(/[#&]?bridge-ticket=[\w-]+/, "");
    history.replaceState(history.state, "", location.pathname + location.search + (h && h !== "#" ? h : ""));
    sessionStorage.removeItem(KEY);
    try {
      const r = await fetch(api("pair"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }) });
      if (!r.ok) throw new Error(r.status === 404 ? "This tab's ticket was used or expired." : `Pairing failed (${r.status})`);
      const t = await r.json() as { pageId: string; pageToken: string; agent: string; color: string; label: string; task: string };
      pairing = { pageId: t.pageId, pageToken: t.pageToken, mode: "tab" };
      keep();
      set({ mode: "tab", phase: "attached", agent: t.agent, agentColor: t.color, tab: { agent: t.agent, color: t.color, label: t.label, task: t.task, paused: false, left: false, closed: false } });
      listen();
    } catch (e) { set({ mode: "tab", phase: "off", error: e instanceof Error ? e.message : String(e) }); }
    return;
  }
  const raw = sessionStorage.getItem(KEY);
  if (!raw) return;
  try {
    pairing = JSON.parse(raw) as Pairing;
    pairing.mode ??= "hub";
    set({ mode: pairing.mode, phase: pairing.mode === "tab" ? "attached" : "waiting", code: pairing.code ?? null });
    listen();
  } catch { sessionStorage.removeItem(KEY); }
}
/** the pairing ended by the user: a hub's agents and tabs with it; a tab's (the tab closes itself if it can) */
export async function bridgeDisconnect() {
  const was = pairing;
  stream?.close(); stream = null;
  if (was) await post("close", {}).catch(() => {});
  const tab = was?.mode === "tab";
  gone("off");
  if (tab) { set({ tab: view.tab ? { ...view.tab, closed: true } : null }); window.close(); }
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

// ---- the hub's: agents and their tabs
const openFor = (q: BridgeRequest) => window.open(`${basePath}${q.url}#bridge-ticket=${q.ticket}`, "_blank");
export async function bridgeAllowTabs(on: boolean) { set({ allowTabs: on }); await post("allow-tabs", { on }); }
/** a code for another agent to attach (tabs only) */
export async function bridgeAddAgent() {
  const r = await post("agent-code", {});
  if (!r.ok) throw new Error(`No code (${r.status})`);
  const c = await r.json() as { code: string };
  set({ agentCode: c.code });
}
export const bridgeRevoke = (agentId: string) => post("revoke", { agentId });
export const bridgePauseTab = (tabId: string, paused: boolean) => post("pause", { tabId, paused });
export async function bridgeCloseTab(tab: BridgeTab) { await post("close-tab", { tabId: tab.pageId }); windows.get(tab.ticket)?.close(); windows.delete(tab.ticket); }
/** the tab's window brought forward (where the browser lets a page do that) */
export function bridgeFocusTab(tab: BridgeTab) { const w = windows.get(tab.ticket); if (w && !w.closed) { w.focus(); return true; } return false; }
/** a tab the browser wouldn't open by itself, opened by the user's click (or denied) */
export function bridgeOpenRequest(q: BridgeRequest) {
  const w = openFor(q);
  if (w) windows.set(q.ticket, w);
  set({ requests: view.requests.filter(x => x.ticket !== q.ticket) });
  return !!w;
}
export async function bridgeDenyRequest(q: BridgeRequest) { set({ requests: view.requests.filter(x => x.ticket !== q.ticket) }); await post("deny-tab", { ticket: q.ticket }); }

// ---- an agent's tab's: the user takes over (the agent's commands refused) or gives it back
export async function bridgeTakeOver(paused: boolean) { set({ tab: view.tab ? { ...view.tab, paused } : null }); await post("pause", { paused }); }

function listen() {
  if (!pairing) return;
  stream?.close();
  stream = new EventSource(`${api("stream")}?pageId=${encodeURIComponent(pairing.pageId)}&t=${encodeURIComponent(pairing.pageToken)}`);
  stream.onopen = () => { failures = 0; bridgeHello(); };
  const on = <T,>(name: string, f: (d: T) => void) => stream!.addEventListener(name, e => f(JSON.parse((e as MessageEvent).data) as T));
  on<{ name: string; color?: string } | null>("agent", a => { if (pairing?.mode === "hub") { if ((a?.name ?? null) !== view.agent) unwatch(); set({ agent: a?.name ?? null, agentColor: a?.color ?? null, phase: a ? "attached" : "waiting" }); } });
  on<{ allowTabs: boolean; agents: BridgeAgent[]; tabs: BridgeTab[] }>("hub", h => set({ allowTabs: h.allowTabs, agents: h.agents, tabs: h.tabs }));
  on<NonNullable<BridgeView["tab"]>>("tab", t => { if (t.left || t.agent !== view.agent) unwatch(); set({ tab: { ...t, closed: false }, agent: t.agent, agentColor: t.color, phase: t.left ? "lost" : "attached" }); });
  // (an agent asks for a tab: opened at once if the browser lets it, else the user is asked)
  on<BridgeRequest>("openTab", q => {
    if (windows.has(q.ticket) || view.requests.some(x => x.ticket === q.ticket)) return;
    const w = openFor(q);
    if (w) windows.set(q.ticket, w); else set({ requests: [...view.requests, q], open: true });
  });
  on<Command>("command", c => { void run(c); });
  // (the pairing ended on the server: by the user, the agent, or idle too long; a tab closes itself if it can)
  on("closed", () => { const tab = pairing?.mode === "tab"; gone("off"); if (tab) { set({ tab: view.tab ? { ...view.tab, closed: true } : null }); window.close(); } });
  // (gone for good, the pairing with it, after a few tries: the server restarted, or the pairing ended)
  stream.onerror = () => { if (++failures >= 4) gone("lost"); };
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
      const u = bridgeUi();
      // (the UI state's paths watched, their changes sent as "ui" events; [] stops)
      if (Array.isArray(a.watch)) { const ps = a.watch.map(String).filter(Boolean); if (ps.length) watch(ps); else unwatch(); return { watching: watching?.paths ?? [] }; }
      // (a part of the UI state)
      if (typeof a.path === "string") {
        if (!u) throw new Error("this page keeps no UI state (a V2 plan's editor does)");
        const snap = u.snapshot(), v = at(snap, a.path);
        if (v === undefined) throw noPath(a.path, snap);
        return { [a.path]: v };
      }
      const keys = Array.isArray(a.keys) && a.keys.length ? a.keys.map(String) : [...bridgeState.names().filter(k => k !== "hitTest" && k !== "sketchJson"), ...(u ? ["ui"] : [])];
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (k === "ui" && u) { out.ui = u.snapshot(); continue; }
        const f = bridgeState.get(k); out[k] = f ? await f({}) : { error: "not offered on this page" };
      }
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
