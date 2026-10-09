import "server-only";
import { randomBytes, randomInt, timingSafeEqual } from "crypto";

/**
 * The Claude bridge's server side (see docs/claude-bridge.md). A hub (the page an admin paired with "Connect Claude")
 * has agents attached to it, each with its own token: the one paired with the hub's code drives the hub; others, added
 * from the hub's panel ("Add agent"), work in tabs of their own (agent tabs), opened in the user's browser through the
 * hub with a single-use ticket. Each page (the hub, or a tab) has its own stream of commands; an agent only ever reaches
 * its own pages. The events the user sends from a page (annotations, messages) go to the agents working there. In memory,
 * in this server process: a restart drops them (the pages reconnect, the agents pair again).
 */

export interface Command { id: string; type: string; args: Record<string, unknown> }
export interface CommandResult { ok: boolean; data?: unknown; error?: string }
export interface BridgeEvent { seq: number; at: number; kind: "annotation" | "message"; pageId: string; [k: string]: unknown }
/** an agent as a page shows it */
export interface AgentView { id: string; name: string; color: string; hub: boolean }
/** a tab as the hub and its agent see it */
export interface TabView { pageId: string; /** the ticket it was opened with (the hub knows its window by it) */ ticket: string; agent: string; agentName: string; color: string; label: string; task: string; url: string; title: string; connected: boolean; paused: boolean; left: boolean }
type PageMessage =
  | { event: "command"; data: Command }
  | { event: "agent"; data: { name: string; color?: string } | null }
  | { event: "closed"; data: null }
  /** (to the hub) an agent asks for a tab: open `url` with the ticket in its hash */
  | { event: "openTab"; data: { ticket: string; url: string; label: string; task: string; agent: string; color: string } }
  /** (to the hub) the agents and their tabs, again (on every change) */
  | { event: "hub"; data: { allowTabs: boolean; agents: AgentView[]; tabs: TabView[] } }
  /** (to a tab) whose it is and how it stands */
  | { event: "tab"; data: { agent: string; color: string; label: string; task: string; paused: boolean; left: boolean } };

