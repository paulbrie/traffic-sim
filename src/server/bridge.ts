import "server-only";
import { randomBytes, randomInt, timingSafeEqual } from "crypto";

/**
 * The Claude bridge's server side (see docs/claude-bridge.md): pairings of a page with an agent, the commands the
 * agent sends (queued for the page, the agent waiting for each one's result), and the events the page sends the
 * agent (annotations, messages). In memory, in this server process: a restart drops them (the page reconnects,
 * the agent pairs again).
 */

export interface Command { id: string; type: string; args: Record<string, unknown> }
export interface CommandResult { ok: boolean; data?: unknown; error?: string }
export interface BridgeEvent { seq: number; at: number; kind: "annotation" | "message"; [k: string]: unknown }
type PageMessage = { event: "command"; data: Command } | { event: "agent"; data: { name: string } | null } | { event: "closed"; data: null };

interface Pairing {
  pageId: string; userId: string; pageToken: string;
  code: string | null; codeExpires: number;
  agentToken: string | null; agentName: string | null;
  page: { url: string; title: string } | null;
  lastSeen: number;
  /** commands not yet sent to a page stream */
  queue: Command[];
  /** the page's open streams */
  streams: Set<(m: PageMessage) => void>;
  /** the agent's commands waiting for the page's result */
  waiting: Map<string, { resolve: (r: CommandResult) => void; timer: ReturnType<typeof setTimeout> }>;
  events: BridgeEvent[]; seq: number;
  /** the agent's long polls waiting for an event */
  eventWaiters: Set<() => void>;
}

const IDLE = 8 * 3600_000, CODE_LIFE = 10 * 60_000, KEEP_EVENTS = 200;
export const COMMAND_TIMEOUT = 30_000;

// (kept on globalThis: route modules are reloaded in development, the pairings stay)
const g = globalThis as unknown as { __claudeBridge?: Map<string, Pairing> };
const pairings = (g.__claudeBridge ??= new Map<string, Pairing>());

const token = () => randomBytes(24).toString("base64url");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function sweep() {
  const now = Date.now();
  for (const p of [...pairings.values()]) if (now - p.lastSeen > IDLE) close(p);
  for (const p of pairings.values()) if (p.code && now > p.codeExpires) p.code = null;
}

/** a page asks to be paired: a code to give the agent (and the page's own token) */
export function pair(userId: string): { pageId: string; code: string; pageToken: string; expiresAt: number } {
  sweep();
  const used = new Set([...pairings.values()].map(p => p.code));
  let code = "";
  do code = String(randomInt(0, 1_000_000)).padStart(6, "0"); while (used.has(code));
  const p: Pairing = {
    pageId: token(), userId, pageToken: token(), code, codeExpires: Date.now() + CODE_LIFE, agentToken: null, agentName: null, page: null,
    lastSeen: Date.now(), queue: [], streams: new Set(), waiting: new Map(), events: [], seq: 0, eventWaiters: new Set(),
  };
  pairings.set(p.pageId, p);
  return { pageId: p.pageId, code, pageToken: p.pageToken, expiresAt: p.codeExpires };
}

/** the page's pairing, if `pageToken` is its own and it belongs to `userId` */
export function pageOf(pageId: string | null, pageToken: string | null, userId: string): Pairing | null {
  const p = pageId ? pairings.get(pageId) : undefined;
  if (!p || !pageToken || !same(p.pageToken, pageToken) || p.userId !== userId) return null;
  p.lastSeen = Date.now();
  return p;
}

/** an agent claims a page by its code: the agent's token (a page has one agent at a time: a new one replaces the old) */
export function claim(code: string, agent: string): { agentToken: string; pageId: string } | null {
  sweep();
  const p = [...pairings.values()].find(x => x.code === code && Date.now() <= x.codeExpires);
  if (!p) return null;
  p.code = null; p.agentToken = token(); p.agentName = agent.slice(0, 40) || "Claude"; p.lastSeen = Date.now();
  broadcast(p, { event: "agent", data: { name: p.agentName } });
  return { agentToken: p.agentToken, pageId: p.pageId };
}

