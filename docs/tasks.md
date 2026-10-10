# Team tasks

The task log of the Claude Code sessions working on this project (and on the admin's Comms / Agents City in
`/opt/project/admin`). Kept by Alice (the manager), the only one who edits this file; the tagged messages between
sessions (`TASK:` `ACK:` `STATUS:` `BLOCKED:` `DONE:` `CANCELLED:` `CLAIM:` `RELEASE:` `COMMIT:` `PUSHED:`) are the
source of truth, this is their summary. No credentials or private data here.

Team: **Alice** (manages), **Bob** (simulation, editor), **Tatiana** (editor features), **Ramona** (tests),
**Alex** (admin: Comms, Agents City), **Tom** (Agents City's Desk mode).

Commits are in this repo unless marked `admin:` (`/opt/project`). "admin-dev" = built and previewed, not committed (no previews any more: the admin is built, then the user deploys)
(the user commits and deploys the admin).

## Open

| Id | Task | Owner | Since | Notes |
|---|---|---|---|---|
| T165 | V2: show junction warnings (console, tree badges, panel count; computed off the main thread after edits) and a 'Junction rules: first come / priority' toggle in sim settings | Tatiana | 2026-10-10 | approved by the user |
| T148 | Bistrița J696 (Drumul Sigmirului × Petru Maior): the roundabout drawn precisely from the imagery and OSM, as an agent patch; plus the merge starvation at c5258 Ramona found (l3179 held by l3178's stream) | Bob | 2026-10-10 | causes in the drawing (cross lanes, one-lane bottleneck, slips); version 1 submitted as agent patch #5, a Sketch-window try-out (the user's choice); the main-plan patch kept ready |
| T143 | Research: the best ways to show an agent swarm at work in 2D or very light graphics (prior art, low-power techniques, 3 concepts with mocks and CPU estimates, a recommendation, a quick win) | Alex | 2026-10-10 | the 3D view spins up the user's M5 fan |
| T134 | Bistrița: 172 dead-end U-turn stubs on rev 92: corrected to 167 (5 false positives): A1 after a closer check = j696 (a missing roundabout, Petru Maior × Sigmirului) and j405 (a hairpin closing at j404), two patches; j633, j341 are real dead ends; j100, j728 correct as drawn; B 4; C 15; D 143 kept as turning circles; tracks not modelled (the user's choices), B 4 at the edge (ways in/out, one patch), C 15 unused (delete, one patch), D 82 real dead ends (keep; drawn as turning circles, T139): the user's choices | Bob | 2026-10-10 | list: /home/genie/bob-scratch/trafficsim/t134/T134-list.md |
| T91 | Agents City Table: a BLOCKED agent looks at Alice's avatar (open question to the user) | Tom | 2026-10-10 | waits for the user's answer |
| T56 | Bistrița after T46: lane-change standoffs (l2847–l2849, l14/l15), the deadlocks left by 900 s, held-back arrivals shown | Bob | 2026-10-09 | d7d31ba, a47d023, 371e800; held-back shown (68eda39). HEAD, 900 s, seeds 1/2/3: deadlocks 1/8/4, collisions 2/2/2. Causes: r1560 drawn over r7/r1459 (l14 never accepts a lane change), J574's head-on connectors (a plan fix, needs approval). User edited by hand to rev 145 (2026-10-10, ~15:00): patches rebuilt on rev 145. Earlier: plan fix applied: Bistrița rev 92 (2026-10-10 13:27, by Bob on the user's go, through the app's restoreFromFile): five drawn-over places (r1560, J574, J577, Strada Tărpiului, l879/l2954, l2476/l2513); seeds 1–8 deadlocks 71 → 102 (76 of them one j671 ping-pong), collisions 17 → 34, out +1%; rev 91 backed up. Step 3 on rev 92: j671 was a sim rule (f270dab: a car stopped up to 0.5 m into a zone counts as short): seeds 1–8 deadlocks 102 → 31, collisions 34 → 27; j21: a lane drawn into the lane it joins waits before the overlap (8a1e9ae): seeds 1–16 deadlocks 79 → 61, collisions 56 → 62 (noise), out +0.7%, j21 0. Next j746, l3241/j169; j534's loop kept as a patch for agent patches. Notes in /home/genie/bob-scratch/trafficsim/T56-NOTES.md |

## After the restart (2026-10-10, done 01:30)

1. The user starts trafficsim's dev server (port 7000) and the team; Alice restarts her memory watcher
   (`/home/genie/alice-scratch/memwatch.sh 2500`, in the background).
2. Alice collects the ACKs and sends T90 first (Alex, Tom), then the open tasks: T56 (Bob), T74 (Tatiana),
   T68 split across processes, T89, T73 (Ramona), T85, T88 (Alex). T85 goes on top of T90's tree, not the old one.
3. Everyone: agent-browser always with `--session <Name>`. Scratch is in `/home/genie/<name>-scratch` (not /tmp).
4. Waiting on the user: Tatiana's login (in her session), T91, Bob's Bistrița plan fixes (r1560, J574) once worth it,
   the 2xlarge sizes in genie (T81), the nginx save's sudo vs a confined helper.

## Done

| Id | Task | Owner | Done | Commits / result |
|---|---|---|---|---|
| T161 | Junction priority model (roundabout roles, give-way, lights, main road, left turn, from the right; first come as timed last resort; commitment) behind tuning junctionRules (0 first come default, 1 priority); off = HEAD to the car on 16 seeds; editor warnings function | Bob | 2026-10-10 | 45439df, a455ded; toggle and warnings UI: T165 |
| T161b | Car explainer: plain words for the junction-rule reasons and a patience note; unchanged with the setting off | Alex | 2026-10-10 | 6719f5b |
| T157b | V2: editor shortcuts work whenever focus isn't in a text field or an open menu/dialog (document-level, pure rules in editor-keys.ts) | Alex | 2026-10-10 | a895829 |
| T164 | Admin Table: whiteboard 33×17.6 on shorter legs, writing a step (+10%) larger, post-its 10% larger, four rows a column | Tom | 2026-10-10 | admin 928d5cd, local in tom-scratch/admin-t164; push on the user's word |
| T163 | Admin: Agents City's 2D Ops view, the default: agent cards, task swimlanes, message chips, isometric repo map with agents over their files; 2D/3D switch; idle draws nothing | Alex | 2026-10-10 | admin 539fa0b, committed locally in admin-t90; push on the user's word |
| T162 | Admin: status dots ping 3 times then still; Claude spark twinkles ~2.6 s then holds; Low power switch for Agents City's 3D (no glow, dpr 1, no AA/MSAA, ≤30 fps, ambient ≤15 fps) | Alex | 2026-10-10 | admin abd0113; awaiting deploy and the M5 check |
| T158b | Run restarting at 0 was the dev server's hot reload of the sketch store module, not the drag; in dev the stores' undo history and sim now survive hot reloads (production unchanged) | Tom | 2026-10-10 | f064355 |
| T160 | V2: undo/redo take the map back and keep run settings changed since that step (traffic, demand, journeys); a demand change's own undo still works | Tom | 2026-10-10 | e8a47c7 |
| T157 | Per-car explainer: 'Why' box (headline, speeds, leader, rule, held by, stop point, chain with Deadlock badge, plan, recent decisions, Copy), map/3D lines to leader and blocker and the conflict zone, replay from the recording, bridge selection.explain | Bob (sim), Alex (UI) | 2026-10-10 | 4410e63, 34f8bd7; checked by Ramona (re-check on her copy: all seen but a live deadlock, which didn't occur) |
| T158 | V2: a running simulation pauses when a map edit begins (drags, tools, panel fields, undo/redo of map edits; not select/pan/zoom or traffic/demand numbers), toast with Resume | Tom | 2026-10-10 | 4d44bff |
| T149 | V2: align selected lanes like a design tool (left, centre, right, top, middle, bottom) | Tom | 2026-10-10 | bc2709a; checked by Ramona |
| T155 | Check agent patch #5 on Bistrița: already applied by the user at rev 244; History entry and Sketch-window piece correct, main plan unchanged | Ramona | 2026-10-10 | ramona-scratch/t155/report.md |
| T156 | Several named sketches per plan (picker; new, duplicate, rename, delete with undo; old scratch = 'Sketch 1'); Test in Sketch → New; agent-patch pieces go into a new sketch named after the patch | Tatiana | 2026-10-10 | 58022c1 |
| T159 | Test accounts alex/bob/tom@test.com (agent:login), each with a city and a Bistrița copy (rev 249); Bistrița unchanged | Alex | 2026-10-10 | ff75143; plans 4a18995a (Alex), ca9bd06c (Bob), 874497d4 (Tom) |
| T154 | V2 junction shape editing: border, corners take precedence, '+' at edge middles to add, Delete/double-click to remove, corner menu (curve/sharp/take out), Automatic turns Drawn in the same undo step, hint line | Tatiana | 2026-10-10 | 153bf32 |
| T153 | V2: a selected car's way on to the end of its trip (dashed blue with an arrow in 2D, a ribbon in 3D; the panel lists roads, distance and time left), recomputed only on a new lane, connector or reroute | Tatiana | 2026-10-10 | 924da66 |
| T152 | Agent patches can add a piece to the plan's Sketch window (`sketchWindowAdd`): ids remapped as Add does, placed beside the content, main plan byte-identical or refused; a Sketch-window section with a thumbnail in the review | Alex | 2026-10-10 | 716fb25 |
| T147 | V2 junctions: "Fill holes" (per junction, off by default; Tidy offers it for all): gaps under 4 m between bands paved, only adding paving; 2D and 3D | Tom | 2026-10-10 | 84defd4; Ramona: /home/genie/ramona-scratch/t147 |
| T151 | V2: "Delete this lane" (menu, Lane panel, the Road panel's new lane list; side-by-side re-packed, last lane takes the road) and "Take out of the road" (kept, with the road's speed); every delete now cleans dangling journeys and turning shares | Tatiana | 2026-10-10 | 4987e2f |
| T150 | V2 header (and the Sketch window): a page memory gauge after the fps counter, every 3 s, amber > 1 GB, red > 2 GB with "save and reload"; hidden in Safari and Firefox | Tatiana | 2026-10-10 | bfe0d5f |
| T146 | V2: memory grew ~3 MB per edit on Bistrița (16 whole-sketch WeakMap caches kept alive by the 200-step undo history); now a last-6 cache: 150 edits, tab 498 → 1,431 MB rising before, ~1 GB level after; autosave loses at most 9 edits or 2 min | Tatiana | 2026-10-10 | 3108a37 |
| T145 | Zones on 7000 (save and reload, History, Copy JSON, layer, corner add/remove) and T144's Back/Esc: pass (Alex's harness covers the scroll) | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t145 |
| T144 | Agent patches dialog: Back and Esc in a patch return to the list (scroll and focus kept), Esc on the list closes | Alex | 2026-10-10 | 4965415 |
| T129 | V2 editor: zones (neighbourhoods): labelled, coloured polygons stored in the plan; Zone tool (Z), editing, layer, panel, tree, search, hover, copy/paste, History, Copy JSON, 3D | Tom | 2026-10-10 | 8df5c21, 085c395; Ramona's check: /home/genie/ramona-scratch/t129 |
| T137 | Browser checks on 7000: blinkers in 2D and 3D, way labels edited in place, junction shading: all pass | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t137 |
| T127 | V2: cars' turn signals as in V1: amber, 380 ms on/off, on the turning side, 2D and 3D; hazards kept for broken-down cars | Alex, Tatiana | 2026-10-10 | 913e1ca, 71ff865; checked in T137 |
| T142 | V2: dead-end test only counts a U-turn back onto the same street: 167 on Bistrița (no circle at j206, j728, j100, j266) | Tatiana, Bob | 2026-10-10 | 5d6eb2b |
| T141 | V2: a "Smooth" button (Lane, Road and multi-lane panels) curving every point between a lane's ends; side-by-side lanes follow; one undo step | Tatiana | 2026-10-10 | feb7f78 |
| T139 | V2: dead ends with only a U-turn drawn on a turning circle (2D and 3D, display only; 172 on Bistrița); an info line in the console | Tatiana | 2026-10-10 | 0c9e20d |
| T140 | Agent patches can remove (lanes, connectors, junctions, roads, links, crossings, zones), with checks so nothing goes unlisted; shown struck through in the review; plain History files still can't remove | Alex | 2026-10-10 | f6b79b1 |
| T124 | V2: connectors that turn back over 150° flagged in the Problems console ("Turns back", click to select) and straightened by a Tidy step (bends dropped, ends kept); 5 on Bistrița | Tatiana, Bob | 2026-10-10 | 223bad2 |
| T138 | Agents sign in without passwords: npm run agent:login --as/--list/--revoke/--scramble (8 h token sessions into the agent's own agent-browser state file; dev DB, listed test accounts only); tatiana@ and ramona@test.com scrambled (the user's approval), their lines removed from credentials.md | Alex | 2026-10-10 | 142d540 |
| T132 | Agent patches: agents submit plan patches (npm run patch:submit, checked against the current revision); the V2 plan page lists them with History's preview; the plan's editors apply (one new version, "Agent patch #n") or reject | Alex | 2026-10-10 | 326c64b; migration 0009 on railway |
| T135 | V2 map: way-in and way-out labels edited in place (click, type, Enter; arrows step; red when out of range; one undo step) | Tatiana | 2026-10-10 | 58e7e07, 4247123 |
| T130 | V2 map: a junction shaded (selection blue, 22 %) while it's drawn or selected for editing | Tatiana | 2026-10-10 | 68e426f |
| T136 | Agents City: commits matched to their repo by its directory (repos with no project no longer share "null/"; the admin's commits stay the admin's) | Alex | 2026-10-10 | admin: ab0a188 |
| T133 | Agents City Table: bookshelf 1.4× bigger, one shelf per project on the table in the cities' order, name plates, up to 6 shelves then "Other projects"; Alice reaches to the right shelf | Tom | 2026-10-10 | admin: f845abe |
| T128 | V2: merge two lanes (end to start, directly or through one connector) or two roads (V1's Merge roads ported): M, the lane menu, the selection panel; clear refusals; one undo step | Tatiana | 2026-10-10 | df7fc4b |
| T131 | V2: road and lane speed limits now survive save and load (sanitizeSketch keeps `speed`, 10–130 km/h); limits set before were lost and must be set again | Tatiana | 2026-10-10 | 0beb836 |
| T126 | V2: the connector being drawn shows in yellow (#facc15 over a dark edge, yellow start, bend and end dots) until placed | Tatiana | 2026-10-10 | d43863c |
| T125 | V2 map: clicking a junction's name selects the junction (shape highlighted, panel open), a road's name selects the road; hover highlights, pointer cursor (3D has no labels) | Tatiana | 2026-10-10 | 99dd87d |
| T121 | Agents City: no more nameless "pid NNNNN" agents in short windows (a day of transcripts read for pairing and names; names from /rename or "You are <Name>"; only agents active in the window listed) | Alex | 2026-10-10 | admin: 563903d |
| T123 | Agents City Table: bubbles and paper planes start when the page first sees a message (message ids marked with the beats) | Tom | 2026-10-10 | admin: 0f87d23 |
| T122 | Agents City replay bar: 22 px task lanes with the label inside, overlapping tasks stacked; also recent edits no longer all flash on page load (quiet City after load 26% → 3% CPU) | Alex | 2026-10-10 | admin: ec6e5e5 |
| T120 | Task parser: ids with a bracketed note or a dash, tasks split between owners (one part each), re-sent TASKs don't reopen done work, the manager's COMMIT/PUSHED closes a blocked part; Kanban and whiteboard checked identical per window | Alex | 2026-10-10 | admin: 2c742c1 |
| T119 | Replay cap in the browser (Bistrița copy, 10×, test car followed, 5 min): renderer 1,012 → 1,584 MB, flat from 1 min (T113 after: 2,051 and rising); replay held at 320 MB; answers in < 0.6 s | Tatiana | 2026-10-10 | /home/genie/tatiana-scratch/t119-*.txt |
| T118 | Re-test of T112 and T113: the trip kept while running (panel and bridge), the 3D hint, Bistrița read-only at 10× for 5 min (JS heap 70–170 MB): pass; a followed test car on real traffic not covered (her Restore is refused; Tatiana's T119 covers it) | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t118 |
| T117 | Sim replay capped at 320 MB (oldest frames first; the bar shows "last m:ss" when capped); same-seed runs unchanged; Bistrița 900 s: replay 375 → 320 MB | Bob | 2026-10-10 | a96d0d4 |
| T113 | V2: the tab growing to 8 GB: route writes nested proxies one level deeper each time (reads slowed without limit); updaters now get and store plain copies. 10× with a test car for 5 min: renderer 945 → 2,051 MB, answers in < 0.4 s (before: 4 GB, hung) | Tatiana | 2026-10-10 | 7f0311a |
| T112 | V2: a test car sent while the cars run keeps its trip (a late worker frame cleared it); a 3D camera hint line | Tatiana | 2026-10-10 | 6e5e66e |
| T106 | Agents City Table: messages fly as paper planes (sender's colour band, 2.2 s arc with bank and bob, unfold on landing; off the table edge for absentees; staggered) | Tom | 2026-10-10 | admin: d2bc2ee |
| T95 | Agents City Table: commits as books on a bookshelf left of the whiteboard (newest 90, hover for hash, repo, subject); Alice walks over to shelve each new one (one trip for several); the commit tower and the mug removed | Tom | 2026-10-10 | admin: f84128e |
| T116 | Re-test of T115 on a fresh page: {id, width} applies at once; refused-only files say "Nothing would change: 1 item was left out" in red with the reason, Apply disabled: pass | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t116 |
| T107 | Browser test of T104: camera back to the arrival framing, a drag stops the ease, Escape in search / menus / dialogs only closes them: pass | Ramona, Tatiana | 2026-10-10 | /home/genie/ramona-scratch/t107 |
| T115 | History from file: refused items shown ("Nothing would change: N left out" in red, the table with reasons); the "stale version" was a tab running pre-b50cf4e code, now pinned by a check; restore:check 26/26 | Alex | 2026-10-10 | 18584b1 |
| T111 | Agents City: agents waiting for the user all look at the camera and wave: questions (AskUserQuestion, or a turn ending on a question) with "?", permission prompts with an amber "!" and "needs your OK" | Alex, Tom | 2026-10-10 | admin: 8cb65d8, 8202ecf |
| T100 | Re-test of T88 (preview only; the save clicks are refused by Ramona's permission check): the merge is right in all 5 cases; refused items hidden and a stale current version (→ T115) | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t100 |
| T114 | Agents City Table: browsers shown by their label only (host, CPU) at the owner's seat, no screen | Tom | 2026-10-10 | admin: 609bdfe |
| T108 | Agents City: a touched file's building lifts (edits 1.5 storeys, reads 1), with a ground shadow, bolts ending on the lifted roof, then settles; City and Table share lib/lift.ts | Alex, Tom | 2026-10-10 | admin: 3a899b3, 52f78d7 |
| T94 | Agents City Table: the City's lightning from each laptop to its newest touched files (shared BoltPool), replacing the glowing threads; claim threads kept | Tom | 2026-10-10 | admin: 52f78d7 |
| T109 | Admin: local-only content carried to origin (eu-funding workflow and agents, AGENTS-IMPROVEMENTS.md, TASKS.md), nginx/projects.conf untracked; /opt/project moved to origin/main, clean; backups: branch backup/local-main-2026-10-10, stash@{0}, /home/genie/alex-scratch/t109 | Alex, Alice | 2026-10-10 | admin: 5e606f7; ready for the user's deploy |
| T96 | Agents City Table: table top at the avatars' seated elbow height (2.75 = 0.35 of standing, the user's choice), feet on a floor, chairs on it, a walking ring and the bookshelf's spot; camera re-framed | Tom | 2026-10-10 | admin: beaa4ee |
| T110 | genie: the 2xlarge size (16 vCPU, 32 GB, disk unknown) in the API docs, the size list, both create forms and the tools' text | Alex, Alice | 2026-10-10 | genie: a4414f6 (pushed by Alice at the user's request) |
| T98 | A raised lane (Level 1) over a junction: model, tooltip and 2D pass; tilted 3D shot not reached (→ T112); the 3D screenshot is the bridge's, works for 2D and 3D | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t98 |
| T97 | Route tracer in the browser: way in/out and lane picking, the orange route, a test car followed to arrival, the lane menu, the 3D route, the bridge's route pass; route.test stays null (→ T112); blue reroute not reachable on a one-path plan | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t97 |
| T93 | Agents City Table: while thinking, the eyes glance around (80–120 ms glances, 0.6–2.5 s holds, mostly up-left/up-right, some blinks, the head follows long holds), seeded per agent | Tom | 2026-10-10 | admin: 18908ff |
| T105 | Agents City Table: an agent asking the user a question (AskUserQuestion) looks at the camera and waves, at once then every 6–8 s; permission prompts keep the still look; a plain question at the end of a turn isn't detectable yet | Tom | 2026-10-10 | admin: ac5b812 |
| T103 | Agents City: Escape closes one thing per press (input, overlay, selection or follow, the Table's board close-up), then flies the camera to its default | Alex, Tom | 2026-10-10 | admin: c004240, cc11ccf |
| T102 | Agents City Table: who's using a browser: a small browser screen at the owner's seat (host, page title, CPU bar, label), unowned sessions stacked in front; data from /api/agents3d/browsers (host only) | Alex, Tom | 2026-10-10 | admin: 91fc749, cc11ccf |
| T101 | Agents City Table: gauge needles, numbers and core bars ease to each reading over 0.8 s (needle as a rotated mesh, frames only while easing) | Tom | 2026-10-10 | admin: 0781804 |
| T92 | Agents City Table: a per-core CPU strip under the CPU dial (wraps into rows past 16), from cpuPerCore in /api/stats | Alex, Tom | 2026-10-10 | admin: 3d03d75, 0781804 |
| T104 | V2 3D view: Escape, after its other jobs, eases the camera back to the framing on entering 3D (0.7 s); editors.<kind>.camera in the UI store | Tatiana | 2026-10-10 | 73a5b56 |
| T74 | V2 route tracer: way in, way out, lane, route drawn, a test car from the panel, "other way" only for a longer way. With the plan's traffic (3 seeds × 60 cars): 113 of 180 arrived, never faster than the limits, 24 flagged blue, all on real reroutes. Screenshots of a real reroute in 2D and 3D: /home/genie/tatiana-scratch/t74-*-otherway*.png | Tatiana | 2026-10-10 | 6994d9a, 46a9565, 14a24fe, fde6bbb |
| T99 | Agents City: folders starting with "." left out of the cities (server-side, before the file cap) unless "Show hidden folders" (?dot=1); dot-files in shown folders stay; touches inside hidden folders draw no bolt | Alex | 2026-10-10 | admin: 941d8aa (pushed, not deployed) |
| T85 | Agents City and Table: on-demand frames (60 flights, 30 animating, 0 when still or hidden), dpr ≤ 1.5, 4× MSAA, 250 ms clock, stable handlers, no per-frame allocations; idle Table frozen (the user's choice). Harness (SwiftShader): City idle 417% → 4% CPU, Table calm 722% → 32% | Alex, Tom | 2026-10-10 | admin: f1d0b13 (pushed, not deployed) |
| T88 | History from file: Apply merges the file's fields onto the item with the same id (missing fields kept, null clears optional ones, required ones can't be cleared, a new id needs a whole item); restore:check 23/23 | Alex | 2026-10-10 | b50cf4e |
| T73 | Re-test of the 3D view (T62): toggle, orbit, zoom, imagery, roads, junctions, markings, live cars, picking pass; a real bridge and the 3D screenshot not reached (→ T98) | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t73 |
| T89 | Re-test of T69's conflict dialog: compares with the live revision, shows the conflict, applies cleanly: pass | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t89 |
| T68 | Bistrița repeatable runs (HEAD 3f58bc8, rev 91, 900 s, a process per run): identical per seed; deadlocks 2/10/8, collisions 1/6/4 (seeds 1/2/3); hot spots j746, j574, l2607, l1923/l40. Differs from Bob's harness (1/8/4, 2/2/2): Bob to reconcile | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t68 |
| T90 | Admin: the Table work (T82–T87) on origin/main; tests 61/61, tsc, build pass, lint as origin | Alex, Tom, Alice | 2026-10-10 | admin: ca7e185 (pushed); the user moves /opt/project to origin/main and deploys |
| T87 | Agents City Table: CPU, MEM and DISK dials on the whiteboard's right edge (from /api/stats; MEM by available memory: amber < 4 GB, red < 2.5 GB; CPU 70/90 %, DISK 80/90 %), polled every 5 s, paused when hidden, repainted only on change | Tom | 2026-10-10 | admin: ca7e185 (deployed 01:24 from the live tree) |
| T72 | Re-test of T69: Restore keeps geo and journeys, red warning for removed items, "Restored from the file" pass; Apply of a minimal partial patch fails (→ T88); conflict dialog not reached (→ T89) | Ramona | 2026-10-10 | /home/genie/ramona-scratch/t72 |
| T86 | Agents City Table: an agent waiting for the user (permission prompt or question) stays awake, sits up, shows "?" and "waiting for you", looks at the camera, laptop screen amber | Tom | 2026-10-10 | admin: ca7e185 (deployed 01:24 from the live tree) |
| T83 | Agents City Table: bigger table (r 16) and cities (×1.8 for 3 repos, packed in rows), a file's path on hover, folder names when the camera comes close (fading, at most 12) | Tom | 2026-10-10 | admin: ca7e185 (deployed 01:24 from the live tree) |
| T84 | Agents City Table: every post-it yellow (#fff59d), the agent's colour as a small dot top-right; darker amber/red for long elapsed times | Tom | 2026-10-10 | admin: ca7e185 (deployed 01:24 from the live tree) |
| T82 | Agents City Table: an agent idle for more than 30 s (wall clock, running, not busy) holds the nap pose until its next tool call; guests and ended sessions as before | Tom | 2026-10-10 | admin: ca7e185 (deployed 01:24 from the live tree) |
| T80 | Admin: the live tree's features on origin/main with its security hardening kept: an Nginx config manager (no dot names, regular files only, private temp file), a Git graph with diffs, Docker stats; apps no longer inherit the admin's basePath | Alex, Alice | 2026-10-10 | admin: b88fc34 (pushed; not deployed) |
| T81 | genie: the largest Taz Cloud Server size documented in genie is xlarge (8 vCPU, 16 GB, 160 GB); Taz also offers 2xlarge, undocumented in genie (this server after the resize: 16 vCPU, 32 GB, a 154 GB disk) | Alex | 2026-10-10 | answer |
| T50 | Re-test of T48 plus a Next.js 16.4 smoke test: all pass; 3 bridge input-check bugs, a one-off glitch | Ramona | 2026-10-09 | /tmp/ramona/t50/ → T59 |
| T52 | V1→V2 quick wins: per-road speed limits, hover cards, zoom keys and lat/lon, a colour-by-speed switch, five sim settings (identical runs at the defaults) | Tatiana | 2026-10-09 | 9a32774, cf4a7d8, cad3d57, 6949407, de8031e |
| T55 | Bistrița after T46 (rev 91, seeds 1–3, 5/10/15 min): 5-min deadlocks 22/56/64 → 0/0/4; a new ping-pong on the Strada 1 Decembrie overlap (seed 3); l2607/l1945 collisions; saturation by 10 min | Ramona | 2026-10-09 | /tmp/ramona/t55/ → T56 |
| T69 | History from file: Restore keeps what the file lacks, cleared fields in red, the dialog after a conflict, "Applied from file" | Alex | 2026-10-09 | 7c39383 |
| T66 | Test of History from file: Apply passes; Restore with Copy JSON drops geo and journeys; conflict dialog stale | Ramona | 2026-10-09 | /tmp/ramona/t66/ → T69 |
| T60 | Re-test of T59 and T52: all pass; more bridge arguments accepted; same seed not repeating after Clear the cars | Ramona | 2026-10-09 | /tmp/ramona/t60/ → T67, T56 |
| T70 | Admin: a Team menu (Teams; Comms, Agents City, Tasks) and a Kanban task board with filters and a task's thread; /chrome owners of agent-browser sessions | Alex | 2026-10-09 | admin (deployed 20:50) |
| T62 | The 3D view in V2, phase 1: toggle, orbit camera, imagery, roads, junctions, markings, bridges, cars, live lights, picking with overlays at their height; bridge mode and 3D screenshots | Tatiana | 2026-10-09 | 6cd84df, 1507df6, 3b20b0b, 119d579 |
| T76 | The deployed admin work as one clean commit on origin/main (only our features) | Alex, Alice | 2026-10-09 | admin: 403e63d |
| T78 | Agents City / Table: ghost duplicates after the restart: one agent per name, ended sessions merged, guests flagged and hidden behind "Show guests" | Alex, Tom | 2026-10-09 | admin: 537799f (deployed 10-10) |
| T79 | Agents City Table: no headphones on the avatars (Alex's headset removed) | Tom | 2026-10-09 | admin: 537799f (deployed 10-10) |
| T77 | Agents City Table: the thought cloud fades in or out in 0.6 s on wall-clock time | Tom | 2026-10-09 | admin: 403e63d (deployed) |
| T75 | The shared task parser: STATUS/DONE without ACK, several ids in one tag, TASK after a lead-in, untagged progress notes | Alex | 2026-10-09 | admin (deployed 20:50); follow-ups (sub-ids, no id-less DONE, reports only from owner/manager): admin: 537799f (deployed 10-10) |
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