interface Agent {
  id: string; token: string; name: string; color: string; hubId: string;
  /** paired with the hub's own code: drives the hub's page too (an added agent works only in its tabs) */
  drivesHub: boolean;
  tabs: Set<string>; lastTab: string | null;
  events: BridgeEvent[]; seq: number; eventWaiters: Set<() => void>;
}
interface Page {
  pageId: string; userId: string; pageToken: string; kind: "hub" | "tab";
  page: { url: string; title: string } | null;
  lastSeen: number;
  /** commands not yet sent to a page stream */
  queue: Command[];
  streams: Set<(m: PageMessage) => void>;
  /** the agents' commands waiting for this page's result */
  waiting: Map<string, { resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>;
  // a hub's
  hub?: {
    /** the code for the agent that drives the hub; codes for agents added for tabs */
    code: string | null; codeExpires: number;
    extraCodes: Map<string, number>;
    allowTabs: boolean;
    agents: Map<string, Agent>;
    tickets: Map<string, { agentId: string; url: string; label: string; task: string; expires: number; done: (pageId: string | null) => void }>;
  };
  // a tab's
  tab?: { hubId: string; ticket: string; agentId: string; agentName: string; color: string; label: string; task: string; paused: boolean; left: boolean };
}

const IDLE = 8 * 3600_000, CODE_LIFE = 10 * 60_000, TICKET_LIFE = 60_000, KEEP_EVENTS = 200;
export const COMMAND_TIMEOUT = 30_000;
/** how many tabs an agent may have open at once */
export const MAX_TABS = 3;
const COLORS = ["#7c3aed", "#0891b2", "#db2777", "#ea580c", "#16a34a", "#2563eb", "#ca8a04"];

// (kept on globalThis: route modules are reloaded in development, the pairings stay)
const g = globalThis as unknown as { __claudeBridge2?: { pages: Map<string, Page>; agents: Map<string, Agent> } };
const store = (g.__claudeBridge2 ??= { pages: new Map(), agents: new Map() });
const pages = store.pages, agents = store.agents;

const token = () => randomBytes(24).toString("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const usedCodes = () => new Set([...pages.values()].flatMap(p => (p.hub ? [p.hub.code, ...p.hub.extraCodes.keys()] : [])));
const newCode = () => { const used = usedCodes(); let c = ""; do c = String(randomInt(0, 1_000_000)).padStart(6, "0"); while (used.has(c)); return c; };

function sweep() {
  const now = Date.now();
  for (const p of [...pages.values()]) if (now - p.lastSeen > IDLE) close(p);
  for (const p of pages.values()) if (p.hub) {
    if (p.hub.code && now > p.hub.codeExpires) p.hub.code = null;
    for (const [c, exp] of p.hub.extraCodes) if (now > exp) p.hub.extraCodes.delete(c);
    for (const [t, x] of p.hub.tickets) if (now > x.expires) { p.hub.tickets.delete(t); x.done(null); }
  }
}

function newPage(userId: string, kind: Page["kind"]): Page {
  return { pageId: token(), userId, pageToken: token(), kind, page: null, lastSeen: Date.now(), queue: [], streams: new Set(), waiting: new Map() };
}

/** a page asks to be paired as a hub: a code to give the agent (and the page's own token) */
export function pair(userId: string): { pageId: string; code: string; pageToken: string; expiresAt: number } {
  sweep();
  const p = newPage(userId, "hub"), code = newCode();
  p.hub = { code, codeExpires: Date.now() + CODE_LIFE, extraCodes: new Map(), allowTabs: false, agents: new Map(), tickets: new Map() };
  pages.set(p.pageId, p);
  return { pageId: p.pageId, code, pageToken: p.pageToken, expiresAt: p.hub.codeExpires };
}

/** a tab opened for an agent pairs with its ticket (the same signed-in user as the hub's) */
export function pairTab(userId: string, ticket: string): { pageId: string; pageToken: string; agent: string; color: string; label: string; task: string } | null {
  sweep();
  for (const hub of pages.values()) {
    const t = hub.hub?.tickets.get(ticket);
    if (!t || hub.userId !== userId) continue;
    hub.hub!.tickets.delete(ticket);
    const a = agents.get(t.agentId);
    if (!a || !hub.hub!.agents.has(a.id) || Date.now() > t.expires) { t.done(null); return null; }
    const p = newPage(userId, "tab");
    p.tab = { hubId: hub.pageId, ticket, agentId: a.id, agentName: a.name, color: a.color, label: t.label, task: t.task, paused: false, left: false };
    pages.set(p.pageId, p);
    a.tabs.add(p.pageId); a.lastTab = p.pageId;
    t.done(p.pageId);
    tellHub(hub);
    return { pageId: p.pageId, pageToken: p.pageToken, agent: a.name, color: a.color, label: t.label, task: t.task };
  }
  return null;
}

/** the page's pairing, if `pageToken` is its own and it belongs to `userId` */
export function pageOf(pageId: string | null, pageToken: string | null, userId: string): Page | null {
  const p = pageId ? pages.get(pageId) : undefined;
  if (!p || !pageToken || !same(p.pageToken, pageToken) || p.userId !== userId) return null;
  p.lastSeen = Date.now();
  return p;
}

/** an agent claims a hub by a code shown in it: its token (the hub's own code: it drives the hub; an added agent's: tabs only) */
export function claim(code: string, name: string): { agentToken: string; pageId: string; agentId: string; drivesHub: boolean } | null {
  sweep();
  for (const hub of pages.values()) {
    const h = hub.hub;
    if (!h) continue;
    const main = h.code === code && Date.now() <= h.codeExpires, extra = !main && (h.extraCodes.get(code) ?? 0) >= Date.now();
    if (!main && !extra) continue;
    if (main) h.code = null; else h.extraCodes.delete(code);
    // (the hub's own agent replaced by a new claim of its code, as before: one drives the hub)
    if (main) for (const a of [...h.agents.values()]) if (a.drivesHub) revoke(hub, a.id);
    const used = new Set([...h.agents.values()].map(a => a.color));
    const a: Agent = {
      id: token().slice(0, 12), token: token(), name: name.slice(0, 40) || "Claude", color: COLORS.find(c => !used.has(c)) ?? COLORS[h.agents.size % COLORS.length], hubId: hub.pageId,
      drivesHub: main, tabs: new Set(), lastTab: null, events: [], seq: 0, eventWaiters: new Set(),
    };
    h.agents.set(a.id, a); agents.set(a.id, a);
    hub.lastSeen = Date.now();
    tellHub(hub);
    return { agentToken: a.token, pageId: hub.pageId, agentId: a.id, drivesHub: main };
  }
  return null;
}

/** the agent a token is for */
export function agentOf(authorization: string | null): Agent | null {
  const t = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!t) return null;
  for (const a of agents.values()) if (same(a.token, t)) { const hub = pages.get(a.hubId); if (hub) hub.lastSeen = Date.now(); return a; }
  return null;
}

/** the page an agent's command goes to: `pageId` if it is one of its own, else the tab it opened last, else the hub if it drives it */
export function targetOf(a: Agent, pageId?: string): Page | { error: string } {
  if (pageId) {
    const p = pages.get(pageId);
    if (p && ((p.tab && p.tab.agentId === a.id) || (p.kind === "hub" && p.pageId === a.hubId && a.drivesHub))) return p;
    return { error: "Not one of your pages (bridge_tabs lists yours)" };
  }
  const last = a.lastTab ? pages.get(a.lastTab) : undefined;
  if (last && !last.tab?.left) return last;
  const hub = pages.get(a.hubId);
  if (hub && a.drivesHub) return hub;
  return { error: "No page of yours yet: open one with bridge_open_tab" };
}

function broadcast(p: Page, m: PageMessage) { for (const s of p.streams) s(m); }
const agentList = (h: NonNullable<Page["hub"]>): AgentView[] => [...h.agents.values()].map(a => ({ id: a.id, name: a.name, color: a.color, hub: a.drivesHub }));
function tabView(p: Page): TabView {
  const t = p.tab!;
  return { pageId: p.pageId, ticket: t.ticket, agent: t.agentId, agentName: t.agentName, color: t.color, label: t.label, task: t.task, url: p.page?.url ?? "", title: p.page?.title ?? "", connected: p.streams.size > 0, paused: t.paused, left: t.left };
}
const tabsOf = (hubId: string) => [...pages.values()].filter(p => p.tab?.hubId === hubId).map(tabView);
/** the hub told of its agents and their tabs, as they are now */
function tellHub(hub: Page | undefined) {
  if (!hub?.hub) return;
  broadcast(hub, { event: "hub", data: { allowTabs: hub.hub.allowTabs, agents: agentList(hub.hub), tabs: tabsOf(hub.pageId) } });
  const driver = [...hub.hub.agents.values()].find(a => a.drivesHub);
  broadcast(hub, { event: "agent", data: driver ? { name: driver.name, color: driver.color } : null });
}
const tellTab = (p: Page) => { if (p.tab) broadcast(p, { event: "tab", data: { agent: p.tab.agentName, color: p.tab.color, label: p.tab.label, task: p.tab.task, paused: p.tab.paused, left: p.tab.left } }); };

/** a page stream opened: it is told how it stands, then gets the commands (those queued first); returns how to stop */
export function subscribe(p: Page, send: (m: PageMessage) => void): () => void {
  p.streams.add(send);
  if (p.hub) {
    const driver = [...p.hub.agents.values()].find(a => a.drivesHub);
    send({ event: "agent", data: driver ? { name: driver.name, color: driver.color } : null });
    send({ event: "hub", data: { allowTabs: p.hub.allowTabs, agents: agentList(p.hub), tabs: tabsOf(p.pageId) } });
    // (tabs asked for while it was away: asked again)
    for (const [ticket, t] of p.hub.tickets) { const a = agents.get(t.agentId); if (a) send({ event: "openTab", data: { ticket, url: t.url, label: t.label, task: t.task, agent: a.name, color: a.color } }); }
  } else if (p.tab) {
    send({ event: "tab", data: { agent: p.tab.agentName, color: p.tab.color, label: p.tab.label, task: p.tab.task, paused: p.tab.paused, left: p.tab.left } });
    tellHub(pages.get(p.tab.hubId));
  }
  for (const c of p.queue.splice(0)) send({ event: "command", data: c });
  return () => { p.streams.delete(send); if (p.tab) tellHub(pages.get(p.tab.hubId)); };
}

/** an agent's command, sent to its page; the page's result (or a time-out); refused at once in a tab the user has taken over */
export function command(p: Page, type: string, args: Record<string, unknown>): Promise<CommandResult> {
  if (p.tab?.paused) return Promise.resolve({ ok: false, error: "paused by user (they took over this tab)" });
  if (p.tab?.left) return Promise.resolve({ ok: false, error: "this tab is no longer yours" });
  const c: Command = { id: token(), type, args };
  return new Promise(resolve => {
    const timer = setTimeout(() => { p.waiting.delete(c.id); p.queue = p.queue.filter(x => x.id !== c.id); resolve({ ok: false, error: "The page didn't answer in time (is it open and connected?)" }); }, COMMAND_TIMEOUT);
    p.waiting.set(c.id, { resolve, timer });
    if (p.streams.size) broadcast(p, { event: "command", data: c }); else p.queue.push(c);
  });
}

/** the page's answer to a command */
export function result(p: Page, id: string, r: CommandResult): boolean {
  const w = p.waiting.get(id);
  if (!w) return false;
  clearTimeout(w.timer); p.waiting.delete(id); w.resolve(r);
  return true;
}

/** the agents a page's events go to: a tab's own agent; at the hub, the agent driving it */
function listeners(p: Page): Agent[] {
  if (p.tab) { const a = agents.get(p.tab.agentId); return a && !p.tab.left ? [a] : []; }
  return p.hub ? [...p.hub.agents.values()].filter(a => a.drivesHub) : [];
}
/** the page tells its agents something (an annotation, a message) */
export function addEvent(p: Page, e: Record<string, unknown> & { kind: BridgeEvent["kind"] }): number {
  const to = listeners(p);
  for (const a of to) {
    const ev = { ...e, pageId: p.pageId, seq: ++a.seq, at: Date.now() } as BridgeEvent;
    a.events.push(ev);
    if (a.events.length > KEEP_EVENTS) a.events.splice(0, a.events.length - KEEP_EVENTS);
    for (const w of [...a.eventWaiters]) w();
  }
  return to.length;
}

/** an agent's events after `after`, waiting up to `waitMs` for one if there are none yet */
export async function events(a: Agent, after: number, waitMs: number, signal?: AbortSignal): Promise<{ events: BridgeEvent[]; seq: number }> {
  const now = () => a.events.filter(e => e.seq > after);
  if (!now().length && waitMs > 0) {
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(t); a.eventWaiters.delete(done); resolve(); };
      const t = setTimeout(done, waitMs);
      a.eventWaiters.add(done);
      signal?.addEventListener("abort", done);
    });
  }
  return { events: now(), seq: a.seq };
}

