# V2 engine: porting tracker

V2 plans (`plans.engine = 'v2'`) are built on the lane sketch: the model in `src/lib/lane-sketch.ts`, the
simulation in `src/lib/lane-sketch-sim.ts`, the editor in `src/components/workspace/lane-sketch.tsx` (full page
in `src/components/v2/workspace-v2.tsx`). The plan's data is its `sketch`; its V1 `network` stays empty. V1 plans
keep the original engine (`src/engine`, `src/render`, `plan-canvas`) unchanged.

This file tracks the V1 features and where they are in V2. Status: **done**, **partial** (what is missing is
noted), **todo**, or **n/a** (not needed in V2).

## Plans and workspace

| Feature | V1 files | V2 status |
|---|---|---|
| Engine per plan, chosen when creating it (V2 by default); duplicate and city copy keep it | `db/schema.ts`, `server/actions.ts`, `new-plan-dialog.tsx` | done (migration 0008) |
| Full-page editor, top bar (back, name, save status, history, user menu) | `workspace.tsx` | done (`workspace-v2.tsx`) |
| Autosave, conflicts, Cmd/Ctrl+S | `workspace.tsx` (`useAutosave`, `doSave`) | done (shared) |
| History and versions (restore) | `history-dialog.tsx`, `server/data/history.ts` | done (shared; the sketch is in every version) |
| Live collaboration | `api/plans/[planId]/live`, `state/merge.ts` | partial: the whole sketch, the newer side wins; to do: merge per lane / connector / road / junction |
| Thumbnails, counts and V1/V2 badges in lists | `plan-thumb.tsx`, `plan-card.tsx` | done |
| Sharing (read / write) | `components/cities/share-*` | done (shared; view only respected) |
| OSM import | `lib/osm/*`, `server/osm.ts`, `components/osm` | partial: import as V1, then "Convert to V2" |
| Converting a V1 plan to V2 | `lib/v1-to-v2.ts`, `convertPlanToV2` (server action), plan card menu | done: lanes along V1's centrelines, roads, every lane-to-lane path as a connector, automatic junctions, signs (and all-way stops), lights with their phases (green per connector) and timings, roundabouts as true circles, zebra crossings, place and reference image. Not converted: bus stops / lines, buildings, parking, demand, junction shapes drawn by hand (automatic surfaces instead) |
| Sample district template | `server/actions.ts` (`sampleTown`) | todo (V2 starts blank) |
| Walkthrough | `walkthrough.tsx`, `lib/walkthrough.ts` | todo |
| Search palette | `search-palette.tsx` | todo (the structure tree covers part of it) |
| Assistant chat | `assistant-chat.tsx`, `server/assistant.ts` | todo |
| Settings menu, layers | `workspace.tsx` (`SettingsMenu`, `LayerPicker`) | partial: V2 has its own layers menu; no settings menu yet |

## Network

| Feature | V1 files | V2 status |
|---|---|---|
| Roads with lanes, curves; lanes side by side | `engine/types.ts`, `compile.ts`, `state/ops.ts` | done (lanes, arcs, rings, curved points, roads aligned) |
| Lane connections, turns per lane, arrows | `lane-connections.tsx`, `lane-arrows.tsx`, `state/connections.ts` | partial: connectors drawn by hand; to do: turn arrows painted on lanes |
| Splitting / merging roads | `merge-roads.ts`, `carriageways.ts` | partial: slice tool and road links; to do: merge two roads into one |
| Junctions: shapes, surfaces | `state/junctions.ts`, `junction-shape.tsx` | done (drawn or automatic, smoothed, curved borders) |
| Junction templates and library | `junction-library.tsx`, `server/data/templates.ts` | todo |
| Splitter islands, medians | `splitter-island.tsx`, `state/islands.ts` | todo |
| Junction groups | `state/groups.ts`, `group-inspector.tsx` | todo |
| Roundabouts | `state/roundabouts.ts`, `state/rings.ts`, `ring-inspector.tsx` | partial: rings drawn and reshaped by hand; to do: a roundabout tool (ring + entries/exits in one go) |
| Stop / yield signs, all-way stop | `engine/sim/junctions.ts`, `inspector.tsx` | done |
| Traffic lights: fixed / actuated, min green, phases worked out or by hand | `engine/signals.ts`, `engine/sim/signals.ts`, `phase-editor.tsx` | done (green per connector) |
| Signal groups, green waves | `signal-groups.tsx`, `engine/signals.ts` (`greenWaveOffsets`) | todo |
| Signal optimizer | `engine/optimize.ts`, `optimize-dialog.tsx` | todo |
| Reversible lanes | `engine/sim/reversible.ts`, `reversible-lane.tsx` | todo |
| Bus stops and lines | `lines-panel.tsx`, engine `stops` / `lines` | todo |
| Pedestrians, zebra crossings | `engine/crossings.ts`, `render/pedestrians.ts`, `crossing-parking.tsx` | done: X tool, pedestrians in the sim and the replay; converted from V1 (drawn crossings, and one across each road of a junction with pedestrians) |
| Parking bays | `engine/parking.ts` | todo |
| Markers | `engine/markers.ts`, `marker-inspector.tsx` | todo |
| Copy / paste, placing, multi-select, bulk delete | `state/placing.ts`, `state/bulk.ts`, `multi-selection.tsx` | done (sketch copy / paste / duplicate, box select) |
| Validation and sanitizing | `engine/validate.ts` | done (`sanitizeSketch`) |

