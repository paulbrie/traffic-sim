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
| `screenshot` | `{ target?: "map" \| "page", maxWidth?: number }` | `{ dataUrl }` (PNG; `map`: the editor's canvas, `page`: the whole page, best effort) |
| `state` | `{ keys?: string[] }` (`sketch`, `selection`, `stats`, `problems`, `view`, `run`) | `{ [key]: value }` (sketch: counts and ids, not the whole JSON; ask `sketchJson` for that) |
| `click` | `{ role?, name?, nth?, selector?, text? }` | `{ clicked: "<role> \"<name>\"" }` |
| `type` | `{ role?, name?, selector?, text, submit?: boolean }` | `{ typed }` |
| `key` | `{ key: string }` (e.g. `"Control+k"`, `"Escape"`) | `{}` |
| `navigate` | `{ url }` (same origin) | `{ url }` |
| `app` | `{ action, args }`: `select` `{ kind, id }`, `goTo` `{ kind, id }`, `view` `{ x, y, scale? }`, `run`, `pause`, `replay` `{ t }`, `restart` | `{}` or what the action returns |

Targets by role and name follow Playwright's `getByRole` (name: case-insensitive substring unless `exact`).
Every command is shown to the user in the activity log; `click` / `type` / `key` move the agent's cursor there first
(about 300 ms) so the user sees it. Commands that would edit the plan go through the normal undo.

## Events (page → agent)

```
{ seq, at, kind: "annotation", note, rect: { x, y, w, h }, screenshot?: dataUrl,
  under: { roles: string[], map?: { x, y, lanes: string[], connectors: string[], junctions: string[], car?: number } },
  url, simT? }
{ seq, at, kind: "message", text }
```

## Guardrails

Admins only; pairing by code shown in the page; a visible badge while attached, one-click disconnect; no
arbitrary JavaScript; cookies and tokens never sent to the agent; every command logged in the page.
