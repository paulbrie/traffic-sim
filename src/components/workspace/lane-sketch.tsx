"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { Car, ChevronDown, ChevronRight, ChevronUp, Circle, Plus, Scissors, Layers as LayersIcon, ClipboardCopy, Copy, Crosshair, Maximize, Milestone, MousePointer2, Pause, Pentagon, Play, Redo2, RotateCcw, Spline, Trash2, Undo2, Waypoints, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  LANE_WIDTH, addLane, sketchIndex, boxesMeet, straightenLanes, curveLanes, demandWays, laneInRate, laneOutWeight, DEFAULT_LIGHTS, MAX_PHASES, signalAt, signalPlan, signalPlans, junctionApproaches, setSigns, linkGeometry, linkRoads, unlink, arcToPoints, at, boundsOfPts, connectorPts, copyPart, curveThrough, dist, emptySketch, groupRoad, insertCorner, bandPolygon, junctionBands, roadMarkings, sliceLane, sliceRoad, onBands, insideLoops, smoothJunction, SMOOTH_R, insidePolygon, outlinePath, removeCorner, toggleCorner, curveAllCorners, isFullCircle,
  junctionContents, laneById, laneLength, nearestOn, nextId, pastePart, piecePoints, pointAt, polygonArea, remove, reshape, reverseLane,
  roadOf, rotation, samples, setControl, surfaceAround, transformPiece, translation,
  alignmentOf, entryLanes, insertPoint, leadOf, removePoint, settle, toggleCurve,
  type Band, type SketchJunction, type JunctionContents, type JunctionLights, type SignalController, type LightsPhase, type LaneAt, type LaneControl, type LaneShape, type Piece, type Pt, type Sketch,
} from "@/lib/lane-sketch";
import { DEFAULT_SIM, type ReplayCar, type SimParams, type SimStats, type SketchSim } from "@/lib/lane-sketch-sim";
import { SketchSimClient } from "@/state/sketch-sim-client";
import { laneSketch$, ui, underlay$ } from "@/state/store";
import { ALL_SKETCH_LAYERS, SKETCH_LAYERS, setSketchLayers, sketchLayers$, type SketchLayers } from "@/state/sketch-layers";
import { editSketch, recordSketch, redoSketch, setSketchClip, setSketchSim, sketchClip, sketchSim, undoSketch } from "@/state/lane-sketch";
import { readPalette, speedColor } from "@/render/palette";
import { ResizeEdges, useFloatingBox } from "./floating-box";
import { NumberField } from "./fields";
import { DemandPanel } from "@/components/v2/demand-panel";
import { REPLAY_STEP, SketchReplayBar, type ReplayKept } from "@/components/v2/sketch-replay-bar";
import { BackgroundPanel, drawBackground, loadSatOptions, saveSatOptions, type Background, type Calibration, type SatOptions } from "@/components/v2/background";
import { underlayImg$ } from "@/state/underlay-image";

type Tool = "select" | "lane" | "arc" | "circle" | "connector" | "junction" | "slice";
/** what can be shown on the sketch, or hidden (kept in the browser) */
type Layers = SketchLayers;
const LAYERS = SKETCH_LAYERS, ALL_LAYERS = ALL_SKETCH_LAYERS;
const TOOLS: { id: Tool; key: string; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: "select", key: "V", label: "Select", icon: <MousePointer2 />, hint: "Click a lane, connector or junction (Shift adds) · drag to move · drag points to reshape (Alt-click a lane's point curves it), a connector's ends along their lanes or onto others (double-click a lane, connector or junction edge adds a point, double-click a point removes it) · round handle turns lanes and junctions (Shift: 15°; Q / E) · ⌘C / ⌘X / ⌘V, ⌘D duplicates · double-click a lane selects its road" },
  { id: "lane", key: "L", label: "Lane", icon: <Spline />, hint: "Click the lane's points in the direction of travel · double-click or Enter to finish · Backspace takes the last point back · Esc cancels" },
  { id: "arc", key: "A", label: "Arc", icon: <Waypoints />, hint: "Click the centre, then where the lane starts, then move round the way it goes and click where it ends" },
  { id: "circle", key: "O", label: "Ring", icon: <Circle />, hint: "Click the centre, then the radius: a full ring of lane, anticlockwise (Shift: clockwise)" },
  { id: "connector", key: "C", label: "Connector", icon: <Milestone />, hint: "Click the lane traffic leaves, then click bend points anywhere (Alt: over a lane too), then the lane it joins · Backspace takes the last bend back · Esc cancels" },
  { id: "slice", key: "K", label: "Slice", icon: <Scissors />, hint: "Click a road to cut it across there into two roads (Shift: keep them linked, so the road carries on; Alt: only the lane under the pointer) · its connectors stay with the piece they are on" },
  { id: "junction", key: "J", label: "Junction", icon: <Pentagon />, hint: "Click the junction's corners; click the first again (or Enter, or double-click) to close it. The lanes in no road and the connectors on it are its own" },
];
const tip = (t: (typeof TOOLS)[number]) => `${t.label} (${t.key})`;

interface View { cx: number; cy: number; /** px per metre */ scale: number }
type Sel = Piece & { road: string | null; link?: string | null };
const NO_SEL: Sel = { lanes: [], connectors: [], junctions: [], road: null };
type Hit = { lane: string } | { connector: string } | { junction: string } | { link: string };
/** what is lit up under the pointer: something on the sketch, or (a traffic-light phase hovered in its panel) some connectors */
type Hover = Hit | { conns: string[] } | { lanes: string[] };
/** a point to drag: a lane's, a connector's bend or end (moved along its lane or onto another), a junction's corner */
type Handle = { kind: "lane" | "bend" | "corner"; id: string; i: number } | { kind: "end"; id: string; end: "from" | "to" };

type Draft =
  | { kind: "lane"; pts: Pt[] }
  | { kind: "arc"; c: Pt; start: { r: number; a0: number; sweep: number; last: number } | null }
  | { kind: "circle"; c: Pt }
  | { kind: "connector"; from: LaneAt; via: Pt[] }
  | { kind: "junction"; pts: Pt[] };
type Drag =
  | { kind: "pan"; x0: number; y0: number; v0: View; /** with the right button: a click without moving opens the menu */ right?: boolean }
  | { kind: "move"; base: Sketch; from: Pt; piece: Piece }
  | { kind: "handle"; base: Sketch; h: Handle }
  | { kind: "box"; a: Pt; b: Pt; add: boolean }
  | { kind: "rotate"; base: Sketch; o: Pt; a0: number; piece: Piece; angle: number };

const isEmpty = (p: Piece) => !p.lanes.length && !p.connectors.length && !p.junctions.length;
/**
 * What turns of a selection: its lanes and junctions. Connectors don't turn by themselves (their ends are on
 * their lanes); the bends of those between two lanes that turn go with them.
 */
const turning = (p: Piece): Piece => ({ lanes: p.lanes, connectors: [], junctions: p.junctions });
/** the box round what turns of the selection, its centre and the handle to turn it by (over the box, 28 px up) */
function rotateHandle(sk: Sketch, piece: Piece, scale: number) {
  const b = boundsOfPts(piecePoints(sk, turning(piece)));
  if (!b) return null;
  const o = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  return { box: b, o, h: { x: o.x, y: b.minY - 28 / scale } };
}
/** where to put a new point in a path so it gets the least longer (between `i - 1` and `i`) */
function insertIndex(path: Pt[], p: Pt, closed: boolean) {
  let best = 1, cost = Infinity;
  const n = path.length;
  for (let i = 1; i <= (closed ? n : n - 1); i++) {
    const a = path[i - 1], b = path[i % n], c = dist(a, p) + dist(p, b) - dist(a, b);
    if (c < cost) { cost = c; best = i; }
  }
  return best;
}

/** a piece with the lead lanes of the side-by-side roads its lanes follow (they move and turn with their lead) */
function withLeads(sk: Sketch, piece: Piece): Piece {
  const leads = piece.lanes.map(id => leadOf(sk, id)).filter((x): x is string => !!x && !piece.lanes.includes(x));
  return leads.length ? { ...piece, lanes: [...piece.lanes, ...new Set(leads)] } : piece;
}

function prune(sel: Sel, sk: Sketch): Sel {
  const ids = new Set(sk.lanes.map(l => l.id)), cids = new Set(sk.connectors.map(c => c.id)), jids = new Set(sk.junctions.map(j => j.id));
  const linkOk = !sel.link || !!sk.links?.some(k => k.id === sel.link);
  if (linkOk && sel.lanes.every(l => ids.has(l)) && sel.connectors.every(c => cids.has(c)) && sel.junctions.every(j => jids.has(j)) && (!sel.road || sk.roads.some(r => r.id === sel.road))) return sel;
  return { lanes: sel.lanes.filter(l => ids.has(l)), connectors: sel.connectors.filter(c => cids.has(c)), junctions: sel.junctions.filter(j => jids.has(j)), road: sk.roads.some(r => r.id === sel.road) ? sel.road : null, link: linkOk ? sel.link : null };
}
const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const toggle = (ids: string[], id: string) => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id]);

/** the structure as copied: what was drawn, and what each junction takes in */
function exportSketch(sk: Sketch, contents: Map<string, JunctionContents>) {
  const junctionOf = (kind: "lanes" | "connectors", id: string) => [...contents].find(([, c]) => c[kind].includes(id))?.[0] ?? null;
  return {
    lanes: sk.lanes.map(l => ({ ...l, length: Number(laneLength(l.shape).toFixed(2)), road: roadOf(sk, l.id)?.id ?? null, junction: junctionOf("lanes", l.id) })),
    connectors: sk.connectors.map(c => ({ ...c, junction: junctionOf("connectors", c.id) })),
    roads: sk.roads,
    junctions: sk.junctions.map(j => ({ ...j, ...contents.get(j.id) })),
  };
}

/** the lane under `p` (within its width, or 4 px of it) */
function laneUnder(sk: Sketch, p: Pt, px: number) {
  let best: Sketch["lanes"][number] | null = null, bd = Infinity;
  // (only the lanes near it: see sketchIndex)
  for (const id of sketchIndex(sk).near(p, 4 * px + 0.5).lanes) { const l = laneById(sk, id)!, d = nearestOn(l.shape, p).d - l.width / 2; if (d <= 4 * px && d < bd) { bd = d; best = l; } }
  return best;
}

/**
 * The lane sketch editor: a window floating over a V1 plan, or (`page`) the whole page of a V2 plan,
 * the sketch being the plan itself.
 */