export function hello(p: Page, page: { url: string; title: string }) {
  p.page = { url: String(page.url).slice(0, 500), title: String(page.title).slice(0, 200) };
  if (p.tab) tellHub(pages.get(p.tab.hubId));
}

/** what an agent sees: its hub's page (if it drives it) and its tabs */
export function status(a: Agent) {
  const hub = pages.get(a.hubId);
  return {
    agent: { id: a.id, name: a.name, drivesHub: a.drivesHub },
    page: a.drivesHub && hub?.page ? { ...hub.page, connected: hub.streams.size > 0, pageId: hub.pageId } : null,
    allowTabs: !!hub?.hub?.allowTabs, tabs: tabsFor(a),
  };
}
export const tabsFor = (a: Agent) => [...a.tabs].flatMap(id => { const p = pages.get(id); return p ? [tabView(p)] : []; });

// ---------------------------------------------------------------- agent tabs

/**
 * An agent asks for a tab at `path` (this app's, not its API): the hub opens it (or, its pop-up blocked, asks the user);
 * answers when the tab has paired, or `pending` after `waitMs` (it is still asked for: bridge_tabs shows it when it opens).
 */
export async function openTab(a: Agent, path: string, label: string, task: string, waitMs: number): Promise<{ ok: true; pageId: string } | { ok: false; error: string; pending?: boolean }> {
  sweep();
  const hub = pages.get(a.hubId);
  if (!hub?.hub) return { ok: false, error: "The hub is gone" };
  if (!hub.hub.allowTabs) return { ok: false, error: "Agent tabs aren't allowed: the user switches on 'Allow agent tabs' in the hub's Claude panel" };
  if (!hub.streams.size) return { ok: false, error: "The hub page isn't open" };
  const open = [...a.tabs].filter(id => { const p = pages.get(id); return p && !p.tab?.left; });
  const pendingTickets = [...hub.hub.tickets.values()].filter(t => t.agentId === a.id).length;
  if (open.length + pendingTickets >= MAX_TABS) return { ok: false, error: `At most ${MAX_TABS} tabs each: close one first (bridge_close_tab)` };
  const ticket = token();
  return new Promise(resolve => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve({ ok: false, pending: true, error: "Not opened yet: the user is asked in the hub (pop-ups blocked?), or hasn't answered" }); } }, waitMs);
    hub.hub!.tickets.set(ticket, {
      agentId: a.id, url: path, label, task, expires: Date.now() + TICKET_LIFE,
      done: (pageId: string | null) => { if (settled) return; settled = true; clearTimeout(t); resolve(pageId ? { ok: true, pageId } : { ok: false, error: "The user didn't open it (denied, or it timed out)" }); },
    });
    broadcast(hub, { event: "openTab", data: { ticket, url: path, label, task, agent: a.name, color: a.color } });
  });
}
/** the user denied a tab the hub was asked to open */
export function denyTab(hub: Page, ticket: string) {
  const t = hub.hub?.tickets.get(ticket);
  if (!t) return false;
  hub.hub!.tickets.delete(ticket); t.done(null);
  return true;
}
/** the hub lets agents open tabs, or not */
export function allowTabs(hub: Page, on: boolean) { if (hub.hub) { hub.hub.allowTabs = on; tellHub(hub); } }
/** a code for another agent to attach to the hub (tabs only) */
export function agentCode(hub: Page): { code: string; expiresAt: number } | null {
  if (!hub.hub) return null;
  sweep();
  const code = newCode(), expiresAt = Date.now() + CODE_LIFE;
  hub.hub.extraCodes.set(code, expiresAt);
  return { code, expiresAt };
}
/** an agent let go (revoked, or the hub disconnected): its token ends; its tabs stay open for the user, marked as left */
export function revoke(hub: Page, agentId: string) {
  const a = hub.hub?.agents.get(agentId);
  if (!a) return false;
  hub.hub!.agents.delete(agentId); agents.delete(agentId);
  for (const [t, x] of [...hub.hub!.tickets]) if (x.agentId === agentId) { hub.hub!.tickets.delete(t); x.done(null); }
  for (const id of a.tabs) { const p = pages.get(id); if (p?.tab) { p.tab.left = true; failWaiting(p, `${a.name} left`); tellTab(p); } }
  for (const w of [...a.eventWaiters]) w();
  tellHub(hub);
  return true;
}
/** a tab paused (the user took over) or resumed */
export function pauseTab(p: Page, paused: boolean) {
  if (!p.tab) return false;
  p.tab.paused = paused;
  if (paused) failWaiting(p, "paused by user (they took over this tab)");
  tellTab(p); tellHub(pages.get(p.tab.hubId));
  return true;
}
/** a tab of the hub's, by id */
export const tabOfHub = (hub: Page, tabId: string) => { const p = pages.get(tabId); return p?.tab?.hubId === hub.pageId ? p : null; };
/** an agent closes one of its tabs: the tab is told (it closes itself if it can), its pairing ends */
export function closeTab(a: Agent, pageId: string) {
  const p = pages.get(pageId);
  if (!p?.tab || p.tab.agentId !== a.id) return false;
  close(p);
  return true;
}

