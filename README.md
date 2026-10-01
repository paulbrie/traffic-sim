# Gridlock — street design & traffic simulation

Design street networks precisely (lanes, curves, junction control, bus lanes and lines),
then run a deterministic traffic simulation on them in a plan view or in 3D.
Plans are grouped by city and stored in Postgres.

Stack: Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 · shadcn/ui components ·
[subjecto](https://github.com/paulbrie/subjecto) for client state · Drizzle ORM · Postgres 16 · three.js.

## Run it

```bash
npm install
cp .env.example .env          # DATABASE_URL for the Docker database below
npm run db:up                 # docker compose: Postgres 16 on localhost:5544
npm run db:migrate            # create tables
npm run db:seed               # optional: "Demo City" with a sample plan and a blank plan
npm run dev                   # http://localhost:3000
```

`npm run db:admin` creates the first admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (in `.env.local` or `.env`;
a password is generated and printed if `ADMIN_PASSWORD` is empty). That account must pick a new password at first sign-in.

`npm run db:setup` does the database steps in one go. If the app shows "Can't reach the database"
or "needs migrating", it tells you which of these steps is missing. After pulling changes that add a
migration (for example the reference image support), run `npm run db:migrate` again.

Using your own Postgres instead of Docker: point `DATABASE_URL` in `.env` at it and skip `db:up`.

Serving under a sub-path (behind a proxy that forwards e.g. `/projects/trafficsim/…` unchanged): set
`NEXT_PUBLIC_BASE_PATH=/projects/trafficsim` in `.env.local` and restart the dev server. It is empty by default.

Other scripts: `npm run typecheck`, `npm run lint`, `npm run db:studio` (Drizzle Studio),
`npm run db:generate` (after changing `src/db/schema.ts`), `npm run engine:check` (headless simulation run),
`npm run osm:check -- <south> <west> <north> <east>` (imports an OpenStreetMap area headlessly and runs traffic on it),
`npm run engine:baseline` (the engine must reproduce stored fingerprints of 9 scenarios exactly; `-- --update` after an
intended behaviour change), `npx tsx scripts/engine-bench.ts` (ms per simulation step on loaded networks).

## Using the editor

| Key | Tool / action |
| --- | --- |
| `V` | Select: click roads, junctions, stops, vehicles; drag junctions; drag the square handle to curve a road, then the two round handles to shape it |
| `R` → `C` | Draw roads with smooth curves: every point you click becomes a bend the road flows through (toggle Straight/Curved in the bar) |
| `R` | Draw roads: click to place points, click an existing road to join it (creates a junction), `Esc`/double-click to finish, `Shift` for 15° angles |
| `B` | Bus stop: click the side of a road where buses should stop |
| double-click a road | Add a bend point (Select tool); drag it, then **Smooth here** / **Sharp corner** in the inspector, or **Smooth whole road** on a road |
| Make junction here | On a road point (double-click a road to add one), turns it into a junction: traffic lights (with an all-red crossing phase), stop or priority |
| `I` | Reference image: drag it to move, corners to scale, round handle to rotate (`Shift` for 15°) |
| `H` / `Space`+drag | Pan · scroll or two-finger drag pans, `⌘`/`Ctrl`+scroll zooms |
| right-click | On imported plans: **Open in Google Maps** at that point (new tab), with its coordinates (right-drag pans) |
| `P` | Run / pause traffic · `F` fit · `+`/`-` zoom |
| `O` | Roads as outlines only (the **Roads** switch next to Grid): see the satellite imagery or reference image under them |
| `S` | With two roads selected (click one, `Shift`+click the other): smooth the join where they meet, so one flows into the other (also at a junction; both stay separate roads) |
| `Shift`+click, `M` | Select several roads, then merge them into one (roads that follow on through plain bend points; with one road selected, `M` merges all its pieces) |
| `⌘Z` / `⇧⌘Z` | Undo / redo · `Delete` removes the selection |

Reference image: in the **Image** tab, drop a map screenshot, aerial photo or site drawing (PNG/JPEG/WebP, up to 25 MB).
Use **Calibrate scale** (click two points whose real distance you know, type the distance), then rotate and move it
into place, lock it, and trace your streets over it. It is stored per plan (`plan_images` table), can be shown on
the 3D ground, and is copied when you duplicate a plan.

Precision: the inspector takes exact coordinates for junctions, length and bearing for straight roads,
and exact curve handle positions. Grid snapping is adjustable from 0.5 m to 20 m.

Roads: 0–6 lanes per direction (0 = one-way), lane width (2.5–4.2 m), optional bus-only kerb lane per direction, speed limit.
**Turn bays** (road inspector → Lanes): up to two extra lanes on the left and/or right for the last metres before the
junction ahead, with the length you set. Left bays take the left turns, right bays the right turns; vehicles move into a
bay only once it opens (after a taper), line up beside it before, and wait at its mouth when it is full.
**Lane ends** (road inspector → Lanes, per direction, 2+ lanes): the left or the right lane merges into the lane
beside it over the last metres you set before the road's end; the road narrows in a taper, drivers in that lane move
over (neighbours let them in) and wait at the end of the taper if they must. Use it where a road goes on with fewer
lanes (without it the extra lane just stops at the road point). **Median**
(two-way roads): a painted (hatched) or raised (kerbed) strip between the directions; left bays open into it.
**Junction shapes** come from the lanes through them: each road end plus every lane path at its full width,
merged, with a kerb band along the edge, so the asphalt always covers the lanes and kerbs follow the turns (a turn
with no lane path leaves a notch; the gap between two roads splitting off becomes a nose). **Junction editor**
(junction inspector → Shape): *Edit outline* to drag the kerb points onto the aerial (double-click an edge to add
a point, Alt+click to remove one; *Automatic outline* goes back), *Lane lines through the junction*, and painted
areas (*Add hatched area* / *Add island*: click the corners, double-click or Enter to finish). To change how a lane
runs through, show the Connectors layer, click its path and drag its two handles (each slides along its lane; with
Shift it moves freely), or type how far they reach; vehicles drive the new path. Stored per node (`outline`,
`paint`, `laneLines`, `connShape`).
**Lane connections** (junction or road point inspector → Lane connections): which lane of each approach feeds
which lane of each exit, per turn. They are worked out automatically; change any of them by hand (or take a lane off
a turn with –), and the arrow puts a turn back to automatic. Clicking a single lane connector on the map offers the
same. The section also lists problems: a road that leads nowhere, a lane with no connection, an exit lane nothing
feeds, and lanes of one approach whose paths cross. *Add a connector* links any lane coming in to any lane going out,
even where there was no turn (it becomes one, whatever the lane arrows say). Lane connectors are automatic until one
is changed (in the inspector or on the map); then the junction's whole set is written out (`NodeDef.connectors`: lane of
a road arriving → lane of a road leaving, with its curve) and kept as it is: turns exist only where connectors say so.
A road with no connectors of its own (one added since) still gets the automatic ones; one whose last connector is
removed is `closed`. **Back to automatic** in Lane connections drops the written-out set; changing an approach's lane
arrows hands that approach back to automatic. Splitting, reversing and merging roads keep the connectors at their
junctions (`src/state/connections.ts`; the older per-turn `laneMap` / `connShape` are still read).
**Driving through** a junction: at priority and free junctions without pedestrians, a turn whose paths cross and
join no other path there (e.g. the far side of a two-way road when the side road only turns right in and out) is
driven without stopping or asking; it is tagged *through* in Lane connections, and at 4-way junctions its lane lines
and centre line carry on across. Switch off the turns that cross a direction to leave that direction out of a
junction (`throughConns` in `compile.ts`). **Carriageways** (road inspector → Carriageways): splits a two-way road
into two one-way roads with a gap between them — the selected roads (`Shift`+click), or the road and its
continuation straight on through junctions, up to lights, roundabouts and entry points. Each junction on the way is
split too, every side road joining the carriageway on its own side; *openings* add lane connectors across the gap at
each junction (left turns from the side road into the other direction, and from it into the side road), which makes
the two halves one junction. The road splits a little before the junction at each end (with *Line up lanes* on, no
turning round there), so that junction keeps its shape (`src/state/carriageways.ts`).
**Junctions over several points**: a connector may run from a lane ending at one node to a lane starting at another
nearby (up to 60 m, `CROSS_REACH`); nodes linked that way make one junction (`CNode.cluster`): each grants its
crossings seeing the others' reservations and priority traffic, so paths crossing between them never go together, and
its control is set for all of them (a plain road point in it becomes part of the junction). Such connectors are drawn
like any other: from a lane in its inspector (*Connect from this lane*, then click a lane — lanes starting at nodes
nearby are offered too), by dragging a selected connector's end onto a lane at another node, or with *Add a connector*
in Lane connections (*Starting nearby*).
**Free junctions** (no signs, no lights): vehicles waiting at the line go in the order they arrived, so every
entering lane gets its turn and one still on its way can't jump them; crossings that end in the same lane zip in,
each following the one ahead. **Slip lanes** (junction inspector → Slip lanes): a free right turn that leaves the approach before the junction, curves
round a kerbed island and gives way where it joins the exit; the junction then has no right turn from that approach.
**Elevation** (road inspector → Elevation, or the Level column in the Dataview): 0 = ground, 1, 2, … = bridges and
flyovers, −1, … = underpasses and tunnels. Roads only meet at junctions, so a bridge simply passes over the roads it
crosses; the plan view draws levels in order (bridges with a shadow, over the traffic beneath; below ground faded), clicks
pick the road on top, and in 3D bridges stand on pillars while the roads joining them ramp up (6 m per level).
Junctions with lights get zebra crossings and dashed guide lines for left turns, and lane lines are solid for the last
metres before a stop line.
Junctions (3+ roads): priority (first come, first served), all-way stop, actuated traffic lights
(green / yellow / all-red / minimum green per junction), or roundabout. Dead ends are entry/exit points
where traffic comes from and leaves to the rest of the city (toggle to make them turn-arounds).