/** the pairing an agent's token is for */
export function agentOf(authorization: string | null): Pairing | null {
  const t = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!t) return null;
  for (const p of pairings.values()) if (p.agentToken && same(p.agentToken, t)) { p.lastSeen = Date.now(); return p; }
  return null;
}

function broadcast(p: Pairing, m: PageMessage) { for (const s of p.streams) s(m); }

/** a page stream opened: it gets who is attached, then the commands (those queued first); returns how to stop */
export function subscribe(p: Pairing, send: (m: PageMessage) => void): () => void {
  p.streams.add(send);
  send({ event: "agent", data: p.agentName ? { name: p.agentName } : null });
  for (const c of p.queue.splice(0)) send({ event: "command", data: c });
  return () => { p.streams.delete(send); };
}

/** the agent's command, sent to the page; the page's result (or a time-out) */
export function command(p: Pairing, type: string, args: Record<string, unknown>): Promise<CommandResult> {
  const c: Command = { id: token(), type, args };
  return new Promise(resolve => {
    const timer = setTimeout(() => { p.waiting.delete(c.id); p.queue = p.queue.filter(x => x.id !== c.id); resolve({ ok: false, error: "The page didn't answer in time (is it open and connected?)" }); }, COMMAND_TIMEOUT);
    p.waiting.set(c.id, { resolve, timer });
    if (p.streams.size) broadcast(p, { event: "command", data: c }); else p.queue.push(c);
  });
}

/** the page's answer to a command */
export function result(p: Pairing, id: string, r: CommandResult): boolean {
  const w = p.waiting.get(id);
  if (!w) return false;
  clearTimeout(w.timer); p.waiting.delete(id); w.resolve(r);
  return true;
}

/** the page tells the agent something (an annotation, a message) */
export function addEvent(p: Pairing, e: Omit<BridgeEvent, "seq" | "at">): BridgeEvent {
  const ev = { ...e, seq: ++p.seq, at: Date.now() } as BridgeEvent;
  p.events.push(ev);
  if (p.events.length > KEEP_EVENTS) p.events.splice(0, p.events.length - KEEP_EVENTS);
  for (const w of [...p.eventWaiters]) w();
  return ev;
}

/** the events after `after`, waiting up to `waitMs` for one if there are none yet */
export async function events(p: Pairing, after: number, waitMs: number, signal?: AbortSignal): Promise<{ events: BridgeEvent[]; seq: number }> {
  const now = () => p.events.filter(e => e.seq > after);
  if (!now().length && waitMs > 0) {
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(t); p.eventWaiters.delete(done); resolve(); };
      const t = setTimeout(done, waitMs);
      p.eventWaiters.add(done);
      signal?.addEventListener("abort", done);
    });
  }
  return { events: now(), seq: p.seq };
}

export function hello(p: Pairing, page: { url: string; title: string }) { p.page = { url: String(page.url).slice(0, 500), title: String(page.title).slice(0, 200) }; }

export function status(p: Pairing) { return { page: p.page ? { ...p.page, connected: p.streams.size > 0 } : null, agent: p.agentName }; }

/** the pairing ended (by the page, or idle): waiting commands fail, the page is told */
export function close(p: Pairing) {
  pairings.delete(p.pageId);
  for (const [, w] of p.waiting) { clearTimeout(w.timer); w.resolve({ ok: false, error: "The page disconnected" }); }
  p.waiting.clear();
  for (const w of [...p.eventWaiters]) w();
  broadcast(p, { event: "closed", data: null });
}

// ---------------------------------------------------------------- reading request bodies (no casts)

/** a request body as an object of unknowns (empty if it isn't one) */
export async function bodyOf(req: Request): Promise<Record<string, unknown>> {
  const v: unknown = await req.json().catch(() => null);
  return v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {};
}
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});