## Traffic and simulation

| Feature | V1 files | V2 status |
|---|---|---|
| Car following, priority, crossings, merges | `engine/sim/*` | done (lane sketch sim) |
| Lane changes | `engine/sim/*` | done |
| Demand: buildings, zones, OD flows | `engine/buildings.ts`, `engine/sim/demand.ts`, `zones.tsx`, `flows.tsx` | partial: vehicles per hour per way in, a share of the trips per way out (Demand panel, "Ways in and out" layer); to do: OD flows between given ways, buildings / zones |
| Routing, route tracer | `engine/route.ts`, `engine/sim/routing.ts`, `route-tracer.tsx` | partial: each car heads for an exit drawn by the shares and takes the shortest way (`RouteTable`; lane changes count 25 m); to do: route tracer, routes by time (congestion) |
| Turning proportions per approach | `engine/types.ts` (`splitF` / `splitB`) | todo |
| Simulation in a web worker | `state/sim.worker.ts`, `sim-controller.ts` | todo (V2 runs on the main thread) |
| Speed, run / pause, restart | `workspace.tsx` | done (in the editor's header) |
| Replay | `engine/sim/recorder.ts`, `replay-bar.tsx` | done (10 min) |
| Stats, console, perf, data tables, hover info | `problem-console.tsx`, `perf-panel.tsx`, `dataview.tsx`, `hover-info.tsx` | partial: traffic panel and car inspector; to do: console, data tables |
| Fuel / emissions | `engine/fuel.ts`, `fuel.tsx` | todo |

## Map and views

| Feature | V1 files | V2 status |
|---|---|---|
| Satellite and photo tiles, geo-located plans | `render/satellite.ts`, `render/photo-tiles.ts` | done: `sketch.geo` set from a place search (the place put under the view), Esri / Google imagery with brightness (`components/v2/background.tsx`); to do: photo tiles (3D) |
| Reference image (underlay) with scale | `lib/underlay.ts`, `state/underlay-image.ts`, `underlay-panel.tsx` | partial: upload, opacity, position, width, rotation, scale by two clicks and a known distance (the plan's underlay, shared with V1); to do: drag / turn it on the canvas |
| 3D view, helicopter mode | `view-3d.tsx`, `render/scene3d.ts`, `helicopter.ts` | todo |
| Road surfaces and markings | `render/draw2d.ts`, `render/geometry.ts` | done (asphalt, kerbs, lane and centre lines, stop / yield / signal lines, signs) |

## Suggested order

1. ~~Satellite / reference image under the sketch, with real scale~~ (done).
2. ~~Demand (where cars come from and go to) and routing over the network~~ (done: rates, shares, shortest routes; OD flows next).
3. Signal groups and green waves, then the optimizer.
4. Buses, pedestrians and crossings, parking.
5. Per-object live merge; simulation in a worker for large plans.
6. 3D view, assistant, OSM import, data tables.
