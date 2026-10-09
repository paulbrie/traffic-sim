# Claude bridge: an agent working in the app's own UI

A signed-in admin pairs a page with a Claude session; the agent then reads the page, acts in it (seen by the
user: a cursor, an activity log) and receives the user's annotations. Owners: server + MCP (Alice), in-page
module (Bob). This file is the contract between them.

## Pieces

```
Claude Code ──stdio MCP──▶ scripts/claude-bridge-mcp.ts ──HTTP──▶ /api/bridge/agent/*  ┐
                                                                                        ├─ src/server/bridge.ts (in memory)
Browser page ◀──SSE── /api/bridge/page/stream ;  POST /api/bridge/page/* ───────────────┘
```

`src/server/bridge.ts` keeps pairings, queued commands, waiting results and events in memory (one server
process; a restart drops them: the page reconnects, the agent pairs again).

## Pairing

1. Page (signed-in admin, `assertUser("admin")`): `POST /api/bridge/page/pair` → `{ pageId, code, pageToken }`.
   `code`: 6 digits, valid 10 min, shown in the bridge panel. `pageToken` authenticates the page's later calls
   (header `x-bridge-page`), alongside the session cookie.
2. Agent: `POST /api/bridge/agent/claim { code, agent }` (agent: its name, e.g. "Alice") → `{ agentToken, pageId }`.
   Later agent calls carry `Authorization: Bearer <agentToken>`. A page has one agent at a time (a new claim
   replaces the old; the page shows who is attached). The page can disconnect: `POST /api/bridge/page/close`.
3. Pairings end after 8 h idle.

## Page side

- `GET /api/bridge/page/stream?pageId=…` (SSE, cookie + `x-bridge-page` as query `t=` since EventSource can't
  set headers): events `command` (data: a `Command`), `agent` (data: `{ name } | null`), `ping`.
- `POST /api/bridge/page/result { id, ok, data?, error? }`: the answer to a command.
- `POST /api/bridge/page/event { kind: "annotation" | "message", ... }`: the user speaks to the agent (see Events).
- `POST /api/bridge/page/hello { url, title }`: on connect and on every navigation.

## Agent side

