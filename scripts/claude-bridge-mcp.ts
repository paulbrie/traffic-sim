/**
 * The Claude bridge's agent side (docs/claude-bridge.md): an MCP server over stdio giving a Claude session tools
 * to work in a page of the app the user paired with it (the code shown in the page's bridge panel): read the page
 * (accessibility tree, screenshot, the app's state), act in it (click, type, keys, navigate, app actions) and wait
 * for the user's annotations and messages. With the user's leave ("Allow agent tabs" in the hub's panel), it can also open
 * tabs of its own in the user's browser (bridge_open_tab), each marked as the agent's, and work in them (any page tool's
 * `pageId`; by default the tab it opened last, else the hub). No dependencies: MCP's JSON-RPC by hand.
 *
 *   BRIDGE_URL   the app's base URL (default https://paul.cloud.teleporthq.ai/projects/trafficsim)
 *   BRIDGE_AGENT the name shown in the page (default "Claude"; `bridge_pair` can give another)
 */
import { createInterface } from "readline";

const BASE = (process.env.BRIDGE_URL ?? "https://paul.cloud.teleporthq.ai/projects/trafficsim").replace(/\/$/, "") + "/api/bridge";
let token: string | null = null, agent = process.env.BRIDGE_AGENT ?? "Claude", after = 0;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : {});
const s = (v: unknown) => (typeof v === "string" ? v : undefined);

