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
| T78 | Agents City / Table: ghost duplicates after the restart (one agent per name, ended sessions merged, guests flagged) | Alex, Tom | 2026-10-09 | model done (Alex); Tom: guest toggle |
| T74 | V2 route tracer (from V1): pick a way in, a way out and a lane, draw the route, send a test car | Tatiana | 2026-10-09 | |
| T73 | Re-test of the 3D view (T62) | Ramona | 2026-10-09 | after T68, T72 |
| T72 | Re-test of T69 | Ramona | 2026-10-09 | after T68 |
| T68 | Bistrița with repeatable runs (7b27441): repeatability check, every collision with seed and time, deadlocks per place | Ramona | 2026-10-09 | after T66 |
| T56 | Bistrița after T46: lane-change standoffs (l2847–l2849, l14/l15), the deadlocks left by 900 s, held-back arrivals shown | Bob | 2026-10-09 | |

## Done

| Id | Task | Owner | Done | Commits / result |
|---|---|---|---|---|
| T50 | Re-test of T48 plus a Next.js 16.4 smoke test: all pass; 3 bridge input-check bugs, a one-off glitch | Ramona | 2026-10-09 | /tmp/ramona/t50/ → T59 |
| T52 | V1→V2 quick wins: per-road speed limits, hover cards, zoom keys and lat/lon, a colour-by-speed switch, five sim settings (identical runs at the defaults) | Tatiana | 2026-10-09 | 9a32774, cf4a7d8, cad3d57, 6949407, de8031e |
| T55 | Bistrița after T46 (rev 91, seeds 1–3, 5/10/15 min): 5-min deadlocks 22/56/64 → 0/0/4; a new ping-pong on the Strada 1 Decembrie overlap (seed 3); l2607/l1945 collisions; saturation by 10 min | Ramona | 2026-10-09 | /tmp/ramona/t55/ → T56 |
| T69 | History from file: Restore keeps what the file lacks, cleared fields in red, the dialog after a conflict, "Applied from file" | Alex | 2026-10-09 | 7c39383 |
| T66 | Test of History from file: Apply passes; Restore with Copy JSON drops geo and journeys; conflict dialog stale | Ramona | 2026-10-09 | /tmp/ramona/t66/ → T69 |
| T60 | Re-test of T59 and T52: all pass; more bridge arguments accepted; same seed not repeating after Clear the cars | Ramona | 2026-10-09 | /tmp/ramona/t60/ → T67, T56 |
| T70 | Admin: a Team menu (Teams; Comms, Agents City, Tasks) and a Kanban task board with filters and a task's thread; /chrome owners of agent-browser sessions | Alex | 2026-10-09 | admin (deployed 20:50) |
| T62 | The 3D view in V2, phase 1: toggle, orbit camera, imagery, roads, junctions, markings, bridges, cars, live lights, picking with overlays at their height; bridge mode and 3D screenshots | Tatiana | 2026-10-09 | 6cd84df, 1507df6, 3b20b0b, 119d579 |
| T76 | The deployed admin work as one clean commit on origin/main (only our features) | Alex, Alice | 2026-10-09 | admin: 403e63d |
| T79 | Agents City Table: no headphones on the avatars (Alex's headset removed) | Tom | 2026-10-09 | admin, next deploy |
| T77 | Agents City Table: the thought cloud fades in or out in 0.6 s on wall-clock time | Tom | 2026-10-09 | admin, next deploy |
| T75 | The shared task parser: STATUS/DONE without ACK, several ids in one tag, TASK after a lead-in, untagged progress notes | Alex | 2026-10-09 | admin (deployed 20:50); follow-ups: DONE only from the owner, T56 |
| T65 | Agents City Table: round table, thinking cloud and 9 postures, working pose, glowing links, 8 dances, laptop closed for naps, longer bubbles, 4-line post-its | Tom | 2026-10-09 | admin (deployed 20:50) |
| T71 | Admin /chrome: the stream fixed (direct DevTools capture; the global Playwright it called was missing), pipe instances explained, owners, failure messages | Alex | 2026-10-09 | admin (deployed 20:50) |
| T67 | Fixes from T60: strict bridge arguments (required, ranges, ids that exist), editors open on Select, the lat/lon readout on a pill | Tatiana | 2026-10-09 | fad11f8 |
| T64 | V2 History: "Apply changes from file" (partial, by id, nothing removed) and "Restore from file", with summaries, a note, conflict check, server-side merge | Alex | 2026-10-09 | 7e8757c |
| T61 | Agents City Table: speech bubbles, laptop-to-file threads, thinking and idle poses, column close-ups, 3-line post-its with elapsed times, LED task tickers | Tom | 2026-10-09 | admin (deployed 20:50) |
| T63 | Admin terminals: position and size remembered per terminal, kept inside the viewport (not while dragging), bad values ignored | Alex | 2026-10-09 | admin (deployed 20:50) |
| T58 | Admin: team recipes and a Teams page (start, stop with STATUS requests, restart, close; recipe checks; live check with a throwaway Haiku team) | Alex | 2026-10-09 | admin (deployed 20:50) |
| T59 | Fixes from T50: one argument validator for the bridge's actions, known panel ids only, docs, the editors' reset survives a remount, the replay bar leaves the map's buttons clear | Tatiana | 2026-10-09 | 72def88, 57f3147, ef48624, 2173ed8 |
| T57 | Agents City Table: labels on OverlayLabel (no removeChild) | Tom | 2026-10-09 | admin: ee5e444 |
| T49 | Next.js 16.4.0 in trafficsim and the admin | Alex | 2026-10-09 | b086f22; admin: ee5e444 (deployed) |
| T54 | Agents City: collapsible side panel and sections | Tom | 2026-10-09 | admin: ee5e444 |
| T53 | Agents City: City / Table switch for everyone (T key, deep links) | Tom | 2026-10-09 | admin: ee5e444 |
| T46 | Bistrița after 5e8d5b7: give-way stop points, mutual waits read at the step's start, side-by-side lanes not crossings, U-turns, spawn room; 900 s deadlocks 344/422/401 → 9/49/3 | Bob | 2026-10-09 | 657bb2d |
| T43 | Agents City: the unmount warnings (own OverlayLabel instead of drei Html) | Alex | 2026-10-09 | admin: ee5e444 |
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