Traffic lights per lane: select a junction with lights and use **Set lights per lane** (Inspect → Lanes and phases).
The junction then runs your own phases, in order, each with its own green and minimum green time; tap a lane of
an arriving road to give it green in a phase (e.g. a protected left-turn arrow: the left lane green in a phase of its
own). Turns across oncoming traffic still give way when the oncoming lanes are green too, and a lane green in two
phases in a row stays green through the change. Each lane then gets its own signal head. **Back to automatic**
returns to the worked-out phases. **Set lights per connector** (or *Per connector* there) gives green connector by
connector instead (`SignalPhase.conns`): a lane going straight on and left can have the left on an arrow of its own.
At a junction over several nodes (see above) the phases list the connectors of all of them, and the lights of all
run from that node (`CNode.signals`): one timing, demand from all of them, lane heads worked out from the connectors.

Route tracer (Traffic → Route tracer): pick an entry point, an exit and the lane to start in; the fastest route with
no traffic is drawn on the map (length, junctions, free-flow time), and **Send a test vehicle** puts one car on it that
the inspector follows. Test vehicles don't count towards the car total and use their own random numbers, so the rest
of the run is unchanged; their results (arrival time, or ended elsewhere / stuck) are listed there.

Pedestrians (junction inspector → Pedestrians, or **Zebra crossing** on a road point): people per hour crossing each
road. At traffic lights they cross a road early in its red (the walk time; turning vehicles into that road wait for
them); at priority / stop junctions and zebras they have priority, and held-up traffic gets a few seconds before the
next group steps out. They are drawn on the zebras, with the number who crossed and their average wait.