- `POST /api/bridge/agent/command { type, args }` → waits up to 30 s for the page's result → `{ ok, data?, error? }`
  (504 if the page didn't answer; 409 if no page is connected).
- `GET /api/bridge/agent/events?after=<seq>&wait=25` → long poll: `{ events: Event[], seq }`.
- `GET /api/bridge/agent/status` → `{ page: { url, title, connected } | null }`.

## Commands (`type`, `args` → `data`)

| type | args | data |
|---|---|---|
| `snapshot` | `{ root?: string }` (a CSS selector, default `body`) | `{ url, title, tree }`: the accessibility tree, compact text: one line per node `role "name" [value] {states}`, indented; regions, buttons, inputs, headings, tables (first rows), dialogs, toasts |
| `screenshot` | `{ target?: "map" \| "page", maxWidth?: number }` | `{ dataUrl }` (PNG; `map`: the editor's canvas, or its 3D view while that shows; `page`: the whole page, best effort) |
| `state` | `{ keys?: string[] }` (`sketch`, `selection`, `stats`, `problems`, `view`, `run`, `ui`); or `{ path }`; or `{ watch: string[] }` | `{ [key]: value }` (sketch: counts and ids, not the whole JSON; ask `sketchJson` for that); `{ [path]: value }`; `{ watching }` (see "UI state") |
| `click` | `{ role?, name?, nth?, selector?, text? }` | `{ clicked: "<role> \"<name>\"" }` |
| `type` | `{ role?, name?, selector?, text, submit?: boolean }` | `{ typed }` |
| `key` | `{ key: string }` (e.g. `"Control+k"`, `"Escape"`) | `{}` |
| `navigate` | `{ url }` (same origin) | `{ url }` |
| `app` | `{ action, args }`: `select` `{ kind, id }`, `goTo` `{ kind, id }`, `view` `{ x, y, scale? }`, `run`, `pause`, `speed` `{ speed }` (1, 3, 10, 30…), `replay` `{ t }`, `restart`; on a V2 plan also `panel`, `console`, `search`, `layers`, `sort`, `sketchWindow` (see "UI state") | `{}` or what the action returns |

Targets by role and name follow Playwright's `getByRole` (name: case-insensitive substring unless `exact`).
Every command is shown to the user in the activity log; `click` / `type` / `key` move the agent's cursor there first
(about 300 ms) so the user sees it. Commands that would edit the plan go through the normal undo.

## UI state (a V2 plan's editor)

A V2 plan keeps its editors' UI state in one store (`src/state/sketch-ui.ts`), and the bridge reads it as it is:
nothing is registered by hand, so a field added there is readable at once. Small (about 1 KB; lists over 200 items come
as `{ first, count }`), with no plan data, no results, nothing private, nothing each frame.

```
{ active: "plan" | "scratch",            // the editor the user is at: the Sketch window's while open and last used
  editors: { plan: Editor, scratch: Editor },    // the plan's, and the Sketch window's (Test in Sketch)
  panels: { closed: { [panelId]: true } },       // the inspector's panels folded away (both editors')
  sketchWindow: { open, test: { cut, mode, run }, lastPiece: { junctions, lanes, mode, at } | null },
  layers: { surfaces, markings, lanes, connectors, signs, cars, names, demand, grid, satellite, image },  // shown or not
  background: { brightness, source },             // the satellite imagery's
  display: { carsBySpeed } }                      // the cars coloured by speed, or all one colour
Editor = { mode: "plan" | "3d",                  // the map from above or in 3D (the plan's editor; the Sketch window's later)
           tool, selection: { lanes, connectors, junctions, road, link?, crossing? }, point, car, follow,
           view: { cx, cy, scale },        // at most 4 times a second
           run: { running, speed, t, replayT, playing, kept },   // t: at most 4 times a second
           dialogs: { search: { open, query }, console: { open, kind, text, clearedAt }, settings,
                      optimizer: { open, junction, chosen, effort, stage } },
           tables: { junctions: { by, flip, shown }, roads: { by, flip, shown } } }   // the results tables' sort
```

Changes an agent may ask for (`app`; no others, nothing written by path):

| action | args | does |
|---|---|---|
| `panel` | `{ id, open }` | folds an inspector panel away or opens it (ids: `selection`, `traffic`, `fuel`, `demand`, `junction-results`, `road-results`, `test-in-sketch`, `background`, `car`, `crossing`) |
| `console` | `{ open?, kind?, text?, editor? }` | the problem console: open or close it, show one kind (`all`, `stuck`, `collision`, `jump`, `deadlock`, `breakdown`, `towed`), filter its lines |
| `search` | `{ open, query?, editor? }` | the search box (Cmd/Ctrl+K), with what is typed in it |
| `mode` | `{ mode: "plan" \| "3d", editor? }` | the plan's map from above or in 3D, as the header's Plan / 3D switch (the plan's editor only, for now) |
| `sketchWindow` | `{ open? }` | the Sketch window over the plan opened or closed (without `open`: the other way), as the top bar's Sketch button does |
| `layers` | `{ set: { [id]: boolean } }` | layers shown or hidden (ids as in `layers`), kept in the browser as the user's own are |
| `sort` | `{ table: "junctions" \| "roads", by, flip?, editor? }` | a results table sorted: `name`, `rate`, `delay`, `queue`, and `fuel` (junctions) or `speed` (roads); `flip`: the other way |

`editor`: `plan` or `scratch` (the Sketch window, if open); without it, the editor the user is at.

Every action's arguments are checked as they are given: `true` or `false` for a switch (not `"yes"`, `1` or `null`), a
string for a name or text (not `42`), a number for a number; and within what the editor offers: `view` a scale from
0.3 to 80 px a metre and x, y within 1,000 km of the plan's origin, `speed` 1, 3, 10 or 30, `select`/`goTo` something
that is there (a car on the plan now), `panel` its `open` given. Anything else, an unknown panel or layer, or a missing
argument, is an error saying what was expected, and nothing is changed.

- `state { keys: ["ui"] }`: all of it (also in the default answer with no keys).
- `state { path: "editors.plan.selection" }` (dots or slashes): one part. A path that isn't there is an error naming
  the top-level keys.
- `state { watch: ["editors.plan.selection", "active", …] }`: the page sends the agent a `ui` event when any of those
  changes, at most 4 a second, the changes since the last one together. The list belongs to the page: a new `watch`
  replaces it, `watch: []` ends it, and it ends with the pairing or when another agent takes the page over. A path
  that isn't there is an error, and the list stays as it was.

The plan's own data stays out (`sketch`, `sketchJson`), and so do the account menu and the bridge's own panel.

## Events (page → agent)

```
{ seq, at, kind: "annotation", note, rect: { x, y, w, h }, screenshot?: dataUrl,
  under: { roles: string[], map?: { x, y, lanes: string[], connectors: string[], junctions: string[], car?: number } },
  url, simT? }
{ seq, at, kind: "message", text }
{ seq, at, kind: "ui", changed: { [path]: value } }   // the UI state watched changed (see above)
```

Events go to the agents of that page: a tab's own agent, the hub's to the agent driving it. An agent keeps its last
200 annotations and messages, and apart from them its last 50 `ui` events, so watching never pushes out what the user
sent.

## Agent tabs (several agents, tabs of their own)

The page the user pairs with "Connect Claude" is the **hub**. The agent that claims the hub's own code drives the hub (as
above). More agents can be attached from the hub's panel: **Add agent** shows a fresh 6-digit code per agent (10 min); an
agent claiming it (`POST /api/bridge/agent/claim`, same as above; the answer has `drivesHub: false`) works only in tabs of
its own. Each agent has its own token, colour and events; the panel lists the agents with **Revoke**.

Opening a tab (only once the user has switched on **Allow agent tabs** in the hub's panel; off by default):

1. Agent: `POST /api/bridge/agent/open-tab { url, label?, task? }` (`url`: a page of this app, a path like `/plans/<id>` or a
   URL of this site; never `/api/*`). The server makes a single-use **ticket** (60 s) bound to that agent and sends the hub
   `event: openTab` `{ ticket, url, label, task, agent, color }`.
2. Hub: `window.open(url#bridge-ticket=<ticket>)`. If the browser blocks it (no user gesture), the hub's panel asks
   "Ramona wants to open a tab: … [Open] [Deny]" (one click opens it; Deny: `POST /api/bridge/page/deny-tab { ticket }`), and
   says that allowing pop-ups for this site makes it automatic.
3. The new tab's BridgeProvider sees the ticket, pairs as that agent's tab (`POST /api/bridge/page/pair { ticket }` →
   `{ pageId, pageToken, agent, color, label, task }`), takes the ticket out of the address and says hello.
4. The agent's call answers `{ ok: true, pageId }` once the tab has paired, or `{ pending: true }` after 25 s (the request
   stands until the ticket expires: `bridge_tabs` shows the tab when it opens).

At most 3 open tabs per agent (`MAX_TABS` in src/server/bridge.ts). Commands take an optional `pageId`
(`POST /api/bridge/agent/command { type, args, pageId? }`); without it they go to the tab the agent opened last, else to the
hub if it drives it. An agent only ever reaches its own pages; another agent's tab or the hub (unless it drives it) answer
"Not one of your pages". Events (annotations, messages) from a tab go to its agent only; from the hub, to the agent driving it.

| route | | |
|---|---|---|
| `GET /api/bridge/agent/tabs` | agent | `{ tabs: [{ pageId, url, title, label, task, connected, paused, left }] }` |
| `POST /api/bridge/agent/close-tab { pageId }` | agent | its own tab only; the tab closes itself where the browser lets it |
| `POST /api/bridge/page/allow-tabs { on }` | hub | |
| `POST /api/bridge/page/agent-code` | hub | `{ code, expiresAt }` |
| `POST /api/bridge/page/revoke { agentId }` | hub | the agent's token ends; its tabs stay open for the user, marked "Ramona left" |
| `POST /api/bridge/page/pause { paused, tabId? }` | tab (Take over), or hub with `tabId` | commands to it answer "paused by user" until resumed |
| `POST /api/bridge/page/close-tab { tabId }` | hub | |

Streams: the hub also gets `event: hub` `{ allowTabs, agents: [{ id, name, color, hub }], tabs: [...] }` on every change
(and the requests still open when it reconnects); a tab gets `event: tab` `{ agent, color, label, task, paused, left }`.

Each tab is marked as the agent's: its title prefixed "● Ramona · T34 — …", its favicon a dot in the agent's colour, a frame
round the window in that colour and a bar "Ramona is working here · T34 · <label> [Take over] [Close]", the agent's cursor and
toasts in its colour. The hub's panel lists every agent tab (agent, label, live/paused/left) with Focus (where the browser
lets a page bring another tab forward), Pause/Resume and Close. Disconnecting the hub ends its agents and their tabs'
pairings. Closing a tab ends its pairing (the agent sees it gone from `bridge_tabs`).

MCP tools (scripts/claude-bridge-mcp.ts): every page tool takes an optional `pageId`; new: `bridge_open_tab { url, label?,
task? }`, `bridge_tabs`, `bridge_close_tab { pageId }`; `bridge_pair` takes either kind of code.

## Guardrails

Admins only; pairing by code shown in the page; a visible badge while attached, one-click disconnect; no
arbitrary JavaScript; cookies and tokens never sent to the agent; every command logged in the page. No typing in or reading
of password fields; the bridge's own UI (panel, tab bar) is out of the agent's reach; pages of this app only (never its API).
Agent tabs: only with the user's leave (Allow agent tabs), each agent only in its own tabs, a tab taken over at any time;
an agent token can't drive the hub unless the user paired that agent with the hub's own code.