async function call(path: string, init: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<Json> {
  if (init.auth !== false && !token) throw new Error("Not paired yet: ask the user for the 6-digit code in the page's Claude panel, then call bridge_pair");
  const res = await fetch(BASE + path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "Content-Type": "application/json", ...(init.auth !== false && token ? { Authorization: `Bearer ${token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = obj(await res.json().catch(() => ({ error: `HTTP ${res.status}` })));
  if (res.status === 401 && init.auth !== false) { token = null; throw new Error("The pairing ended (the user disconnected, or the server restarted): ask for a new code"); }
  if (!res.ok && data.ok !== false) throw new Error(s(data.error) ?? `HTTP ${res.status}`);
  return data;
}
/** a command to one of the agent's pages (`pageId` in the args, else the default one): its data, or its error thrown */
async function command(type: string, args: Json = {}): Promise<unknown> {
  const { pageId, ...rest } = args;
  const r = await call("/agent/command", { body: { type, args: rest, ...(s(pageId) ? { pageId } : {}) } });
  if (r.ok !== true) throw new Error(s(r.error) ?? "The page couldn't do it");
  return r.data;
}

// ---------------------------------------------------------------- tools

interface Tool { name: string; description: string; inputSchema: Json; run: (a: Json) => Promise<Content[]> }
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (v: unknown): Content[] => [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }];
const page = { pageId: { type: "string", description: "which of your pages (bridge_tabs lists them); default: the tab you opened last, else the hub" } };
const target = { ...page, role: { type: "string", description: "ARIA role, e.g. button, textbox, link, tab, option, region" }, name: { type: "string", description: "accessible name (case-insensitive substring)" }, exact: { type: "boolean" }, nth: { type: "number", description: "0-based, when several match" }, selector: { type: "string", description: "CSS selector instead of role/name" }, text: { type: "string", description: "visible text instead of role/name" } };

const TOOLS: Tool[] = [
  {
    name: "bridge_pair", description: "Pair with the user's hub page: the user clicks 'Connect Claude' in the app's account menu and gives you the 6-digit code shown there (that code: you drive the hub page too), or an 'Add agent' code from the hub's panel (you work in tabs of your own). Needed before any other bridge tool.",
    inputSchema: { type: "object", properties: { code: { type: "string" }, agent: { type: "string", description: "your name shown in the page (e.g. Alice)" } }, required: ["code"] },
    run: async a => {
      if (s(a.agent)) agent = s(a.agent)!;
      const r = await call("/agent/claim", { body: { code: s(a.code) ?? "", agent }, auth: false });
      token = s(r.agentToken) ?? null; after = 0;
      if (r.drivesHub === false) return text(`Paired as ${agent}, for tabs of your own (open one with bridge_open_tab). ${JSON.stringify(await call("/agent/status"))}`);
      return text(`Paired as ${agent}. ${JSON.stringify(await call("/agent/status"))}`);
    },
  },
  { name: "bridge_status", description: "Who you are to the hub, its page (if you drive it), whether agent tabs are allowed, and your tabs.", inputSchema: { type: "object", properties: {} }, run: async () => text(await call("/agent/status")) },
  {
    name: "bridge_open_tab", description: "Open a tab of your own in the user's browser at a page of this app (a path like /plans/<id>, never /api), marked as yours. The user must have switched on 'Allow agent tabs' in the hub's panel; if their browser blocks pop-ups they're asked to open it (then this answers pending: check bridge_tabs). At most 3 open tabs. Your page tools then go to it by default.",
    inputSchema: { type: "object", properties: { url: { type: "string" }, label: { type: "string", description: "what it's for, shown to the user" }, task: { type: "string", description: "your task id, e.g. T34" } }, required: ["url"] },
    run: async a => text(await call("/agent/open-tab", { body: { url: s(a.url), label: s(a.label), task: s(a.task) } })),
  },
  { name: "bridge_tabs", description: "Your tabs: pageId, url, title, label, connected, paused (the user took over), left.", inputSchema: { type: "object", properties: {} }, run: async () => text(await call("/agent/tabs")) },
  {
    name: "bridge_close_tab", description: "Close one of your tabs.", inputSchema: { type: "object", properties: { pageId: { type: "string" } }, required: ["pageId"] },
    run: async a => text(await call("/agent/close-tab", { body: { pageId: s(a.pageId) } })),
  },
  {
    name: "bridge_snapshot", description: "The page's accessibility tree as compact text (one line per node: role \"name\" [value] {states}), to see what is on it and how to target it.",
    inputSchema: { type: "object", properties: { ...page, root: { type: "string", description: "CSS selector of the part to read (default the whole page)" } } },
    run: async a => { const d = obj(await command("snapshot", a)); return text(`${s(d.url) ?? ""} · ${s(d.title) ?? ""}\n${s(d.tree) ?? JSON.stringify(d)}`); },
  },
  {
    name: "bridge_screenshot", description: "A picture of the editor's map (target 'map', default) or of the whole page ('page').",
    inputSchema: { type: "object", properties: { ...page, target: { type: "string", enum: ["map", "page"] }, maxWidth: { type: "number" } } },
    run: async a => {
      const d = obj(await command("screenshot", a)), url = s(d.dataUrl) ?? "", m = url.match(/^data:([^;]+);base64,(.*)$/);
      return m ? [{ type: "image", mimeType: m[1], data: m[2] }] : text(d);
    },
  },
  {
    name: "bridge_state", description: "The app's own state, by key: sketch (counts and ids), selection, stats (the running cars' results), problems (the console), view (centre and zoom), run (running, speed, time), ui (a V2 plan's UI state: active editor; each editor's tool, selection, view, run, replay and dialogs (search, console, settings, optimizer); panels folded; the Sketch window). Or one part of the UI state by `path` (e.g. editors.plan.selection, editors.scratch.run, active). Or `watch` paths: their changes then come as 'ui' events in bridge_wait_events (at most 4 a second; [] stops).",
    inputSchema: { type: "object", properties: { ...page, keys: { type: "array", items: { type: "string" } }, path: { type: "string", description: "a part of the UI state, dots or slashes: editors.plan.selection" }, watch: { type: "array", items: { type: "string" }, description: "UI state paths to be told about when they change ([] stops)" } } },
    run: async a => text(await command("state", a)),
  },
  { name: "bridge_click", description: "Click an element (the user sees your cursor go there first).", inputSchema: { type: "object", properties: target }, run: async a => text(await command("click", a)) },
  {
    name: "bridge_type", description: "Type into a field (not password fields).",
    inputSchema: { type: "object", properties: { ...target, value: { type: "string", description: "the text to type" }, submit: { type: "boolean", description: "press Enter after" } }, required: ["value"] },
    run: async a => { const { value, ...rest } = a; return text(await command("type", { ...rest, text: s(value) ?? "" })); },
  },
  { name: "bridge_key", description: "Press a key or chord, e.g. 'Escape', 'Control+k', 'p'.", inputSchema: { type: "object", properties: { ...page, key: { type: "string" } }, required: ["key"] }, run: async a => text(await command("key", a)) },
  { name: "bridge_navigate", description: "Go to another page of the app (same origin).", inputSchema: { type: "object", properties: { ...page, url: { type: "string" } }, required: ["url"] }, run: async a => text(await command("navigate", a)) },
  {
    name: "bridge_app", description: "An action of the editor: select {kind,id}, goTo {kind,id} (kind: road, lane, connector, junction, link, crossing, car), view {x,y,scale?}, run, pause, replay {t}, restart. On a V2 plan also: panel {id, open} (fold an inspector panel), console {open?, kind?, text?, editor?} (kind: all, stuck, collision, jump, deadlock, breakdown, towed), search {open, query?, editor?}; editor: plan or scratch (the Sketch window), default the one the user is at.",
    inputSchema: { type: "object", properties: { ...page, action: { type: "string" }, args: { type: "object" } }, required: ["action"] },
    run: async a => text(await command("app", { action: s(a.action), args: obj(a.args) })),
  },
  {
    name: "bridge_wait_events", description: "The user's annotations and messages from the page since the last call, waiting up to `wait` seconds (25 max) for one. Annotations come with a note, a screenshot crop and what is under them. Also 'ui' events, { changed: { path: value } }, for the UI state paths you watch (bridge_state watch).",
    inputSchema: { type: "object", properties: { wait: { type: "number" } } },
    run: async a => {
      const r = await call(`/agent/events?after=${after}&wait=${Math.min(25, Math.max(0, Number(a.wait ?? 20)))}`);
      const evs = Array.isArray(r.events) ? r.events.map(obj) : [];
      after = Number(r.seq ?? after);
      if (!evs.length) return text("No annotation, message or UI change yet.");
      const out: Content[] = [];
      for (const e of evs) {
        const { screenshot, ...rest } = e, m = s(screenshot)?.match(/^data:([^;]+);base64,(.*)$/);
        out.push(...text(rest));
        if (m) out.push({ type: "image", mimeType: m[1], data: m[2] });
      }
      return out;
    },
  },
];

// ---------------------------------------------------------------- MCP over stdio (JSON-RPC 2.0, one message a line)

const send = (m: Json) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
createInterface({ input: process.stdin }).on("line", async line => {
  let msg: Json;
  try { msg = obj(JSON.parse(line)); } catch { return; }
  const id = msg.id, method = s(msg.method), params = obj(msg.params);
  if (id === undefined) return; // (notifications: nothing to answer)
  try {
    if (method === "initialize") return send({ id, result: { protocolVersion: s(params.protocolVersion) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "trafficsim-ui", version: "0.1.0" } } });
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: TOOLS.map(({ run: _, ...t }) => t) } });
    if (method === "tools/call") {
      const tool = TOOLS.find(t => t.name === s(params.name));
      if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool ${s(params.name)}` } });
      try { return send({ id, result: { content: await tool.run(obj(params.arguments)) } }); }
      catch (e) { return send({ id, result: { content: text(e instanceof Error ? e.message : String(e)), isError: true } }); }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) { send({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }); }
});