function failWaiting(p: Page, error: string) {
  for (const [, w] of p.waiting) { clearTimeout(w.timer); w.resolve({ ok: false, error }); }
  p.waiting.clear(); p.queue = [];
}

/** a page's pairing ended (by the user, the agent, or idle): waiting commands fail, the page is told; a hub's agents and tabs end with it */
export function close(p: Page) {
  if (!pages.has(p.pageId)) return;
  pages.delete(p.pageId);
  failWaiting(p, "The page disconnected");
  broadcast(p, { event: "closed", data: null });
  if (p.hub) for (const id of [...p.hub.agents.keys()]) revoke(p, id);
  if (p.tab) {
    const a = agents.get(p.tab.agentId);
    if (a) { a.tabs.delete(p.pageId); if (a.lastTab === p.pageId) a.lastTab = [...a.tabs].pop() ?? null; }
    tellHub(pages.get(p.tab.hubId));
  }
}

// ---------------------------------------------------------------- reading request bodies (no casts)

/** a request body as an object of unknowns (empty if it isn't one) */
export async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const v: unknown = await req.json().catch(() => null);
  return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});
/** a path of this app a tab may open (not its API, not another site): the path itself, or null */
export function appPath(raw: string): string | null {
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return null;
  const path = raw.split("#")[0];
  if (/^\/api(\/|$|\?)/.test(path)) return null;
  return path;
}
