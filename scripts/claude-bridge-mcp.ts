/**
 * The Claude bridge's agent side (docs/claude-bridge.md): an MCP server over stdio giving a Claude session tools
 * to work in a page of the app the user paired with it (the code shown in the page's bridge panel): read the page
 * (accessibility tree, screenshot, the app's state), act in it (click, type, keys, navigate, app actions) and wait
 * for the user's annotations and messages (which also come with any tool's answer, T191). With the user's leave ("Allow agent tabs" in the hub's panel), it can also open
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

/** the user's messages, annotations and watched UI changes since the last look, waiting up to `wait` seconds for one (T191:
 * every tool call looks too, without waiting, so an agent at work sees them at its next call, not only in bridge_wait_events) */
async function pending(wait: number): Promise<Content[]> {
  const r = await call(`/agent/events?after=${after}&wait=${wait}`);
  const evs = Array.isArray(r.events) ? r.events.map(obj) : [];
  after = Number(r.seq ?? after);
  const out: Content[] = [];
  for (const e of evs) {
    const { screenshot, ...rest } = e, m = s(screenshot)?.match(/^data:([^;]+);base64,(.*)$/);
    out.push(...text(rest));
    if (m) out.push({ type: "image", mimeType: m[1], data: m[2] });
  }
  return out;
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
  { name: "bridge_status", description: "Who you are to the hub, its page (if you drive it), whether agent tabs are allowed, your tabs, and pairedUntil (ms epoch: 8 h since the hub's last call — any call from either side pushes it out again, so pair again only once the page itself says the pairing is lost).", inputSchema: { type: "object", properties: {} }, run: async () => text(await call("/agent/status")) },
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
    name: "bridge_screenshot", description: "A picture of the editor's map (target 'map', default; its 3D view while that shows) or of the whole page ('page').",
    inputSchema: { type: "object", properties: { ...page, target: { type: "string", enum: ["map", "page"] }, maxWidth: { type: "number" } } },
    run: async a => {
      const d = obj(await command("screenshot", a)), url = s(d.dataUrl) ?? "", m = url.match(/^data:([^;]+);base64,(.*)$/);
      return m ? [{ type: "image", mimeType: m[1], data: m[2] }] : text(d);
    },
  },
  {
    name: "bridge_state", description: "The app's own state, by key: sketch (counts and ids), selection, stats (the running cars' results), problems (the console), view (centre and zoom), run (running, speed, time), experiment (the Sketch window's spatial experiment: on, its stats, whether the sketch has a roundabout it drives), visibility (document.visibilityState: a background tab stops repainting, so a screenshot or a running experiment may be stale or delayed); not in the default keys, only by name: browserConsole (the last 50 of the page's own uncaught errors, unhandled rejections and console.error/warn lines — not the worker's, those don't reach this thread's console), ui (a V2 plan's UI state: active editor; each editor's tool, selection, view, run, replay and dialogs (search, console, settings, optimizer); panels folded; the Sketch window; layers; the imagery's brightness; the results tables' sort). Or one part of the UI state by `path` (e.g. editors.plan.selection, editors.scratch.run, active). Or `watch` paths: their changes then come as 'ui' events in bridge_wait_events (at most 4 a second; [] stops).",
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
  { name: "bridge_navigate", description: "Go to another page of the app (same origin). To the page already open: a real reload, not a no-op (use bridge_reload for that without changing the URL)." , inputSchema: { type: "object", properties: { ...page, url: { type: "string" } }, required: ["url"] }, run: async a => text(await command("navigate", a)) },
  { name: "bridge_reload", description: "A real page reload (location.reload()), not router.push: use after a merge, when a dynamically-imported module (a worker, say) is still the old code and hot reload hasn't swapped it.", inputSchema: { type: "object", properties: { ...page } }, run: async a => text(await command("reload", a)) },
  {
    name: "bridge_app", description: "An action of the editor: select {kind,id}, goTo {kind,id} (kind: road, lane, connector, junction, link, crossing, car), view {x,y,scale?} (clears a car followed first, which would otherwise move the view right back), run, pause, speed {speed}, replay {t}, restart, runUntil {t} (runs at the speed set until sim time t, or 25 s real time passes first — then {reached:false}, still running: call again or raise the speed; the experiment's own clock while that's on), carsAt {x,y,r?} (cars within r metres, default 10: id, position, kind 'lane'|'sensing', and (the main engine only, so far) what holds it — for whichever engine is on, live or replayed), experiment {on} (the Sketch window's spatial-roundabout switch, same as its own Switch). On a V2 plan also: panel {id, open} (fold an inspector panel), console {open?, kind?, text?, editor?} (kind: all, stuck, collision, jump, deadlock, breakdown, towed), search {open, query?, editor?}, layers {set: {id: bool}}, sort {table: junctions|roads, by, flip?, editor?}, sketchWindow {open?} (the Sketch window, as its button), mode {mode: plan|3d} (the plan's map from above or in 3D), route {from, to} or {clear: true} (the route the cars would take from a lane to an exit lane: read editors.<editor>.route.result); editor: plan or scratch (the Sketch window), default the one the user is at. Edits (only if the user allows agent edits in the Claude panel; each one undo step; args strict, unknown keys refused): addLane {points:[{x,y}…], width?, speed?, level?, curved?}, deleteLanes {lanes}, reshapeLane {lane, points}, movePoint {lane, i, x, y}, addConnector {from:{lane, s?}, to:{lane, s?}, bends?, straight?}, deleteConnectors {connectors}, moveConnectorEnd {connector, end: from|to, s}, setControl {lanes, control: yield|stop|lights|none}, setLights {junction, on}, groupRoad {lanes, name?}, addJunction {outline, name?}, deleteJunctions {junctions}, roundabout {x, y, r}, batch {actions:[{action, args}]} (one undo step, all or nothing); each takes editor?; and the plan's sketches: openSketch {id}, newSketch {name?}, duplicateSketch {id?, name?}. See docs/claude-bridge.md.",
    inputSchema: { type: "object", properties: { ...page, action: { type: "string" }, args: { type: "object" } }, required: ["action"] },
    run: async a => text(await command("app", { action: s(a.action), args: obj(a.args) })),
  },
  {
    name: "bridge_report", description: "Show the user a report in the page (a window over it, kept in the Claude panel): a title, an intro, a table of results (columns, rows of text or numbers, rows to highlight from 0, a note under it) and findings, one per line. Plain text only; at most 14 columns, 60 rows, 24 findings.",
    inputSchema: {
      type: "object", required: ["title"],
      properties: {
        ...page, title: { type: "string" }, intro: { type: "string" },
        table: { type: "object", properties: { columns: { type: "array", items: { type: "string" } }, rows: { type: "array", items: { type: "array", items: { type: ["string", "number", "null"] } } }, highlight: { type: "array", items: { type: "number" } }, note: { type: "string" } }, required: ["columns", "rows"] },
        findings: { type: "array", items: { type: "string" } },
      },
    },
    run: async a => text(await command("report", a)),
  },
  {
    name: "bridge_wait_events", description: "The user's annotations and messages from the page since the last call, waiting up to `wait` seconds (25 max) for one. Annotations come with a note, a screenshot crop and what is under them. Also 'ui' events, { changed: { path: value } }, for the UI state paths you watch (bridge_state watch).",
    inputSchema: { type: "object", properties: { wait: { type: "number" } } },
    run: async a => {
      const out = await pending(Math.min(25, Math.max(0, Number(a.wait ?? 20))));
      return out.length ? out : text("No annotation, message or UI change yet.");
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
      try {
        const content = await tool.run(obj(params.arguments));
        // (what the user sent from the page meanwhile, with any tool's answer: not only when the agent waits for it)
        if (token && tool.name !== "bridge_wait_events") {
          const extra = await pending(0).catch(() => [] as Content[]);
          if (extra.length) content.push(...text("Meanwhile, from the page (the user's messages and notes, or UI changes you watch):"), ...extra);
        }
        return send({ id, result: { content } });
      }
      catch (e) { return send({ id, result: { content: text(e instanceof Error ? e.message : String(e)), isError: true } }); }
    }
    send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) { send({ id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }); }
});
