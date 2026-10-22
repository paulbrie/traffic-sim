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

**How it stands, in the panel (T193).** The hub's code counts down (`expiresAt`); expired unused, the panel says so and
offers a new code; used, it says by whom and when (the `hub` event's `codesUsed`: the last 8 codes claimed, the hub's own
and Add agent's). Each agent in the `hub` event carries `pairedAt` and `lastSeen` (its last bridge call; the hub is told
at most every 15 s, the page counts the time since): "seen 20 s ago", or "quiet 5 min" with what that means (an agent acts
only while its session works). A message still "sent" after 20 s gets a line on why (who fetches it, when it last looked).
When the stream drops the page asks the server (`hello`) whether the pairing still stands: 404, the server no longer knows
it (a restart, or it ended): "Pairing lost", with why and "Pair again"; 401/403, signed out, the same; the server out of
reach, "reconnecting…" and the pairing kept.

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
- `GET /api/bridge/agent/status` → `{ page: { url, title, connected } | null, pairedUntil }`.

## Commands (`type`, `args` → `data`)

| type | args | data |
|---|---|---|
| `snapshot` | `{ root?: string }` (a CSS selector, default `body`) | `{ url, title, tree }`: the accessibility tree, compact text: one line per node `role "name" [value] {states}`, indented; regions, buttons, inputs, headings, tables (first rows), dialogs, toasts, and a `<p>` or other mixed-content element's own text (not swallowed by its children's) |
| `screenshot` | `{ target?: "map" \| "page", maxWidth?: number }` | `{ dataUrl }` (PNG; `map`: the editor's canvas, or its 3D view while that shows; `page`: the whole page, best effort) plus `note` if the tab is hidden (`document.visibilityState`): a background tab stops painting, so the picture may be stale |
| `state` | `{ keys?: string[] }` (`sketch`, `selection`, `stats`, `problems`, `view`, `run`, `experiment`, `visibility`, `ui`; not in the default keys, only by name: `browserConsole`); or `{ path }`; or `{ watch: string[] }` | `{ [key]: value }` (sketch: counts and ids, not the whole JSON; ask `sketchJson` for that; `experiment`: `{ on }`, or on: `{ on, stats, hasJunction }`; `visibility`: `{ visible, state }`, `document.visibilityState`; `browserConsole`: the page's last 50 uncaught errors, unhandled rejections and `console.error`/`warn` lines — not a worker's, which don't reach this thread's console); `{ [path]: value }`; `{ watching }` (see "UI state") |
| `click` | `{ role?, name?, nth?, selector?, text? }` | `{ clicked: "<role> \"<name>\"" }` |
| `type` | `{ role?, name?, selector?, text, submit?: boolean }` | `{ typed }` |
| `key` | `{ key: string }` (e.g. `"Control+k"`, `"Escape"`) | `{}` |
| `navigate` | `{ url }` (same origin; an absolute path missing the app's base, e.g. `/plans/x`, is still read as under it, not the origin's root; to the page already shown: a real reload, `router.push` being a no-op there) | `{ url }` (always the full URL, base path included) |
| `reload` | `{}` | `{}` (a real `location.reload()`, not `router.push`: for a dynamically-imported module — a worker, say — still the old code after a merge, that hot reload didn't swap) |
| `app` | `{ action, args }` (edits too, with the user's leave: see "Edits"): `select` `{ kind, id }`, `goTo` `{ kind, id }`, `view` `{ x, y, scale? }` (clears a car followed first: it would otherwise move the view right back, every frame), `run`, `pause`, `speed` `{ speed }` (1, 3, 10, 30, 50, 100), `replay` `{ t }`, `restart`, `testCar`, `runUntil` `{ t }` (runs at the speed set until sim time `t`, or 25 s real time first — then `{ reached: false }`, left running: call again or raise the speed; the Sketch window's experiment's own clock while that's on), `carsAt` `{ x, y, r? }` (r: metres, default 10 — `{ cars: [{ id, x, y, kind: "lane" | "sensing", why? }] }`, `why` the main engine only so far; whichever engine is on, live or replayed), `experiment` `{ on }` (the Sketch window's spatial-roundabout switch, as its own Switch) (see "UI state"); on a V2 plan also `route`, `mode`, `panel`, `console`, `search`, `layers`, `sort`, `sketchWindow` (see "UI state") | `{}` or what the action returns |
| `report` | `{ title, intro?, table?: { columns, rows, highlight?, note? }, findings?: string[] }` (T196, `bridge_report`: plain text and numbers, at most 14 columns, 60 rows, 24 findings) | `{ shown }`: the report in a window over the page, kept in the Claude panel (the last 10) to open again, copied as text from there |

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
           camera: { x, y, distance, heading, tilt } | null,   // in 3D (null from above): the point looked at (m), how far off (m),
                                           // heading (° clockwise from north), tilt (° from straight down); at most 4 times a second.
                                           // Escape, with nothing else to do (no draft, nothing selected, no car picked), eases it back
                                           // to where it arrived on entering 3D (`key` { key: "Escape" })
           run: { running, speed, t, replayT, playing, kept, tune },   // t: at most 4 times a second; tune: the simulation
                                           // settings changed from their defaults, as saved (e.g. { junctionRules: 1, ringLanes: 1 })
           dialogs: { search: { open, query }, console: { open, kind, text, clearedAt }, settings,
                      optimizer: { open, junction, chosen, effort, stage } },
           tables: { junctions: { by, flip, shown }, roads: { by, flip, shown } },   // the results tables' sort
           route: { from, to, result: { ok, steps, length, freeTime } | { ok: false, reason } | null,   // the route tracer
                    test: { car, t0, state: "driving" | "arrived" | "gone", time, stops, path, otherWay } | null } }   // its test car
```

Changes an agent may ask for (`app`; no others, nothing written by path):

| action | args | does |
|---|---|---|
| `panel` | `{ id, open }` | folds an inspector panel away or opens it (ids: `selection`, `traffic`, `fuel`, `demand`, `junction-results`, `road-results`, `test-in-sketch`, `background`, `car`, `crossing`) |
| `console` | `{ open?, kind?, text?, editor? }` | the problem console: open or close it, show one kind (`all`, `stuck`, `collision`, `jump`, `deadlock`, `breakdown`, `towed`), filter its lines |
| `search` | `{ open, query?, editor? }` | the search box (Cmd/Ctrl+K), with what is typed in it |
| `route` | `{ from, to, editor? }` or `{ clear: true }` | the route tracer from a lane to an exit lane; the page works it out (read `editors.<editor>.route.result`: the steps in order, metres, seconds at the speed limits; or why there is none) |
| `testCar` | | a test car on the route traced, as the Route panel's "Send a test car": `{ car }` (its number, negative), the cars running and the view following it; an error if no route is traced or there is no room where it starts. Its trip in `editors.<editor>.route.test`: driving, arrived or gone, its time (s) so far or in all, the times it stood still 2 s or more, the edges it drove (`lane:…`, `conn:…`) and `otherWay` if it went a longer way than the one traced (drawn in blue; another lane of the same road, or a way as short give or take the 5 m the cars choose within, doesn't count). Kept until the route changes or the cars start again |
| `mode` | `{ mode: "plan" \| "3d", editor? }` | the plan's map from above or in 3D, as the header's Plan / 3D switch (the plan's editor only, for now) |
| `sketchWindow` | `{ open? }` | the Sketch window over the plan opened or closed (without `open`: the other way), as the top bar's Sketch button does |
| `layers` | `{ set: { [id]: boolean } }` | layers shown or hidden (ids as in `layers`), kept in the browser as the user's own are |
| `sort` | `{ table: "junctions" \| "roads", by, flip?, editor? }` | a results table sorted: `name`, `rate`, `delay`, `queue`, and `fuel` (junctions) or `speed` (roads); `flip`: the other way |

`editor`: `plan` or `scratch` (the Sketch window, if open); without it, the editor the user is at.

Every action's arguments are checked as they are given: `true` or `false` for a switch (not `"yes"`, `1` or `null`), a
string for a name or text (not `42`), a number for a number; and within what the editor offers: `view` a scale from
0.3 to 80 px a metre and x, y within 1,000 km of the plan's origin, `speed` 1, 3, 10, 30, 50 or 100, `select`/`goTo` something
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

## Edits (T189: an agent building in the user's page)

Only with the user's leave: **Allow agent edits** in the hub's Claude panel, **Off** by default; **This sketch only** (the sketch
the Sketch window has open when it is chosen: the plan's and the sketch's ids are kept, shown as `Only "<name>"`); or **Plan
and its sketches**. The server keeps it (`POST /api/bridge/page/allow-edits { permit }`; in the `hub` event as `allowEdits`,
in `bridge_status` too) and holds for the hub's agents' tabs as well. An edit action while it is off is refused by the server
(403, "Agent edits are off…"); the leave is sent to the page with each edit (set by the server, never taken from the agent),
and the page checks the editor and the sketch against it: with one sketch only, the plan's editor, another plan, or another
sketch in the Sketch window are refused, and so is picking or making sketches.

Each edit is an `app` action (args checked strictly, as the others: a number for a number, the lane or connector there, and
an unknown key refused, so a typo isn't quietly ignored), applied to the editor's sketch through its store: **one undo step**,
saved as the user's edit would be (Undo takes it back). The agent's cursor goes to where it was, with a few words by it
("added connector c13 (l4 → l9)") and in the line saying what it did; the activity log says "edited by <agent>: …".
`editor`: `plan` or `scratch` (the Sketch window); without it, the editor the user is at (with one sketch only: the Sketch
window). Points are `{ x, y }` in metres, as the map's; `s`: metres along a lane from its start.

| action | args | data |
|---|---|---|
| `addLane` | `{ points: [{x,y}, …] (2+), width? (2–6 m, 3.5), speed? (km/h), level?, curved? }` | `{ lane, length }` |
| `deleteLanes` | `{ lanes: [id] }` (their connectors go; a road left with none goes) | `{ deleted, roadsGone }` |
| `reshapeLane` | `{ lane, points }` (a line lane; its connectors kept within its new length) | `{ lane, length }` |
| `movePoint` | `{ lane, i, x, y }` | `{ lane, i }` |
| `addConnector` | `{ from: { lane, s? (its end) }, to: { lane, s? (its start) }, bends?: [{x,y}], straight? }` | `{ connector, from, to }` |
| `deleteConnectors` | `{ connectors: [id] }` | `{ deleted }` |
| `moveConnectorEnd` | `{ connector, end: "from" \| "to", s }` | `{ connector, [end] }` |
| `setControl` | `{ lanes: [id], control: "yield" \| "stop" \| "none" \| "lights" }` (lights: on the junctions the lanes lead into, their signs taken off) | `{ lanes, control, junctions? }` |
| `setLights` | `{ junction, on }` | `{ junction, lights }` |
| `groupRoad` | `{ lanes: [id], name? }` (out of the roads they were in) | `{ road, name, lanes }` |
| `addJunction` | `{ outline: [{x,y}, …] (3+), name? }` | `{ junction, name }` |
| `deleteJunctions` | `{ junctions: [id] }` (their lanes and connectors kept) | `{ deleted }` |
| `roundabout` | `{ x, y, r (8–80 m) }` (as the Roundabout tool: the roads it crosses cut and joined to its ring) | `{ junction, ring }` |
| `batch` | `{ actions: [{ action, args }] }` (at most 50): one undo step, all or nothing (the first error says which and nothing is done); `"$k"` as an argument (a lane, a connector…): the id the k-th action made, e.g. `{ from: { lane: "$0" }, to: { lane: "l7" } }` | `{ results }` |
| `openSketch` | `{ id }` (Plan and its sketches only) | `{ open, name, sketches }` |
| `newSketch` | `{ name? }` (opened) | `{ open, name, made, sketches }` |
| `duplicateSketch` | `{ id? (the one open), name? }` (opened) | `{ open, name, made, sketches }` |

The edits themselves: `src/lib/bridge-edits.ts` (framework-free, checked by `npm run engine:check`); the page's side:
`src/state/bridge-edits.ts` (the editors on the page offer themselves; the leave checked there).

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

**Delivery (T191).** The agent side fetches events in `bridge_wait_events`, and also, without waiting, after every other
bridge tool call: what came meanwhile follows that tool's answer ("Meanwhile, from the page…"). So an agent at work in the
page sees a message at its next bridge call. An agent not using the bridge at all can't be woken by the MCP server: it
sees them when it next calls a bridge tool. Each message and note carries a `msgId` from the page. The first time an
agent fetches it, the server tells the page (`event: delivered { msgId, agent, at }`), and the panel's log shows it as
"sent", then "delivered to <agent>"; "no agent" if no agent was connected to take it (the page's post answers `{ to }`,
how many agents it went to).

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
agent edits: only with the user's leave (Allow agent edits: one sketch, or the plan), kept and checked by the server, each
one undo step and shown;
an agent token can't drive the hub unless the user paired that agent with the hub's own code.
