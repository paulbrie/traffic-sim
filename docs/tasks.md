# Team tasks

The task log of the Claude Code sessions working on this project (and on the admin's Comms / Agents City in
`/opt/project/admin`). Kept by Alice (the manager), the only one who edits this file; the tagged messages between
sessions (`TASK:` `ACK:` `STATUS:` `BLOCKED:` `DONE:` `CANCELLED:` `CLAIM:` `RELEASE:` `COMMIT:` `PUSHED:`) are the
source of truth, this is their summary. No credentials or private data here.

Team: **Alice** (manages), **Bob** (simulation, editor), **Tatiana** (editor features), **Ramona** (tests),
**Alex** (admin: Comms, Agents City), **Tom** (Agents City's Desk mode).

Commits are in this repo unless marked `admin:` (`/opt/project`). "admin-dev" = built and previewed, not committed
(the user commits and deploys the admin).

## Open

| Id | Task | Owner | Since | Notes |
|---|---|---|---|---|
| T52 | V1→V2 quick wins: per-road speed limits, hover cards, zoom keys and cursor x/y, a colour-by-speed switch with a legend, the sim settings that map | Tatiana | 2026-10-09 | |
| T50 | Re-test of T48, and a smoke test of Next.js 16.4 | Ramona | 2026-10-09 | |
| T49 | Next.js 16.3 → 16.4.0 in trafficsim, then the admin (after the user's deploy) | Alex | 2026-10-09 | |
| T46 | Regressions after 5e8d5b7: a deadlock loop at J21 (Strada Sigmirului), collisions on l1945 after J574 | Bob | 2026-10-09 | from T45 |
| T43 | Agents City: React "synchronously unmount a root" warning (32× per load, drei Html labels) | Alex | 2026-10-09 | after T42 |

## Done

| Id | Task | Owner | Done | Commits / result |
|---|---|---|---|---|
| T51 | genie: resize Taz VMs (API client with a 5 min timeout, manager handler with progress, agent tool marked disruptive, admin card Resize dialog), tests on mocks | Alex | 2026-10-09 | genie: bdf04a4 |
| T39 | Agents City Desk mode (behind ?desk=1): seated avatars with laptops, miniature cities, thrown messages, a live task whiteboard | Tom | 2026-10-09 | admin: 00c1948 |
| T48 | V2 central UI store read by the Claude bridge: per-editor tool, selection, view, run, dialogs, tables; layers, panels, Sketch window, background; ui reads, watch and events; a closed list of actions | Tatiana | 2026-10-09 | d2edce8, 4c47de4, a91a6f3, 1b4a117 |
| T47 | Re-test of T44: all 9 pass, nothing new | Ramona | 2026-10-09 | /tmp/ramona/t47/ |
| T44 | Test in Sketch fixes from T34: a fresh sim on Replace, the kept connectors, imagery in the window, Add's fit, copy names, tree ids, per-lane rates, Shift+T, whole junctions | Tatiana, Bob | 2026-10-09 | f1dcebf, 72b001e |
| T45 | Bistrița after 5e8d5b7 (seeds 1–3): J574 and j747 fixed; new J21 deadlock loop, collisions on l1945/l1946, a two-car lock that re-forms after letting go (deadlocks 22 / 56 / 64) | Ramona | 2026-10-09 | report → T46 |
| T37 | Bistrița rev 89 follow-ups: false crossings between chained lanes fixed (J574, j747); J593 a phantom (optional removal); J356 is capacity | Bob | 2026-10-09 | 5e8d5b7 |
| T42 | Admin tree ready to deploy: agents3d-view.tsx back to its own style, Desk toggle re-applied (hidden behind ?desk=1), full production build check | Alex, Tom | 2026-10-09 | admin-dev |
| T34 | Independent test of Test in Sketch | Ramona | 2026-10-09 | report → T44 |
| T41 | Claude bridge "agent tabs": a hub page, per-agent codes and tokens, labelled agent tabs (title, favicon, frame, Take over), popup prompt, 3 tabs per agent | Bob | 2026-10-09 | a4af1b2 |
| T40 | Fixed agent colours by name, shared by Comms, City and Desk | Alex | 2026-10-09 | admin-dev |
| T38 | Small UI leftovers: search keys typed while it opens, panel header overflow, compass names in a junction's roads (the font 404 is Next's own, skipped) | Tatiana | 2026-10-09 | 7eb4653 |
| T36 | Proposal and sample avatar for the Desk mode | Tom | 2026-10-09 | approved by the user |
| T35 | Search: an exact name ranks first; car numbers need "#" | Tatiana | 2026-10-09 | 8b20b6c |
| T33 | Re-test of T19, and a before/after baseline on Bistrița (rev 88 → 89) | Ramona | 2026-10-09 | /tmp/ramona/ |
| T32 | Agents City: the replay bar as a video-editor timeline | Alex | 2026-10-09 | admin-dev |
| T31 | Bistrița: roundabouts at J572 and in place of the loop by J741 (user-approved) | Bob | 2026-10-09 | 9c5d258 (stamp fix); plan rev 89 |
| T30 | Agents City: the cities on a planet under a starry sky | Alex | 2026-10-09 | admin-dev |
| T29 | Agents City: time windows 1h · 8h · 1d · 3d · 7d | Alex | 2026-10-09 | admin-dev |
| T28 | Agents City: clicking an agent flies the camera to it | Alex | 2026-10-09 | admin-dev |
| T27 | Comms / Agents City: holders only from CLAIM, the CANCELLED tag, stale guessed tasks dropped | Alex | 2026-10-09 | admin-dev |
| T26 | Agents City: each agent's tmux pane live in its card (redacted, read-only) | Alex | 2026-10-09 | admin-dev |
| T25 | Port Comms and Agents City onto the reset GitHub history | Alex | 2026-10-09 | admin: 46b1722, 572db58 (pushed by the user) |
| T24 | Agents City: lightning lingers, then fades | Alex | 2026-10-09 | admin-dev |
| T23 | Commit the deployed admin work | Alex | 2026-10-09 | admin: 9b75bef, be4f895 |
| T22 | Agents City: full screen | Alex | 2026-10-09 | admin-dev |
| T21 | Test in Sketch: any portion of the plan into the Sketch window in one step | Tatiana | 2026-10-09 | cb21dc9 |
| T19 | Leftovers from T17: the plan loaded in a layout effect, copy with connectors and lanes (system clipboard too), J709's panel, replay keys, same-named roads | Tatiana | 2026-10-09 | add4c71 |
| T18 | Agents City: keep City only (Orbit and Helix removed) | Alex | 2026-10-09 | admin-dev → admin |
| T17 | Re-test of T10 | Tatiana | 2026-10-09 | |
| T16 | Agents City: choose which projects to show | Alex | 2026-10-09 | admin |
| T15 | Agents City: lightning from each agent to what it works on | Alex | 2026-10-09 | admin |
| T14 | Admin: the theme script's React warning | Alex | 2026-10-09 | admin |
| T13 | Admin preview: a stale build cache after an install | Alex | 2026-10-09 | — |
| T12 | Search without accents, roads told apart; Demand's duplicate way names | Tatiana | 2026-10-09 | 4903eab, ea8183b, 3c1e69c |
| T11 | Bistrița: the gridlock's causes (J572, the loop by J741), collisions at ways in | Bob | 2026-10-09 | d1c45a2 |
| T10 | UI bugs from the smoke test (overflow, console over replay, focus, roundabout across a lane, wording, undo / unsaved) | Bob | 2026-10-09 | 06dc863, 7975767 |
| T9 | Keys for the layers (1–9, 0, Shift, `, Shift+L) | Bob | 2026-10-09 | 3d58944 |
| T8 | Comms: message bodies formatted | Alex | 2026-10-09 | admin |
| T7 | Three 3D views of the agents (City, Orbit, Helix) | Alex | 2026-10-09 | admin (City kept, T18) |
| T6 | Proposal for a 3D view of the agents | Alex | 2026-10-09 | — |
| T5 | Claude bridge: the agent's run starts the cars | Bob | 2026-10-09 | 812346e |
| T4 | Browser smoke test of the day's V2 features | Tatiana | 2026-10-09 | report → T10, T11, T12 |
| T3 | Claude bridge: the page's side (Connect Claude, commands, cursor, annotations) | Bob | 2026-10-09 | e4d5abc |
| T2 | Per-road counters in the simulation | Bob | 2026-10-09 | 6d37b13 |
| T1 | Problem console | Bob | 2026-10-09 | 6d37b13 |

## Cancelled

| Id | Task | Owner | Why |
|---|---|---|---|
| T20 | Deploy Comms and Agents City to /admin | Alex | the user deployed it themselves |