Two-lane roundabouts (junction inspector → Two circulating lanes): the outer lane serves the first exit, the inner
lane everything further round (on approaches with 2+ lanes, the kerb lane is for the first exit); where both lanes
leave into a one-lane exit they zip in turn.

Satellite imagery brightness is adjustable in Traffic → Display (dimmer imagery makes roads and traffic stand out).

Transit flows: select an entry / exit point and **Add a flow from here** to send vehicles from it to a chosen exit
(vehicles per hour, share of trucks), e.g. through traffic crossing the area. They come on top of the car and truck
totals and keep their exit (turning shares don't apply to them). While traffic runs you see how many were sent,
arrived (with the average travel time), are still driving or are waiting to enter; **Traffic → Transit flows** lists
them all, and the selected entry point's flows are drawn on the map.

Road event log (road inspector → Event log → Record): what vehicles do on that road, in both directions: appearing
or entering (with their next turn and the lanes it needs), lane changes (and whether they had to), changes of state
(free, following, queued, at a red light, yielding…) with the gap to the vehicle ahead, leaving into a junction,
arriving, leaving the plan or being removed; downloadable as CSV / JSON like the junction logs. Recording doesn't
change the run.

Traffic counters: select a road and switch on **Count traffic on this road** (off by default). While traffic runs,
the inspector shows each direction's vehicles counted at the middle of the road, the rate per hour (last 5 minutes) and
their average speed; counted roads get a badge on the map and are listed under **Traffic → Traffic counters**.

Zones (origin–destination demand): group entry points and buildings into zones, then set how many vehicles per hour
travel from each zone to each other. Create zones under **Traffic → Zones and demand** (or with **New zone…** in the
Zone picker of an entry point or building), add members from their inspector or with **Add buildings in view**, and fill
in the matrix. Trips start and end at the zone's entry points (evenly) and buildings (by trip weight); they come on top
of the car and truck totals and keep their destination. The results table shows arrivals, average travel time and
vehicles waiting to enter per pair; the **Zones** layer colours each zone's members on the map.

Map view (plans imported from OpenStreetMap): **Satellite background** (Esri World Imagery, also on the 3D ground)
and **Show lane connectors** are display toggles in the Traffic tab; vehicles are coloured by speed (legend on the map).
The **Layer** picker in the top bar (Roads, Lanes, Junctions, Lane connectors, Entry / exit points, Signals, Stops,
Counters, Buildings, Vehicles, Zones) highlights one kind of object and makes clicks pick only that kind, so single
lanes and lane connectors can be selected and inspected. The table button next to it opens the **Dataview**: a
sortable, filterable table of the chosen layer under the map, with live columns while traffic runs; click a row to
select and focus the object, double-click an underlined cell (or use its list / checkbox) to edit it (undoable).

**Replay** (bar at the bottom of the plan view): every simulation step is kept in memory (compactly, up to
512 MB; the oldest go first) and can be replayed like a video: drag to any step, step back and forward, play back
at the chosen speed; Live returns to the running simulation (replaying doesn't change it; running again goes live).
Settings menu → Record steps for replay turns it off on very big plans. In `src/engine/sim/recorder.ts`.

**Load panel** (Traffic panel → Display → Show CPU and memory load): frames per second, time spent drawing and time
blocked on the page; how busy the simulation worker is (share of time working, ms per step, speed reached) and the
outline worker; JavaScript memory where Chrome reports it. Browsers don't let a page see Chrome's own CPU use, so the
load is measured inside each thread.

**Simulation settings** (Traffic panel → Simulation settings): every tunable number of the simulation, grouped
(drivers, trucks, lane changes, junctions, pedestrians, stuck vehicles), each with its default and a reset. They are
saved with the plan (only the changed ones) and reach the running simulation at once; driver and truck values apply to
vehicles entering from then on. Defined in `src/engine/params.ts`; the defaults are the engine's own values.

Optimise (top bar): improves the junctions you choose by simulation. It may change their control (priority, all-way
stop, lights, roundabout), lane arrows (dedicated left / right lanes), protected left-turn phases and green times,
whichever you allow. Each candidate runs this plan's traffic on several random seeds (the same seeds for every
candidate); a change is kept only when it clearly beats the current plan and wins again on a second set of seeds, and
the result is checked on fresh seeds before you decide: apply it (one undo step) or save it as a new plan. It runs in
the browser on spare CPU cores (Web Workers). More effort = more seeds and longer runs, which tells real gains from luck
better. Headless: `npx tsx scripts/optimize-check.ts <planId> [J2,J3|all] [quick|standard|thorough]
[greens,control,lefts,lanes|everything]` (reads the plan from the database in `.env.local`).

Changes save automatically. If the same plan was saved from another tab, you choose whose version to keep.
Duplicate a plan from the city page to compare alternatives, or **Duplicate** a whole city (all its plans).

## Importing from OpenStreetMap

**Import from map** (cities list: new city · city page: new plan) opens an OpenStreetMap map: search for a place, pan
and zoom until the frame covers the streets you want (up to 6 km across / 20 km²), choose road classes and whether to
include buildings. Data comes from the public Overpass API (with fallback mirrors) and is © OpenStreetMap contributors (ODbL).

- Roads are clipped to the frame; roads leaving it become entry points. Lanes, one-way, speed limits, names, bus lanes,
  traffic signals, stop / give-way signs and small roundabouts are taken from the tags. Junction points a few metres
  apart (dual carriageways) become one junction, opposite one-way carriageways become one two-way road, and road
  shapes are fitted with the editor's straight and curved links, so everything stays editable.
- Bridges and tunnels keep their level (`layer`, `bridge`, `tunnel`), so flyovers are drawn over what they cross.
- Up to 6 lanes per direction are kept. Lane arrows come from `turn:lanes`; a short stretch before a junction that gains
  turn-only lanes becomes turn bays on the road before it; two merged carriageways keep the gap between them as a median
  (raised from 2.5 m); a one-way road cutting the corner of a right turn next to a junction becomes a slip lane.
- Buildings are drawn in the plan view and extruded in 3D (height from `height` / `building:levels`). Trips inside the
  plan start and end at buildings, weighted by use (homes, shops, offices, …) × floor area; select a building to change
  its use, height or trip weight. **Traffic → Through traffic** sets how many trips use the entry points instead.
- In the editor, the map-plus button in the tool rail **adds an area to the open plan**. Imported plans remember where
  they are on Earth, so a new area lines up with the earlier ones: its frame snaps to the edge of the area already
  imported, roads crossing the seam are joined, and roads or buildings already in the plan are skipped. That way a
  city can be imported part by part. The whole import is one undo step.

## Code map

- `src/engine/` — headless, deterministic simulator (no React, no DOM)
  - `types.ts` plan data model (what is stored as JSON in `plans.network`)
  - `compile.ts` turns nodes + links into lanes, junction areas, turn movements with lane rules, connectors, signal phases, roundabout rings
  - `sim/` the simulator, in layers each extending the one below: `base` (state, vehicle index, logging) → `routing` (A* with congestion, lanes through junctions) → `signals` → `junctions` (reservations with conflict checks, give-way, roundabout gap acceptance) → `motion` (IDM car-following, MOBIL-style lane changes, buses) → `demand` (spawning) → `index` (the tick, queries for renderers); `mirror.ts` snapshots for running it in a Web Worker
  - `buildings.ts` building footprints, trip weights, and where each building's traffic joins the road network
  - `optimize.ts` junction optimiser (control, lane arrows, protected lefts, green times; judged by simulation)
  - `validate.ts` sanitises plan JSON on the server
- `src/lib/osm/` — OpenStreetMap import: area, projection and Overpass query (`area.ts`), OSM → plan conversion (`convert.ts`)
- `src/state/` — subjecto stores (`ui` DeepSubject, `network$`/`settings$`/`stats$` Subjects), undo history, edit operations, simulation controller (the live simulation runs in `sim.worker.ts`; the page reads a mirror of it; junction outlines are worked out in `outline.worker.ts` and patched in, simple outlines show meanwhile)
- `src/render/` — shared road geometry, Canvas 2D renderer, three.js scene builders
- `src/components/workspace/` — editor UI: canvas, 3D view, inspector, traffic and bus-line panels
- `src/components/osm/` — the import dialog and its Leaflet map
- `src/server/` — queries and server actions (Drizzle) · `src/db/` schema and client · `drizzle/` migrations

This app has no authentication; it is meant to run locally.

## Users

Everyone signs in (`/login`). Two roles:

- **admin**: everything, plus **Manage users** in the account menu (`/admin/users`): add users (a temporary password is
  shown once), change roles, reset passwords, delete users. You can't demote or delete yourself, and the last admin can't be deleted.
- **user**: create and edit cities and plans.

Passwords are hashed with scrypt; sessions are random tokens in an httpOnly cookie, stored hashed in `sessions` (30 days).
Scripts read `.env.local` first, then `.env`, like Next does.