export function LaneSketch({ page = false }: { page?: boolean } = {}) {
  const { panel, style, placed, start, reset } = useFloatingBox("laneSketch:box", 480, 320);
  const [sketch] = useSubject(laneSketch$);
  const [tool, setTool] = useState<Tool>("lane");
  const [rawSel, setSel] = useState<Sel>(NO_SEL);
  /** a line lane's point picked (to curve or delete) */
  const [selPt, setSelPt] = useState<{ lane: string; i: number } | null>(null);
  /** a car picked to inspect (by its number), and the view kept on it */
  const [selCar, setSelCarId] = useState<number | null>(null);
  const [carInfo, setCarInfo] = useState<ReturnType<SketchSim["inspect"]>>(null);
  /** replaying what was kept: the moment shown (null: the cars as they are), playing or not, and the span kept */
  const [replayT, setReplayT] = useState<number | null>(null);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayRange, setReplayRange] = useState<ReplayKept | null>(() => sketchSim()?.replayRange() ?? null);
  const [follow, setFollow] = useState(false);
  /** the layers shown (kept in the browser) */
  // (shared with the top bar's layers picker on a V2 plan)
  const [layers] = useSubject(sketchLayers$);
  const setLayers = setSketchLayers;
  // (without what is gone, deleted by an undo for instance)
  const sel = useMemo(() => prune(rawSel, sketch), [rawSel, sketch]);
  const contents = useMemo(() => new Map(sketch.junctions.map(j => [j.id, junctionContents(sketch, j)])), [sketch]);

  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ cx: 0, cy: 0, scale: 6 });
  const draft = useRef<Draft | null>(null);
  const drag = useRef<Drag | null>(null);
  const cursor = useRef<{ p: Pt; snapped: boolean; alt: boolean } | null>(null);
  const hover = useRef<Hover | null>(null);
  const space = useRef(false);
  // cars on the sketch, to try it out (made when first run, kept with what they did when the window closes;
  // they follow the sketch as it is edited)
  const sim = useRef<SketchSimClient | null>(sketchSim());
  const [running, setRunning] = useState(false);
  const [simSpeed, setSimSpeed] = useState(1);
  // (saved with the sketch: changing them isn't an undo step)
  const params: SimParams = sketch.traffic ?? DEFAULT_SIM;
  const setParams = (p: SimParams) => laneSketch$.next({ ...live.current.sketch, traffic: { rate: p.rate, speed: p.speed } });
  const [readOnly] = useDeepSubject(ui, "readOnly");
  // the background (V2 plans): how the imagery shows, the image, a scale being set by two clicks
  const [sat, setSatState] = useState<SatOptions>(loadSatOptions);
  const setSat = (o: SatOptions) => { setSatState(o); saveSatOptions(o); };
  const [underlay] = useSubject(underlay$), [ulImg] = useSubject(underlayImg$);
  const [calib, setCalib] = useState<Calibration | null>(null);
  // the menu a right click opens, where it was clicked, and the lanes it is for
  const [menu, setMenu] = useState<{ x: number; y: number; lanes: string[]; straightenable: boolean } | null>(null);
  const [stats, setStats] = useState<SimStats | null>(() => sketchSim()?.stats() ?? null);
  // what the handlers and the drawing read (kept current after every render)
  const live = useRef({ sketch, sel, tool, contents, selPt, selCar, follow, layers, replayT, page, sat, underlay, ulImg, calib });

  // ------------------------------------------------------------ coordinates, snapping, picking
  const toWorld = (e: { clientX: number; clientY: number }): Pt => {
    const c = canvas.current!, r = c.getBoundingClientRect(), v = view.current;
    return { x: v.cx + (e.clientX - r.left - r.width / 2) / v.scale, y: v.cy + (e.clientY - r.top - r.height / 2) / v.scale };
  };
  /** onto a lane's end within 10 px, else to the half metre */
  const snap = (p: Pt, exclude?: string): { p: Pt; snapped: boolean } => {
    const tol = 10 / view.current.scale;
    let best: Pt | null = null, bd = tol;
    for (const l of live.current.sketch.lanes) {
      if (l.id === exclude || isFullCircle(l.shape)) continue;
      for (const q of [pointAt(l.shape, 0).p, pointAt(l.shape, laneLength(l.shape)).p]) { const d = dist(p, q); if (d < bd) { bd = d; best = q; } }
    }
    return best ? { p: best, snapped: true } : { p: { x: Math.round(p.x * 2) / 2, y: Math.round(p.y * 2) / 2 }, snapped: false };
  };
  /** what is under `p`: connectors first (they are thin), then lanes, then the smallest junction surface */
  const pick = (p: Pt): Hit | null => {
    const sk = live.current.sketch, px = 1 / view.current.scale;
    let best: Hit | null = null, bd = Infinity;
    // (only what is near it; connectors hidden: not picked, but for the selected ones)
    const near = sketchIndex(sk).near(p, 6 * px + 0.5), cs = sk.connectors.filter(c => near.conns.has(c.id));
    for (const c of live.current.layers.connectors ? cs : cs.filter(x => live.current.sel.connectors.includes(x.id))) {
      const pts = connectorPts(sk, c);
      if (!pts) continue;
      const d = nearestOn({ kind: "line", pts }, p).d;
      if (d <= 6 * px && d - 4 * px < bd) { bd = d - 4 * px; best = { connector: c.id }; }
    }
    for (const id of near.lanes) {
      const l = laneById(sk, id)!, d = nearestOn(l.shape, p).d - l.width / 2;
      if (d <= 4 * px && d < bd) { bd = d; best = { lane: l.id }; }
    }
    if (best) return best;
    // (a link's surface, between the road ends it joins)
    for (const k of sk.links ?? []) { const g = linkGeometry(sk, k); if (g && insidePolygon(p, g.outline)) return { link: k.id }; }
    const inJ = (j: SketchJunction) => {
      if (j.shape !== "auto") return insidePolygon(p, outlinePath(j));
      const c = live.current.contents.get(j.id) ?? { lanes: [], connectors: [], roads: [] };
      return j.smooth ? insideLoops(p, smoothJunction(sk, j, c)) : onBands(junctionBands(sk, c), p);
    };
    const jn = sketchIndex(sk).near(p, 1).junctions;
    const js = sk.junctions.filter(j => jn.has(j.id) && inJ(j)).sort((a, b) => polygonArea(a.outline) - polygonArea(b.outline));
    return js.length ? { junction: js[0].id } : null;
  };
  /** a place on the lane under `p` (connectors over it don't hide it), snapped to the lane's ends within 12 px */
  const placeOn = (p: Pt): LaneAt | null => {
    const sk = live.current.sketch, px = 1 / view.current.scale;
    let l = null, bd = Infinity;
    for (const id of sketchIndex(sk).near(p, 4 * px + 0.5).lanes) { const x = laneById(sk, id)!, d = nearestOn(x.shape, p).d - x.width / 2; if (d <= 4 * px && d < bd) { bd = d; l = x; } }
    if (!l) return null;
    const L = laneLength(l.shape), tol = 12 / view.current.scale;
    let s = nearestOn(l.shape, p).s;
    if (!isFullCircle(l.shape)) { if (s < tol) s = 0; else if (s > L - tol) s = L; }
    return { lane: l.id, s: Number(s.toFixed(2)) };
  };
  /** the selection's point under `p` */
  const handleAt = (p: Pt): Handle | null => {
    const sk = live.current.sketch, s = live.current.sel, tol = 7 / view.current.scale;
    const find = (kind: "lane" | "bend" | "corner", id: string, pts: Pt[] | undefined) => { const i = pts?.findIndex(q => dist(p, q) <= tol) ?? -1; return i >= 0 ? { kind, id, i } : null; };
    for (const id of s.connectors) {
      const c = sk.connectors.find(x => x.id === id);
      if (!c) continue;
      for (const end of ["to", "from"] as const) { const a = at(sk, c[end]); if (a && dist(p, a.p) <= tol) return { kind: "end", id, end }; }
      const h = find("bend", id, c.via);
      if (h) return h;
    }
    // (a lane following a lead in a side-by-side road is shaped by its lead)
    for (const id of s.lanes) { const l = laneById(sk, id); const h = l?.shape.kind === "line" && !leadOf(sk, id) ? find("lane", id, l.shape.pts) : null; if (h) return h; }
    for (const id of s.junctions) { const h = find("corner", id, sk.junctions.find(j => j.id === id)?.outline); if (h) return h; }
    return null;
  };

  /** the cars to draw, and the one picked: as they are, or as they were at the moment replayed */
  const carsShown = () => {
    const s = sim.current, t = live.current.replayT, id = live.current.selCar;
    if (!s) return { cars: null, car: null };
    if (t === null) return { cars: s.poses(), car: id !== null ? s.inspect(id) : null };
    const cars = s.replayAt(t)?.cars ?? [];
    return { cars, car: replayInfo(cars.find(c => c.id === id)) };
  };
  /** a car's details: as it is, or as it was at the moment replayed */
  const carInfoAt = (id: number, t: number | null) => (t === null ? sim.current?.inspect(id) ?? null : replayInfo(sim.current?.replayAt(t)?.cars.find(c => c.id === id)));
  /** the replay at moment `t` (the view kept on the car picked, if following it) */
  const showAt = (t: number) => {
    // (going into the replay: the cars pause, where they are)
    if (live.current.replayT === null) { setRunning(false); setReplayRange(sim.current?.replayRange() ?? null); }
    live.current.replayT = t;
    setReplayT(t);
    const id = live.current.selCar;
    if (id === null) return;
    const info = carInfoAt(id, t);
    setCarInfo(info);
    if (info && live.current.follow) view.current = { ...view.current, cx: info.p.x, cy: info.p.y };
  };
  const goLive = () => {
    setReplayT(null); setReplayPlaying(false);
    const id = live.current.selCar;
    setCarInfo(id !== null ? sim.current?.inspect(id) ?? null : null);
  };
  /** a step through the replay (seconds; stops playing it): from the moment shown, or from now when live */
  const stepReplay = (dt: number) => {
    const r = sim.current?.replayRange(), t = live.current.replayT;
    if (!r) return;
    setReplayPlaying(false);
    showAt(Math.min(r.to, Math.max(r.from, (t ?? r.to) + dt)));
  };
  const frame = useRef(0);
  // (the sketch drawn without what moves with the cars, kept between frames: redrawn when something
  // else changed, `full`, or the view or the canvas did; each frame then only the cars and lights over it)
  const kept = useRef<{ canvas: HTMLCanvasElement; stale: boolean; key: string } | null>(null);
  const redraw = (full = true) => {
    if (full && kept.current) kept.current.stale = true;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const c = canvas.current;
      if (!c) return;
      // (the background, V2 plans only: the imagery where the plan is, the reference image)
      const l = live.current, bg = (x: typeof l): Background => ({ geo: x.sketch.geo ?? null, satellite: x.layers.satellite, sat: x.sat, underlay: x.layers.image ? x.underlay : null, img: x.ulImg, calib: x.calib, onTile: redraw });
      const st: PaintState = { ...live.current, view: view.current, draft: draft.current, drag: drag.current, cursor: cursor.current, hover: hover.current, placeOn, ...carsShown(), simT: sim.current ? (live.current.replayT ?? sim.current.t) : null, signals: sim.current?.signals ?? null, bg: l.page ? bg(l) : null };
      const w = c.clientWidth, h = c.clientHeight, v = view.current, key = `${w}x${h}:${v.cx},${v.cy},${v.scale}`;
      kept.current ??= { canvas: document.createElement("canvas"), stale: true, key: "" };
      const k = kept.current;
      if (k.stale || k.key !== key) { paint(k.canvas, st, "static", { w, h }); k.stale = false; k.key = key; }
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const ctx = c.getContext("2d")!;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(k.canvas, 0, 0);
      paint(c, st, "dynamic");
    });
  };
  // (a render: the kept image drawn again only if something it shows changed, not for the cars' stats)
  const shownBy = useRef<unknown[]>([]);
  useEffect(() => {
    live.current = { sketch, sel, tool, contents, selPt, selCar, follow, layers, replayT, page, sat, underlay, ulImg, calib };
    const now = [sketch, sel, tool, contents, selPt, layers, page, sat, underlay, ulImg, calib];
    const changed = now.length !== shownBy.current.length || now.some((x, i) => x !== shownBy.current[i]);
    shownBy.current = now;
    redraw(changed);
  });
  /** the worker sent the cars as they are now (or a replay frame came): what is shown kept up with them */
  const shownAt = useRef(0);
  const onSimFrame = () => {
    const s = sim.current;
    if (!s) return;
    // (the view kept on the car picked)
    const id = live.current.selCar, c = live.current.follow && id !== null && live.current.replayT === null ? s.inspect(id) : null;
    if (c) view.current = { ...view.current, cx: c.p.x, cy: c.p.y };
    const now = performance.now();
    // (while running, four times a second; paused, a frame is an answer: shown at once)
    if (!running || now - shownAt.current > 250) {
      shownAt.current = now;
      setStats(s.stats()); setReplayRange(s.replayRange());
      if (id !== null) setCarInfo(carInfoAt(id, live.current.replayT));
    }
    redraw(false);
  };
  // (the client kept between openings of the window: its frames come here)
  useEffect(() => { if (sim.current) sim.current.onFrame = onSimFrame; });
  const changeTool = (t: Tool) => { draft.current = null; setTool(t); redraw(); };
  /** a car picked to inspect (null: none) */
  const setSelCar = (id: number | null) => { setSelCarId(id); setCarInfo(id !== null ? carInfoAt(id, live.current.replayT) : null); };

  // ------------------------------------------------------------ cars
  useEffect(() => { sim.current?.setSketch(sketch); }, [sketch]);
  useEffect(() => { sim.current?.setParams(params); }, [params]);
  // the cars run in the worker, at the speed picked (it sends a frame after each go: see onSimFrame)
  useEffect(() => { sim.current?.run(running, simSpeed); }, [running, simSpeed]);
  // (while they run, the cars drawn at every frame of the page: on their way between the worker's frames)
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const loop = () => { redraw(false); raf = requestAnimationFrame(loop); };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  // playing the replay (at the simulation speed picked), stopping at the end of what is kept
  useEffect(() => {
    if (!replayPlaying) return;
    let raf = 0, last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000) * simSpeed, r = sim.current?.replayRange(), t = live.current.replayT;
      last = now;
      if (r && t !== null) {
        const next = Math.min(r.to, t + dt);
        showAt(next);
        if (next >= r.to) { setReplayPlaying(false); return; }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayPlaying, simSpeed]);
  const play = () => {
    if (!sim.current) { sim.current = new SketchSimClient(live.current.sketch, params, onSimFrame); setSketchSim(sim.current); }
    // (running carries on from now: out of the replay)
    if (live.current.replayT !== null) goLive();
    setRunning(r => !r);
  };
  /** what the cars did, as text to paste into a conversation (like the plan's replay data) */
  const copyRun = async () => {
    const s = sim.current;
    if (!s) return;
    const r = await s.report(), sk = live.current.sketch;
    const text = `Lane sketch simulation at ${clock(r.time)} (${running ? "running" : "paused"}) · ${r.stats.vehicles} cars, ${r.stats.collisions} collisions, ${r.stats.jumps} jumps\n\`\`\`json\n${JSON.stringify({ sketch: exportSketch(sk, live.current.contents), ...r })}\n\`\`\`\n`;
    try { await navigator.clipboard.writeText(text); toast.success("Simulation data copied", { description: `${Math.round(text.length / 1024)} kB: the sketch, the cars now, the jumps, the last minute's events and the last 10 s of every car. Paste it into the conversation.` }); }
    catch { toast.error("Couldn't copy: the browser blocked the clipboard."); }
  };
  /** the moment shown (replayed, or now) as text to paste into a conversation, like V1's: the cars in view, the lights, a minute's events */
  const copyMoment = async () => {
    const s = sim.current, c = canvas.current;
    if (!s || !c) return;
    const v = view.current, m = 20, hw = c.clientWidth / 2 / v.scale + m, hh = c.clientHeight / 2 / v.scale + m;
    const t = live.current.replayT, at = t ?? s.t;
    const mo = await s.moment(at, { x0: v.cx - hw, y0: v.cy - hh, x1: v.cx + hw, y1: v.cy + hh });
    if (!mo) return;
    const sk = live.current.sketch, u = ui.getValue();
    const names = new Map(sk.junctions.map(j => [j.id, j.name]));
    const data = {
      plan: u.planId, revision: u.save.revision,
      moment: { time: mo.time, live: t === null, now: mo.now, kept: mo.kept },
      view: { cx: Math.round(v.cx * 10) / 10, cy: Math.round(v.cy * 10) / 10, width: Math.round(hw * 20) / 10, height: Math.round(hh * 20) / 10 },
      selection: { ...live.current.sel, car: live.current.selCar }, params: mo.params, stats: mo.stats,
      cars: mo.cars, lights: mo.lights.map(l => ({ ...l, name: names.get(l.junction) ?? null })),
      events: mo.events.length ? mo.events : "none within a minute",
    };
    const text = `Lane sketch replay at ${clock(mo.time)} (${t === null ? "live" : "replay"}) · plan ${u.planId} rev ${u.save.revision}\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n`;
    try { await navigator.clipboard.writeText(text); toast.success("Replay data copied", { description: `${Math.round(text.length / 1024)} kB: paste it into the conversation.` }); }
    catch { toast.error("Couldn't copy: the browser blocked the clipboard."); }
  };
  const resetCars = () => { sim.current?.reset(); setStats(sim.current?.stats() ?? null); setCarInfo(null); setReplayT(null); setReplayPlaying(false); setReplayRange(null); redraw(); };

  // ------------------------------------------------------------ editing
  /** a junction selected with what it takes in, so they move, turn and copy with it */
  const junctionSel = (sk: Sketch, ids: string[]): Sel => {
    const cs = ids.map(id => { const j = sk.junctions.find(x => x.id === id); return j ? junctionContents(sk, j) : null; });
    return { lanes: [...new Set(cs.flatMap(c => c?.lanes ?? []))], connectors: [...new Set(cs.flatMap(c => c?.connectors ?? []))], junctions: ids, road: null };
  };
  const finishLane = () => {
    const d = draft.current;
    if (d?.kind !== "lane") return;
    const pts = d.pts.filter((q, i) => i === 0 || dist(q, d.pts[i - 1]) > 0.05);
    draft.current = null;
    if (pts.length >= 2) addShape({ kind: "line", pts });
    redraw();
  };
  const finishJunction = () => {
    const d = draft.current;
    if (d?.kind !== "junction") return;
    const pts = d.pts.filter((q, i) => i === 0 || dist(q, d.pts[i - 1]) > 0.05);
    draft.current = null;
    if (pts.length >= 3) {
      const sk = live.current.sketch, id = nextId("j", sk.junctions.map(j => j.id));
      const next = { ...sk, junctions: [...sk.junctions, { id, name: `Junction ${id.slice(1)}`, outline: pts }] };
      editSketch(() => next);
      setSel(junctionSel(next, [id]));
    }
    redraw();
  };
  const addShape = (shape: LaneShape) => {
    const id = nextId("l", live.current.sketch.lanes.map(l => l.id));
    editSketch(s => addLane(s, { id, shape, width: LANE_WIDTH }));
    setSel({ ...NO_SEL, lanes: [id] });
  };
  const deleteSel = () => {
    const s = live.current.sel;
    if (s.link) { const id = s.link; editSketch(sk => unlink(sk, id)); setSel(NO_SEL); return; }
    if (isEmpty(s)) return;
    editSketch(sk => remove(sk, s));
    setSel(NO_SEL);
  };
  const groupSel = () => {
    const s = live.current.sel, sk = live.current.sketch;
    if (!s.lanes.length) return;
    const id = nextId("r", sk.roads.map(r => r.id));
    editSketch(k => groupRoad(k, s.lanes, id, `Road ${id.slice(1)}`));
    setSel({ ...NO_SEL, lanes: s.lanes, road: id });
  };
  /** a junction surface drawn round the selection */
  const junctionAround = () => {
    const sk = live.current.sketch, s = live.current.sel, outline = surfaceAround(piecePoints(sk, s));
    if (outline.length < 3) return;
    const id = nextId("j", sk.junctions.map(j => j.id)), next = { ...sk, junctions: [...sk.junctions, { id, name: `Junction ${id.slice(1)}`, outline }] };
    editSketch(() => next);
    setSel(junctionSel(next, [id]));
  };
  /** a line lane's point curved or made a corner again, or taken out */
  const curvePoint = (lane: string, i: number) => editSketch(k => { const l = laneById(k, lane); return l?.shape.kind === "line" ? reshape(k, lane, toggleCurve(l.shape, i)) : k; });
  const deletePoint = (lane: string, i: number) => {
    editSketch(k => { const l = laneById(k, lane); return l?.shape.kind === "line" && l.shape.pts.length > 2 ? reshape(k, lane, removePoint(l.shape, i)) : k; });
    setSelPt(null);
  };
  const reverseSel = () => {
    const lanes = live.current.sel.lanes;
    if (lanes.length) editSketch(sk => lanes.reduce(reverseLane, sk));
  };
  /** turns the selection about its centre */
  const rotateSel = (a: number) => {
    const sk = live.current.sketch, s = live.current.sel, rh = rotateHandle(sk, s, view.current.scale);
    if (rh) editSketch(k => transformPiece(k, withLeads(k, turning(s)), rotation(rh.o, a)));
  };
  const copySel = () => {
    const sk = live.current.sketch, s = live.current.sel, b = boundsOfPts(piecePoints(sk, s));
    if (!b || (!s.lanes.length && !s.junctions.length)) return false;
    setSketchClip({ part: copyPart(sk, s), centre: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, pastes: 0 });
    return true;
  };
  const place = (part: Sketch, dx: number, dy: number) => {
    const r = pastePart(live.current.sketch, part, dx, dy);
    editSketch(() => r.sketch);
    setSel({ ...r.piece, road: null });
    changeTool("select");
  };
  /** the copied piece pasted at the cursor (or, with the cursor away, a little off the last one) */
  const paste = () => {
    const k = sketchClip();
    if (!k) return;
    const c = cursor.current?.p;
    const at = c ? { x: Math.round(c.x * 2) / 2, y: Math.round(c.y * 2) / 2 } : null;
    k.pastes++;
    place(k.part, at ? at.x - k.centre.x : 4 * k.pastes, at ? at.y - k.centre.y : 4 * k.pastes);
  };
  /** the selection copied a little off (leaves what was copied alone) */
  const duplicate = () => {
    const sk = live.current.sketch, s = live.current.sel;
    if (s.lanes.length || s.junctions.length) place(copyPart(sk, s), 4, 4);
  };
  const fit = () => { const sk = live.current.sketch; zoomTo({ lanes: sk.lanes.map(l => l.id), connectors: [], junctions: sk.junctions.map(j => j.id) }); };
  /** the view fitted round a piece of the sketch */
  const zoomTo = (piece: Piece) => {
    cancelAnimationFrame(glide.current);
    const sk = live.current.sketch, c = canvas.current;
    if (!c) return;
    const b = boundsOfPts(piecePoints(sk, piece));
    if (!b) { view.current = { cx: 0, cy: 0, scale: 6 }; redraw(); return; }
    const scale = Math.min(40, Math.max(0.5, Math.min(c.clientWidth / (b.maxX - b.minX + 30), c.clientHeight / (b.maxY - b.minY + 30))));
    view.current = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale };
    redraw();
  };
  /**
   * The view moved gently (a third of a second, easing out) to centre a piece of the sketch; zoomed out
   * only if the piece wouldn't fit as it is.
   */
  const glide = useRef(0);
  const centerOn = (piece: Piece) => {
    const c = canvas.current, b = boundsOfPts(piecePoints(live.current.sketch, piece));
    if (!c || !b) return;
    const from = { ...view.current }, fit = Math.min(c.clientWidth / (b.maxX - b.minX + 30), c.clientHeight / (b.maxY - b.minY + 30));
    const to = { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.max(0.5, Math.min(from.scale, fit)) };
    cancelAnimationFrame(glide.current);
    const t0 = performance.now(), T = 350;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / T), e = 1 - (1 - t) ** 3;
      view.current = { cx: from.cx + (to.cx - from.cx) * e, cy: from.cy + (to.cy - from.cy) * e, scale: from.scale * (to.scale / from.scale) ** e };
      redraw();
      if (t < 1) glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  };
  /** a point added to a selected connector (a bend) or junction (a corner) where it was double-clicked; on a point, the point taken out */
  const editPoints = (p: Pt) => {
    const sk = live.current.sketch, s = live.current.sel, h = handleAt(p);
    if (h?.kind === "end") return true;
    if (h?.kind === "lane") { deletePoint(h.id, h.i); return true; }
    if (h?.kind === "bend") { editSketch(k => ({ ...k, connectors: k.connectors.map(c => (c.id === h.id ? { ...c, via: c.via!.filter((_, i) => i !== h.i) } : c)) })); return true; }
    if (h?.kind === "corner") {
      editSketch(k => ({ ...k, junctions: k.junctions.map(j => (j.id === h.id ? removeCorner(j, h.i) : j)) }));
      return true;
    }
    const hit = pick(p), q = snap(p).p;
    // (on a selected line lane: a point added there)
    if (hit && "lane" in hit && s.lanes.includes(hit.lane) && !leadOf(sk, hit.lane)) {
      const l = laneById(sk, hit.lane)!;
      if (l.shape.kind === "line") {
        const shape = insertPoint(l.shape, q);
        editSketch(k => reshape(k, hit.lane, shape));
        setSelPt({ lane: hit.lane, i: shape.pts.findIndex(x => x === q) });
        return true;
      }
    }
    if (hit && "connector" in hit && s.connectors.includes(hit.connector)) {
      const c = sk.connectors.find(x => x.id === hit.connector)!, a = at(sk, c.from)!, b = at(sk, c.to)!, via = c.via ?? [];
      const i = insertIndex([a.p, ...via, b.p], q, false) - 1;
      editSketch(k => ({ ...k, connectors: k.connectors.map(x => (x.id === c.id ? { ...x, via: [...via.slice(0, i), q, ...via.slice(i)] } : x)) }));
      return true;
    }
    for (const id of s.junctions) {
      const j = sk.junctions.find(x => x.id === id)!;
      const border = outlinePath(j);
      if (nearestOn({ kind: "line", pts: [...border, border[0]] }, p).d > 6 / view.current.scale) continue;
      const i = insertIndex(j.outline, q, true);
      editSketch(k => ({ ...k, junctions: k.junctions.map(x => (x.id === id ? insertCorner(x, i, q) : x)) }));
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------ pointer
  /** the middle of the view and how much it shows, metres */
  const viewNow = () => { const c = canvas.current, v = view.current; return { cx: v.cx, cy: v.cy, wm: (c?.clientWidth ?? 800) / v.scale, hm: (c?.clientHeight ?? 600) / v.scale }; };
  const openMenu = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const sk = live.current.sketch, s = live.current.sel, raw = toWorld(e), l = laneUnder(sk, raw, 1 / view.current.scale);
    // (on a lane of the selection: all the lanes selected; on another: that one, selected; off any: the lanes selected, if any)
    const lanes = l ? (s.lanes.includes(l.id) ? s.lanes : [l.id]) : s.lanes;
    if (!lanes.length) return;
    if (l && !s.lanes.includes(l.id)) setSel({ ...NO_SEL, lanes: [l.id] });
    const can = lanes.some(id => { const sh = laneById(sk, id)?.shape; return sh?.kind === "line" && !sh.closed && sh.pts.length > 2 && !leadOf(sk, id); });
    const r = e.currentTarget.getBoundingClientRect();
    setMenu({ x: e.clientX - r.left, y: e.clientY - r.top, lanes, straightenable: can });
  };
  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    panel.current?.focus();
    // (setting the image's scale: the two points clicked)
    const c0 = live.current.calib;
    if (c0 && e.button === 0 && !space.current && !(c0.a && c0.b)) {
      const p = toWorld(e);
      setCalib(c0.a ? { ...c0, b: p } : { a: p, b: null });
      return;
    }
    // (the view taken over: a glide to centre something stopped)
    cancelAnimationFrame(glide.current);
    e.currentTarget.setPointerCapture(e.pointerId);
    const raw = toWorld(e);
    if (e.button === 1 || e.button === 2 || space.current) { setMenu(null); drag.current = { kind: "pan", x0: e.clientX, y0: e.clientY, v0: { ...view.current }, right: e.button === 2 && !space.current }; return; }
    if (e.button !== 0) return;
    const sk = live.current.sketch, d = draft.current;
    switch (tool) {
      case "select": {
        const s = live.current.sel, rh = rotateHandle(sk, s, view.current.scale);
        if (rh && dist(raw, rh.h) <= 8 / view.current.scale) {
          drag.current = { kind: "rotate", base: sk, o: rh.o, a0: Math.atan2(raw.y - rh.o.y, raw.x - rh.o.x), piece: withLeads(sk, turning(s)), angle: 0 };
          return;
        }
        const h = handleAt(raw);
        if (h?.kind === "lane") {
          setSelPt({ lane: h.id, i: h.i });
          // (Alt: the point curved, or made a corner again)
          if (e.altKey) { curvePoint(h.id, h.i); return; }
        } else setSelPt(null);
        // (Alt on a junction's corner: rounded off, or a corner again)
        if (h?.kind === "corner" && e.altKey) { editSketch(k => ({ ...k, junctions: k.junctions.map(j => (j.id === h.id ? toggleCorner(j, h.i) : j)) })); return; }
        if (h) { drag.current = { kind: "handle", base: sk, h }; return; }
        // a car, to inspect (over what it drives on)
        const rt = live.current.replayT, car = (rt !== null ? sim.current?.replayCarAt(rt, raw, 4 / view.current.scale) : sim.current?.carAt(raw, 4 / view.current.scale)) ?? null;
        if (car !== null && !e.shiftKey) { setSelCar(car); setSel(NO_SEL); redraw(); return; }
        setSelCar(null);
        const hit = pick(raw);
        if (!hit) {
          if (!e.shiftKey) setSel(NO_SEL);
          drag.current = { kind: "box", a: raw, b: raw, add: e.shiftKey };
          return;
        }
        // (a link: selected on its own, nothing to drag)
        if ("link" in hit) { setSel({ ...NO_SEL, link: hit.link }); return; }
        const has = "lane" in hit ? s.lanes.includes(hit.lane) : "connector" in hit ? s.connectors.includes(hit.connector) : s.junctions.includes(hit.junction);
        if (e.shiftKey) {
          setSel("lane" in hit ? { ...s, road: null, lanes: toggle(s.lanes, hit.lane) } : "connector" in hit ? { ...s, road: null, connectors: toggle(s.connectors, hit.connector) }
            : has ? { ...s, road: null, junctions: toggle(s.junctions, hit.junction) } : { ...junctionSel(sk, [...s.junctions, hit.junction]), lanes: [...new Set([...s.lanes, ...junctionSel(sk, [hit.junction]).lanes])] });
          return;
        }
        const next = has ? s : "lane" in hit ? { ...NO_SEL, lanes: [hit.lane] } : "connector" in hit ? { ...NO_SEL, connectors: [hit.connector] } : junctionSel(sk, [hit.junction]);
        if (!has) setSel(next);
        drag.current = { kind: "move", base: sk, from: snap(raw).p, piece: withLeads(sk, next) };
        return;
      }
      case "slice": {
        const l = laneUnder(sk, raw, 1 / view.current.scale);
        if (!l) return;
        const road = roadOf(sk, l.id), s = nearestOn(l.shape, raw).s;
        if (isFullCircle(l.shape)) { toast.error("A ring can't be cut in two", { description: "Cut the lanes leading to it instead." }); return; }
        const next = road && !e.altKey
          ? sliceRoad(sk, road.id, l.id, raw, nextId("r", sk.roads.map(r => r.id)), `${road.name} (2)`)
          : sliceLane(sk, l.id, s, nextId("l", sk.lanes.map(x => x.id)));
        if (!next) { toast.error("Can't cut there", { description: "Cut at least half a metre from a lane's ends." }); return; }
        // (Shift: the two roads linked where they were cut, so the road carries on)
        const newRoad = road && !e.altKey ? next.roads.find(r => !sk.roads.some(x => x.id === r.id)) : null;
        const linked = e.shiftKey && road && newRoad ? linkRoads(next, road.id, newRoad.id, nextId("k", (next.links ?? []).map(k => k.id))) : null;
        editSketch(() => linked ?? next);
        setSel(NO_SEL);
        toast.success(road && !e.altKey ? `${road.name} cut in two` : `Lane ${l.id} cut in two`, {
          description: linked ? "Linked where it was cut: move a piece and the road carries on between them." : "The pieces aren't joined: Shift-click to cut and keep them linked, or link them later (select both roads' lanes, Link roads).",
        });
        return;
      }
      case "lane": {
        const p = snap(raw).p;
        if (d?.kind === "lane") d.pts.push(p); else draft.current = { kind: "lane", pts: [p] };
        break;
      }
      case "junction": {
        const p = snap(raw).p;
        if (d?.kind !== "junction") { draft.current = { kind: "junction", pts: [p] }; break; }
        if (d.pts.length >= 3 && dist(raw, d.pts[0]) <= 10 / view.current.scale) { finishJunction(); return; }
        d.pts.push(p);
        break;
      }
      case "circle": {
        const p = snap(raw).p;
        if (d?.kind !== "circle") { draft.current = { kind: "circle", c: p }; break; }
        const r = dist(d.c, p);
        draft.current = null;
        if (r >= 1) addShape({ kind: "arc", c: d.c, r: Number(r.toFixed(2)), a0: Math.atan2(p.y - d.c.y, p.x - d.c.x), sweep: e.shiftKey ? 2 * Math.PI : -2 * Math.PI });
        break;
      }
      case "arc": {
        const p = snap(raw).p;
        if (d?.kind !== "arc") { draft.current = { kind: "arc", c: p, start: null }; break; }
        if (!d.start) {
          const r = dist(d.c, p), a0 = Math.atan2(p.y - d.c.y, p.x - d.c.x);
          if (r >= 1) d.start = { r: Number(r.toFixed(2)), a0, sweep: 0, last: a0 };
          break;
        }
        draft.current = null;
        if (Math.abs(d.start.sweep) > 0.05) addShape({ kind: "arc", c: d.c, r: d.start.r, a0: d.start.a0, sweep: d.start.sweep });
        break;
      }
      case "connector": {
        const place = e.altKey && d?.kind === "connector" ? null : placeOn(raw);
        if (d?.kind !== "connector") { if (place) draft.current = { kind: "connector", from: place, via: [] }; break; }
        // off a lane (or with Alt): a bend point
        if (!place) { d.via.push({ x: Math.round(raw.x * 4) / 4, y: Math.round(raw.y * 4) / 4 }); break; }
        draft.current = null;
        if (place.lane === d.from.lane && Math.abs(place.s - d.from.s) < 0.5 && !d.via.length) break;
        const id = nextId("c", sk.connectors.map(c => c.id));
        editSketch(k => ({ ...k, connectors: [...k.connectors, { id, from: d.from, to: place, ...(d.via.length ? { via: d.via } : {}) }] }));
        setSel({ ...NO_SEL, connectors: [id] });
        break;
      }
    }
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const raw = toWorld(e), g = drag.current, v = view.current;
    if (g?.kind === "pan") {
      view.current = { ...g.v0, cx: g.v0.cx - (e.clientX - g.x0) / v.scale, cy: g.v0.cy - (e.clientY - g.y0) / v.scale };
    } else if (g?.kind === "move") {
      const p = snap(raw).p;
      laneSketch$.next(settle(transformPiece(g.base, g.piece, translation(p.x - g.from.x, p.y - g.from.y))));
    } else if (g?.kind === "handle" && g.h.kind === "end") {
      // the end goes to the place on the lane under the cursor (and stays at the last one off lanes)
      const { id, end } = g.h, place = placeOn(raw), b = g.base;
      const c = b.connectors.find(x => x.id === id)!, other = c[end === "from" ? "to" : "from"];
      if (place && !(place.lane === other.lane && Math.abs(place.s - other.s) < 0.5 && !c.via?.length))
        laneSketch$.next({ ...b, connectors: b.connectors.map(x => (x.id === id ? { ...x, [end]: place } : x)) });
    } else if (g?.kind === "handle" && g.h.kind !== "end") {
      const { kind, id, i } = g.h, b = g.base;
      if (kind === "lane") {
        const l = laneById(b, id)!;
        if (l.shape.kind === "line") laneSketch$.next(settle(reshape(b, id, { ...l.shape, pts: l.shape.pts.map((q, k) => (k === i ? snap(raw, id).p : q)) })));
      } else if (kind === "bend") {
        const q = { x: Math.round(raw.x * 4) / 4, y: Math.round(raw.y * 4) / 4 };
        laneSketch$.next({ ...b, connectors: b.connectors.map(c => (c.id === id ? { ...c, via: c.via!.map((x, k) => (k === i ? q : x)) } : c)) });
      } else {
        laneSketch$.next({ ...b, junctions: b.junctions.map(j => (j.id === id ? { ...j, outline: j.outline.map((x, k) => (k === i ? snap(raw).p : x)) } : j)) });
      }
    } else if (g?.kind === "box") {
      g.b = raw;
    } else if (g?.kind === "rotate") {
      const step = (15 * Math.PI) / 180;
      let a = wrapAngle(Math.atan2(raw.y - g.o.y, raw.x - g.o.x) - g.a0);
      a = e.shiftKey ? Math.round(a / step) * step : a;
      g.angle = a;
      laneSketch$.next(settle(transformPiece(g.base, g.piece, rotation(g.o, a))));
    }
    if (canvas.current && tool === "select" && !g) {
      const rh = rotateHandle(live.current.sketch, live.current.sel, v.scale);
      canvas.current.style.cursor = (rh && dist(raw, rh.h) <= 8 / v.scale) || handleAt(raw) ? "grab" : "";
    }
    const d = draft.current;
    if (d?.kind === "arc" && d.start) {
      const a = Math.atan2(raw.y - d.c.y, raw.x - d.c.x);
      d.start.sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, d.start.sweep + wrapAngle(a - d.start.last)));
      d.start.last = a;
    }
    cursor.current = { ...(tool === "select" || tool === "connector" || tool === "slice" ? { p: raw, snapped: false } : snap(raw)), alt: e.altKey };
    hover.current = g ? null : pick(raw);
    redraw();
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = drag.current;
    drag.current = null;
    // a right click (not a right drag): the menu for the lane under it, or the lanes selected
    if (g?.kind === "pan" && g.right && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 4) { openMenu(e); return; }
    if (g?.kind === "move" || g?.kind === "handle" || g?.kind === "rotate") recordSketch(g.base);
    if (g?.kind === "box" && dist(g.a, g.b) * view.current.scale > 3) {
      const sk = live.current.sketch, x0 = Math.min(g.a.x, g.b.x), x1 = Math.max(g.a.x, g.b.x), y0 = Math.min(g.a.y, g.b.y), y1 = Math.max(g.a.y, g.b.y);
      const inside = (pts: Pt[] | null) => !!pts?.length && pts.every(p => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1);
      const got: Piece = {
        lanes: sk.lanes.filter(l => inside(samples(l.shape, 2))).map(l => l.id),
        connectors: sk.connectors.filter(c => inside(connectorPts(sk, c))).map(c => c.id),
        junctions: sk.junctions.filter(j => inside(j.outline)).map(j => j.id),
      };
      const merge = (a: string[], b: string[]) => [...new Set([...a, ...b])];
      setSel(s => (g.add ? { road: null, lanes: merge(s.lanes, got.lanes), connectors: merge(s.connectors, got.connectors), junctions: merge(s.junctions, got.junctions) } : { ...got, road: null }));
    }
    redraw();
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (tool === "lane") { finishLane(); return; }
    if (tool === "junction") { finishJunction(); return; }
    if (tool !== "select") return;
    const p = toWorld(e);
    if (editPoints(p)) return;
    const h = pick(p), r = h && "lane" in h ? roadOf(live.current.sketch, h.lane) : null;
    if (r) setSel({ ...NO_SEL, lanes: r.lanes, road: r.id });
  };

  // zoom about the cursor (a native listener: React's wheel events can't stop the page scrolling)
  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const before = toWorld(e), v = view.current;
      const scale = Math.min(80, Math.max(0.3, v.scale * Math.exp(-e.deltaY * 0.0015)));
      view.current = { scale, cx: before.x - (before.x - v.cx) * (v.scale / scale), cy: before.y - (before.y - v.cy) * (v.scale / scale) };
      redraw();
    };
    c.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => redraw());
    ro.observe(c);
    return () => { c.removeEventListener("wheel", onWheel); ro.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ------------------------------------------------------------ keys (kept from the plan's shortcuts while the window has focus)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input,textarea")) { e.stopPropagation(); return; }
    e.stopPropagation();
    const k = e.key.toLowerCase(), mod = e.metaKey || e.ctrlKey, d = draft.current;
    if (mod && k === "z") { e.preventDefault(); if (e.shiftKey) redoSketch(); else undoSketch(); return; }
    if (mod && k === "y") { e.preventDefault(); redoSketch(); return; }
    if (mod && k === "c") { if (copySel()) e.preventDefault(); return; }
    if (mod && k === "x") { if (copySel()) { e.preventDefault(); deleteSel(); } return; }
    if (mod && k === "v") { e.preventDefault(); paste(); return; }
    if (mod && k === "d") { e.preventDefault(); duplicate(); return; }
    if (mod) return;
    if (k === " ") { e.preventDefault(); space.current = true; return; }
    if (k === "escape") { if (d) draft.current = null; else { setSel(NO_SEL); setSelCar(null); } redraw(); return; }
    if (k === "enter") { finishLane(); finishJunction(); return; }
    if (k === "backspace" && d && (d.kind === "lane" || d.kind === "junction" || d.kind === "connector")) {
      e.preventDefault();
      if (d.kind === "connector") { if (!d.via.pop()) draft.current = null; } else { d.pts.pop(); if (!d.pts.length) draft.current = null; }
      redraw();
      return;
    }
    if (k === "delete" || k === "backspace") {
      e.preventDefault();
      const pt = live.current.selPt;
      if (pt && live.current.sel.lanes.includes(pt.lane)) deletePoint(pt.lane, pt.i); else deleteSel();
      return;
    }
    if (k === "g") { groupSel(); return; }
    if (k === "r") { reverseSel(); return; }
    if (k === "q" || k === "e") { rotateSel(((k === "e" ? 1 : -1) * (e.shiftKey ? 1 : 15) * Math.PI) / 180); return; }
    if (k === "f") { fit(); return; }
    if (k === "p") { play(); return; }
    // (the replay: a step back or forward; Shift, a second)
    if (k === "arrowleft" || k === "arrowright" || ((k === "," || k === ".") && live.current.replayT !== null)) {
      e.preventDefault();
      stepReplay((k === "arrowleft" || k === "," ? -1 : 1) * (e.shiftKey ? 1 : REPLAY_STEP));
      return;
    }
    const t = TOOLS.find(t => t.key.toLowerCase() === k);
    if (t) changeTool(t.id);
  };
  const onKeyUp = (e: React.KeyboardEvent) => { if (e.key === " ") space.current = false; };

  const toolInfo = TOOLS.find(t => t.id === tool)!;
  const copy = () => {
    void navigator.clipboard.writeText(JSON.stringify(exportSketch(sketch, contents), null, 2))
      .then(() => toast.success("Copied the sketch", { description: "Lanes, connectors, roads and junctions (with what each takes in), as JSON." }), () => toast.error("Couldn't copy"));
  };
  const empty = !sketch.lanes.length && !sketch.junctions.length;

  return (
    <div ref={panel} style={page ? undefined : style} role={page ? "region" : "dialog"} aria-label={page ? "Plan editor" : "Lane sketch"} tabIndex={-1} onKeyDown={onKeyDown} onKeyUp={onKeyUp}
      className={page
        ? "relative flex size-full flex-col overflow-hidden bg-background outline-none"
        : cn("absolute z-30 flex flex-col overflow-hidden rounded-lg border bg-background shadow-xl outline-none", !placed && "top-3 right-3 h-[min(640px,calc(100%-1.5rem))] w-[min(1280px,calc(100%-1.5rem))]")}>
      {!page && <ResizeEdges start={start} />}
      <div className={cn("flex items-center gap-2 border-b px-3 py-1.5 select-none", !page && "cursor-move touch-none")} title={page ? undefined : "Drag to move · double-click to put back"}
        onPointerDown={e => { if (!page && !(e.target as HTMLElement).closest("button")) start(e, null); }} onDoubleClick={e => { if (!page && !(e.target as HTMLElement).closest("button")) reset(); }}>
        {!page && <span className="text-sm font-medium">Lane sketch <span className="text-xs font-normal text-muted-foreground">· {readOnly ? "view only: changes here aren't saved" : "saved with the plan"}</span></span>}
        <ToggleGroup type="single" value={tool} onValueChange={v => v && changeTool(v as Tool)} aria-label="Drawing tool" className="ml-2">
          {TOOLS.map(t => <ToggleGroupItem key={t.id} value={t.id} aria-label={tip(t)} title={tip(t)} className="h-7 px-2">{t.icon}</ToggleGroupItem>)}
        </ToggleGroup>
        <div className="ml-auto flex items-center gap-0.5">
          <Button size="sm" variant={running ? "secondary" : "default"} className="mr-0.5 h-7 w-20" onClick={play} title={running ? "Pause the cars (P)" : "Run cars on the sketch (P)"}>
            {running ? <><Pause /> Pause</> : <><Play /> Run</>}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Clear the cars" title="Take the cars off and start the clock again" disabled={!stats} onClick={resetCars}><RotateCcw /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Undo" title="Undo (⌘Z / Ctrl+Z)" onClick={undoSketch}><Undo2 /></Button>
          <Button size="icon-sm" variant="ghost" aria-label="Redo" title="Redo (⇧⌘Z / Ctrl+Y)" onClick={redoSketch}><Redo2 /></Button>
          {/* (a V2 plan: the layers are picked in the top bar) */}
          {!page && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant={LAYERS.every(l => layers[l.id]) ? "ghost" : "secondary"} aria-label="Layers" title="Layers: what to show on the sketch"><LayersIcon /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuCheckboxItem checked={LAYERS.every(l => layers[l.id])} onCheckedChange={() => setLayers(LAYERS.every(l => layers[l.id]) ? { ...ALL_LAYERS, ...Object.fromEntries(LAYERS.map(l => [l.id, false])) } : ALL_LAYERS)} onSelect={e => e.preventDefault()}>
                All layers
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {LAYERS.filter(l => page || !l.page).map(l => (
                <DropdownMenuCheckboxItem key={l.id} className="group" checked={layers[l.id]} title={l.hint} onCheckedChange={v => setLayers({ ...layers, [l.id]: !!v })} onSelect={e => e.preventDefault()}>
                  <span className={cn(l.id === "markings" && !layers.surfaces && "text-muted-foreground")}>{l.label}</span>
                  <button type="button" className="ml-auto rounded px-1 text-[11px] text-muted-foreground opacity-0 group-hover:opacity-100 group-focus:opacity-100 hover:bg-background hover:text-foreground"
                    onClick={e => { e.stopPropagation(); e.preventDefault(); setLayers({ ...(Object.fromEntries(LAYERS.map(x => [x.id, false])) as Layers), [l.id]: true }); }} aria-label={`Only ${l.label}`}>only</button>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          )}
          <Button size="icon-sm" variant="ghost" aria-label="Fit to view" title="Fit the sketch in view (F)" onClick={fit}><Maximize /></Button>
          {!page && <Button size="icon-sm" variant="ghost" aria-label="Close" title="Close (the sketch stays with the plan)" onClick={() => { ui.getValue().sketch = false; }}><X /></Button>}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-56 shrink-0 flex-col overflow-y-auto border-r text-sm" aria-label="Sketch structure">
          <StructureTree sketch={sketch} sel={sel} setSel={setSel} contents={contents} junctionSel={ids => junctionSel(sketch, ids)}
            onHover={h => { hover.current = h; redraw(); }} onZoom={zoomTo} onCenter={centerOn} />
        </aside>
        <div className="relative min-w-0 flex-1">
          {menu && (
            <DropdownMenu open onOpenChange={o => { if (!o) setMenu(null); }}>
              <DropdownMenuTrigger asChild><span className="absolute size-px" style={{ left: menu.x, top: menu.y }} aria-hidden /></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56" onCloseAutoFocus={e => { e.preventDefault(); panel.current?.focus(); }}>
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{menu.lanes.length === 1 ? `Lane ${menu.lanes[0]}` : `${menu.lanes.length} lanes`}</DropdownMenuLabel>
                <DropdownMenuItem disabled={readOnly || !menu.straightenable} onSelect={() => editSketch(s => straightenLanes(s, menu.lanes))}>
                  Straighten <span className="ml-auto text-[11px] text-muted-foreground">only the ends</span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={readOnly || !menu.straightenable} onSelect={() => editSketch(s => straightenLanes(s, menu.lanes, 0.5))}>
                  Fewer points <span className="ml-auto text-[11px] text-muted-foreground">within 0.5 m</span>
                </DropdownMenuItem>
                <DropdownMenuItem disabled={readOnly || !menu.straightenable} onSelect={() => makeCurve(menu.lanes)}>
                  Make a curve <span className="ml-auto text-[11px] text-muted-foreground">2 ends, 1 curved point</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <canvas ref={canvas} className={cn("absolute inset-0 size-full touch-none", tool === "select" ? "cursor-default" : "cursor-crosshair")}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
            onPointerLeave={() => { cursor.current = null; hover.current = null; redraw(); }}
            onDoubleClick={onDoubleClick} onContextMenu={e => e.preventDefault()} />
          <div className="pointer-events-none absolute inset-x-2 top-2 rounded bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
            <span className="font-medium text-foreground">{toolInfo.label}:</span> {toolInfo.hint} · scroll zooms, right-drag or Space-drag pans, right-click a lane for its menu
          </div>
          <SketchReplayBar kept={replayRange} t={replayT} playing={replayPlaying} onPlaying={setReplayPlaying}
            onShow={showAt} onLive={goLive} onCopy={() => void copyMoment()} />
        </div>
        <aside className="flex w-80 shrink-0 flex-col overflow-y-auto border-l text-sm" aria-label="Sketch details">
          {selCar !== null && (
            <CarPanel info={carInfo} id={selCar} follow={follow} running={running} replayT={replayT}
              onFollow={setFollow} onPick={setSelCar} onClose={() => { setSelCar(null); setFollow(false); }}
              onCopy={async () => {
                const s = sim.current, info = s?.inspect(selCar);
                if (!s) return;
                const { frames, events } = await s.car(selCar);
                const text = `Lane sketch car ${selCar} at ${clock(s.t)}\n\`\`\`json\n${JSON.stringify({ car: info ? { ...info, route: undefined } : "left the sketch", frames, events })}\n\`\`\`\n`;
                void navigator.clipboard.writeText(text).then(() => toast.success(`Car ${selCar}'s data copied`, { description: "Its state, its last 10 s and what happened to it. Paste it into the conversation." }), () => toast.error("Couldn't copy"));
              }} />
          )}
          <SelectionPanel sketch={sketch} sel={sel} setSel={setSel} contents={contents} junctionSel={ids => junctionSel(sketch, ids)}
            selPt={selPt} onCurvePoint={curvePoint} onDeletePoint={deletePoint}
            onGroup={groupSel} onJunctionAround={junctionAround} onReverse={reverseSel} onDelete={deleteSel} onHover={h => { hover.current = h; redraw(); }} />
          {page && <BackgroundPanel sketch={sketch} sat={sat} setSat={setSat} viewNow={viewNow} calib={calib} setCalib={setCalib} readOnly={readOnly} />}
          <TrafficPanel sketch={sketch} params={params} setParams={setParams} simSpeed={simSpeed} setSimSpeed={setSimSpeed} stats={stats} onCopy={copyRun} />
          <DemandPanel sketch={sketch} readOnly={readOnly} onFocus={lanes => { hover.current = lanes ? { lanes } : null; redraw(); }} />
          <div className="mt-auto flex gap-1.5 border-t p-2">
            <Button size="sm" variant="outline" className="flex-1" onClick={copy} disabled={empty}><Copy /> Copy JSON</Button>
            <Button size="sm" variant="ghost" aria-label="Clear the sketch" title="Clear the sketch (undo brings it back)" disabled={empty}
              onClick={() => { editSketch(s => ({ ...emptySketch(), ...(s.geo ? { geo: s.geo } : {}), ...(s.traffic ? { traffic: s.traffic } : {}) })); setSel(NO_SEL); }}><Trash2 /></Button>
          </div>
        </aside>
      </div>
    </div>
  );
}

const fmtM = (m: number) => `${m.toFixed(1)} m`;
const deg = (r: number) => (r * 180) / Math.PI;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const edgeName = (key: string) => key.replace(/^lane:/, "lane ").replace(/^conn:/, "connector ");
/** what holds a car back, in words (and the car it is about, to pick) */
function reasonOf(why: string | null, kmh: number): { text: string; car?: number } {
  if (!why) return { text: kmh < 1 ? "Stopped" : "Free road ahead" };
  let m: RegExpExecArray | null;
  if ((m = /^car (\d+)$/.exec(why))) return { text: "Following car", car: Number(m[1]) };
  if ((m = /^stop (\S+)$/.exec(why))) return { text: `At the stop line at the end of ${edgeName(m[1])}` };
  if ((m = /^signal (\S+) (red|amber)$/.exec(why))) return { text: `Waiting at the ${m[2]} light at the end of ${edgeName(m[1])}` };
  if ((m = /^merge (\S+): ring nearly full$/.exec(why))) return { text: `Waiting to join ${edgeName(m[1])}: the ring is nearly full` };
  if ((m = /^merge (\S+): no room for car (\d+)$/.exec(why))) return { text: `Waiting to join ${edgeName(m[1])}: no room past where it joins, behind car`, car: Number(m[2]) };
  if ((m = /^merge (\S+) for car (\d+)$/.exec(why))) return { text: `Giving way to join ${edgeName(m[1])}, to car`, car: Number(m[2]) };
  if ((m = /^zone (\S+) for car (\d+)$/.exec(why))) return { text: `Giving way where its path meets ${edgeName(m[1])}, to car`, car: Number(m[2]) };
  if ((m = /^changing to (\S+)$/.exec(why))) return { text: `Waiting to change to ${edgeName(m[1])}` };
  if ((m = /^letting car (\d+) change lane$/.exec(why))) return { text: "Letting in, to change lane, car", car: Number(m[1]) };
  if ((m = /^letting car (\d+) in$/.exec(why))) return { text: "Letting in car", car: Number(m[1]) };
  if ((m = /^keeping clear \((.*)\)$/.exec(why))) { const r = reasonOf(m[1], kmh); return { text: `Keeping a crossing clear (${r.text.charAt(0).toLowerCase()}${r.text.slice(1)}${r.car !== undefined ? ` ${r.car}` : ""})` }; }
  return { text: why };
}

/** a recorded car's details, in the shape of a live one (what wasn't kept left out: its place along, its desired speed, its route) */
/**
 * Lanes made one curve each, their two ends and a curved point (see curveLanes); a warning for one that
 * bends more than one curve can follow (straying more than half a lane's width from where it ran).
 */
function makeCurve(ids: string[]) {
  let off: { lane: string; off: number }[] = [];
  editSketch(s => { const r = curveLanes(s, ids); off = r.off; return r.sketch; });
  if (!off.length) { toast("Nothing to make a curve of", { description: "Only open lanes of more than two points are (not rings or arcs, nor a road's lanes that follow its lead lane)." }); return; }
  const worst = off.reduce((a, b) => (b.off > a.off ? b : a));
  if (worst.off > LANE_WIDTH / 2) toast.warning(`Lane ${worst.lane} now strays up to ${worst.off.toFixed(1)} m from where it ran`, { description: "It bends more than one curve can follow: drag its curved point, or undo (Ctrl+Z) and use Fewer points instead." });
}

function replayInfo(c: ReplayCar | undefined): ReturnType<SketchSim["inspect"]> {
  if (!c) return null;
  return { id: c.id, edge: c.edge, pos: NaN, len: NaN, ring: false, kmh: c.kmh, desiredKmh: NaN, exit: c.exit, then: null, leaves: false, dest: null, changeTo: null, goal: null, why: c.why, still: 0, p: c.p, d: c.d, route: [] };
}

function CarPanel({ info, id, follow, running, replayT, onFollow, onPick, onClose, onCopy }: {
  info: ReturnType<SketchSim["inspect"]>; id: number; follow: boolean; running: boolean; replayT: number | null;
  onFollow: (on: boolean) => void; onPick: (id: number) => void; onClose: () => void; onCopy: () => void;
}) {
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-2 text-xs"><span className="text-muted-foreground">{label}</span><span className="text-right">{value}</span></div>
  );
  const reason = info ? reasonOf(info.why, info.kmh) : null;
  return (
    <section className="grid gap-2 border-b bg-muted/30 p-3">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        <Car className="size-3.5" /> <span className="flex-1">Car {id}</span>
        <button className="rounded p-0.5 hover:bg-muted" aria-label="Stop inspecting the car" title="Stop inspecting (Esc)" onClick={onClose}><X className="size-3.5" /></button>
      </h3>
      {!info ? <p className="text-xs text-muted-foreground">{replayT !== null ? "Not on the sketch at this moment." : "It has left the sketch."}</p> : replayT !== null ? (
        <>
          {row("At", <span className="font-mono tabular">{clock(replayT)} (replay)</span>)}
          {row("On", <span className="font-mono">{edgeName(info.edge)}</span>)}
          {row("Speed", <span className="font-mono tabular">{info.kmh.toFixed(0)} km/h</span>)}
          {info.exit && row("Going", edgeName(info.exit))}
          {row("Then", <>{reason!.text}{reason!.car !== undefined && <> <button className="underline" onClick={() => onPick(reason!.car!)}>{reason!.car}</button></>}</>)}
          <Button size="sm" variant={follow ? "secondary" : "outline"} className="h-7" aria-pressed={follow} onClick={() => onFollow(!follow)} title="Keep the view on the car while the replay plays">
            <Crosshair /> {follow ? "Following" : "Follow"}
          </Button>
        </>
      ) : (
        <>
          {row("On", <span className="font-mono">{edgeName(info.edge)} · {info.pos.toFixed(1)}{info.ring ? "" : ` of ${info.len.toFixed(1)}`} m</span>)}
          {row("Speed", <span className="font-mono tabular">{info.kmh.toFixed(0)} km/h <span className="text-muted-foreground">of {info.desiredKmh.toFixed(0)}</span></span>)}
          {info.changeTo && row("Changing to", <span className="font-mono">{edgeName(info.changeTo)}</span>)}
          {row("Heading for", info.dest ? `the exit at the end of lane ${info.dest}` : "anywhere (no exit it can reach)")}
          {row("Going", info.goal ? (info.goal.startsWith("end:") ? `off the end of ${edgeName(info.goal.slice(4))}` : edgeName(info.goal)) : info.leaves ? `off the end of ${edgeName(info.edge)}` : info.exit ? `${edgeName(info.exit)}, then ${edgeName(info.then ?? "")}` : info.then ? `onto ${edgeName(info.then)}` : "round the ring")}
          {row("Now", <>{reason!.text}{reason!.car !== undefined && <> <button className="underline" onClick={() => onPick(reason!.car!)}>{reason!.car}</button></>}</>)}
          {info.still >= 1 && row("Stopped for", <span className="font-mono tabular">{info.still.toFixed(0)} s</span>)}
          <div className="flex gap-1.5">
            <Button size="sm" variant={follow ? "secondary" : "outline"} className="h-7 flex-1" aria-pressed={follow} onClick={() => onFollow(!follow)} title="Keep the view on the car while the cars run">
              <Crosshair /> {follow ? "Following" : "Follow"}
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={onCopy} title="Copy the car's state, its last 10 s and what happened to it, to paste into a conversation"><ClipboardCopy /></Button>
          </div>
          {!running && <p className="text-[11px] text-muted-foreground">Paused: Run to watch it.</p>}
        </>
      )}
    </section>
  );
}

/**
 * A junction's signs, as on the plan: for each way into it a sign (none, yield or stop) on every
 * lane of it that ends there, and the whole junction at once (an all-way stop: the first there goes first).
 */
function JunctionSigns({ sketch, contents }: { sketch: Sketch; contents: JunctionContents }) {
  const ways = junctionApproaches(sketch, contents);
  if (!ways.length) return <p className="text-[11px] text-muted-foreground">Signs: no lane ends into it (signs go where a lane&apos;s connectors leave its end).</p>;
  const all = (control: LaneControl | null) => editSketch(sk => setSigns(sk, ways.flatMap(w => w.lanes), control));
  const allStop = ways.every(w => w.sign === "stop");
  return (
    <div className="grid gap-1.5">
      <span className="text-xs text-muted-foreground">Signs on the ways in{allStop && ways.length > 1 ? " · all-way stop" : ""}</span>
      {ways.map(w => (
        <div key={w.road ?? w.lanes[0]} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs" title={`${w.name}: ${plural(w.lanes.length, "lane")} (${w.lanes.join(", ")})`}>{w.name}</span>
          <ToggleGroup type="single" value={w.sign === "mixed" ? "" : (w.sign ?? "none")} aria-label={`Sign on ${w.name}`}
            onValueChange={v => v && editSketch(sk => setSigns(sk, w.lanes, v === "none" ? null : (v as LaneControl)))}>
            <ToggleGroupItem value="none" className="h-6 px-1.5 text-[11px]" title="No sign: it has right of way over signed ways">None</ToggleGroupItem>
            <ToggleGroupItem value="yield" className="h-6 px-1.5 text-[11px]" title="Give way to the ways without a sign">Yield</ToggleGroupItem>
            <ToggleGroupItem value="stop" className="h-6 px-1.5 text-[11px]" title="Stop at the line, then give way to the ways without a sign">Stop</ToggleGroupItem>
          </ToggleGroup>
        </div>
      ))}
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" className="flex-1" disabled={allStop} onClick={() => all("stop")} title="A stop sign on every way in: each car stops, then the first there goes first">All-way stop</Button>
        <Button size="sm" variant="outline" className="flex-1" disabled={ways.every(w => w.sign === null)} onClick={() => all(null)} title="Take every sign away">Clear signs</Button>
      </div>
    </div>
  );
}

/**
 * A junction's traffic lights, as on the plan: their times, actuated or not, and the phases: worked
 * out (ways facing each other together, or one at a time) or set by hand, each with its own green and
 * the connectors that have green in it (hovering a phase lights them up on the sketch).
 */
function JunctionLightsPanel({ sketch, junction, contents, onHover }: { sketch: Sketch; junction: SketchJunction; contents: JunctionContents; onHover: (h: Hover | null) => void }) {
  const L = junction.lights!, plan = signalPlan(sketch, junction, contents);
  const set = (patch: Partial<JunctionLights>) => editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => (x.id === junction.id ? { ...x, lights: { ...L, ...patch } } : x)) }));
  const name = (key: string) => (key.startsWith("lane:") ? `Lane ${key.slice(5)}` : sketch.roads.find(r => r.id === key)?.name ?? key);
  if (!plan) return <p className="text-[11px] text-muted-foreground">No lane ends into it, so there is nothing for the lights to hold (they go where a lane&apos;s connectors leave its end).</p>;
  const phases = L.phases ?? [];
  const setPhases = (ps: LightsPhase[]) => { const n = { ...L }; if (ps.length) n.phases = ps; else delete n.phases; editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => (x.id === junction.id ? { ...x, lights: n } : x)) })); };
  const setPhase = (i: number, patch: Partial<LightsPhase>) => setPhases(phases.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  // (a connector by where it goes: from which way, to which road, turning which way)
  const label = (id: string) => {
    const c = sketch.connectors.find(x => x.id === id);
    if (!c) return id;
    const a = at(sketch, c.from), b = at(sketch, c.to), to = roadOf(sketch, c.to.lane)?.name ?? `lane ${c.to.lane}`;
    const ang = a && b ? Math.atan2(a.d.x * b.d.y - a.d.y * b.d.x, a.d.x * b.d.x + a.d.y * b.d.y) : 0;
    const turn = Math.abs(ang) < 0.5 ? "straight" : Math.abs(ang) > 2.6 ? "U-turn" : ang > 0 ? "right" : "left";
    return `${c.from.lane} → ${to} (${turn})`;
  };
  const byWay = junctionApproaches(sketch, contents).map(w => ({ w, conns: plan.controlled.filter(id => w.lanes.includes(sketch.connectors.find(x => x.id === id)!.from.lane)) }));
  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-3 gap-2">
        <NumberField id="sk-green" label={L.actuated ? "Max green" : "Green"} unit="s" digits={0} value={L.green} min={3} max={180} step={1} onCommit={green => set({ green })} />
        <NumberField id="sk-amber" label="Amber" unit="s" digits={0} value={L.amber} min={0} max={10} step={1} onCommit={amber => set({ amber })} />
        <NumberField id="sk-allred" label="All red" unit="s" digits={0} value={L.allRed} min={0} max={15} step={1} onCommit={allRed => set({ allRed })} />
      </div>
      <div className="grid grid-cols-[1fr_auto] items-end gap-2">
        <label className="flex items-center justify-between gap-2 pb-1.5 text-xs" title="End a green nobody is using once its minimum is over, when another phase has cars waiting; pass over phases nobody waits for; rest on green when nobody else waits">
          Actuated <Switch checked={L.actuated} onCheckedChange={actuated => set({ actuated })} />
        </label>
        <NumberField id="sk-mingreen" label="Min green" unit="s" digits={0} value={L.minGreen} min={1} max={60} step={1} onCommit={minGreen => set({ minGreen })} />
      </div>
      <ToggleGroup type="single" value={phases.length ? "custom" : L.mode} aria-label="Phases" className="w-full"
        onValueChange={v => {
          if (!v) return;
          // (by hand: starting from the phases worked out now)
          if (v === "custom") setPhases(plan.phases.map(p => ({ name: p.name, green: p.green, conns: [...p.conns] })));
          else editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => { if (x.id !== junction.id) return x; const n = { ...L, mode: v as JunctionLights["mode"] }; delete n.phases; return { ...x, lights: n }; }) }));
        }}>
        <ToggleGroupItem value="pairs" className="h-7 flex-1 px-1 text-[11px]" title="Ways facing each other get green together">Opposite together</ToggleGroupItem>
        <ToggleGroupItem value="each" className="h-7 flex-1 px-1 text-[11px]" title="One way in at a time">One at a time</ToggleGroupItem>
        <ToggleGroupItem value="custom" className="h-7 flex-1 px-1 text-[11px]" title="Phases set by hand: their order, greens, and which connectors go in each">By hand</ToggleGroupItem>
      </ToggleGroup>
      {!phases.length ? (
        <div className="grid gap-0.5">
          {plan.phases.map((p, i) => (
            <div key={i} className="flex justify-between gap-2 rounded px-1 text-xs hover:bg-muted" onMouseEnter={() => onHover({ conns: p.conns })} onMouseLeave={() => onHover(null)}>
              <span className="truncate"><span className="text-muted-foreground">{p.name}:</span> {p.ways.map(name).join(" + ")}</span>
              <span className="shrink-0 font-mono tabular text-muted-foreground">{p.green} s</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          {phases.map((p, i) => (
            <div key={i} className="grid gap-1.5 rounded-md border p-2" onMouseEnter={() => onHover({ conns: p.conns })} onMouseLeave={() => onHover(null)}>
              <div className="flex items-center gap-1">
                <Input aria-label={`Phase ${i + 1} name`} value={p.name ?? ""} placeholder={`Phase ${i + 1}`} className="h-7 flex-1 text-xs" onChange={e => setPhase(i, { name: e.target.value })} />
                <Button size="icon-sm" variant="ghost" aria-label="Earlier" title="Run it earlier" disabled={i === 0} onClick={() => setPhases(phases.map((q, k) => (k === i - 1 ? phases[i] : k === i ? phases[i - 1] : q)))}><ChevronUp /></Button>
                <Button size="icon-sm" variant="ghost" aria-label="Later" title="Run it later" disabled={i === phases.length - 1} onClick={() => setPhases(phases.map((q, k) => (k === i + 1 ? phases[i] : k === i ? phases[i + 1] : q)))}><ChevronDown /></Button>
                <Button size="icon-sm" variant="ghost" aria-label="Remove phase" title="Take the phase out" disabled={phases.length <= 1} onClick={() => setPhases(phases.filter((_, k) => k !== i))}><Trash2 /></Button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <NumberField id={`sk-ph${i}-g`} label={L.actuated ? "Max green" : "Green"} unit="s" digits={0} value={p.green} min={3} max={180} step={1} onCommit={green => setPhase(i, { green })} />
                <NumberField id={`sk-ph${i}-m`} label="Min green" unit="s" digits={0} value={p.minGreen ?? L.minGreen} min={1} max={60} step={1} onCommit={minGreen => setPhase(i, { minGreen })} />
              </div>
              {byWay.map(({ w, conns }) => (
                <div key={w.road ?? w.lanes[0]} className="grid gap-0.5">
                  <span className="text-[11px] text-muted-foreground">{w.name}</span>
                  {conns.map(id => (
                    <label key={id} className="flex items-center gap-1.5 text-xs" onMouseEnter={() => onHover({ conns: [id] })} onMouseLeave={() => onHover({ conns: p.conns })}>
                      <input type="checkbox" className="accent-green-600" checked={p.conns.includes(id)}
                        onChange={e => setPhase(i, { conns: e.target.checked ? [...p.conns, id] : p.conns.filter(x => x !== id) })} />
                      <span className="truncate">{label(id)}</span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          ))}
          <Button size="sm" variant="outline" disabled={phases.length >= MAX_PHASES} onClick={() => setPhases([...phases, { green: L.green, conns: [] }])}><Plus /> Add phase</Button>
          {plan.controlled.some(id => !phases.some(p => p.conns.includes(id))) && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">Some connectors are in no phase: they never get green.</p>
          )}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">{L.actuated ? `Up to ${plan.cycle} s round` : `A cycle of ${plan.cycle} s`}. Turning cars give way where their paths cross on green.</p>
    </div>
  );
}

function SelectionPanel({ sketch, sel, setSel, contents, junctionSel, selPt, onCurvePoint, onDeletePoint, onGroup, onJunctionAround, onReverse, onDelete, onHover }: {
  sketch: Sketch; sel: Sel; setSel: (s: Sel) => void; contents: Map<string, JunctionContents>; junctionSel: (ids: string[]) => Sel;
  selPt: { lane: string; i: number } | null; onCurvePoint: (lane: string, i: number) => void; onDeletePoint: (lane: string, i: number) => void;
  onGroup: () => void; onJunctionAround: () => void; onReverse: () => void; onDelete: () => void; onHover: (h: Hover | null) => void;
}) {
  const road = sel.road ? sketch.roads.find(r => r.id === sel.road) : null;
  const link = sel.link ? sketch.links?.find(k => k.id === sel.link) : null;
  const junction = sel.junctions.length === 1 ? sketch.junctions.find(j => j.id === sel.junctions[0]) : null;
  const lane = sel.lanes.length === 1 && !sel.connectors.length && !sel.junctions.length && !road ? laneById(sketch, sel.lanes[0]) : null;
  const conn = sel.connectors.length === 1 && !sel.lanes.length && !sel.junctions.length ? sketch.connectors.find(c => c.id === sel.connectors[0]) : null;
  const where = (a: LaneAt) => { const l = laneById(sketch, a.lane); return `${a.lane} at ${l ? (a.s < 0.01 ? "its start" : a.s > laneLength(l.shape) - 0.01 ? "its end" : fmtM(a.s)) : "?"}`; };
  const junctionOf = (kind: "lanes" | "connectors", id: string) => sketch.junctions.find(j => contents.get(j.id)?.[kind].includes(id));
  const roadName = (id: string) => sketch.roads.find(r => r.id === id)?.name ?? id;
  const rename = <K extends "roads" | "junctions">(kind: K, id: string, name: string) => laneSketch$.next({ ...sketch, [kind]: sketch[kind].map(x => (x.id === id ? { ...x, name } : x)) });

  let body: React.ReactNode;
  // (roads the selected lanes are in: two of them can be linked)
  const selRoads = [...new Set(sel.lanes.map(id => roadOf(sketch, id)?.id).filter((x): x is string => !!x))];
  const linkSel = () => {
    const next = linkRoads(sketch, selRoads[0], selRoads[1], nextId("k", (sketch.links ?? []).map(k => k.id)));
    if (!next) { toast.error("Can't link them", { description: "Their nearest ends are already linked." }); return; }
    editSketch(() => next);
    setSel({ ...NO_SEL, link: next.links![next.links!.length - 1].id });
  };
  if (link) {
    const endName = (e: { road: string; end: string }) => `${roadName(e.road)} (its ${e.end})`;
    body = (
      <>
        <p className="text-xs text-muted-foreground">Joins {endName(link.a)} to {endName(link.b)} · {plural(link.conns.length, "connector")}, made from the lanes at the two ends</p>
        <p className="text-[11px] text-muted-foreground">The road carries on across it: its surface runs from one end to the other, its lines go on, and each lane leads into the matching one. Move or turn either road and it follows.</p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" onClick={onDelete} title="Take the link away, with its connectors (Del)">Unlink</Button>
        </div>
      </>
    );
  } else if (road) {
    body = (
      <>
        <Input aria-label="Road name" value={road.name} className="h-8" onChange={e => rename("roads", road.id, e.target.value)} />
        <p className="text-xs text-muted-foreground">{plural(road.lanes.length, "lane")} ({road.lanes.join(", ")}) · joined at {sketch.junctions.filter(j => contents.get(j.id)?.roads.includes(road.id)).map(j => j.name).join(", ") || "no junction"}</p>
        {road.lanes.length > 1 && (
          <div className="grid gap-1.5">
            <label className="flex items-center justify-between gap-2 text-xs">
              <span title="Its lanes kept parallel to the lead lane, edge to edge (by their widths), each on its side and running its way; they follow the lead when it is moved or reshaped">Lanes side by side</span>
              <Switch checked={!!road.align} onCheckedChange={on => editSketch(sk => ({ ...sk, roads: sk.roads.map(r => (r.id === road.id ? { ...r, align: on ? alignmentOf(sk, r) : undefined } : r)) }))} />
            </label>
            {road.align && (
              <label className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">Lead lane</span>
                <select className="h-7 rounded-md border bg-transparent px-1.5 text-xs" value={road.align.ref}
                  onChange={e => { const ref = e.target.value; editSketch(sk => ({ ...sk, roads: sk.roads.map(r => (r.id === road.id ? { ...r, align: alignmentOf(sk, r, ref) } : r)) })); }}>
                  {road.lanes.map(id => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" onClick={() => editSketch(sk => ({ ...sk, roads: sk.roads.filter(r => r.id !== road.id) }))}>Ungroup</Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete the road's lanes" title="Delete the road and its lanes"><Trash2 /></Button>
        </div>
      </>
    );
  } else if (junction) {
    const c = contents.get(junction.id) ?? { lanes: [], connectors: [], roads: [] };
    body = (
      <>
        <Input aria-label="Junction name" value={junction.name} className="h-8" onChange={e => rename("junctions", junction.id, e.target.value)} />
        <p className="text-xs text-muted-foreground">
          {plural(c.lanes.length, "lane")}{c.lanes.length ? ` (${c.lanes.join(", ")})` : ""}, {plural(c.connectors.length, "connector")} on it · joins {c.roads.map(roadName).join(", ") || "no road"}
        </p>
        <p className="text-[11px] text-muted-foreground">Drag its corners to reshape it; double-click its edge to add a corner, a corner to take it out; Alt-click a corner to round it off (again to make it sharp). Moving or turning it takes what is on it along.</p>
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Surface</span>
          <ToggleGroup type="single" value={junction.shape ?? "drawn"} aria-label="Junction surface" className="w-full"
            onValueChange={v => v && editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => { if (x.id !== junction.id) return x; const n = { ...x }; if (v === "auto") n.shape = "auto"; else delete n.shape; return n; }) }))}>
            <ToggleGroupItem value="drawn" className="h-7 flex-1 text-xs" title="The surface is the border drawn">Drawn</ToggleGroupItem>
            <ToggleGroupItem value="auto" className="h-7 flex-1 text-xs" title="The surface is the union of its connectors and the ends of the roads entering it; the border drawn only says what it takes in">Automatic</ToggleGroupItem>
          </ToggleGroup>
          {junction.shape === "auto" && <>
            <div className="flex items-center justify-between gap-2 text-xs">
              <label htmlFor="sk-smooth" title="Round off the notches between its connectors and roads, as a kerb would">Smooth</label>
              <Switch id="sk-smooth" checked={!!junction.smooth} onCheckedChange={on => editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => { if (x.id !== junction.id) return x; const n = { ...x }; if (on) n.smooth = SMOOTH_R; else delete n.smooth; return n; }) }))} />
            </div>
            {!!junction.smooth && <NumberField id="sk-smooth-r" label="Kerb radius" unit="m" value={junction.smooth} min={0.5} max={50} step={0.5}
              onCommit={r => editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => (x.id === junction.id ? { ...x, smooth: r } : x)) }))} />}
            <p className="text-[11px] text-muted-foreground">Its border (dashed while selected) still decides which lanes and connectors are on it.</p>
          </>}
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" disabled={!!junction.curved && junction.curved.length === junction.outline.length && junction.curved.every(Boolean)}
            title="Round off every corner of its border" onClick={() => editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => (x.id === junction.id ? curveAllCorners(x, true) : x)) }))}>Round corners</Button>
          <Button size="sm" variant="outline" className="flex-1" disabled={!junction.curved?.some(Boolean)}
            title="Make every corner of its border sharp again" onClick={() => editSketch(sk => ({ ...sk, junctions: sk.junctions.map(x => (x.id === junction.id ? curveAllCorners(x, false) : x)) }))}>Sharp corners</Button>
        </div>
        <div className="grid gap-1">
          <span className="text-xs text-muted-foreground">Control</span>
          <ToggleGroup type="single" value={junction.lights ? "lights" : "signs"} aria-label="Junction control" className="w-full"
            onValueChange={v => v && editSketch(sk => {
              const ways = junctionApproaches(sk, c);
              return {
                // (lights replace the signs on the ways in)
                ...(v === "lights" ? setSigns(sk, ways.flatMap(w => w.lanes), null) : sk),
                junctions: sk.junctions.map(x => { if (x.id !== junction.id) return x; const n = { ...x }; if (v === "lights") n.lights = { ...DEFAULT_LIGHTS }; else delete n.lights; return n; }),
              };
            })}>
            <ToggleGroupItem value="signs" className="h-7 flex-1 text-xs" title="Signs on the ways in (or none: the first there goes first)">Signs</ToggleGroupItem>
            <ToggleGroupItem value="lights" className="h-7 flex-1 text-xs" title="Traffic lights: each way in gets green in turn">Traffic lights</ToggleGroupItem>
          </ToggleGroup>
        </div>
        {junction.lights ? <JunctionLightsPanel sketch={sketch} junction={junction} contents={c} onHover={onHover} /> : <JunctionSigns sketch={sketch} contents={c} />}
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" title="Take the surface away; its lanes and connectors stay" onClick={() => { editSketch(sk => remove(sk, { junctions: [junction.id] })); setSel(NO_SEL); }}>Remove surface</Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete the junction and what is on it" title="Delete the junction and its lanes and connectors (Del)"><Trash2 /></Button>
        </div>
      </>
    );
  } else if (lane) {
    const sh = lane.shape, inRoad = roadOf(sketch, lane.id), j = junctionOf("lanes", lane.id), lead = leadOf(sketch, lane.id);
    // (a new width in a side-by-side road: its lanes packed again)
    const set = (shape: LaneShape, width?: number) => editSketch(s => {
      const k = reshape(s, lane.id, shape, width);
      return width === undefined || !inRoad?.align ? k : { ...k, roads: k.roads.map(r => (r.id === inRoad.id ? { ...r, align: alignmentOf(k, r, r.align!.ref) } : r)) };
    });
    const pt = selPt?.lane === lane.id && sh.kind === "line" && selPt.i < sh.pts.length ? selPt.i : null;
    body = (
      <>
        <p className="text-xs text-muted-foreground">
          {sh.kind === "arc" ? (isFullCircle(sh) ? "Ring" : "Arc") : `${sh.closed ? "Ring of " : ""}${sh.pts.length} points`} · {fmtM(laneLength(sh))} · {inRoad
            ? <>in <button className="underline" onClick={() => setSel({ ...NO_SEL, lanes: inRoad.lanes, road: inRoad.id })}>{inRoad.name}</button></>
            : j ? <>on <button className="underline" onClick={() => setSel(junctionSel([j.id]))}>{j.name}</button></> : "in no road or junction"}
        </p>
        {lead && <p className="text-[11px] text-muted-foreground">Side by side with lead lane {lead}: it follows it (move or reshape the lead).</p>}
        {sh.kind === "line" && !lead && (
          pt !== null ? (
            <div className="flex items-center gap-1.5 text-xs">
              <span className="flex-1 text-muted-foreground">Point {pt + 1} of {sh.pts.length}</span>
              <Button size="sm" variant="outline" className="h-7" disabled={!sh.closed && (pt === 0 || pt === sh.pts.length - 1)} title="Round the corner off here (Alt-click the point)" onClick={() => onCurvePoint(lane.id, pt)}>{sh.curved?.[pt] ? "Corner" : "Curve"}</Button>
              <Button size="sm" variant="ghost" className="h-7" disabled={sh.pts.length <= (sh.closed ? 3 : 2)} title="Take the point out (Del, or double-click it)" onClick={() => onDeletePoint(lane.id, pt)}><Trash2 /></Button>
            </div>
          ) : <p className="text-[11px] text-muted-foreground">Double-click the lane to add a point; click a point to pick it, Alt-click to curve it, double-click to take it out.</p>
        )}
        {sh.kind === "line" && !lead && !sh.closed && sh.pts.length > 2 && (
          <div className="grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="outline" title="Only its two ends: a straight lane (its connectors stay where they are)" onClick={() => editSketch(s => straightenLanes(s, [lane.id]))}>Straighten</Button>
            <Button size="sm" variant="outline" title="Leave out the points it doesn't need, keeping it within half a metre of where it runs" onClick={() => editSketch(s => straightenLanes(s, [lane.id], 0.5))}>Fewer points</Button>
            {!(sh.pts.length === 3 && sh.curved?.[1]) && (
              <Button size="sm" variant="outline" className="col-span-2" title="Its two ends and one curved point between them, where the curve keeps closest to where it runs (drag the point to bend it; its connectors move to the nearest place)" onClick={() => makeCurve([lane.id])}><Spline /> Make a curve</Button>
            )}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="sk-w" label="Width" unit="m" value={lane.width} min={2} max={8} step={0.25} onCommit={w => set(sh, w)} />
          {sh.kind === "arc" && <NumberField id="sk-r" label="Radius" unit="m" value={sh.r} min={1} max={500} step={0.5} onCommit={r => set({ ...sh, r })} />}
          {sh.kind === "arc" && <NumberField id="sk-sw" label="Sweep" unit="°" digits={0} value={deg(sh.sweep)} min={-360} max={360} onCommit={d => set({ ...sh, sweep: (d * Math.PI) / 180 })} />}
        </div>
        {sh.kind === "arc" && !lead && (
          <Button size="sm" variant="outline" title="Make it curved points along the same circle, to drag, add and curve like a drawn lane (a ring stays a ring); its connectors stay where they are"
            onClick={() => editSketch(s => arcToPoints(s, lane.id))}><Spline /> Edit as points</Button>
        )}
        {!isFullCircle(sh) && (
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">At its end</span>
            <ToggleGroup type="single" value={lane.control ?? "none"} aria-label="Sign at the lane's end" className="w-full"
              onValueChange={v => v && editSketch(s => setControl(s, lane.id, v === "none" ? null : (v as LaneControl)))}>
              <ToggleGroupItem value="none" className="h-7 flex-1 text-xs" title="No sign: where paths cross, the first there goes first">Nothing</ToggleGroupItem>
              <ToggleGroupItem value="yield" className="h-7 flex-1 text-xs" title="Yield: cars leaving here come up slowly and give way to traffic without a sign">Yield</ToggleGroupItem>
              <ToggleGroupItem value="stop" className="h-7 flex-1 text-xs" title="Stop: cars leaving here stop at the line, then give way to traffic without a sign">Stop</ToggleGroupItem>
            </ToggleGroup>
          </div>
        )}
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" onClick={onGroup} title="Make it a road of its own (G)">{inRoad ? "Own road" : "Make road"}</Button>
          <Button size="sm" variant="outline" onClick={onReverse} title="Turn its direction of travel (R)">Reverse</Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete lane" title="Delete (Del)"><Trash2 /></Button>
        </div>
      </>
    );
  } else if (conn) {
    const j = junctionOf("connectors", conn.id), bends = conn.via?.length ?? 0;
    body = (
      <>
        <p className="text-xs text-muted-foreground">From {where(conn.from)} to {where(conn.to)} · {bends ? plural(bends, "bend") : "no bends"}{j ? ` · on ${j.name}` : ""}</p>
        <p className="text-[11px] text-muted-foreground">Drag its ends along their lanes or onto other lanes, and its bends; double-click it to add a bend, a bend to take it out. It doesn&apos;t turn by itself: it follows its lanes.</p>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="flex-1" disabled={!bends} onClick={() => editSketch(sk => ({ ...sk, connectors: sk.connectors.map(c => (c.id === conn.id ? { id: c.id, from: c.from, to: c.to } : c)) }))}>Straighten</Button>
          <Button size="sm" variant="ghost" onClick={onDelete} aria-label="Delete connector" title="Delete (Del)"><Trash2 /></Button>
        </div>
      </>
    );
  } else if (!isEmpty(sel)) {
    body = (
      <>
        <p className="text-xs text-muted-foreground">{[plural(sel.lanes.length, "lane"), plural(sel.connectors.length, "connector"), sel.junctions.length ? plural(sel.junctions.length, "junction") : ""].filter(Boolean).join(", ")}</p>
        <div className="grid grid-cols-2 gap-1.5">
          <Button size="sm" variant="outline" disabled={!sel.lanes.length} onClick={onGroup} title="Group the lanes into one road (G)">Make road</Button>
          <Button size="sm" variant="outline" onClick={onJunctionAround} title="Draw a junction surface round the selection">Make junction</Button>
          {sel.lanes.length > 0 && <>
            <Button size="sm" variant="outline" title="The selected lanes with only their two ends: straight (rings, arcs and lanes following a lead are left; connectors stay where they are)" onClick={() => editSketch(s => straightenLanes(s, sel.lanes))}>Straighten</Button>
            <Button size="sm" variant="outline" title="The selected lanes without the points they don't need, each kept within half a metre of where it runs" onClick={() => editSketch(s => straightenLanes(s, sel.lanes, 0.5))}>Fewer points</Button>
            <Button size="sm" variant="outline" title="Each selected lane as its two ends and one curved point, the curve kept closest to where it runs (rings, arcs and lanes following a lead are left)" onClick={() => makeCurve(sel.lanes)}><Spline /> Make a curve</Button>
          </>}
        </div>
        {selRoads.length === 2 && (
          <Button size="sm" variant="outline" onClick={linkSel} title="Join the two roads at their nearest ends so the road carries on: a surface between them, its lines, and a connector for each lane">
            Link {roadName(selRoads[0])} and {roadName(selRoads[1])}
          </Button>
        )}
        <Button size="sm" variant="ghost" className="justify-start" onClick={onDelete}><Trash2 /> Delete</Button>
      </>
    );
  } else {
    body = <p className="text-xs text-muted-foreground">Draw lanes (L, A for arcs, O for a ring) and connectors (C, with bends where you click), group lanes into roads (G), and draw junctions (J): a surface taking in the lanes and connectors on it.</p>;
  }
  return (
    <section className="grid gap-2 border-b p-3">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{link ? `Link ${link.id}` : road ? "Road" : junction ? `Junction ${junction.id}` : lane ? `Lane ${lane.id}` : conn ? `Connector ${conn.id}` : "Selection"}</h3>
      {body}
    </section>
  );
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function TrafficPanel({ sketch, params, setParams, simSpeed, setSimSpeed, stats, onCopy }: {
  sketch: Sketch; params: SimParams; setParams: (p: SimParams) => void; simSpeed: number; setSimSpeed: (n: number) => void; stats: SimStats | null; onCopy: () => void;
}) {
  // where cars come in
  const entries = entryLanes(sketch).length;
  const row = (label: string, value: React.ReactNode, cls?: string) => (
    <div className={cn("flex justify-between gap-2 text-xs", cls)}><span className="text-muted-foreground">{label}</span><span className="font-mono tabular">{value}</span></div>
  );
  return (
    <section className="grid gap-2 border-b p-3">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Traffic</h3>
      <p className="text-[11px] text-muted-foreground">
        {entries
          ? `Cars come in at the start of the ${entries === 1 ? "lane" : `${entries} lanes`} nothing joins near their start (at each one's rate in Demand, or the one below), head for a lane end nothing leaves (by their shares of the trips) and take the shortest way there. Joining cars give way; cars at a stop or yield line give way to those without one; elsewhere, where connectors cross, the first there goes first.`
          : "Every lane has a connector joining it near its start (or is a ring), so no car can come in: draw a lane leading in."}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <NumberField id="sk-rate" label="Each entry" unit="veh/h" digits={0} value={params.rate} min={0} max={3000} step={50} onCommit={rate => setParams({ ...params, rate })} />
        <NumberField id="sk-speed" label="Speed" unit="km/h" digits={0} value={params.speed} min={10} max={130} step={5} onCommit={speed => setParams({ ...params, speed })} />
      </div>
      <ToggleGroup type="single" value={String(simSpeed)} onValueChange={v => v && setSimSpeed(Number(v))} aria-label="Simulation speed" className="w-full">
        {[1, 2, 4, 8].map(n => <ToggleGroupItem key={n} value={String(n)} className="h-7 flex-1 text-xs">{n}×</ToggleGroupItem>)}
      </ToggleGroup>
      {stats && (
        <div className="grid gap-0.5">
          {row("Time", clock(stats.t))}
          {row("Cars on the sketch", stats.vehicles)}
          {row("Came in / drove off", `${stats.spawned} / ${stats.finished}`)}
          {row("Through", stats.t > 60 ? `${Math.round((stats.finished / stats.t) * 3600)} veh/h` : "…")}
          {row("Mean speed", `${stats.meanSpeed.toFixed(0)} km/h`)}
          {row("Waiting 20 s+", stats.waiting, stats.waiting ? "text-amber-700 dark:text-amber-400" : undefined)}
          {stats.overlaps > 0 && row("Overlapping", stats.overlaps, "text-destructive")}
          {row("Collisions", stats.collisions ?? 0, stats.collisions ? "text-destructive" : undefined)}
          {(stats.laneChanges ?? 0) > 0 && row("Lane changes", stats.laneChanges)}
          {(stats.deadlocks ?? 0) > 0 && row("Deadlocks broken", stats.deadlocks, "text-amber-700 dark:text-amber-400")}
          {row("Jumps", stats.jumps, stats.jumps ? "text-destructive" : undefined)}
          <Button size="sm" variant="outline" className="mt-1.5" onClick={onCopy}
            title="Copy what the cars did (the sketch, the cars now, every jump, the last minute's events, the last 10 s of every car) to paste into a conversation">
            <ClipboardCopy /> Copy simulation data
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * The sketch as a tree: roads with their lanes, junctions with the roads they join, their connectors
 * and the lanes on them, and what is in neither. A click selects (⇧ adds to the selection) and centres it, a
 * double-click zooms to it, hovering lights it up on the sketch.
 */
function StructureTree({ sketch, sel, setSel, contents, junctionSel, onHover, onZoom, onCenter }: {
  sketch: Sketch; sel: Sel; setSel: (s: Sel) => void; contents: Map<string, JunctionContents>; junctionSel: (ids: string[]) => Sel;
  onHover: (h: Hit | null) => void; onZoom: (p: Piece) => void; onCenter: (p: Piece) => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  // (long lists: the first rows only, more on asking; what is selected always listed)
  const [limits, setLimits] = useState<Record<string, number>>({});
  const STEP = 60;
  const capped = <T,>(key: string, items: T[], chosen: (x: T) => boolean) => {
    const n = limits[key] ?? STEP, shown = items.slice(0, n);
    for (const x of items.slice(n)) if (chosen(x)) shown.push(x);
    return { shown, more: Math.max(0, items.length - n) };
  };
  const moreRow = (key: string, more: number) => more > 0 && (
    <button key={`${key}:more`} className="ml-6 justify-self-start rounded px-1 py-0.5 text-[11px] text-primary hover:underline" onClick={() => setLimits(l => ({ ...l, [key]: (l[key] ?? STEP) + 200 }))}>
      Show {Math.min(200, more)} more of {more}
    </button>
  );
  // (the junctions each road is joined at, worked out once)
  const joinedAt = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const j of sketch.junctions) for (const r of contents.get(j.id)?.roads ?? []) m.set(r, [...(m.get(r) ?? []), j.name]);
    return m;
  }, [sketch.junctions, contents]);
  const box = useRef<HTMLDivElement>(null);
  // (the row of what was just selected brought into view)
  useEffect(() => { box.current?.querySelector("[data-on='true']")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  const fold = (key: string) => setClosed(c => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const inRoad = new Set(sketch.roads.flatMap(r => r.lanes)), cs = [...contents.values()];
  const onJ = new Set(cs.flatMap(c => c.lanes)), connOnJ = new Set([...cs.flatMap(c => c.connectors), ...(sketch.links ?? []).flatMap(k => k.conns)]);
  const looseLanes = sketch.lanes.filter(l => !inRoad.has(l.id) && !onJ.has(l.id)), looseConns = sketch.connectors.filter(c => !connOnJ.has(c.id));
  // only what is selected, with what it is part of: the roads of its lanes, the junctions (or links) its lanes and connectors are on
  const sl = new Set(sel.lanes), sc = new Set(sel.connectors), sj = new Set(sel.junctions);
  const nothing = !sl.size && !sc.size && !sj.size && !sel.road && !sel.link;
  const roadsShown = sketch.roads.filter(r => sel.road === r.id || r.lanes.some(l => sl.has(l)));
  const junctionsShown = sketch.junctions.filter(j => { if (sj.has(j.id)) return true; const c = contents.get(j.id); return !!c && (c.connectors.some(id => sc.has(id)) || c.lanes.some(id => sl.has(id))); });
  const linksShown = (sketch.links ?? []).filter(k => sel.link === k.id || k.conns.some(id => sc.has(id)));
  const looseLanesShown = looseLanes.filter(l => sl.has(l.id)), looseConnsShown = looseConns.filter(c => sc.has(c.id));
  const roadName = (id: string) => sketch.roads.find(r => r.id === id)?.name ?? id;
  const laneName = (id: string) => { const r = roadOf(sketch, id); return r ? `${id} (${r.name})` : id; };
  const piece = (p: Partial<Piece>): Piece => ({ lanes: p.lanes ?? [], connectors: p.connectors ?? [], junctions: p.junctions ?? [] });
  const pick = (e: React.MouseEvent, s: Sel) => setSel(e.shiftKey ? { lanes: [...new Set([...sel.lanes, ...s.lanes])], connectors: [...new Set([...sel.connectors, ...s.connectors])], junctions: [...new Set([...sel.junctions, ...s.junctions])], road: null } : s);

  const row = (o: { key: string; depth: number; on: boolean; label: React.ReactNode; note?: React.ReactNode; title?: string; kids?: boolean; hit?: Hit; sel: Sel; zoom: Piece; tone?: string }) => (
    <div key={o.key} role="treeitem" aria-selected={o.on} aria-expanded={o.kids ? !closed.has(o.key) : undefined} data-on={o.on}
      className={cn("flex cursor-default items-center gap-1 rounded py-0.5 pr-1.5 text-xs hover:bg-muted", o.on && "bg-primary/10 text-foreground", o.tone)}
      style={{ paddingLeft: 4 + o.depth * 12 }} title={o.title}
      onMouseEnter={() => onHover(o.hit ?? null)} onMouseLeave={() => onHover(null)}
      onClick={e => { pick(e, o.sel); onCenter(o.zoom); }} onDoubleClick={() => onZoom(o.zoom)}>
      {o.kids
        ? <button className="grid size-4 shrink-0 place-items-center rounded text-muted-foreground hover:text-foreground" aria-label={closed.has(o.key) ? "Open" : "Close"}
            onClick={e => { e.stopPropagation(); fold(o.key); }}><ChevronRight className={cn("size-3 transition-transform", !closed.has(o.key) && "rotate-90")} /></button>
        : <span className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 truncate">{o.label}</span>
      {o.note !== undefined && <span className="shrink-0 truncate text-[11px] text-muted-foreground">{o.note}</span>}
    </div>
  );
  const heading = (key: string, text: string, n: number) => (
    <button key={key} className="mt-2 flex w-full items-center gap-1 px-1 text-left text-[11px] font-semibold tracking-wider text-muted-foreground uppercase first:mt-0" onClick={() => fold(key)} aria-expanded={!closed.has(key)}>
      <ChevronRight className={cn("size-3 transition-transform", !closed.has(key) && "rotate-90")} /> <span className="flex-1">{text}</span> <span className="font-normal tabular-nums">{n}</span>
    </button>
  );
  // (`under`: what the row is listed under, for its key: a lane or connector may be on two junctions whose surfaces overlap)
  const laneRow = (id: string, depth: number, under = "") => {
    const l = laneById(sketch, id);
    if (!l) return null;
    const next = sketch.connectors.filter(c => c.from.lane === id).map(c => c.to.lane);
    const sign = l.control === "stop" ? <span className="font-medium text-red-600 dark:text-red-400">stop</span> : l.control === "yield" ? <span className="font-medium text-amber-600 dark:text-amber-400">yield</span> : null;
    return row({
      key: `${under}lane:${id}`, depth, on: sel.lanes.includes(id) && !sel.road, hit: { lane: id }, sel: { ...NO_SEL, lanes: [id] }, zoom: piece({ lanes: [id] }),
      label: <>{id} {sign}</>, note: isFullCircle(l.shape) ? `ring · ${fmtM(laneLength(l.shape))}` : fmtM(laneLength(l.shape)),
      title: next.length ? `Leads on to ${[...new Set(next)].map(laneName).join(", ")}` : "Leads nowhere: cars drive off its end",
    });
  };
  const connRow = (id: string, depth: number, under = "") => {
    const c = sketch.connectors.find(x => x.id === id);
    if (!c) return null;
    return row({
      key: `${under}conn:${id}`, depth, on: sel.connectors.includes(id), hit: { connector: id }, sel: { ...NO_SEL, connectors: [id] }, zoom: piece({ connectors: [id] }),
      label: <>{id} <span className="text-muted-foreground">{c.from.lane} → {c.to.lane}</span></>, title: `From ${laneName(c.from.lane)} to ${laneName(c.to.lane)}`,
    });
  };
  const open = (key: string) => !closed.has(key);

  return (
    <div ref={box} role="tree" aria-label="Roads and junctions" className="grid gap-px p-2">
      <p className="px-1 pb-1 text-[11px] text-muted-foreground">
        {plural(sketch.roads.length, "road")} · {plural(sketch.junctions.length, "junction")} · {plural(sketch.lanes.length, "lane")} · {plural(sketch.connectors.length, "connector")}
      </p>
      {nothing
        ? <p className="px-1 text-xs text-muted-foreground">Select something on the map to see it here, with the road or junction it is part of. Click a row to select it and centre it, ⇧-click to add, double-click to zoom to it.</p>
        : <p className="px-1 pb-1 text-[11px] text-muted-foreground">The selection, with what it is part of · click selects and centres, ⇧-click adds, double-click zooms</p>}

      {!!roadsShown.length && heading("h:roads", "Roads", roadsShown.length)}
      {open("h:roads") && (roadsShown.length ? (() => { const { shown, more } = capped("roads", roadsShown, r => sel.road === r.id || r.lanes.some(l => sel.lanes.includes(l))); return [...shown.flatMap(r => {
        const js = joinedAt.get(r.id) ?? [];
        return [
          row({
            key: `road:${r.id}`, depth: 0, kids: true, on: sel.road === r.id, sel: { ...NO_SEL, lanes: r.lanes, road: r.id }, zoom: piece({ lanes: r.lanes }),
            label: <span className="font-medium">{r.name}</span>, note: plural(r.lanes.length, "lane"), title: js.length ? `Joined at ${js.join(", ")}` : "Joined at no junction",
          }),
          ...(open(`road:${r.id}`) ? r.lanes.map(id => laneRow(id, 1)) : []),
        ];
      }), moreRow("roads", more)]; })() : null)}

      {!!junctionsShown.length && heading("h:junctions", "Junctions", junctionsShown.length)}
      {open("h:junctions") && (junctionsShown.length ? (() => { const { shown, more } = capped("junctions", junctionsShown, j => sel.junctions.includes(j.id)); return [...shown.flatMap(j => {
        const c = contents.get(j.id) ?? { lanes: [], connectors: [], roads: [] }, k = `junction:${j.id}`;
        const group = (key: string, text: string, n: number, kids: React.ReactNode[]) => n ? [
          <div key={key} className="flex items-center gap-1 py-0.5 text-[11px] text-muted-foreground" style={{ paddingLeft: 4 + 12 }}>
            <button className="grid size-4 place-items-center rounded hover:text-foreground" aria-label={closed.has(key) ? "Open" : "Close"} onClick={() => fold(key)}>
              <ChevronRight className={cn("size-3 transition-transform", open(key) && "rotate-90")} />
            </button>
            {text} · {n}
          </div>,
          ...(open(key) ? kids : []),
        ] : [];
        return [
          row({
            key: k, depth: 0, kids: true, on: sel.junctions.includes(j.id), hit: { junction: j.id }, sel: junctionSel([j.id]), zoom: piece({ junctions: [j.id] }),
            label: <span className="font-medium">{j.name}</span>, note: c.roads.length ? plural(c.roads.length, "road") : plural(c.connectors.length, "connector"),
          }),
          ...(open(k) ? [
            ...group(`${k}:roads`, "Roads it joins", c.roads.length, c.roads.map(id => {
              const r = sketch.roads.find(x => x.id === id)!;
              return row({ key: `${k}:road:${id}`, depth: 2, on: sel.road === id, sel: { ...NO_SEL, lanes: r.lanes, road: id }, zoom: piece({ lanes: r.lanes }), label: roadName(id), note: plural(r.lanes.length, "lane") });
            })),
            ...group(`${k}:lanes`, "Lanes on it", c.lanes.length, c.lanes.map(id => laneRow(id, 2, `${k}:`))),
            ...group(`${k}:conns`, "Connectors", c.connectors.length, c.connectors.map(id => connRow(id, 2, `${k}:`))),
          ] : []),
        ];
      }), moreRow("junctions", more)]; })() : null)}

      {!!linksShown.length && <>
        {heading("h:links", "Links", linksShown.length)}
        {open("h:links") && linksShown.flatMap(k => [
          row({
            key: `link:${k.id}`, depth: 0, kids: true, on: sel.link === k.id, hit: { link: k.id }, sel: { ...NO_SEL, link: k.id }, zoom: piece({ connectors: k.conns }),
            label: <span className="font-medium">{roadName(k.a.road)} ↔ {roadName(k.b.road)}</span>, note: plural(k.conns.length, "connector"), title: `Joins ${roadName(k.a.road)} (its ${k.a.end}) to ${roadName(k.b.road)} (its ${k.b.end})`,
          }),
          ...(open(`link:${k.id}`) ? k.conns.map(id => connRow(id, 1, `link:${k.id}:`)) : []),
        ])}
      </>}

      {(looseLanesShown.length > 0 || looseConnsShown.length > 0) && <>
        {heading("h:loose", "Loose", looseLanesShown.length + looseConnsShown.length)}
        {open("h:loose") && <>
          <p className="px-6 pb-0.5 text-[11px] text-amber-700 dark:text-amber-400">In no road and on no junction</p>
          {(() => { const { shown, more } = capped("looseLanes", looseLanesShown, l => sel.lanes.includes(l.id)); return [...shown.map(l => laneRow(l.id, 0)), moreRow("looseLanes", more)]; })()}
          {(() => { const { shown, more } = capped("looseConns", looseConnsShown, c => sel.connectors.includes(c.id)); return [...shown.map(c => connRow(c.id, 0)), moreRow("looseConns", more)]; })()}
        </>}
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- drawing

interface PaintState {
  sketch: Sketch; sel: Sel; tool: Tool; view: View; draft: Draft | null; drag: Drag | null;
  cursor: { p: Pt; snapped: boolean; alt: boolean } | null; hover: Hover | null;
  placeOn: (p: Pt) => LaneAt | null;
  selPt: { lane: string; i: number } | null;
  /** the cars, if running: middle, heading, length and speed as a share of the desired one */
  cars: { p: Pt; d: Pt; len: number; share: number }[] | null;
  /** the time of the cars shown (live or replayed), for the traffic lights; null with no cars */
  simT: number | null;
  /** the traffic lights as they run with the cars (null: worked out from the fixed cycle) */
  signals: SignalController[] | null;
  /** what is under the sketch: the satellite imagery, the reference image (V2 plans; null otherwise) */
  bg: Background | null;
  /** the car picked to inspect, with the way it will go */
  car: ReturnType<SketchSim["inspect"]>;
  /** the layers shown */
  layers: Layers;
  /** what each junction takes in */
  contents: Map<string, JunctionContents>;
}

/** a marking's box (kept: markings are kept per sketch) */
const markBoxes = new WeakMap<{ pts: Pt[] }, { x0: number; y0: number; x1: number; y1: number }>();
function markBox(m: { pts: Pt[] }) {
  let b = markBoxes.get(m);
  if (!b) { b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }; for (const p of m.pts) { b.x0 = Math.min(b.x0, p.x); b.x1 = Math.max(b.x1, p.x); b.y0 = Math.min(b.y0, p.y); b.y1 = Math.max(b.y1, p.y); } markBoxes.set(m, b); }
  return b;
}

/** where automatic junction surfaces are put together before going on the sketch */
let scratch: HTMLCanvasElement | null = null;

/**
 * The sketch drawn: `part` "static", everything but what moves with the cars (into the image kept between
 * frames; `size`: the size of the canvas it is for, CSS px), or "dynamic", what moves (the cars, the car
 * picked, the traffic lights), over that image.
 */
function paint(c: HTMLCanvasElement, st: PaintState, part: "static" | "dynamic", size?: { w: number; h: number }) {
  const S = part === "static", D = part === "dynamic";
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = size?.w ?? c.clientWidth, h = size?.h ?? c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const ctx = c.getContext("2d")!, v = st.view, px = 1 / v.scale, tool = st.tool, placeOn = st.placeOn;
  const { sketch: sk, sel: s } = st;
  const dark = document.documentElement.classList.contains("dark"), pal = readPalette();
  // the plan's map colours: its ground and grid, connectors in its connector yellow, lanes in green
  // (selection in blue: the plan's selection green would be lost on green lanes)
  const col = {
    bg: pal.ground, minor: pal.grid, major: pal.gridMajor, lane: pal.go, conn: "#e8c547", connEdge: dark ? "rgba(0,0,0,0.55)" : "rgba(120,92,10,0.55)",
    jFill: dark ? "rgba(58,64,71,0.55)" : "rgba(74,80,88,0.16)", jLine: dark ? "rgba(201,150,42,0.7)" : "rgba(160,118,20,0.7)", jText: dark ? "#e0b44a" : "#8a6510",
    sel: dark ? "#60a5fa" : "#2563eb", text: pal.fg, pill: dark ? "rgba(21,26,23,0.88)" : "rgba(255,255,255,0.88)",
  };

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S) { ctx.fillStyle = col.bg; ctx.fillRect(0, 0, w, h); }
  ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * (w / 2 - v.cx * v.scale), dpr * (h / 2 - v.cy * v.scale));
  const x0 = v.cx - (w / 2) * px, x1 = v.cx + (w / 2) * px, y0 = v.cy - (h / 2) * px, y1 = v.cy + (h / 2) * px;
  // what is in view (with a margin for kerbs and labels): only that is drawn
  const vis = sketchIndex(sk).query({ x0: x0 - 20 * px, y0: y0 - 20 * px, x1: x1 + 20 * px, y1: y1 + 20 * px });
  const viewBox = { x0, y0, x1, y1 };
  // far out (under a pixel a metre): less detail, drawn in fewer strokes
  const far = v.scale < 1;

  // the background (V2 plans): the imagery and the reference image
  if (S && st.bg) drawBackground(ctx, st.bg, { minX: x0, minY: y0, maxX: x1, maxY: y1 }, v.scale * dpr, px);
  // grid: a line every metre when close, every 10 m stronger
  if (S) for (const [step, color] of [[1, col.minor], [10, col.major]] as const) {
    // (over imagery or an image: only lines far enough apart, and fainter, not to hide what is under them)
    const under = !!st.bg && ((st.bg.satellite && !!st.bg.geo) || !!(st.bg.underlay?.visible && st.bg.img));
    if (!st.layers.grid || step * v.scale < (under ? 24 : 6)) continue;
    ctx.globalAlpha = under ? 0.35 : 1;
    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.strokeStyle = color; ctx.lineWidth = px; ctx.stroke();
    ctx.globalAlpha = 1;
  }

  const path = (pts: Pt[]) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); };
  const label = (text: string, p: Pt, color: string) => {
    ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sx = (p.x - v.cx) * v.scale + w / 2, sy = (p.y - v.cy) * v.scale + h / 2;
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = col.pill; ctx.beginPath(); ctx.roundRect(sx - tw / 2 - 5, sy - 9, tw + 10, 18, 4); ctx.fill();
    ctx.fillStyle = color; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, sx, sy + 0.5);
    ctx.restore();
  };
  const square = (p: Pt) => { ctx.fillStyle = col.bg; ctx.strokeStyle = col.sel; ctx.lineWidth = 1.5 * px; ctx.fillRect(p.x - 3.5 * px, p.y - 3.5 * px, 7 * px, 7 * px); ctx.strokeRect(p.x - 3.5 * px, p.y - 3.5 * px, 7 * px, 7 * px); };
  const dot = (p: Pt, r: number, fill: string) => { ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill(); };
  const hv = st.hover;

  // junction and road surfaces
  const selJ = new Set(s.junctions), selLanes = new Set(s.lanes), selConns = new Set(s.connectors);
  // (the plan's map colours: its asphalt, its light kerb about 0.3 m wide)
  const asphalt = pal.asphalt, kerb = pal.curb, kerbW = Math.max(0.6, 3 * px);
  const jOn = (j: SketchJunction) => selJ.has(j.id), jOver = (j: SketchJunction) => !!hv && "junction" in hv && hv.junction === j.id;
  // links: a strip between the road ends they join
  const linkGeo = (sk.links ?? []).flatMap(k => { const g = linkGeometry(sk, k); return g ? [{ k, g, on: s.link === k.id, over: !!hv && "link" in hv && hv.link === k.id }] : []; });
  const drawn = sk.junctions.filter(j => j.outline.length >= 3 && j.shape !== "auto" && vis.junctions.has(j.id)), autos = sk.junctions.filter(j => j.shape === "auto" && vis.junctions.has(j.id));
  const contentsOf = (j: SketchJunction) => st.contents.get(j.id) ?? { lanes: [], connectors: [], roads: [] };
  // (smoothed ones are outlines, like drawn ones; the others bands)
  const loopsOf = new Map(autos.filter(j => j.smooth).map(j => [j.id, smoothJunction(sk, j, contentsOf(j))]));
  const bandsOf = new Map(autos.filter(j => !j.smooth).map(j => [j.id, junctionBands(sk, contentsOf(j))]));
  const loopsPath = (loops: Pt[][]) => { ctx.beginPath(); for (const l of loops) { l.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); } };
  const strokeBands = (g: CanvasRenderingContext2D, bands: Band[], extra: number) => {
    for (const b of bands) {
      // (one changing width filled as a polygon, in the colour it would be stroked in)
      if (b.w1 !== undefined) { g.fillStyle = g.strokeStyle; g.beginPath(); bandPolygon(b, extra).forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fill(); continue; }
      g.beginPath(); b.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); if (b.closed) g.closePath();
      g.lineWidth = b.width + extra; g.stroke();
    }
  };
  // (an automatic junction's edge in a colour: its bands a little wider, put together on a scratch canvas with the bands cut out of them)
  const bandEdge = (bands: Band[], color: string, w: number, fill?: { color: string; alpha: number }) => {
    scratch ??= document.createElement("canvas");
    if (scratch.width !== c.width || scratch.height !== c.height) { scratch.width = c.width; scratch.height = c.height; }
    const sc = scratch.getContext("2d")!, m = ctx.getTransform();
    const blit = (alpha: number) => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = alpha; ctx.drawImage(scratch!, 0, 0); ctx.restore(); };
    const clear = () => { sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, scratch!.width, scratch!.height); sc.setTransform(m); sc.lineCap = "butt"; sc.lineJoin = "round"; sc.globalCompositeOperation = "source-over"; };
    if (fill) { clear(); sc.strokeStyle = fill.color; strokeBands(sc, bands, 0); blit(fill.alpha); }
    clear(); sc.strokeStyle = color; strokeBands(sc, bands, 2 * w);
    sc.globalCompositeOperation = "destination-out"; sc.strokeStyle = "#000"; strokeBands(sc, bands, 0);
    sc.globalCompositeOperation = "source-over"; blit(1);
  };
  if (!S) { /* (the surfaces are in the image kept) */ } else if (st.layers.surfaces) {
    // like the roads: one asphalt surface, the union of the road lanes' bands and the junctions (every
    // kerb first, then all the grey over them, so only the outline of the whole shows)
    const roadLanes = sk.roads.flatMap(r => r.lanes).filter(id => vis.lanes.has(id)).map(id => laneById(sk, id)).filter(l => !!l);
    ctx.lineCap = "butt"; ctx.lineJoin = "round";
    // (far out the kerbs are under a pixel: the asphalt only)
    for (const pass of far ? [1] : [0, 1]) {
      ctx.strokeStyle = ctx.fillStyle = pass ? asphalt : kerb;
      for (const j of drawn) { path(outlinePath(j)); ctx.closePath(); if (pass) ctx.fill(); else { ctx.lineWidth = kerbW; ctx.stroke(); } }
      for (const loops of loopsOf.values()) { loopsPath(loops); if (pass) ctx.fill("evenodd"); else { ctx.lineWidth = kerbW; ctx.stroke(); } }
      if (!far) for (const bands of bandsOf.values()) strokeBands(ctx, bands, pass ? 0 : kerbW);
      // (a link: its sides kerbed, not its ends, where it meets its roads)
      for (const { g } of linkGeo) { if (pass) { path(g.outline); ctx.closePath(); ctx.fill(); } else { ctx.lineWidth = kerbW; for (const side of g.sides) { path(side); ctx.stroke(); } } }
      // (the lanes of one width in one go)
      const byWidth = new Map<number, typeof roadLanes>();
      for (const l of roadLanes) byWidth.set(l.width, [...(byWidth.get(l.width) ?? []), l]);
      for (const [wd, ls] of byWidth) {
        ctx.beginPath();
        for (const l of ls) { samples(l.shape, far ? 2 : 0.5).forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); if (isFullCircle(l.shape)) ctx.closePath(); }
        ctx.lineWidth = wd + (pass ? 0 : kerbW); ctx.stroke();
      }
    }
    // the markings, as on the plan's map: dashed lines between lanes, the centre line in its yellow
    ctx.lineCap = "butt";
    for (const m of st.layers.markings && v.scale >= 1.5 ? roadMarkings(sk) : []) {
      if (!boxesMeet(markBox(m), viewBox)) continue;
      path(m.pts);
      ctx.strokeStyle = m.kind === "center" ? pal.divider : pal.mark; ctx.lineWidth = Math.max(0.15, px);
      ctx.setLineDash(m.dashed ? [3, 4] : []); ctx.stroke();
    }
    ctx.setLineDash([]);
    // (the junction or link selected or under the pointer, outlined)
    for (const { g, on, over } of linkGeo) if (on || over) { path(g.outline); ctx.closePath(); ctx.strokeStyle = col.sel; ctx.globalAlpha = on ? 1 : 0.6; ctx.lineWidth = 2 * px; ctx.stroke(); ctx.globalAlpha = 1; }
    for (const j of drawn) if (jOn(j) || jOver(j)) { path(outlinePath(j)); ctx.closePath(); ctx.strokeStyle = col.sel; ctx.globalAlpha = jOn(j) ? 1 : 0.6; ctx.lineWidth = 2 * px; ctx.stroke(); ctx.globalAlpha = 1; }
    for (const j of autos) {
      if (!jOn(j) && !jOver(j)) continue;
      const loops = loopsOf.get(j.id), bands = bandsOf.get(j.id);
      if (loops) { loopsPath(loops); ctx.strokeStyle = col.sel; ctx.globalAlpha = jOn(j) ? 1 : 0.6; ctx.lineWidth = 2 * px; ctx.stroke(); ctx.globalAlpha = 1; }
      else if (bands?.length) bandEdge(bands, col.sel, jOn(j) ? 2 * px : 1.5 * px);
    }
  } else {
    // a tint with a dashed edge (automatic ones: the union of their bands, so overlaps don't darken; links: dashed along their sides)
    for (const { g, on, over } of linkGeo) {
      path(g.outline); ctx.closePath(); ctx.fillStyle = col.jFill; ctx.fill();
      ctx.strokeStyle = on || over ? col.sel : col.jLine; ctx.lineWidth = (on ? 2 : over ? 1.5 : 1) * px; ctx.setLineDash(on ? [] : [4 * px, 3 * px]);
      for (const side of g.sides) { path(side); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    for (const j of drawn) {
      path(outlinePath(j)); ctx.closePath();
      ctx.fillStyle = col.jFill; ctx.fill();
      if (jOn(j)) { ctx.strokeStyle = col.sel; ctx.lineWidth = 2 * px; ctx.setLineDash([]); }
      else { ctx.strokeStyle = col.jLine; ctx.lineWidth = (jOver(j) ? 2 : 1) * px; ctx.setLineDash([4 * px, 3 * px]); }
      ctx.lineJoin = "round"; ctx.stroke(); ctx.setLineDash([]);
    }
    for (const j of autos) {
      const loops = loopsOf.get(j.id);
      if (loops) {
        loopsPath(loops); ctx.fillStyle = col.jFill; ctx.fill("evenodd");
        ctx.strokeStyle = jOn(j) || jOver(j) ? col.sel : col.jLine; ctx.lineWidth = (jOn(j) ? 2 : jOver(j) ? 1.5 : 1) * px; ctx.lineJoin = "round"; ctx.stroke();
        continue;
      }
      const bands = bandsOf.get(j.id)!;
      if (bands.length) bandEdge(bands, jOn(j) || jOver(j) ? col.sel : col.jLine, (jOn(j) ? 2 : jOver(j) ? 1.5 : 1) * px, { color: dark ? "rgb(58,64,71)" : "rgb(74,80,88)", alpha: dark ? 0.55 : 0.16 });
    }
  }
  // (an automatic junction's border, saying what it takes in, shown to edit while it is selected or hovered)
  if (S) for (const j of autos) {
    if (j.outline.length < 3 || !(jOn(j) || jOver(j))) continue;
    path(outlinePath(j)); ctx.closePath(); ctx.strokeStyle = col.sel; ctx.globalAlpha = 0.6; ctx.lineWidth = px; ctx.setLineDash([4 * px, 3 * px]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  }
  // selection and hover halos under the lanes
  if (S) for (const l of sk.lanes) {
    if (!vis.lanes.has(l.id)) continue;
    const on = selLanes.has(l.id), over = (hv && "lane" in hv && hv.lane === l.id) || (hv && "lanes" in hv && hv.lanes.includes(l.id));
    if (!on && !over) continue;
    path(samples(l.shape, 0.5)); if (isFullCircle(l.shape)) ctx.closePath();
    ctx.strokeStyle = col.sel; ctx.globalAlpha = on ? 0.9 : 0.35; ctx.lineWidth = l.width + 5 * px; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // lanes: a green line down the middle (on a faint band as wide as the lane), with chevrons along their direction of travel
  // (far out, under a pixel a metre: only the lines, all in one go)
  if (S && far) {
    ctx.beginPath();
    for (const l of sk.lanes) {
      if (!vis.lanes.has(l.id) || (!st.layers.lanes && !selLanes.has(l.id))) continue;
      const pts = samples(l.shape, 2);
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    }
    ctx.lineCap = "butt"; ctx.lineJoin = "round"; ctx.strokeStyle = col.lane; ctx.lineWidth = Math.max(0.2, 1.5 * px); ctx.stroke();
  }
  for (const l of far || !S ? [] : sk.lanes) {
    if (!vis.lanes.has(l.id) || (!st.layers.lanes && !selLanes.has(l.id))) continue;
    const pts = samples(l.shape, 0.5), closed = isFullCircle(l.shape);
    ctx.lineCap = "butt"; ctx.lineJoin = "round"; ctx.strokeStyle = col.lane;
    path(pts); if (closed) ctx.closePath();
    ctx.globalAlpha = 0.12; ctx.lineWidth = l.width; ctx.stroke(); ctx.globalAlpha = 1;
    ctx.lineWidth = Math.max(0.2, 2 * px); ctx.stroke();
    const L = laneLength(l.shape), gap = Math.max(6, 60 * px), k = Math.max(0.5, 5 * px);
    ctx.lineWidth = Math.max(0.15, 1.5 * px); ctx.lineCap = "round";
    for (let a = gap / 2; a < L; a += gap) {
      const { p, d } = pointAt(l.shape, a);
      ctx.beginPath();
      ctx.moveTo(p.x - d.x * k - d.y * k, p.y - d.y * k + d.x * k); ctx.lineTo(p.x, p.y); ctx.lineTo(p.x - d.x * k + d.y * k, p.y - d.y * k - d.x * k);
      ctx.stroke();
    }
  }
  // stop and yield lines across lane ends: on the surfaces, white as on the plan's map (a solid bar, a
  // dashed one); otherwise a red bar, or a row of teeth pointing at the traffic coming up
  // traffic lights, as on the plan's map: a head on the kerb beside each way in (phases set by hand: a
  // small one on each lane, as their lanes may differ), lit as the cars shown see them (dark without
  // cars), and a line across each lane held by them
  const head = (c: Pt, R: number, state: "green" | "amber" | "red" | null) => {
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2); ctx.fillStyle = pal.asphalt; ctx.fill();
    ctx.beginPath(); ctx.arc(c.x, c.y, R * 0.68, 0, Math.PI * 2);
    ctx.fillStyle = state === "green" ? pal.go : state === "amber" ? pal.slow : state === "red" ? pal.stop : pal.muted; ctx.fill();
  };
  for (const plan of st.layers.signs && D ? signalPlans(sk) : []) {
    const ctl = st.signals?.find(x => x.plan.junction === plan.junction) ?? null;
    // (a lane's light: green if one of its connectors is, else amber if one is, else red)
    const laneState = (lane: string) => {
      if (st.simT === null) return null;
      if (!ctl) return signalAt(plan, lane, st.simT);
      const ss = plan.controlled.filter(id => sk.connectors.find(x => x.id === id)?.from.lane === lane).map(id => ctl.stateAt(id, st.simT!));
      return ss.includes("green") ? "green" : ss.includes("amber") ? "amber" : ss.length ? "red" : null;
    };
    const held = [...new Set(plan.controlled.map(id => sk.connectors.find(x => x.id === id)?.from.lane).filter((x): x is string => !!x))];
    // (by way in: their road, or each lane in none)
    const ways = new Map<string, string[]>();
    for (const id of held) { const k = roadOf(sk, id)?.id ?? id; ways.set(k, [...(ways.get(k) ?? []), id]); }
    for (const ids of ways.values()) {
      const lanes = ids.map(id => laneById(sk, id)).filter((l): l is NonNullable<typeof l> => !!l);
      if (!lanes.length) continue;
      const e0 = pointAt(lanes[0].shape, laneLength(lanes[0].shape));
      let right = lanes[0], rd = -Infinity;
      for (const l of lanes) {
        const { p, d } = pointAt(l.shape, laneLength(l.shape)), n = { x: -d.y, y: d.x };
        // (how far right of the first lane's end, as it runs: the head goes by the one on the right)
        const sx = (p.x - e0.p.x) * -e0.d.y + (p.y - e0.p.y) * e0.d.x;
        if (sx > rd) { rd = sx; right = l; }
        if (st.layers.surfaces) {
          const hw = l.width / 2;
          ctx.strokeStyle = pal.mark; ctx.lineWidth = 0.5; ctx.lineCap = "butt"; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(p.x - d.x * 0.25 + n.x * hw, p.y - d.y * 0.25 + n.y * hw); ctx.lineTo(p.x - d.x * 0.25 - n.x * hw, p.y - d.y * 0.25 - n.y * hw); ctx.stroke();
        }
        if (plan.custom) head({ x: p.x - d.x * 1.4, y: p.y - d.y * 1.4 }, Math.max(0.8, 4.5 * px), laneState(l.id));
      }
      const { p, d } = pointAt(right.shape, laneLength(right.shape)), n = { x: -d.y, y: d.x };
      const c = { x: p.x + n.x * (right.width / 2 + 1.4) - d.x * 0.8, y: p.y + n.y * (right.width / 2 + 1.4) - d.y * 0.8 };
      if (plan.custom) head(c, Math.max(0.5, 3 * px), null);
      else head(c, Math.max(1.25, 7 * px), laneState(right.id));
    }
  }
  // the signs, as on the plan's map, on the kerb beside the line (one for lanes side by side with the
  // same sign: by the one on the right): a red octagon, a give-way triangle pointing to the junction
  for (const l of st.layers.signs && S ? sk.lanes : []) {
    if (!l.control || isFullCircle(l.shape) || !vis.lanes.has(l.id)) continue;
    const { p, d } = pointAt(l.shape, laneLength(l.shape)), n = { x: -d.y, y: d.x }, road = roadOf(sk, l.id);
    const besideRight = road?.lanes.some(id => {
      const o = laneById(sk, id);
      if (!o || o.id === l.id || o.control !== l.control) return false;
      const q = pointAt(o.shape, laneLength(o.shape)).p, off = (l.width + o.width) / 2;
      return dist(q, { x: p.x + n.x * off, y: p.y + n.y * off }) < 0.75;
    });
    if (besideRight) continue;
    const R = Math.max(1.1, 6 * px), c = { x: p.x + n.x * (l.width / 2 + 1.4) - d.x * 0.8, y: p.y + n.y * (l.width / 2 + 1.4) - d.y * 0.8 };
    ctx.beginPath();
    if (l.control === "stop") {
      for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k * Math.PI) / 4; ctx.lineTo(c.x + Math.cos(a) * R, c.y + Math.sin(a) * R); }
      ctx.closePath(); ctx.fillStyle = pal.stop; ctx.fill(); ctx.strokeStyle = "#ffffff"; ctx.lineWidth = R * 0.12; ctx.stroke();
    } else {
      const S = R * 1.2, r = { x: -d.y, y: d.x };
      ctx.moveTo(c.x + d.x * S * 0.9, c.y + d.y * S * 0.9);
      ctx.lineTo(c.x - d.x * S * 0.6 + r.x * S, c.y - d.y * S * 0.6 + r.y * S); ctx.lineTo(c.x - d.x * S * 0.6 - r.x * S, c.y - d.y * S * 0.6 - r.y * S); ctx.closePath();
      ctx.fillStyle = "#ffffff"; ctx.fill(); ctx.strokeStyle = pal.stop; ctx.lineWidth = R * 0.25; ctx.lineJoin = "round"; ctx.stroke();
    }
  }
  // the lines across the lanes' ends
  for (const l of st.layers.signs && S ? sk.lanes : []) {
    if (!l.control || isFullCircle(l.shape) || !vis.lanes.has(l.id)) continue;
    const { p, d } = pointAt(l.shape, laneLength(l.shape)), n = { x: -d.y, y: d.x }, hw = l.width / 2;
    if (st.layers.surfaces) {
      ctx.strokeStyle = pal.mark; ctx.lineWidth = 0.5; ctx.lineCap = "butt"; ctx.setLineDash(l.control === "yield" ? [0.9, 0.7] : []);
      ctx.beginPath(); ctx.moveTo(p.x - d.x * 0.25 + n.x * hw, p.y - d.y * 0.25 + n.y * hw); ctx.lineTo(p.x - d.x * 0.25 - n.x * hw, p.y - d.y * 0.25 - n.y * hw); ctx.stroke();
      ctx.setLineDash([]);
    } else if (l.control === "stop") {
      ctx.strokeStyle = "#dc2626"; ctx.lineWidth = 0.5; ctx.lineCap = "butt";
      ctx.beginPath(); ctx.moveTo(p.x - d.x * 0.25 + n.x * hw, p.y - d.y * 0.25 + n.y * hw); ctx.lineTo(p.x - d.x * 0.25 - n.x * hw, p.y - d.y * 0.25 - n.y * hw); ctx.stroke();
    } else {
      const k = Math.max(2, Math.round(l.width / 0.9)), tw = l.width / k;
      ctx.fillStyle = dark ? "#fbbf24" : "#d97706";
      for (let i = 0; i < k; i++) {
        const o = -hw + tw * (i + 0.5), b = { x: p.x + n.x * o, y: p.y + n.y * o };
        ctx.beginPath();
        ctx.moveTo(b.x + n.x * tw * 0.4, b.y + n.y * tw * 0.4); ctx.lineTo(b.x - n.x * tw * 0.4, b.y - n.y * tw * 0.4);
        ctx.lineTo(b.x - d.x * tw * 0.9, b.y - d.y * tw * 0.9); ctx.closePath(); ctx.fill();
      }
    }
  }
  // connectors: a thin curve with an arrowhead where it joins
  const arrowHead = (p: Pt, d: Pt, size: number) => {
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x - d.x * size - d.y * size * 0.5, p.y - d.y * size + d.x * size * 0.5);
    ctx.lineTo(p.x - d.x * size + d.y * size * 0.5, p.y - d.y * size - d.x * size * 0.5); ctx.closePath(); ctx.fill();
  };
  for (const cn of S ? sk.connectors : []) {
    const pts = connectorPts(sk, cn);
    if (!pts) continue;
    // (a phase's connectors, hovered in the lights' panel: lit green)
    const phase = !!hv && "conns" in hv && hv.conns.includes(cn.id);
    const on = selConns.has(cn.id), over = (hv && "connector" in hv && hv.connector === cn.id) || phase, wd = (on ? 3.5 : over ? 2.5 : 2) * px;
    if ((!st.layers.connectors || !vis.conns.has(cn.id) || v.scale < 1) && !on && !over) continue;
    path(pts);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    // (a darker edge under the yellow, so it reads on the light ground)
    if (!on && !over) { ctx.strokeStyle = col.connEdge; ctx.lineWidth = wd + 1.5 * px; ctx.stroke(); }
    ctx.strokeStyle = phase && !on ? pal.go : on || over ? col.sel : col.conn; ctx.lineWidth = wd; ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    arrowHead(pts[pts.length - 1], at(sk, cn.to)!.d, 8 * px);
    dot(pts[0], 2.5 * px, ctx.strokeStyle);
  }
  // cars as on the plan's map (cut corners, a windscreen), in its speed colours: green at their desired speed to red when stopped
  for (const car of st.layers.cars && D ? st.cars ?? [] : []) {
    const { p, d } = car, hl = Math.max(car.len, 5 * px) / 2, hw = Math.max(1.8, 3 * px) / 2, r = Math.min(0.7, hw);
    const at2 = (x: number, y: number): [number, number] => [p.x + d.x * x - d.y * y, p.y + d.y * x + d.x * y];
    const body: [number, number][] = [[hl - r, -hw], [hl, -hw + r], [hl, hw - r], [hl - r, hw], [-hl + r, hw], [-hl, hw - r], [-hl, -hw + r], [-hl + r, -hw]];
    ctx.beginPath(); body.forEach(([x, y], i) => { const [X, Y] = at2(x, y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); }); ctx.closePath();
    ctx.fillStyle = speedColor(pal, Math.round(Math.min(1, car.share) * 15) / 15); ctx.fill();
    ctx.strokeStyle = "rgba(20,28,34,0.45)"; ctx.lineWidth = Math.min(0.15, px); ctx.stroke();
    const ws = [at2(hl * 0.55, -hw * 0.75), at2(hl * 0.2, -hw * 0.75), at2(hl * 0.2, hw * 0.75), at2(hl * 0.55, hw * 0.75)];
    ctx.beginPath(); ws.forEach(([X, Y], i) => (i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y))); ctx.closePath();
    ctx.fillStyle = "rgba(20,28,34,0.55)"; ctx.fill();
  }
  // the car picked: the way it will go, and a ring round it
  if (D && st.car) {
    const { route, p } = st.car;
    if (route.length > 1) {
      path(route); ctx.strokeStyle = col.sel; ctx.lineWidth = 2.5 * px; ctx.setLineDash([6 * px, 4 * px]); ctx.lineCap = "round"; ctx.stroke(); ctx.setLineDash([]);
      const a = route[route.length - 2], b = route[route.length - 1], l = dist(a, b) || 1;
      ctx.fillStyle = col.sel; arrowHead(b, { x: (b.x - a.x) / l, y: (b.y - a.y) / l }, 9 * px);
    }
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3.2, 14 * px), 0, Math.PI * 2); ctx.strokeStyle = col.sel; ctx.lineWidth = 2 * px; ctx.stroke();
  }
  // (what moves is drawn: the rest is in the image kept)
  if (D) return;
  // the selection's box and the handle to turn it by
  const turning = st.drag?.kind === "rotate" ? st.drag : null;
  const rh = tool === "select" && !st.draft && (!st.drag || turning) ? rotateHandle(sk, s, v.scale) : null;
  if (rh) {
    const { box: b } = rh, o = turning?.o ?? rh.o;
    ctx.strokeStyle = col.sel; ctx.lineWidth = px; ctx.setLineDash([4 * px, 3 * px]);
    ctx.strokeRect(b.minX - 3 * px, b.minY - 3 * px, b.maxX - b.minX + 6 * px, b.maxY - b.minY + 6 * px); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(rh.h.x, b.minY - 3 * px); ctx.lineTo(rh.h.x, rh.h.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(rh.h.x, rh.h.y, 5.5 * px, 0, Math.PI * 2); ctx.fillStyle = col.bg; ctx.fill(); ctx.lineWidth = 1.5 * px; ctx.stroke();
    ctx.beginPath(); ctx.arc(rh.h.x, rh.h.y, 2.5 * px, -Math.PI * 0.9, Math.PI * 0.4); ctx.stroke();
    dot(o, 2.5 * px, col.sel);
  }
  // points of the selection, to drag: lane points, junction corners (squares), connector bends (rings)
  // (a line lane's points: corners square, curved ones round, the one picked filled; its control lines when curved)
  for (const id of s.lanes) {
    const l = laneById(sk, id);
    if (l?.shape.kind !== "line" || leadOf(sk, id)) continue;
    const sh = l.shape;
    if (sh.curved?.some(Boolean)) { path(sh.pts); if (sh.closed) ctx.closePath(); ctx.strokeStyle = col.sel; ctx.globalAlpha = 0.5; ctx.lineWidth = px; ctx.setLineDash([3 * px, 3 * px]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    sh.pts.forEach((p, i) => {
      const picked = st.selPt?.lane === id && st.selPt.i === i;
      if (sh.curved?.[i]) { ctx.beginPath(); ctx.arc(p.x, p.y, 4 * px, 0, Math.PI * 2); ctx.fillStyle = picked ? col.sel : col.bg; ctx.fill(); ctx.strokeStyle = col.sel; ctx.lineWidth = 1.5 * px; ctx.stroke(); }
      else { square(p); if (picked) { ctx.fillStyle = col.sel; ctx.fillRect(p.x - 3.5 * px, p.y - 3.5 * px, 7 * px, 7 * px); } }
    });
  }
  // a junction's corners: squares, rounded ones as circles (with the corners it rounds off dotted)
  for (const id of s.junctions) {
    const j = sk.junctions.find(x => x.id === id);
    if (!j) continue;
    if (j.curved?.some(Boolean)) { path(j.outline); ctx.closePath(); ctx.strokeStyle = col.sel; ctx.globalAlpha = 0.5; ctx.lineWidth = px; ctx.setLineDash([3 * px, 3 * px]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
    j.outline.forEach((p, i) => {
      if (!j.curved?.[i]) { square(p); return; }
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 * px, 0, Math.PI * 2); ctx.fillStyle = col.bg; ctx.fill(); ctx.strokeStyle = col.sel; ctx.lineWidth = 1.5 * px; ctx.stroke();
    });
  }
  for (const id of s.connectors) {
    const cn = sk.connectors.find(c => c.id === id);
    for (const p of cn?.via ?? []) {
      ctx.beginPath(); ctx.arc(p.x, p.y, 4 * px, 0, Math.PI * 2); ctx.fillStyle = col.bg; ctx.fill(); ctx.strokeStyle = col.sel; ctx.lineWidth = 1.5 * px; ctx.stroke();
    }
    // its ends: filled, to drag along their lanes or onto others
    for (const e of cn ? [cn.from, cn.to] : []) {
      const a = at(sk, e);
      if (!a) continue;
      ctx.beginPath(); ctx.arc(a.p.x, a.p.y, 5 * px, 0, Math.PI * 2); ctx.fillStyle = col.sel; ctx.fill(); ctx.strokeStyle = col.bg; ctx.lineWidth = 1.5 * px; ctx.stroke();
    }
  }

  // what is being drawn
  const cur = st.cursor, d = st.draft;
  // (slicing: where the cut would go, across the road, or the lane with Alt)
  if (tool === "slice" && cur) {
    const l = laneUnder(sk, cur.p, px);
    if (l && !isFullCircle(l.shape)) {
      const road = roadOf(sk, l.id), q = pointAt(l.shape, nearestOn(l.shape, cur.p).s);
      ctx.strokeStyle = "#dc2626"; ctx.lineWidth = Math.max(0.15, 2 * px); ctx.setLineDash([]); ctx.lineCap = "round";
      for (const id of road && !cur.alt ? road.lanes : [l.id]) {
        const x = laneById(sk, id)!, near = nearestOn(x.shape, q.p);
        if (isFullCircle(x.shape) || near.d > 2 * (x.width + l.width)) continue;
        const { p, d: dir } = pointAt(x.shape, near.s), hw = x.width / 2 + 0.3;
        ctx.beginPath(); ctx.moveTo(p.x - dir.y * hw, p.y + dir.x * hw); ctx.lineTo(p.x + dir.y * hw, p.y - dir.x * hw); ctx.stroke();
      }
    }
  }
  ctx.strokeStyle = col.sel; ctx.fillStyle = col.sel; ctx.lineWidth = 1.5 * px; ctx.setLineDash([6 * px, 4 * px]);
  if (d?.kind === "lane") {
    path(cur ? [...d.pts, cur.p] : d.pts);
    ctx.globalAlpha = 0.35; ctx.lineWidth = LANE_WIDTH; ctx.setLineDash([]); ctx.lineJoin = "round"; ctx.stroke(); ctx.globalAlpha = 1;
  } else if (d?.kind === "junction") {
    path(cur ? [...d.pts, cur.p] : d.pts); ctx.closePath();
    ctx.fillStyle = col.jFill; ctx.fill(); ctx.setLineDash([]); ctx.stroke();
    d.pts.forEach(square);
    if (cur && d.pts.length >= 3 && dist(cur.p, d.pts[0]) <= 10 * px) { ctx.beginPath(); ctx.arc(d.pts[0].x, d.pts[0].y, 7 * px, 0, Math.PI * 2); ctx.strokeStyle = col.sel; ctx.stroke(); }
  } else if (d?.kind === "circle" && cur) {
    ctx.beginPath(); ctx.arc(d.c.x, d.c.y, dist(d.c, cur.p), 0, Math.PI * 2); ctx.globalAlpha = 0.35; ctx.lineWidth = LANE_WIDTH; ctx.setLineDash([]); ctx.stroke(); ctx.globalAlpha = 1;
  } else if (d?.kind === "arc") {
    if (d.start) {
      ctx.beginPath(); ctx.arc(d.c.x, d.c.y, d.start.r, d.start.a0, d.start.a0 + d.start.sweep, d.start.sweep < 0);
      ctx.globalAlpha = 0.35; ctx.lineWidth = LANE_WIDTH; ctx.setLineDash([]); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (cur) { ctx.beginPath(); ctx.arc(d.c.x, d.c.y, dist(d.c, cur.p), 0, Math.PI * 2); ctx.stroke(); }
  } else if (d?.kind === "connector") {
    const a = at(sk, d.from), to = cur && !cur.alt ? placeOn(cur.p) : null, b = to ? at(sk, to) : null;
    if (a) {
      const last = d.via[d.via.length - 1] ?? a.p;
      const end = b ?? (cur ? { p: cur.p, d: (() => { const l = dist(last, cur.p) || 1; return { x: (cur.p.x - last.x) / l, y: (cur.p.y - last.y) / l }; })() } : null);
      if (end) { path(curveThrough(a, d.via, end)); ctx.stroke(); }
      ctx.setLineDash([]);
      for (const p of d.via) dot(p, 3 * px, col.sel);
    }
  }
  ctx.setLineDash([]);
  if (d && "c" in d) dot(d.c, 3 * px, col.sel);
  if (cur && (tool === "lane" || tool === "arc" || tool === "circle" || tool === "junction")) {
    ctx.beginPath(); ctx.arc(cur.p.x, cur.p.y, (cur.snapped ? 5 : 3) * px, 0, Math.PI * 2);
    ctx.strokeStyle = col.sel; ctx.fillStyle = col.sel; ctx.lineWidth = 1.5 * px; if (cur.snapped) ctx.stroke(); else ctx.fill();
  }
  if (tool === "connector" && cur && !cur.alt) {
    const pl = placeOn(cur.p), a = pl ? at(sk, pl) : null;
    if (a) dot(a.p, 4 * px, col.sel);
  }
  const g = st.drag;
  if (g?.kind === "handle" && g.h.kind === "end" && cur) {
    const pl = placeOn(cur.p), a = pl ? at(sk, pl) : null;
    if (a) { ctx.beginPath(); ctx.arc(a.p.x, a.p.y, 8 * px, 0, Math.PI * 2); ctx.strokeStyle = col.sel; ctx.lineWidth = 1.5 * px; ctx.stroke(); }
  }
  if (g?.kind === "box") {
    ctx.fillStyle = col.sel; ctx.globalAlpha = 0.08; ctx.fillRect(g.a.x, g.a.y, g.b.x - g.a.x, g.b.y - g.a.y); ctx.globalAlpha = 1;
    ctx.strokeStyle = col.sel; ctx.lineWidth = px; ctx.strokeRect(g.a.x, g.a.y, g.b.x - g.a.x, g.b.y - g.a.y);
  }

  if (turning && cur) label(`${((turning.angle * 180) / Math.PI).toFixed(0)}°`, { x: cur.p.x, y: cur.p.y - 18 * px }, col.sel);
  // names: roads at the middle of their first lane, junctions at their top
  // the ways in and out: the traffic coming in, the share of trips leaving
  // (labels only once close enough to read them: ways in and out and road names from 1.5 px/m, junction names from 3)
  if (st.layers.demand && v.scale >= 1.5) {
    const { entries, exits } = demandWays(sk), lane = (id: string) => laneById(sk, id)!;
    const sumW = exits.reduce((a, w) => a + w.lanes.reduce((b, id) => b + laneOutWeight(lane(id)), 0), 0);
    const tag = (ids: string[], atEnd: boolean, text: string, color: string) => {
      const l = lane(ids[0]), q = pointAt(l.shape, atEnd ? laneLength(l.shape) : 0), k = (atEnd ? 1 : -1) * 18 * px;
      label(text, { x: q.p.x + q.d.x * k, y: q.p.y + q.d.y * k }, color);
    };
    for (const w of entries) tag(w.lanes, false, `→ ${Math.round(w.lanes.reduce((a, id) => a + laneInRate(lane(id), sk), 0))}/h`, dark ? "#4ade80" : "#15803d");
    for (const w of exits) { const ws = w.lanes.reduce((b, id) => b + laneOutWeight(lane(id)), 0); tag(w.lanes, true, ws === 0 ? "closed" : `${sumW ? Math.round((ws / sumW) * 100) : 0}% →`, dark ? "#93c5fd" : "#1d4ed8"); }
  }
  // (a road's name once on the screen, a street cut into several roads named once)
  const named = new Set<string>();
  for (const r of st.layers.names && v.scale >= 1.5 ? sk.roads : []) {
    const l = laneById(sk, r.lanes[0]), p = l && pointAt(l.shape, laneLength(l.shape) / 2).p;
    if (!p || named.has(r.name) || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
    named.add(r.name);
    label(r.name, p, col.text);
  }
  for (const j of st.layers.names && v.scale >= 3 ? sk.junctions : []) {
    const top = j.outline.reduce((a, p) => (p.y < a.y ? p : a), j.outline[0]);
    if (top) label(j.name, { x: top.x, y: top.y - 14 * px }, col.jText);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = "10px ui-monospace, monospace"; ctx.fillStyle = dark ? "#a1a1aa" : "#78716c"; ctx.textAlign = "left"; ctx.textBaseline = "bottom";
  ctx.fillText(`${cur ? `${cur.p.x.toFixed(1)}, ${cur.p.y.toFixed(1)} m · ` : ""}${v.scale.toFixed(1)} px/m`, 8, h - 6);
}
