"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { batch } from "subjecto";
import { buildRoadGeo, type RoadGeo } from "@/render/geometry";
import { MARKER_HEAD, buildPaths, connectorsOf, drawScene, toScreen, toWorld, underlayHandles, type Camera, type Overlay, type PathCache, type UnderlayHandle } from "@/render/draw2d";
import { readPalette, type Palette } from "@/render/palette";
import { simplifyRing, connShapeKey, connectorHandles, connectorId, linkExtent, LW, type CNode, type Edge, type LanePiece } from "@/engine/compile";
import { pointInPoly } from "@/engine/buildings";
import type { CrossingDef, Network, ParkingDef, Vec } from "@/engine/types";
import { busy, commit, endGesture, highlightedLayers, network$, select, selectMany, selectedAll, toggleSelect, setUnderlay, ui, underlay$, type LayerId, type Selection, type UiState } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { noteDraw } from "@/state/perf";
import { changeConnection, connectLanes, lanesArrivingNear, lanesLeavingNear, setConnectorShape } from "@/state/connections";
import { viewCmd$, viewport, planViewKey } from "@/state/commands";
import { underlayImg$ } from "@/state/underlay-image";
import { worldToImage, type Underlay } from "@/lib/underlay";
import { unproject } from "@/lib/osm/area";
import { routeBetween, routeShape } from "@/engine/route";
import * as ops from "@/state/ops";
import { isJunction } from "@/engine/refs";
import { canJoin, createJunction, deleteJunction, joinStandalone, standaloneAt } from "@/state/junctions";
import { groupById, groupHull, groupOfLink, groupOfNode, groupPorts, hull, moveGroup, place, placePoint } from "@/state/groups";
import { placingPiece, stopPlacing } from "@/state/placing";
import { createRoundabout, islandRadius, joinRadius, TWO_LANES_FROM } from "@/state/roundabouts";
import { createRing, isRing, joinRing, moveRingPoint, ringById, ringOfLink, ringOfNode, ringPointAt, ringPoints, setRing } from "@/state/rings";
import { onCrossing } from "@/engine/crossings";
import { bayOutline, rowEnds } from "@/engine/parking";
import { toast } from "sonner";

type Snap = { p: Vec; nodeId?: string; link?: { id: string; t: number } };
type Drag =
  | { mode: "pan"; sx: number; sy: number; cx: number; cy: number; moved: boolean; clickSel: boolean; right?: boolean }
  | { mode: "node"; id: string; moved: boolean; sx: number; sy: number }
  | { mode: "handle"; linkId: string; handle: "c1" | "c2" | "bend"; moved: boolean }
  | { mode: "conn"; id: string; which: "k1" | "k2" }
  /** a bend point of the selected connector */
  | { mode: "via"; id: string; idx: number }
  | { mode: "connEnd"; id: string; which: "start" | "end" }
  | { mode: "connNew"; from: string; sx: number; sy: number; moved: boolean }
  | { mode: "box"; a: Vec; b: Vec }
  | { mode: "marker"; id: string; moved: boolean; sx: number; sy: number }
  /** a row of parking bays: moved whole (`part` "move"), or stretched by an end */
  | { mode: "parking"; id: string; part: "move" | "a" | "b"; start: Vec; orig: ParkingDef; moved: boolean; sx: number; sy: number }
  /** a zebra crossing drawn by hand: moved whole, or one kerb end */
  | { mode: "crossing"; id: string; part: "move" | "a" | "b"; start: Vec; orig: CrossingDef; moved: boolean; sx: number; sy: number }
  | { mode: "outline"; node: string; idx: number }
  /** a ring placed by hand: one of its points round it, or the whole ring */
  | { mode: "ringPoint"; ring: string; node: string; moved: boolean; sx: number; sy: number }
  | { mode: "ring"; ring: string; last: Vec; moved: boolean; sx: number; sy: number }
  /** a junction group, moved whole */
  | { mode: "group"; id: string; last: Vec; moved: boolean; sx: number; sy: number }
  | { mode: "ul-move"; start: Vec; x0: number; y0: number }
  | { mode: "ul-rotate"; a0: number; rot0: number }
  | { mode: "ul-scale"; d0: number; mpp0: number }
  | null;

const HIT_NODE = 10, HIT_HANDLE = 9;
/** a click this close to a junction outline's first point (px) closes it */
const CLOSE_PX = 12;

export function PlanCanvas() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** right-click menu on plans that know where they are on Earth */
  const [menu, setMenu] = useState<{ x: number; y: number; lat: number; lon: number } | null>(null);

  useEffect(() => {
    const wrap = wrapRef.current!, canvas = canvasRef.current!, ctx = canvas.getContext("2d")!;
    const cam: Camera = { cx: 0, cy: 0, scale: 2, w: 1, h: 1, dpr: 1 };
    let pal: Palette = readPalette();
    let u: UiState = ui.getValue();
    let net: Network = network$.getValue();
    let geo: RoadGeo | null = null, paths: PathCache | null = null, geoVersion = -1;
    let dirty = true;
    let pending: Snap | null = null;
    let cursorWorld: Vec | null = null;
    let shift = false, spaceHeld = false;
    let hover: Overlay["hover"] = null;
    let drag: Drag = null;
    let fitted = "";
    let ul: Underlay | null = underlay$.getValue();
    let ulImg: HTMLImageElement | null = underlayImg$.getValue();
    let ulHover: UnderlayHandle | null = null;

    const markDirty = () => { dirty = true; };
    // the route tracer's route, worked out again only when its ends or the network change
    let traceKey = "", tracePts: number[] | null = null;
    const traceFor = (t: UiState["trace"]) => {
      const key = `${t.from}|${t.to}|${simController.version}`;
      if (key !== traceKey) {
        traceKey = key;
        const r = t.from && t.to ? routeBetween(simController.compiled, t.from, t.to) : null;
        tracePts = r ? routeShape(r).pts : null;
      }
      return tracePts;
    };
    const subs = [
      ui.subscribe("**", () => { u = ui.getValue(); markDirty(); }),
      network$.subscribe(n => { net = n; markDirty(); }),
      underlay$.subscribe(v => { ul = v; markDirty(); }),
      underlayImg$.subscribe(v => { ulImg = v; markDirty(); }),
      viewCmd$.subscribe(c => {
        if (!c) return;
        if (c.cmd === "fit") fit();
        else if (c.cmd === "zoomIn") zoomAt(cam.w / 2, cam.h / 2, 1.4);
        else if (c.cmd === "zoomOut") zoomAt(cam.w / 2, cam.h / 2, 1 / 1.4);
        else if (c.cmd === "focus" && c.x !== undefined && c.y !== undefined) { cam.cx = c.x; cam.cy = c.y!; markDirty(); }
        else if (c.cmd === "frame" && c.x !== undefined && c.y !== undefined) {
          const w = Math.max(40, c.w ?? 0), h = Math.max(40, c.h ?? 0);
          cam.scale = Math.min(40, Math.max(0.05, Math.min(cam.w / (w * 1.5), cam.h / (h * 1.5))));
          cam.cx = c.x; cam.cy = c.y; markDirty();
        }
      }),
    ];
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => { pal = readPalette(); markDirty(); };
    mq.addEventListener("change", onScheme);

    function ensureGeo() {
      if (geoVersion !== simController.version) {
        geo = buildRoadGeo(simController.compiled, net);
        paths = buildPaths(geo);
        geoVersion = simController.version;
      }
    }
    function fit() {
      const b = simController.compiled.bounds;
      const w = Math.max(60, b.maxX - b.minX), h = Math.max(60, b.maxY - b.minY);
      cam.scale = Math.min(12, Math.max(0.05, Math.min(cam.w / (w * 1.25), cam.h / (h * 1.25))));
      cam.cx = (b.minX + b.maxX) / 2; cam.cy = (b.minY + b.maxY) / 2;
      markDirty();
    }
    function zoomAt(sx: number, sy: number, f: number) {
      const before = toWorld(cam, sx, sy);
      cam.scale = Math.min(40, Math.max(0.05, cam.scale * f));
      const after = toWorld(cam, sx, sy);
      cam.cx += before.x - after.x; cam.cy += before.y - after.y;
      markDirty();
    }
    const resize = () => {
      const r = wrap.getBoundingClientRect();
      cam.w = Math.max(1, r.width); cam.h = Math.max(1, r.height); cam.dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(cam.w * cam.dpr); canvas.height = Math.round(cam.h * cam.dpr);
      canvas.style.width = `${cam.w}px`; canvas.style.height = `${cam.h}px`;
      if (fitted !== u.planId) { fitted = u.planId; ensureGeo(); if (!restoreView()) fit(); }
      markDirty();
    };
    // the view of each plan (centre and zoom) is kept in this browser, and comes back when it is opened again
    const viewKey = () => planViewKey(u.planId);
    function restoreView(): boolean {
      try {
        const v = JSON.parse(localStorage.getItem(viewKey()) ?? "null") as { cx: number; cy: number; scale: number } | null;
        if (!v || ![v.cx, v.cy, v.scale].every(Number.isFinite) || v.scale <= 0) return false;
        cam.cx = v.cx; cam.cy = v.cy; cam.scale = Math.min(60, Math.max(0.02, v.scale));
        markDirty();
        return true;
      } catch { return false; }
    }
    let savedView = "", viewTimer: ReturnType<typeof setTimeout> | null = null;
    function rememberView() {
      if (!u.planId || viewTimer) return;
      viewTimer = setTimeout(() => {
        viewTimer = null;
        const v = JSON.stringify({ cx: Math.round(cam.cx * 100) / 100, cy: Math.round(cam.cy * 100) / 100, scale: Math.round(cam.scale * 10000) / 10000 });
        if (v === savedView) return;
        savedView = v;
        try { localStorage.setItem(viewKey(), v); } catch { /* storage full or off: not kept */ }
      }, 400);
    }
    const ro = new ResizeObserver(resize); ro.observe(wrap); resize();

    // ------------------------------------------------------------ hit testing
    const pxToM = (px: number) => px / cam.scale;
    function hitNode(sx: number, sy: number, exclude?: string, only?: (id: string) => boolean): string | null {
      let best: string | null = null, bd = HIT_NODE;
      for (const n of net.nodes) {
        if (n.id === exclude || (only && !only(n.id))) continue;
        const q = toScreen(cam, n.x, n.y), d = Math.hypot(q.x - sx, q.y - sy);
        if (d < bd) { bd = d; best = n.id; }
      }
      return best;
    }
    function hitLink(p: Vec): { id: string; t: number; pt: Vec; d: number } | null {
      let best: { id: string; t: number; pt: Vec; d: number; lv: number } | null = null;
      for (const l of net.links) {
        const A = ops.nodeById(net, l.from), B = ops.nodeById(net, l.to);
        if (!A || !B) continue;
        const [lo, hi] = linkExtent(l), half = Math.max(-lo, hi);
        const r = ops.nearestT(l, A, B, p);
        // where roads overlap (a bridge over a road), the one on top wins
        if (r.d <= half + pxToM(4) && (!best || (l.level ?? 0) > best.lv || ((l.level ?? 0) === best.lv && r.d < best.d))) best = { id: l.id, t: r.t, pt: r.pt, d: r.d, lv: l.level ?? 0 };
      }
      return best;
    }
    /** drawing a connector from lane `from` ("linkId|dir|lane"): the lanes it may end in (leaving its junction, or starting nearby) */
    function connectTargets(from: string) {
      const [lid, dir, ln] = from.split("|"), c = simController.compiled, e = c.edgeByKey.get(`${lid}:${dir}`);
      if (!e || !e.lanes[Number(ln)]) return null;
      return lanesLeavingNear(c, e, Number(ln));
    }
    /** the marker under the pointer: its pin head, or the point it marks */
    function hitMarker(sx: number, sy: number): string | null {
      if (!u.layers.includes("markers")) return null;
      let best: string | null = null, bd = Infinity;
      for (const m of net.markers ?? []) {
        const q = toScreen(cam, m.x, m.y), dh = Math.hypot(q.x - sx, q.y + MARKER_HEAD.dy - sy), dp = Math.hypot(q.x - sx, q.y - sy);
        const d = Math.min(dh <= MARKER_HEAD.r + 4 ? dh : Infinity, dp <= 7 ? dp : Infinity);
        if (d < bd) { bd = d; best = m.id; }
      }
      return best;
    }
    /** lanes are wide enough on screen to aim at one end (about 12 px a lane) */
    const lanesAimable = () => cam.scale * 3.2 >= 12;
    /** the end of a lane arriving at a junction under the pointer ("linkId|dir|lane"), zoomed in enough */
    /**
     * Where a lane's end is grabbed to start a connector: its end, or a little way back along it where the
     * end would sit on the road's own end point (a one-lane road ending without a junction area), so the two
     * handles don't cover each other.
     */
    function laneEndGrip(e: Edge, lp: LanePiece): Vec {
      const p = lp.poly.at(lp.len), q = toScreen(cam, p.x, p.y), n = toScreen(cam, e.to.pos.x, e.to.pos.y);
      return Math.hypot(q.x - n.x, q.y - n.y) < 14 ? lp.poly.at(Math.max(0, lp.len - pxToM(18))) : p;
    }
    function hitLaneEnd(sx: number, sy: number): string | null {
      if (!lanesAimable() || !(u.layers.includes("lanes") || u.layers.includes("connectors"))) return null;
      let best: string | null = null, bd = 11;
      for (const e of simController.compiled.edges) {
        // (a road's loose end too: an entry point or dead end can be linked to a road starting nearby)
        if (e.to.ringR > 0) continue;
        for (const lp of e.lanes) {
          const p = laneEndGrip(e, lp), q = toScreen(cam, p.x, p.y), d = Math.hypot(q.x - sx, q.y - sy);
          if (d < bd) { bd = d; best = `${e.link.id}|${e.dir}|${lp.lane}`; }
        }
      }
      return best;
    }
    /** drawing a connector from `from`: the lane it would go to at a point (its start ring, or on the lane) */
    function connectTargetAt(from: string, w: Vec) {
      const ts = connectTargets(from);
      if (!ts) return null;
      const r = Math.max(LW, pxToM(14));
      return ts.map(t => { const q = t.lp.poly.at(0); return { t, d: Math.hypot(q.x - w.x, q.y - w.y) }; }).filter(x => x.d < r).sort((a, b) => a.d - b.d)[0]?.t
        ?? ts.find(t => t.lp.poly.project(w.x, w.y).d < LW * 0.6) ?? null;
    }
    /** a connector from lane `from` dropped on a ring (anywhere along it): a point of the ring there, joined to it */
    function onRingDrop(from: string, w: Vec): boolean {
      const lid = hitLane(w)?.split("|")[0], l = lid ? ops.linkById(net, lid) : undefined;
      if (!l || !isRing(l)) return false;
      const [fl, fd, fa] = from.split("|");
      if (ops.linkById(net, fl)?.ring === l.ring) return false;
      void busy("Joining the ring…", () => {
        const r = joinRing(net, `${fl}:${fd}`, Number(fa), l.id, w);
        if ("error" in r) { toast.error(r.error); return; }
        commit(r.net); select({ kind: "connector", id: r.id }); ui.getValue().connectFrom = null;
      });
      return true;
    }
    /** start drawing a connector from a lane's end (its lane selected, the lanes it can go to shown) */
    function startConnect(from: string) {
      select({ kind: "lane", id: from });
      ui.getValue().connectFrom = from;
      markDirty();
    }
    /**
     * Where a free-standing row of bays from a to b is reached from: the road nearest its middle (within
     * 80 m), the direction whose lanes are on its side, and the side of a → b away from that road (its bays
     * open toward the road).
     */
    function accessFor(a: Vec, b: Vec): { link: string; dir: 1 | -1; side: 1 | -1 } | null {
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let best: { link: (typeof net.links)[number]; t: number; pt: Vec; d: number } | null = null;
      for (const link of net.links) {
        const A = ops.nodeById(net, link.from), B = ops.nodeById(net, link.to);
        if (!A || !B) continue;
        const r = ops.nearestT(link, A, B, mid);
        if (r.d < 80 && (!best || r.d < best.d)) best = { link, t: r.t, pt: r.pt, d: r.d };
      }
      if (!best) return null;
      const A = ops.nodeById(net, best.link.from)!, B = ops.nodeById(net, best.link.to)!;
      const t0 = ops.linkPoint(best.link, A, B, Math.max(0, best.t - 0.01)), t1 = ops.linkPoint(best.link, A, B, Math.min(1, best.t + 0.01));
      let dir: 1 | -1 = (mid.x - best.pt.x) * -(t1.y - t0.y) + (mid.y - best.pt.y) * (t1.x - t0.x) > 0 ? 1 : -1;
      if (dir === 1 && best.link.lanesF === 0) dir = -1;
      if (dir === -1 && best.link.lanesB === 0) dir = 1;
      const tx = b.x - a.x, ty = b.y - a.y, side: 1 | -1 = (mid.x - best.pt.x) * -ty + (mid.y - best.pt.y) * tx > 0 ? 1 : -1;
      return { link: best.link.id, dir, side };
    }
    /** the selected row of parking bays' end under the pointer (to stretch it) */
    function hitParkingEnd(sx: number, sy: number): { id: string; which: "a" | "b" } | null {
      const sel = u.selection;
      if (sel?.kind !== "parking") return null;
      const p = simController.compiled.parking.find(x => x.def.id === sel.id);
      if (!p) return null;
      const [a, b] = rowEnds(p);
      for (const [q, which] of [[a, "a"], [b, "b"]] as const) { const s = toScreen(cam, q.x, q.y); if (Math.hypot(s.x - sx, s.y - sy) < HIT_HANDLE) return { id: sel.id, which }; }
      return null;
    }
    /** the selected zebra crossing's kerb end under the pointer (to move just that end) */
    function hitCrossingEnd(sx: number, sy: number): { id: string; which: "a" | "b" } | null {
      const sel = u.selection;
      if (sel?.kind !== "crossing") return null;
      const x = net.crossings?.find(c => c.id === sel.id);
      if (!x) return null;
      for (const [q, which] of [[x.a, "a"], [x.b, "b"]] as const) { const s = toScreen(cam, q.x, q.y); if (Math.hypot(s.x - sx, s.y - sy) < HIT_HANDLE) return { id: x.id, which }; }
      return null;
    }
    /** a zebra crossing dragged: moved whole, or one kerb end, to the pointer `w` (Shift: off the grid) */
    function dragCrossing(d: Extract<Drag, { mode: "crossing" }>, w: Vec): Partial<CrossingDef> {
      const o = d.orig, p = shift ? w : gridSnap(w), r = (q: Vec) => ({ x: ops.round(q.x), y: ops.round(q.y) });
      if (d.part === "a") return { a: r(p) };
      if (d.part === "b") return { b: r(p) };
      const dx = w.x - d.start.x, dy = w.y - d.start.y;
      return { a: r({ x: o.a.x + dx, y: o.a.y + dy }), b: r({ x: o.b.x + dx, y: o.b.y + dy }) };
    }
    /** a row of parking bays dragged: moved whole, or one end, to the pointer `w` */
    function dragParking(d: Extract<Drag, { mode: "parking" }>, w: Vec): ParkingDef {
      const o = d.orig, at = (p: Vec) => ({ x: ops.round(p.x), y: ops.round(p.y) });
      if (d.part === "a") return { ...o, line: { ...o.line, a: at(w) } };
      if (d.part === "b") return { ...o, line: { ...o.line, b: at(w) } };
      const dx = w.x - d.start.x, dy = w.y - d.start.y;
      return { ...o, line: { ...o.line, a: at({ x: o.line.a.x + dx, y: o.line.a.y + dy }), b: at({ x: o.line.b.x + dx, y: o.line.b.y + dy }) } };
    }
    /** index of the outline point (of the junction whose outline is being edited) under the pointer, or -1 */
    function hitOutlinePoint(sx: number, sy: number): number {
      const id = ui.getValue().shape.edit, nd = id ? ops.nodeById(net, id) : null;
      if (!nd?.outline) return -1;
      return nd.outline.findIndex(p => { const q = toScreen(cam, nd.x + p.x, nd.y + p.y); return Math.hypot(q.x - sx, q.y - sy) < HIT_HANDLE; });
    }
    /** the selected lane connector and one of its curve handles under the pointer */
    /** the selected lane connector and one of its ends (where it leaves its lane, where it joins the next) */
    function hitConnEnd(sx: number, sy: number): { id: string; which: "start" | "end" } | null {
      const sel = u.selection;
      if (sel?.kind !== "connector") return null;
      const v = connectorsOf(simController.compiled).find(x => connectorId(x) === sel.id);
      if (!v) return null;
      const h = connectorHandles(v.node, v.move, v.inLane, v.outLane);
      for (const [p, which] of [[h.P, "start"], [h.Q, "end"]] as const) { const q = toScreen(cam, p.x, p.y); if (Math.hypot(q.x - sx, q.y - sy) < HIT_HANDLE) return { id: sel.id, which }; }
      return null;
    }
    /** dragging an end of a connector: the lane ends it may move to (lanes arriving at / leaving its junction) */
    function connEndTargets(id: string, which: "start" | "end") {
      const v = connectorsOf(simController.compiled).find(x => connectorId(x) === id);
      if (!v) return null;
      const n = v.node, c = simController.compiled;
      // (lanes of its junction, or of another node nearby)
      const list = (which === "end" ? lanesLeavingNear(c, v.move.in, v.inLane) : lanesArrivingNear(c, v.move.out, v.outLane))
        .map(x => ({ ...x, p: which === "end" ? x.lp.poly.at(0) : x.lp.poly.at(x.lp.len) }));
      const h = connectorHandles(n, v.move, v.inLane, v.outLane);
      return { v, list, fixed: which === "end" ? h.P : h.Q };
    }
    function hitConnHandle(sx: number, sy: number): { id: string; which: "k1" | "k2" } | null {
      const sel = u.selection;
      if (sel?.kind !== "connector") return null;
      const v = connectorsOf(simController.compiled).find(x => connectorId(x) === sel.id);
      if (!v) return null;
      const h = connectorHandles(v.node, v.move, v.inLane, v.outLane);
      for (const [p, which] of [[h.h1, "k1"], [h.h2, "k2"]] as const) { const q = toScreen(cam, p.x, p.y); if (Math.hypot(q.x - sx, q.y - sy) < HIT_HANDLE) return { id: sel.id, which }; }
      return null;
    }
    /** the selected connector, its handles and bend points (world), and its key for setting its shape */
    function selConnector() {
      const sel = u.selection;
      if (sel?.kind !== "connector") return null;
      const v = connectorsOf(simController.compiled).find(x => connectorId(x) === sel.id);
      if (!v) return null;
      return { v, id: sel.id, h: connectorHandles(v.node, v.move, v.inLane, v.outLane), key: connShapeKey(v.move, v.inLane, v.outLane), np: v.node.pos };
    }
    /** a bend point of the selected connector under the pointer */
    function hitConnVia(sx: number, sy: number): { id: string; idx: number } | null {
      const s = selConnector();
      if (!s) return null;
      for (let i = 0; i < s.h.via.length; i++) { const q = toScreen(cam, s.h.via[i].x, s.h.via[i].y); if (Math.hypot(q.x - sx, q.y - sy) < HIT_HANDLE) return { id: s.id, idx: i }; }
      return null;
    }
    /** the selected connector's shape with bend points `via` (world): free handles where they are now */
    function withVia(s: NonNullable<ReturnType<typeof selConnector>>, via: Vec[]) {
      const rel = (p: Vec) => ({ x: p.x - s.np.x, y: p.y - s.np.y });
      return setConnectorShape(net, s.v.node.def.id, s.key, { c1: rel(s.h.h1), c2: rel(s.h.h2), ...(via.length ? { via: via.map(rel) } : {}) });
    }
    /** a double-click on the selected connector's path: a bend point there, between the ones it falls between */
    function addConnVia(w: Vec, sx: number, sy: number): boolean {
      const s = selConnector();
      if (!s) return false;
      // (on the path: within a few pixels of it)
      const pts = s.v.pts;
      let near = Infinity;
      for (let k = 0; k + 3 < pts.length; k += 2) {
        const ax = pts[k], ay = pts[k + 1], dx = pts[k + 2] - ax, dy = pts[k + 3] - ay, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((w.x - ax) * dx + (w.y - ay) * dy) / L2));
        near = Math.min(near, Math.hypot(ax + dx * t - w.x, ay + dy * t - w.y));
      }
      if (near > pxToM(10)) return false;
      const knots = [s.h.P, ...s.h.via, s.h.Q];
      let at = 0, bd = Infinity;
      for (let i = 0; i + 1 < knots.length; i++) {
        const a = knots[i], b = knots[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / L2)), d = Math.hypot(a.x + dx * t - w.x, a.y + dy * t - w.y);
        if (d < bd) { bd = d; at = i; }
      }
      const via = [...s.h.via]; via.splice(at, 0, { x: w.x, y: w.y });
      commit(withVia(s, via));
      void sx; void sy;
      return true;
    }
    function hitHandle(sx: number, sy: number): "c1" | "c2" | "bend" | null {
      const sel = u.selection;
      if (sel?.kind !== "link") return null;
      const l = ops.linkById(net, sel.id); if (!l) return null;
      const A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!;
      const near = (p: Vec) => { const q = toScreen(cam, p.x, p.y); return Math.hypot(q.x - sx, q.y - sy) < HIT_HANDLE; };
      if (l.c1 && l.c2) { if (near(l.c1)) return "c1"; if (near(l.c2)) return "c2"; return null; }
      return near({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }) ? "bend" : null;
    }
    function hitBuilding(p: Vec): string | null {
      if (!u.display.buildings) return null;
      for (const b of net.buildings ?? []) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const q of b.pts) { if (q.x < minX) minX = q.x; if (q.x > maxX) maxX = q.x; if (q.y < minY) minY = q.y; if (q.y > maxY) maxY = q.y; }
        if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) continue;
        if (pointInPoly(b.pts, p.x, p.y)) return b.id;
      }
      return null;
    }
    /** the nearest lane (within its width) under a point */
    function hitLane(p: Vec): string | null {
      let best: string | null = null, bd = LW * 0.6;
      for (const e of simController.compiled.edges) for (const lp of e.lanes) {
        const r = lp.poly.project(p.x, p.y);
        if (r.d < bd) { bd = r.d; best = `${e.link.id}|${e.dir}|${lp.lane}`; }
      }
      return best;
    }
    /**
     * The junction being edited (its nodes, by index): the one selected, or that of a selected lane (where
     * it leads) or connector. Its connectors are drawn and can be clicked even with the connector layer off.
     */
    function focusNodes(): number[] {
      const c = simController.compiled, sel = u.selection;
      if (!sel) return [];
      let n: CNode | undefined;
      if (sel.kind === "node") n = c.nodeById.get(sel.id);
      else if (sel.kind === "lane") { const [lid, dir] = sel.id.split("|"); n = c.edgeByKey.get(`${lid}:${dir}`)?.to; }
      else if (sel.kind === "connector") n = c.nodeById.get(sel.id.split("|")[0]);
      // (a roundabout's paths are drawn too, though they can't be dragged)
      return n && n.degree >= 1 ? n.cluster.map(k => k.idx) : [];
    }
    /** the nearest lane connector through a junction (only those of `only`, node indexes, when given) */
    function hitConnector(p: Vec, only?: Set<number>): string | null {
      let best: string | null = null, bd = Math.max(1.2, pxToM(8));
      for (const c of connectorsOf(simController.compiled)) {
        if (only && !only.has(c.node.idx)) continue;
        const q = c.pts;
        for (let k = 2; k < q.length; k += 2) {
          const ax = q[k - 2], ay = q[k - 1], dx = q[k] - ax, dy = q[k + 1] - ay, L2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L2));
          const d = Math.hypot(p.x - ax - dx * t, p.y - ay - dy * t);
          if (d < bd) { bd = d; best = connectorId(c); }
        }
      }
      return best;
    }
    /**
     * What a click selects among the layers that are on, smallest objects first (the order of the
     * "all layers" default): points and junctions, bus stops, vehicles, lane connectors (where drawn: all of
     * them, or the junction being edited), lanes (zoomed in enough to aim at one), roads, then lanes (zoomed
     * out, with roads off), buildings. Roads come last of the street objects: what is on them is picked first.
     * Zones pick entry points and buildings.
     */
    function pickInLayers(layers: readonly LayerId[], sx: number, sy: number, w: Vec): Selection | null {
      const c = simController.compiled, on = (l: LayerId) => layers.includes(l);
      // (with roads on, every point of the drawing: road ends and joints too)
      const nodeOk = (n: CNode) => (on("junctions") && n.controlled && (n.degree >= 2 || !!n.lead))
        || (on("signals") && n.controlled && n.def.control === "lights") || ((on("entries") || on("zones")) && n.gateway);
      const nodeId = hitNode(sx, sy, undefined, id => { if (on("roads")) return true; const n = c.nodeById.get(id); return !!n && nodeOk(n); });
      if (nodeId) return { kind: "node", id: nodeId };
      if (on("stops")) { const id = hitStop(w); if (id) return { kind: "stop", id }; }
      // zebra crossings drawn by hand, rows of parking bays (a click on one of their bays)
      if (on("crossings")) for (const x of c.crossings) if (onCrossing(x, w.x, w.y, 0.5)) return { kind: "crossing", id: x.def.id };
      if (on("parking")) for (const p of c.parking) for (let i = 0; i < p.bays.length; i++) if (pointInPoly(bayOutline(p, i), w.x, w.y)) return { kind: "parking", id: p.def.id };
      if (on("vehicles")) { const v = simController.sim?.vehicleNear(w.x, w.y, Math.max(3, pxToM(10))); if (v) return { kind: "vehicle", id: String(v.id) }; }
      // (connectors are only drawn when highlighted or switched on in the display options)
      if (on("connectors")) {
        const all = u.display.connectors || highlightedLayers(layers).includes("connectors"), focus = focusNodes();
        if (all || focus.length) { const id = hitConnector(w, all ? undefined : new Set(focus)); if (id) return { kind: "connector", id }; }
      }
      // a kerbed island painted on a point (a splitter island, one on a junction): that point
      if (on("junctions") || on("roads")) for (const n of net.nodes) {
        if (!n.paint) continue;
        for (const a of n.paint) if (a.kind === "island" && pointInPoly(a.pts.map(p => ({ x: n.x + p.x, y: n.y + p.y })), w.x, w.y)) return { kind: "node", id: n.id };
      }
      // inside a junction drawn by hand: the junction (held by its leading node); one on its own: itself
      if (on("junctions") || on("roads")) for (const j of net.junctions ?? []) {
        if (!j.nodes.length) { if (j.outline && pointInPoly(j.outline, w.x, w.y)) return { kind: "junction", id: j.id }; continue; }
        const n = c.nodeById.get(j.nodes[0]);
        if (n && n.polygon.length >= 3 && pointInPoly(n.polygon, w.x, w.y)) return { kind: "node", id: n.def.id };
      }
      // lanes before their road once a lane is wide enough on screen to aim at (about 12 px)
      if (on("lanes") && cam.scale * 3.2 >= 12) { const id = hitLane(w); if (id) return { kind: "lane", id }; }
      // (with road surfaces hidden, roads can always be picked: their outline is all there is to click)
      const roadsOn = on("roads") || u.display.maskRoads;
      if (roadsOn || on("counters")) { const l = hitLink(w); if (l && (roadsOn || ops.linkById(net, l.id)?.counter)) return { kind: "link", id: l.id }; }
      if (on("lanes")) { const id = hitLane(w); if (id) return { kind: "lane", id }; }
      if (on("buildings") || on("zones")) { const id = hitBuilding(w); if (id) return { kind: "building", id }; }
      return null;
    }
    /** a click on part of a junction group picks the group (not from inside it: see ui.groupEdit) */
    function asGroup(pick: Selection): Selection {
      const g = pick.kind === "node" ? groupOfNode(net, pick.id)
        : pick.kind === "link" ? groupOfLink(net, pick.id)
          : pick.kind === "lane" ? groupOfLink(net, pick.id.split("|")[0])
            : pick.kind === "connector" ? groupOfNode(net, pick.id.split("|")[0])
              : pick.kind === "stop" ? groupOfLink(net, net.stops.find(x => x.id === pick.id)?.link ?? "")
                : pick.kind === "parking" ? groupOfLink(net, net.parking?.find(x => x.id === pick.id)?.link ?? "")
                  : null;
      if (g && u.groupEdit !== g.id) return { kind: "group", id: g.id };
      // (a ring placed by hand: its roads and lanes pick the ring itself)
      const ringLink = pick.kind === "link" ? pick.id : pick.kind === "lane" ? pick.id.split("|")[0] : null, r = ringLink ? ringOfLink(net, ringLink) : null;
      return r ? { kind: "ring", id: r.id } : pick;
    }
    /** the selected ring (or the ring of the selected point), its points under the pointer */
    function selectedRing() {
      const sel = u.selection;
      return sel?.kind === "ring" ? ringById(net, sel.id) : sel?.kind === "node" ? ringOfNode(net, sel.id) : null;
    }
    function hitRingPoint(sx: number, sy: number): { ring: string; node: string } | null {
      const r = selectedRing();
      if (!r) return null;
      for (const p of ringPoints(net, r)) { const n = ops.nodeById(net, p.id)!, q = toScreen(cam, n.x, n.y); if (Math.hypot(q.x - sx, q.y - sy) < HIT_HANDLE + 2) return { ring: r.id, node: p.id }; }
      return null;
    }
    function hitStop(p: Vec): string | null {
      if (!geo) return null;
      let best: string | null = null, bd = Math.max(3, pxToM(10));
      for (const s of geo.stops) { const d = Math.hypot(s.p.x - p.x, s.p.y - p.y); if (d < bd) { bd = d; best = s.id; } }
      return best;
    }

    /** which part of the reference image is under the pointer (image tool, unlocked) */
    function hitUnderlay(sx: number, sy: number): UnderlayHandle | null {
      if (!ul || !ul.visible || ul.locked) return null;
      const hd = underlayHandles(cam, ul);
      if (Math.hypot(hd.rotate.x - sx, hd.rotate.y - sy) < 10) return "rotate";
      for (let i = 0; i < 4; i++) if (Math.hypot(hd.corners[i].x - sx, hd.corners[i].y - sy) < 10) return `c${i}` as UnderlayHandle;
      const q = worldToImage(ul, toWorld(cam, sx, sy));
      return q.x >= 0 && q.y >= 0 && q.x <= ul.w && q.y <= ul.h ? "move" : null;
    }

    // ------------------------------------------------------------ snapping
    const gridSnap = (p: Vec): Vec => {
      if (!u.snap.grid) return { x: ops.round(p.x), y: ops.round(p.y) };
      const s = u.snap.step;
      return { x: Math.round(p.x / s) * s, y: Math.round(p.y / s) * s };
    };
    function angleSnap(from: Vec, p: Vec): Vec {
      const dx = p.x - from.x, dy = p.y - from.y, len = Math.hypot(dx, dy);
      if (len < 1e-6) return p;
      const step = Math.PI / 12;
      const a = Math.round(Math.atan2(dy, dx) / step) * step;
      let L = len;
      if (u.snap.grid) L = Math.max(u.snap.step, Math.round(len / u.snap.step) * u.snap.step);
      return { x: ops.round(from.x + Math.cos(a) * L), y: ops.round(from.y + Math.sin(a) * L) };
    }
    function snapAt(sx: number, sy: number, from?: Vec, exclude?: string): Snap {
      // (junctions drawn by hand: a road only carries on from a loose end, never makes a junction by joining)
      const nodeId = hitNode(sx, sy, exclude);
      if (nodeId && canJoin(net, nodeId)) { const n = ops.nodeById(net, nodeId)!; return { p: { x: n.x, y: n.y }, nodeId }; }
      const w = toWorld(cam, sx, sy);
      if (from && shift) return { p: angleSnap(from, w) };
      const l = net.manualJunctions ? null : hitLink(w);
      if (l && l.t > 0.02 && l.t < 0.98) return { p: { x: ops.round(l.pt.x), y: ops.round(l.pt.y) }, link: { id: l.id, t: l.t } };
      return { p: gridSnap(w) };
    }

    /** turn a snap into a node id, creating/splitting as needed */
    function resolve(n0: Network, s: Snap): [Network, string] {
      if (s.nodeId && ops.nodeById(n0, s.nodeId)) return [n0, s.nodeId];
      if (s.link && ops.linkById(n0, s.link.id)) { const [n1, node] = ops.splitLink(n0, s.link.id, s.link.t, s.p); return [n1, node.id]; }
      // an existing node exactly here?
      const same = n0.nodes.find(n => Math.hypot(n.x - s.p.x, n.y - s.p.y) < 0.05);
      if (same) return [n0, same.id];
      const [n1, node] = ops.addNode(n0, s.p);
      return [n1, node.id];
    }

    // ------------------------------------------------------------ pointer handling
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => { const r = canvas.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; };

    function onPointerDown(e: PointerEvent) {
      setMenu(null);
      canvas.setPointerCapture(e.pointerId);
      const { sx, sy } = local(e);
      const w = toWorld(cam, sx, sy);
      const tool = u.tool;
      if (e.button === 1 || e.button === 2 && tool !== "road" || spaceHeld || tool === "pan") {
        drag = { mode: "pan", sx, sy, cx: cam.cx, cy: cam.cy, moved: false, clickSel: false, right: e.button === 2 };
        return;
      }
      if (e.button === 2 && tool === "road") { pending = null; markDirty(); return; }
      if (e.button !== 0) return;

      // placing a junction (pasted, from the library): a click puts it down, joined to the roads it lands on
      const piece = placingPiece();
      if (piece) {
        const at = gridSnap(w), turn = u.placing!.turn;
        stopPlacing();
        void busy(`Placing ${piece.name}…`, () => {
          const r = place(net, piece, at, turn);
          commit(r.net); select({ kind: "group", id: r.group }); u.panel = "inspect";
          toast.success(`${piece.name} placed`, { description: r.joined ? `Joined to ${r.joined} road${r.joined === 1 ? "" : "s"} of the plan.` : "Not joined to any road: drag its entry and exit points onto road ends, or place it over roads." });
        });
        markDirty();
        return;
      }

      // picking a transit flow's exit: a click on an exit point sends the flow there
      const pe = ui.getValue().pickExit;
      if (pe) {
        const flow = net.flows?.find(f => f.id === pe), exits = new Set(ops.entryPoints(net).map(n => n.id));
        const id = flow ? hitNode(sx, sy, flow.from, nid => exits.has(nid)) : null;
        if (flow && id) { commit(ops.updateFlow(net, pe, { to: id })); ui.getValue().pickExit = null; }
        else if (!flow) ui.getValue().pickExit = null;
        markDirty();
        return;
      }
      // drawing a lane connector: a click on a lane leaving the junction ends it there
      const cf = ui.getValue().connectFrom;
      if (cf) {
        const pick = connectTargetAt(cf, w);
        // (another lane's end: draw from there instead)
        const other = pick ? null : hitLaneEnd(sx, sy);
        if (other && other !== cf) { startConnect(other); drag = { mode: "connNew", from: other, sx, sy, moved: false }; return; }
        if (pick) {
          // (stay in picking: more lanes can be clicked; Esc or Done ends it)
          const [lid, dir, ln] = cf.split("|"), r = connectLanes(net, simController.compiled, `${lid}:${dir}`, Number(ln), pick.e.key, pick.lp.lane);
          if (r) commit(r.net);
        } else if (onRingDrop(cf, w)) { /* joined the ring there */ }
        markDirty();
        return;
      }
      // junction editor: clicks add points to the painted area being drawn, or pick outline points
      const sh = ui.getValue().shape;
      // a zebra crossing: the second click is its other kerb
      if (sh.paint?.kind === "crossing") {
        const a = sh.paint.pts[0];
        sh.paint = null;
        if (Math.hypot(w.x - a.x, w.y - a.y) < 1) { markDirty(); return; }
        const [n2, x] = ops.addCrossing(net, a, w);
        commit(n2); select({ kind: "crossing", id: x.id }); markDirty();
        return;
      }
      // a roundabout: the second click is on its outer kerb
      if (sh.paint?.kind === "roundabout") {
        const c0 = sh.paint.pts[0], kerb = Math.hypot(w.x - c0.x, w.y - c0.y), jid = sh.paint.node.startsWith("junction:") ? sh.paint.node.slice(9) : null, ringOnly = sh.paint.node === "ring";
        sh.paint = null;
        if (kerb < 3) { markDirty(); return; }
        if (ringOnly) {
          const r = createRing(net, c0, kerb, kerb >= TWO_LANES_FROM ? 2 : 1);
          commit(r.net); ui.getValue().tool = "select"; select({ kind: "ring", id: r.ring }); ui.getValue().panel = "inspect";
          toast.success("Ring placed", { description: "Drop connectors from lane ends onto it (a point is made there); drag its points round it; double-click it to add a point. Select a point to lead connectors off it." });
          markDirty();
          return;
        }
        void busy("Building the roundabout…", () => {
        const j = jid ? net.junctions?.find(x => x.id === jid) : undefined;
        const r = j ? createRoundabout(deleteJunction(net, j.id), c0, kerb, kerb >= TWO_LANES_FROM ? 2 : 1, { ends: j.nodes }) : createRoundabout(net, c0, kerb, kerb >= TWO_LANES_FROM ? 2 : 1);
        if ("error" in r) toast.error(r.error);
        else { commit(r.net); ui.getValue().tool = "select"; select({ kind: "group", id: r.group }); ui.getValue().panel = "inspect"; toast.success("Roundabout built", { description: "One junction group: a ring of one-way roads, each road joining at a junction where it gives way. Double-click it to edit inside; copy it or save it to your library." }); }
        });
        markDirty();
        return;
      }
      // a row of parking bays: the second click is where it ends
      if (sh.paint?.kind === "parking") {
        // a row standing on its own (a → here): reached from the road nearest it, from the side it is on;
        // its bays open toward that road
        const a = sh.paint.pts[0], b = { x: ops.round(w.x), y: ops.round(w.y) };
        sh.paint = null;
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1) { markDirty(); return; }
        const acc = accessFor(a, b);
        if (!acc) { toast.error("Draw the bays within 80 m of a road: cars reach them from the nearest one."); markDirty(); return; }
        const [n2, p] = ops.addFreeParking(net, acc.link, acc.dir, a, b, acc.side);
        commit(n2); select({ kind: "parking", id: p.id }); markDirty();
        return;
      }
      // a junction's outline: clicking its first point again closes it and makes the junction
      if (sh.paint?.kind === "junction" && sh.paint.pts.length >= 3) {
        const f = toScreen(cam, sh.paint.pts[0].x, sh.paint.pts[0].y);
        if (Math.hypot(f.x - sx, f.y - sy) <= CLOSE_PX) { finishPaint(); markDirty(); return; }
      }
      if (sh.paint) { const pp = sh.paint; sh.paint = { ...pp, pts: [...pp.pts, { x: ops.round(w.x), y: ops.round(w.y) }] }; markDirty(); return; }
      // Zebra crossing tool: the first kerb
      if (tool === "crossing") { sh.edit = null; sh.paint = { node: "", kind: "crossing", pts: [{ x: ops.round(w.x), y: ops.round(w.y) }] }; markDirty(); return; }
      // Ring tool: its centre (anywhere); the second click sets its outer kerb
      if (tool === "ring") { sh.edit = null; sh.paint = { node: "ring", kind: "roundabout", pts: [{ x: ops.round(w.x), y: ops.round(w.y) }] }; markDirty(); return; }
      // Roundabout tool: its centre (a junction's point when clicked on one)
      if (tool === "roundabout") {
        // (inside a junction drawn by hand: a ring there, joined to every one of its road ends)
        const inJ = (net.junctions ?? []).find(j => { const n = j.nodes.length >= 2 ? simController.compiled.nodeById.get(j.nodes[0]) : undefined; return !!n && n.polygon.length >= 3 && pointInPoly(n.polygon, w.x, w.y); });
        const on = inJ ? null : hitNode(sx, sy), nd = on ? ops.nodeById(net, on) : null;
        sh.edit = null; sh.paint = { node: inJ ? `junction:${inJ.id}` : "", kind: "roundabout", pts: [nd ? { x: nd.x, y: nd.y } : { x: ops.round(w.x), y: ops.round(w.y) }] };
        if (inJ) toast.info("A ring inside the junction", { description: "Click to set its outer kerb: all the junction's roads join the ring." });
        markDirty(); return;
      }
      // Parking tool: where a row of bays starts (anywhere; it ends at the next click)
      if (tool === "parking") { sh.edit = null; sh.paint = { node: "free", kind: "parking", pts: [{ x: ops.round(w.x), y: ops.round(w.y) }] }; markDirty(); return; }
      // Junction tool: the first corner of a new junction's outline
      if (tool === "junction") { sh.edit = null; sh.paint = { node: "", kind: "junction", pts: [{ x: ops.round(w.x), y: ops.round(w.y) }] }; markDirty(); return; }
      if (sh.edit) {
        const k = hitOutlinePoint(sx, sy);
        if (k >= 0) {
          const nd = ops.nodeById(net, sh.edit)!;
          if (e.altKey) { if (nd.outline!.length > 3) { commit(ops.setOutline(net, nd.id, nd.outline!.filter((_, i) => i !== k))); sh.point = null; } return; }
          // (picked: highlighted, Delete takes it out; and dragged)
          sh.point = k;
          drag = { mode: "outline", node: nd.id, idx: k };
          return;
        }
        if (sh.point != null) { sh.point = null; markDirty(); }
      }

      const calib = u.calib;
      if (calib.active) {
        const p = { x: ops.round(w.x), y: ops.round(w.y) };
        batch(() => {
          if (!calib.a || calib.b) { calib.a = p; calib.b = null; }
          else calib.b = p;
        });
        return;
      }

      if (tool === "image") {
        const h = hitUnderlay(sx, sy);
        if (h && ul) {
          const c = { x: ul.x, y: ul.y };
          if (h === "move") drag = { mode: "ul-move", start: w, x0: ul.x, y0: ul.y };
          else if (h === "rotate") drag = { mode: "ul-rotate", a0: Math.atan2(w.y - c.y, w.x - c.x), rot0: ul.rot };
          else drag = { mode: "ul-scale", d0: Math.max(1e-6, Math.hypot(w.x - c.x, w.y - c.y)), mpp0: ul.mpp };
          return;
        }
        drag = { mode: "pan", sx, sy, cx: cam.cx, cy: cam.cy, moved: false, clickSel: false };
        return;
      }

      if (tool === "road") {
        const s = snapAt(sx, sy, pending?.p);
        if (!pending) { pending = s; markDirty(); return; }
        if (Math.hypot(s.p.x - pending.p.x, s.p.y - pending.p.y) < 0.5) { pending = null; markDirty(); return; }
        const r1 = resolve(net, pending);
        let n0 = r1[0];
        const a = r1[1];
        // re-snap the end on the updated network (the start may have split a road)
        const endSnap: Snap = s.nodeId ? s : (() => {
          if (s.link) {
            const l = n0.links.find(x => x.id === s.link!.id);
            if (!l) {
              // the link was split by the start point: find the piece under the end point
              for (const x of n0.links) {
                const A = ops.nodeById(n0, x.from)!, B = ops.nodeById(n0, x.to)!;
                const r = ops.nearestT(x, A, B, s.p);
                if (r.d < 0.5 && r.t > 0.02 && r.t < 0.98) return { p: s.p, link: { id: x.id, t: r.t } };
              }
              return { p: s.p };
            }
          }
          return s;
        })();
        const r2 = resolve(n0, endSnap);
        n0 = r2[0];
        const b = r2[1];
        const [added, link] = ops.addLink(n0, a, b, u.draft);
        // curved mode: bend the road smoothly through the previous point
        let n2 = link && u.draft.curved ? ops.smoothAt(added, a) : added;
        // (drawn inside a junction group: the road is the group's — a new entry / exit point where it ends)
        if (link && u.groupEdit) n2 = { ...n2, groups: n2.groups?.map(g => (g.id === u.groupEdit ? { ...g, links: [...g.links, link.id] } : g)) };
        // (ending inside a junction standing on its own: once two roads reach it, they join it; the road ends there)
        const alone = link ? standaloneAt(n2, ops.nodeById(n2, b) ?? { x: Infinity, y: Infinity }) : null;
        const joined = alone ? joinStandalone(n2, alone.id) : null;
        if (joined) { commit(joined.net); select({ kind: "node", id: joined.junction.nodes[0] }); pending = null; toast.success("Roads joined to the junction"); markDirty(); return; }
        if (link) { commit(n2); select({ kind: "link", id: link.id }); }
        else if (n0 !== net) commit(n0);
        pending = { p: ops.nodeById(network$.getValue(), b) ? { ...ops.nodeById(network$.getValue(), b)! } : s.p, nodeId: b };
        markDirty();
        return;
      }

      if (tool === "segment") {
        const l = hitLink(w);
        if (l) { select({ kind: "link", id: l.id }); return; }
        drag = { mode: "pan", sx, sy, cx: cam.cx, cy: cam.cy, moved: false, clickSel: true };
        return;
      }

      // markers: the marker tool places one (or picks one up); with the select tool one is picked before anything else
      const mk = tool === "marker" || tool === "select" ? hitMarker(sx, sy) : null;
      if (mk) {
        if (e.shiftKey && tool === "select") { toggleSelect({ kind: "marker", id: mk }); return; }
        select({ kind: "marker", id: mk });
        drag = { mode: "marker", id: mk, moved: false, sx, sy };
        return;
      }
      if (tool === "marker") {
        const [n2, m] = ops.addMarker(net, w);
        commit(n2); select({ kind: "marker", id: m.id });
        return;
      }
      if (tool === "stop") {
        const l = hitLink(w);
        if (!l) return;
        const link = ops.linkById(net, l.id)!, A = ops.nodeById(net, link.from)!, B = ops.nodeById(net, link.to)!;
        const t0 = ops.linkPoint(link, A, B, Math.max(0, l.t - 0.01)), t1 = ops.linkPoint(link, A, B, Math.min(1, l.t + 0.01));
        const tx = t1.x - t0.x, ty = t1.y - t0.y;
        const right = (w.x - l.pt.x) * -ty + (w.y - l.pt.y) * tx > 0;
        let dir: 1 | -1 = right ? 1 : -1;
        if (dir === 1 && link.lanesF === 0) dir = -1;
        if (dir === -1 && link.lanesB === 0) dir = 1;
        const [n2, stop] = ops.addStop(net, link.id, dir, l.t);
        commit(n2);
        select({ kind: "stop", id: stop.id });
        return;
      }

      // the selected row of parking bays' ends: stretch it
      const xEnd = tool === "select" ? hitCrossingEnd(sx, sy) : null;
      if (xEnd) { const o = net.crossings?.find(c => c.id === xEnd.id); if (o) { drag = { mode: "crossing", id: xEnd.id, part: xEnd.which, start: w, orig: o, moved: false, sx, sy }; return; } }
      const pkEnd = tool === "select" ? hitParkingEnd(sx, sy) : null;
      if (pkEnd) { const o = net.parking?.find(x => x.id === pkEnd.id); if (o) { drag = { mode: "parking", id: pkEnd.id, part: pkEnd.which, start: w, orig: o, moved: false, sx, sy }; return; } }
      // the selected lane connector's curve handles (any layer)
      const ce = hitConnEnd(sx, sy);
      if (ce) { drag = { mode: "connEnd", id: ce.id, which: ce.which }; return; }
      // the selected connector's bend points: drag one, Alt+click to take it out
      const cv = hitConnVia(sx, sy);
      if (cv) {
        if (e.altKey) { const s = selConnector(); if (s) commit(withVia(s, s.h.via.filter((_, i) => i !== cv.idx))); return; }
        drag = { mode: "via", id: cv.id, idx: cv.idx }; return;
      }
      const ch = hitConnHandle(sx, sy);
      if (ch) { drag = { mode: "conn", id: ch.id, which: ch.which }; return; }
      // select tool: the curve handles of the selected road first (they win over a lane's end under them)
      const h = u.layers.includes("roads") ? hitHandle(sx, sy) : null;
      if (h && u.selection?.kind === "link") { drag = { mode: "handle", linkId: u.selection.id, handle: h, moved: false }; return; }
      // the end of a lane (zoomed in): a connector from it, dragged to a lane, or click the lanes after
      const le = tool === "select" ? hitLaneEnd(sx, sy) : null;
      if (le) { startConnect(le); drag = { mode: "connNew", from: le, sx, sy, moved: false }; return; }
      // a point of the selected ring: picked (its lane ends show, to lead connectors off it), and dragged round the ring
      const rp = tool === "select" ? hitRingPoint(sx, sy) : null;
      if (rp) { select({ kind: "node", id: rp.node }); drag = { mode: "ringPoint", ring: rp.ring, node: rp.node, moved: false, sx, sy }; markDirty(); return; }
      const picked = pickInLayers(u.layers, sx, sy, w), pick = picked && tool === "select" && !e.shiftKey ? asGroup(picked) : picked;
      if (pick?.kind === "ring") { select(pick); drag = { mode: "ring", ring: pick.id, last: w, moved: false, sx, sy }; markDirty(); return; }
      if (pick?.kind === "group") {
        select(pick);
        drag = { mode: "group", id: pick.id, last: w, moved: false, sx, sy };
        return;
      }
      if (pick) {
        // Shift+click: add it to what is selected (or take it out): roads, points, stops, buildings, connectors…
        if (e.shiftKey) { toggleSelect(pick); if (pick.kind === "node") return; } else select(pick);
        // junctions and points can be dragged; buildings, lanes and connectors cover so much of the map that a drag from them pans
        if (pick.kind === "node") drag = { mode: "node", id: pick.id, moved: false, sx, sy };
        else if (pick.kind === "crossing" && !e.shiftKey && tool === "select") { const o = net.crossings?.find(x => x.id === pick.id); if (o) drag = { mode: "crossing", id: pick.id, part: "move", start: w, orig: o, moved: false, sx, sy }; }
        else if (pick.kind === "parking" && !e.shiftKey && tool === "select") { const o = net.parking?.find(x => x.id === pick.id); if (o) drag = { mode: "parking", id: pick.id, part: "move", start: w, orig: o, moved: false, sx, sy }; }
        else if (pick.kind === "building" || pick.kind === "lane" || pick.kind === "connector") drag = { mode: "pan", sx, sy, cx: cam.cx, cy: cam.cy, moved: false, clickSel: false };
        return;
      }
      // Shift+drag on the empty map: a box, selecting what is in it
      if (e.shiftKey && tool === "select") { drag = { mode: "box", a: w, b: w }; return; }
      drag = { mode: "pan", sx, sy, cx: cam.cx, cy: cam.cy, moved: false, clickSel: true };
    }
    /** what a selection box from `a` to `b` takes in (among the layers that are on): whole roads, points, stops, buildings */
    function inBox(a: Vec, b: Vec): Selection[] {
      const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
      const inside = (p: Vec) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1, on = (l: LayerId) => u.layers.includes(l);
      const c = simController.compiled, out: Selection[] = [];
      if (on("roads")) for (const l of net.links) {
        const A = ops.nodeById(net, l.from), B = ops.nodeById(net, l.to), mid = c.linkCenters.get(l.id)?.at((c.linkCenters.get(l.id)?.len ?? 0) / 2);
        if (A && B && inside(A) && inside(B) && (!mid || inside(mid))) out.push({ kind: "link", id: l.id });
      }
      for (const n of net.nodes) {
        const cn = c.nodeById.get(n.id);
        const ok = on("roads") || (cn && ((on("junctions") && cn.controlled && cn.degree >= 2) || (on("entries") && cn.gateway)));
        if (ok && inside(n)) out.push({ kind: "node", id: n.id });
      }
      if (on("stops") && geo) for (const s of geo.stops) if (inside(s.p)) out.push({ kind: "stop", id: s.id });
      if (on("buildings")) for (const bd of net.buildings ?? []) if (bd.pts.every(inside)) out.push({ kind: "building", id: bd.id });
      if (on("markers")) for (const m of net.markers ?? []) if (inside(m)) out.push({ kind: "marker", id: m.id });
      return out;
    }

    function onPointerMove(e: PointerEvent) {
      const { sx, sy } = local(e);
      const w = toWorld(cam, sx, sy);
      cursorWorld = w;
      if (u.placing || u.shape.edit) markDirty();
      const c = ui.getValue().cursor;
      batch(() => { c.x = w.x; c.y = w.y; c.inside = true; });
      if (drag?.mode === "pan") {
        const dx = sx - drag.sx, dy = sy - drag.sy;
        if (Math.hypot(dx, dy) > 3) drag.moved = true;
        cam.cx = drag.cx - dx / cam.scale; cam.cy = drag.cy - dy / cam.scale;
        markDirty();
        return;
      }
      if (drag?.mode === "ul-move") {
        const d = drag;
        setUnderlay(cur => ({ ...cur, x: ops.round(d.x0 + w.x - d.start.x), y: ops.round(d.y0 + w.y - d.start.y) }));
        return;
      }
      if (drag?.mode === "ul-rotate") {
        const d = drag;
        setUnderlay(cur => {
          let rot = d.rot0 + ((Math.atan2(w.y - cur.y, w.x - cur.x) - d.a0) * 180) / Math.PI;
          rot = shift ? Math.round(rot / 15) * 15 : Math.round(rot * 10) / 10;
          return { ...cur, rot: ((rot % 360) + 360) % 360 };
        });
        return;
      }
      if (drag?.mode === "ul-scale") {
        const d = drag;
        setUnderlay(cur => ({ ...cur, mpp: Math.max(1e-4, (d.mpp0 * Math.hypot(w.x - cur.x, w.y - cur.y)) / d.d0) }));
        return;
      }
      if (drag?.mode === "marker") {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        drag.moved = true;
        commit(ops.updateMarker(net, drag.id, { x: w.x, y: w.y }), `marker:${drag.id}`);
        return;
      }
      if (drag?.mode === "crossing") {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        drag.moved = true;
        commit(ops.updateCrossing(net, drag.id, dragCrossing(drag, w)), `crossing:${drag.id}`);
        return;
      }
      if (drag?.mode === "parking") {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        drag.moved = true;
        commit(ops.updateParking(net, drag.id, dragParking(drag, w)), `parking:${drag.id}`);
        return;
      }
      if (drag?.mode === "ringPoint") {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        drag.moved = true;
        const r = ringById(net, drag.ring);
        if (!r) return;
        commit(moveRingPoint(net, r.id, drag.node, Math.atan2(w.y - r.y, w.x - r.x)), `ringpt:${drag.node}`);
        return;
      }
      if (drag?.mode === "ring") {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        drag.moved = true;
        const r = ringById(net, drag.ring);
        if (!r) return;
        const dx = w.x - drag.last.x, dy = w.y - drag.last.y;
        drag.last = w;
        commit(setRing(net, r.id, { x: ops.round(r.x + dx), y: ops.round(r.y + dy) }), `ring:${r.id}`);
        return;
      }
      if (drag?.mode === "group") {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        drag.moved = true;
        const g = groupById(net, drag.id);
        if (!g) return;
        const dx = w.x - drag.last.x, dy = w.y - drag.last.y;
        drag.last = w;
        commit(moveGroup(net, g, dx, dy), `group:${g.id}`);
        return;
      }
      if (drag?.mode === "node") {
        if (!drag.moved && Math.hypot(sx - drag.sx, sy - drag.sy) < 3) return;
        drag.moved = true;
        const other = hitNode(sx, sy, drag.id);
        const p = other ? ops.nodeById(net, other)! : gridSnap(w);
        commit(ops.moveNode(net, drag.id, p), `drag:${drag.id}`);
        return;
      }
      if (drag?.mode === "outline") {
        const d = drag, nd = ops.nodeById(net, d.node);
        if (!nd?.outline) return;
        const p = shift ? { x: w.x, y: w.y } : gridSnap(w);
        commit(ops.setOutline(net, nd.id, nd.outline.map((q, i) => (i === d.idx ? { ...q, x: p.x - nd.x, y: p.y - nd.y } : q))), `outline:${nd.id}`);
        return;
      }
      if (drag?.mode === "connEnd") { markDirty(); return; }
      if (drag?.mode === "connNew") { if (Math.hypot(sx - drag.sx, sy - drag.sy) > 4) drag.moved = true; markDirty(); return; }
      if (drag?.mode === "box") { drag.b = w; markDirty(); return; }
      if (drag?.mode === "via") {
        const s = selConnector(), d = drag;
        if (!s || s.id !== d.id) return;
        const via = s.h.via.map((p, i) => (i === d.idx ? (shift ? { x: w.x, y: w.y } : gridSnap(w)) : p));
        commit(withVia(s, via), `via:${d.id}`);
        return;
      }
      if (drag?.mode === "conn") {
        const d = drag, v = connectorsOf(simController.compiled).find(x => connectorId(x) === d.id);
        if (!v) return;
        const h = connectorHandles(v.node, v.move, v.inLane, v.outLane);
        const key = connShapeKey(v.move, v.inLane, v.outLane), np = v.node.pos;
        if (!e.shiftKey) {
          // the handle goes wherever it is dragged (Shift: it slides along its lane, keeping the path square to it)
          const rel = (p: Vec) => ({ x: p.x - np.x, y: p.y - np.y });
          const c1 = d.which === "k1" ? rel(w) : rel(h.h1), c2 = d.which === "k2" ? rel(w) : rel(h.h2);
          commit(setConnectorShape(net, v.node.def.id, key, { c1, c2, ...(h.via.length ? { via: h.via.map(rel) } : {}) }), `conn:${d.id}`);
        } else {
          // each handle slides along its lane's direction (the path stays tangent to both lanes)
          const k = d.which === "k1" ? (w.x - h.P.x) * h.tp.x + (w.y - h.P.y) * h.tp.y : (h.Q.x - w.x) * h.tq.x + (h.Q.y - w.y) * h.tq.y;
          const reach: [number, number] = d.which === "k1" ? [Math.max(0.5, k), h.k2] : [h.k1, Math.max(0.5, k)];
          if (h.via.length) {
            // (with bend points: the handle put on its lane's line, the rest kept)
            const rel = (p: Vec) => ({ x: p.x - np.x, y: p.y - np.y });
            const on = d.which === "k1" ? { x: h.P.x + h.tp.x * reach[0], y: h.P.y + h.tp.y * reach[0] } : { x: h.Q.x - h.tq.x * reach[1], y: h.Q.y - h.tq.y * reach[1] };
            commit(setConnectorShape(net, v.node.def.id, key, { c1: rel(d.which === "k1" ? on : h.h1), c2: rel(d.which === "k2" ? on : h.h2), via: h.via.map(rel) }), `conn:${d.id}`);
          } else commit(setConnectorShape(net, v.node.def.id, key, reach), `conn:${d.id}`);
        }
        return;
      }
      if (drag?.mode === "handle") {
        drag.moved = true;
        const l = ops.linkById(net, drag.linkId);
        if (!l) return;
        const p = gridSnap(w);
        if (drag.handle === "bend") {
          const A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!;
          const P = { x: ops.round((p.x - 0.125 * (A.x + B.x)) / 0.75), y: ops.round((p.y - 0.125 * (A.y + B.y)) / 0.75) };
          const c1 = { x: ops.round(A.x + (P.x - A.x) * 0.9), y: ops.round(A.y + (P.y - A.y) * 0.9) };
          const c2 = { x: ops.round(B.x + (P.x - B.x) * 0.9), y: ops.round(B.y + (P.y - B.y) * 0.9) };
          commit(ops.updateLink(net, l.id, { c1, c2 }), `handle:${l.id}`);
        } else {
          commit(ops.updateLink(net, l.id, { [drag.handle]: p }), `handle:${l.id}`);
        }
        return;
      }
      // hover feedback
      let hv: Overlay["hover"] = null;
      if (u.tool === "select") {
        const h = hitHandle(sx, sy), ch = hitConnHandle(sx, sy);
        if (ch) hv = { kind: "handle", id: ch.which };
        else if (h) hv = { kind: "handle", id: h };
        else { const n = hitNode(sx, sy); if (n) hv = { kind: "node", id: n }; else { const l = hitLink(w); if (l) hv = { kind: "link", id: l.id }; } }
      } else if (u.tool === "stop" || u.tool === "segment") { const l = hitLink(w); if (l) hv = { kind: "link", id: l.id }; }
      else if (u.tool === "road") { const n = hitNode(sx, sy); if (n) hv = { kind: "node", id: n }; }
      if (JSON.stringify(hv) !== JSON.stringify(hover)) { hover = hv; }
      ulHover = u.tool === "image" && !u.calib.active ? hitUnderlay(sx, sy) : null;
      const ulCursor = ulHover === "move" ? "move" : ulHover === "rotate" ? "grab" : ulHover ? (ulHover === "c0" || ulHover === "c2" ? "nwse-resize" : "nesw-resize") : null;
      canvas.style.cursor = drag ? "grabbing" : u.calib.active ? "crosshair" : ulCursor ?? (u.tool === "pan" || u.tool === "image" || spaceHeld ? "grab" : u.tool === "road" || u.tool === "stop" || u.tool === "marker" || u.pickExit ? "crosshair" : hv ? "pointer" : "default");
      markDirty();
    }

    function onPointerUp(e: PointerEvent) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
      // a selection box: what is in it joins what was selected
      if (drag?.mode === "box") {
        const d = drag;
        drag = null;
        const found = inBox(d.a, d.b);
        if (found.length) selectMany([...selectedAll(), ...found]);
        markDirty();
        return;
      }
      // a connector drawn from a lane's end, dropped on a lane: made (a plain click keeps picking lanes)
      if (drag?.mode === "connNew") {
        const d = drag;
        drag = null;
        if (d.moved) {
          const { sx, sy } = local(e), t = connectTargetAt(d.from, toWorld(cam, sx, sy));
          const [lid, dir, ln] = d.from.split("|");
          const r = t ? connectLanes(net, simController.compiled, `${lid}:${dir}`, Number(ln), t.e.key, t.lp.lane) : null;
          ui.getValue().connectFrom = null;
          if (r) { commit(r.net); select({ kind: "connector", id: r.id }); }
          else if (!t) onRingDrop(d.from, toWorld(cam, sx, sy));
        }
        markDirty();
        return;
      }
      // a connector end dropped on another lane end: the connector goes there instead
      if (drag?.mode === "connEnd") {
        const d = drag, t = connEndTargets(d.id, d.which), { sx, sy } = local(e), w = toWorld(cam, sx, sy);
        const hit = t?.list.map(x => ({ x, d: Math.hypot(x.p.x - w.x, x.p.y - w.y) })).filter(x => x.d < Math.max(LW, pxToM(14))).sort((a, b) => a.d - b.d)[0]?.x;
        if (t && hit) {
          const m = t.v.move, c = simController.compiled;
          const inKey = d.which === "start" ? hit.e.key : m.in.key, a = d.which === "start" ? hit.lp.lane : t.v.inLane;
          const outKey = d.which === "end" ? hit.e.key : m.out.key, b = d.which === "end" ? hit.lp.lane : t.v.outLane;
          if (inKey !== m.in.key || a !== t.v.inLane || outKey !== m.out.key || b !== t.v.outLane) {
            // off the old lane ends, onto the new ones (the lanes' other connectors stay)
            const off = changeConnection(net, c, m.in.key, t.v.inLane, m.out.key, t.v.outLane, null);
            const r = connectLanes(off, c, inKey, a, outKey, b);
            if (r) { commit(r.net); select({ kind: "connector", id: r.id }); }
          }
        }
        drag = null; markDirty();
        return;
      }
      if (drag?.mode === "pan" && drag.clickSel && !drag.moved) select(null);
      // right-click without dragging: offer the spot in Google Maps
      if (drag?.mode === "pan" && drag.right && !drag.moved && net.geo) {
        const { sx, sy } = local(e), g = unproject(net.geo, toWorld(cam, sx, sy));
        setMenu({ x: Math.max(0, Math.min(sx, cam.w - 216)), y: Math.max(0, Math.min(sy, cam.h - 72)), lat: g.lat, lon: g.lon });
      }
      // a free-standing row moved: reached from the road nearest it now (the same step to undo)
      if (drag?.mode === "parking" && drag.moved) {
        const id = drag.id, p = net.parking?.find(x => x.id === id);
        if (p) { const acc = accessFor(p.line.a, p.line.b); if (acc && (acc.link !== p.link || acc.dir !== p.dir)) commit(ops.updateParking(net, p.id, { link: acc.link, dir: acc.dir }), `parking:${p.id}`); }
      }
      if (drag?.mode === "node" && drag.moved) {
        // dropped onto another node: merge them
        const { sx, sy } = local(e);
        const other = hitNode(sx, sy, drag.id);
        if (other && canJoin(net, other, drag.id)) commit(ops.mergeNodes(net, other, drag.id));
      }
      if (drag && drag.mode !== "pan") endGesture();
      drag = null;
      markDirty();
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      setMenu(null);
      const { sx, sy } = local(e);
      if (e.ctrlKey || e.metaKey || e.deltaMode === 1) zoomAt(sx, sy, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.08 : 0.01)));
      else { cam.cx += e.deltaX / cam.scale; cam.cy += e.deltaY / cam.scale; markDirty(); }
    }

    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable]");
      shift = e.shiftKey;
      if (e.type === "keydown" && e.code === "Space" && !typing) { spaceHeld = true; canvas.style.cursor = "grab"; e.preventDefault(); }
      if (e.type === "keyup" && e.code === "Space") { spaceHeld = false; canvas.style.cursor = "default"; }
      if (e.type === "keydown" && e.key === "Escape") setMenu(null);
      const sh = ui.getValue().shape;
      if (e.type === "keydown" && !typing && e.key === "Escape" && sh.edit && !sh.paint) { sh.edit = null; sh.point = null; e.stopPropagation(); markDirty(); return; }
      if (e.type === "keydown" && !typing && e.key === "Escape" && ui.getValue().placing) { stopPlacing(); e.stopPropagation(); markDirty(); return; }
      if (e.type === "keydown" && !typing && e.key === "Escape" && ui.getValue().groupEdit && !sh.paint && !ui.getValue().connectFrom) {
        const id = ui.getValue().groupEdit!; ui.getValue().groupEdit = null; select({ kind: "group", id }); e.stopPropagation(); markDirty(); return;
      }
      if (e.type === "keydown" && !typing && e.key === "Escape" && ui.getValue().connectFrom) { ui.getValue().connectFrom = null; e.stopPropagation(); markDirty(); return; }
      if (e.type === "keydown" && !typing && e.key === "Escape" && ui.getValue().pickExit) { ui.getValue().pickExit = null; e.stopPropagation(); markDirty(); return; }
      if (e.type === "keydown" && !typing && sh.paint && (e.key === "Enter" || e.key === "Escape")) {
        if (e.key === "Enter") finishPaint(); else sh.paint = null;
        e.stopPropagation(); e.preventDefault(); markDirty(); return;
      }
      if (e.type === "keydown" && !typing && (e.key === "Escape" || e.key === "Enter") && pending) { pending = null; markDirty(); e.stopPropagation(); }
      if (e.type === "keydown" && !typing && e.key === "Escape" && u.calib.active) {
        const c = ui.getValue().calib; batch(() => { c.active = false; c.a = null; c.b = null; }); e.stopPropagation();
      }
      markDirty();
    };
    const onDbl = (e: MouseEvent) => {
      const sh = ui.getValue().shape;
      // drawing a painted area: a double-click finishes it
      // (a junction's outline is closed on its first point, or with Enter: a double-click only adds points)
      if (sh.paint) { if (sh.paint.kind !== "junction") finishPaint(); return; }
      // editing an outline: double-click an edge to add a point there
      if (sh.edit) {
        const nd = ops.nodeById(net, sh.edit);
        if (nd?.outline) {
          const { sx, sy } = local(e), w = toWorld(cam, sx, sy), pts = nd.outline.map(p => ({ x: nd.x + p.x, y: nd.y + p.y }));
          let best = -1, bd = pxToM(12);
          for (let i = 0; i < pts.length; i++) {
            const a = pts[i], b = pts[(i + 1) % pts.length], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
            const t = Math.max(0, Math.min(1, ((w.x - a.x) * dx + (w.y - a.y) * dy) / L2)), d = Math.hypot(a.x + dx * t - w.x, a.y + dy * t - w.y);
            if (d < bd) { bd = d; best = i; }
          }
          if (best >= 0) { const next = [...nd.outline]; next.splice(best + 1, 0, { x: w.x - nd.x, y: w.y - nd.y }); commit(ops.setOutline(net, nd.id, next)); }
          return;
        }
      }
      if (u.tool === "road") { pending = null; markDirty(); return; }
      if (u.tool !== "select") return;
      // double-click the selected connector's path: a bend point there
      { const { sx, sy } = local(e); if (addConnVia(toWorld(cam, sx, sy), sx, sy)) { markDirty(); return; } }
      // double-click a junction group: go inside it (its roads and junctions are picked one by one; Esc comes out)
      {
        const { sx, sy } = local(e), w = toWorld(cam, sx, sy), p = pickInLayers(u.layers, sx, sy, w), g = p && asGroup(p);
        if (g?.kind === "group") { u.groupEdit = g.id; select(p); markDirty(); return; }
        // double-click a junction: edit its outline (starting from the automatic one)
        const cn = p?.kind === "node" ? simController.compiled.nodeById.get(p.id) : undefined, lead = cn ? cn.lead ?? cn : undefined;
        if (lead && isJunction(lead) && !(lead.ringR > 0) && !u.readOnly) {
          const nd = ops.nodeById(net, lead.def.id)!;
          if (!nd.outline && lead.polygon.length >= 3) commit(ops.setOutline(net, nd.id, simplifyRing(lead.polygon, 0.15).map(q => ({ x: q.x - nd.x, y: q.y - nd.y }))));
          const sh = ui.getValue().shape;
          sh.paint = null; sh.point = null; sh.edit = nd.id;
          select({ kind: "node", id: nd.id }); u.panel = "inspect";
          toast.info("Editing the junction's outline", { description: "Drag its points; double-click an edge to add one; click a point to pick it (Delete removes it, C curves the kerb round it). Esc or Done when finished." });
          markDirty();
          return;
        }
      }
      // double-click a ring: a point of it there (to lead a connector off it, or join it at)
      {
        const { sx, sy } = local(e), w = toWorld(cam, sx, sy), l = hitLink(w), def = l ? ops.linkById(net, l.id) : undefined;
        if (def && isRing(def)) { const r = ringPointAt(net, def.id, w); if (r) { commit(r.net); select({ kind: "node", id: r.node }); markDirty(); } return; }
      }
      // double-click a road to add a bend point you can drag
      const { sx, sy } = local(e);
      if (hitNode(sx, sy)) return;
      const l = hitLink(toWorld(cam, sx, sy));
      if (!l || l.t < 0.03 || l.t > 0.97) return;
      const [n2, node] = ops.splitLink(net, l.id, l.t, l.pt);
      commit(n2);
      select({ kind: "node", id: node.id });
    };
    /** finish the painted area being drawn (3 points or more) and add it to its junction */
    function finishPaint() {
      const sh = ui.getValue().shape, p = sh.paint;
      if (!p) return;
      const nd = ops.nodeById(net, p.node);
      // (a double-click also clicked twice: drop points on top of the one before)
      const pts = p.pts.filter((q, i) => i === 0 || Math.hypot(q.x - p.pts[i - 1].x, q.y - p.pts[i - 1].y) > 0.3);
      sh.paint = null;
      if (p.kind === "roundabout") { /* (built by the second click) */ }
      else if (p.kind === "junction") {
        // a junction drawn by hand: cut the roads at it, then show it in the inspector
        void busy("Building the junction…", () => {
          const r = pts.length >= 3 ? createJunction(net, pts) : { error: "Draw at least three corners." };
          if ("error" in r) { toast.error(r.error); return; }
          commit(r.net); ui.getValue().tool = "select"; ui.getValue().panel = "inspect";
          if (r.junction.nodes.length) select({ kind: "node", id: r.junction.nodes[0] });
          else { select({ kind: "junction", id: r.junction.id }); toast.info("Junction on its own", { description: "No roads reach it yet: draw roads to it (or across it) and they join it." }); }
        });
      } else if (nd && pts.length >= 3 && (p.kind === "hatch" || p.kind === "island")) commit(ops.addPaint(net, nd.id, p.kind, pts.map(q => ({ x: q.x - nd.x, y: q.y - nd.y }))));
      markDirty();
    }
    const onLeave = () => { cursorWorld = null; hover = null; ui.getValue().cursor.inside = false; markDirty(); };
    const noMenu = (e: MouseEvent) => e.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDbl);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("contextmenu", noMenu);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);

    // ------------------------------------------------------------ render loop
    let raf = 0, lastTool = u.tool;
    const frame = () => {
      if (u.tool !== lastTool) { if (u.tool !== "road") pending = null; lastTool = u.tool; }
      const moved = u.view === "2d" ? simController.advance() : false;
      if (u.view === "2d" && (dirty || moved || u.sim.running || geoVersion !== simController.version)) {
        ensureGeo();
        let draftOv: Overlay["draft"] = null;
        if (u.tool === "road" && pending && cursorWorld) {
          const sc = toScreen(cam, cursorWorld.x, cursorWorld.y);
          const s = snapAt(sc.x, sc.y, pending.p);
          const dx = s.p.x - pending.p.x, dy = s.p.y - pending.p.y;
          const len = Math.hypot(dx, dy);
          const bearing = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
          draftOv = { from: pending.p, to: s.p, lanes: u.draft.lanesF + u.draft.lanesB, label: `${len.toFixed(1)} m · ${bearing.toFixed(0)}°` };
          // curved mode: preview the bend the next click will make (same tangent rule as ops.smoothAt)
          const prev = u.draft.curved && pending.nodeId ? ops.linksAt(net, pending.nodeId) : [];
          if (prev.length === 1 && len > 0.5) {
            const P = ops.nodeById(net, prev[0].from === pending.nodeId ? prev[0].to : prev[0].from);
            if (P) {
              const t = ops.smoothTangent(P, pending.p, s.p);
              draftOv.c1 = { x: pending.p.x + (t.x * len) / 3, y: pending.p.y + (t.y * len) / 3 };
              draftOv.c2 = { x: s.p.x + (pending.p.x - s.p.x) / 3, y: s.p.y + (pending.p.y - s.p.y) / 3 };
            }
          }
        }
        const drawT0 = performance.now();
        drawScene(ctx, cam, pal, geo!, paths!, net, simController.compiled, simController.sim, {
          selection: u.selection, hover, showNodes: u.tool !== "pan", draft: draftOv,
          pendingPoint: u.tool === "road" && pending ? pending.p : null,
          reservations: u.display.reservations, bySpeed: u.display.bySpeed, labels: u.display.labels, junctions: u.display.junctions,
          snapStep: u.snap.step, gridOn: u.snap.grid,
          underlay: ul ? { u: ul, img: ulImg, editing: u.tool === "image" && !u.calib.active, hover: ulHover } : null,
          calib: u.calib.active ? { a: u.calib.a, b: u.calib.b, cursor: cursorWorld } : null,
          buildings: u.display.buildings,
          satellite: u.display.satellite, satBrightness: u.display.satBrightness, satSource: u.display.satSource, onTile: markDirty, connectors: u.display.connectors, highlight: highlightedLayers(u.layers), show: u.layers, maskRoads: u.display.maskRoads, trace: traceFor(u.trace),
          focusNodes: focusNodes(),
          box: drag?.mode === "box" ? { a: drag.a, b: drag.b } : null,
          exitPick: u.pickExit ? (() => {
            const flow = net.flows?.find(f => f.id === u.pickExit);
            if (!flow) return null;
            const ends = ops.entryPoints(net).filter(n => n.id !== flow.from), to = ops.nodeById(net, flow.to);
            return { targets: ends.map(n => ({ x: n.x, y: n.y })), current: to ? { x: to.x, y: to.y } : null };
          })() : null,
          markersSel: selectedAll(u).filter(x => x.kind === "marker").map(x => x.id),
          group: u.extra.length ? (() => {
            const c = simController.compiled, ex = u.extra;
            return {
              links: ex.filter(x => x.kind === "link").map(x => x.id),
              nodes: ex.flatMap(x => { const n = x.kind === "node" ? ops.nodeById(net, x.id) : null; return n ? [{ x: n.x, y: n.y }] : []; }),
              stops: ex.flatMap(x => { const st = x.kind === "stop" ? geo?.stops.find(q => q.id === x.id) : null; return st ? [st.p] : []; }),
              buildings: ex.flatMap(x => { const bd = x.kind === "building" ? net.buildings?.find(q => q.id === x.id) : null; return bd ? [bd.pts] : []; }),
              connectors: ex.flatMap(x => { const v = x.kind === "connector" ? connectorsOf(c).find(q => connectorId(q) === x.id) : null; return v ? [v.pts] : []; }),
            };
          })() : null,
          // (the junction being edited, zoomed in: its lanes' ends, where a connector can be started)
          laneEnds: lanesAimable() ? focusNodes().filter(i => !(simController.compiled.nodes[i].ringR > 0)).flatMap(i => simController.compiled.nodes[i].arms.flatMap(a => a.inEdge?.lanes.map(lp => laneEndGrip(a.inEdge!, lp)) ?? [])) : [],
          connectPick: (() => {
            if (drag?.mode === "connEnd") {
              const t = connEndTargets(drag.id, drag.which);
              if (!t) return null;
              // (the same snapping as when it is dropped)
              const cw = cursorWorld, snap = cw ? t.list.map(x => ({ x, d: Math.hypot(x.p.x - cw.x, x.p.y - cw.y) })).filter(x => x.d < Math.max(LW, pxToM(14))).sort((a, b) => a.d - b.d)[0]?.x.p ?? null : null;
              return { from: t.fixed, targets: t.list.map(x => x.lp.poly.pts), ends: t.list.map(x => x.p), snap, cursor: cursorWorld };
            }
            const cf = u.connectFrom, ts = cf ? connectTargets(cf) : null;
            if (!cf || !ts) return null;
            const [lid, dir, ln] = cf.split("|"), lp = simController.compiled.edgeByKey.get(`${lid}:${dir}`)!.lanes[Number(ln)];
            const cw = cursorWorld, over = cw ? connectTargetAt(cf, cw) : null;
            return { from: lp.poly.at(lp.len), targets: ts.map(t => t.lp.poly.pts), ends: ts.map(t => t.lp.poly.at(0)), snap: over ? over.lp.poly.at(0) : null, cursor: cursorWorld };
          })(),
          shape: (() => {
            const sh = u.shape, on = sh.edit ? ops.nodeById(net, sh.edit) : null;
            const rc = sh.paint?.kind === "roundabout" ? sh.paint.pts[0] : null, kerb = rc && cursorWorld ? Math.hypot(cursorWorld.x - rc.x, cursorWorld.y - rc.y) : 0;
            const ring = rc && kerb >= 3 ? { c: rc, kerb, island: Math.max(0, islandRadius(kerb, kerb >= TWO_LANES_FROM ? 2 : 1)), join: sh.paint?.node === "ring" ? kerb : joinRadius(kerb), lanes: kerb >= TWO_LANES_FROM ? 2 : 1 } : null;
            return { outline: on?.outline ? on.outline.map(p => ({ ...p, x: on.x + p.x, y: on.y + p.y })) : null, paint: sh.paint?.pts ?? null, paintKind: sh.paint?.kind ?? null,
              point: sh.edit ? sh.point ?? null : null, pointHover: sh.edit && cursorWorld ? (() => { const q = toScreen(cam, cursorWorld!.x, cursorWorld!.y); return hitOutlinePoint(q.x, q.y); })() : -1, cursor: cursorWorld, ring,
              closable: sh.paint?.kind === "junction" && sh.paint.pts.length >= 3 && !!cursorWorld && (() => { const f = toScreen(cam, sh.paint!.pts[0].x, sh.paint!.pts[0].y), q = toScreen(cam, cursorWorld!.x, cursorWorld!.y); return Math.hypot(f.x - q.x, f.y - q.y) <= CLOSE_PX; })() };
          })(),
          ringSel: (() => {
            const sel = u.selection, r = sel?.kind === "ring" ? ringById(net, sel.id) : sel?.kind === "node" ? ringOfNode(net, sel.id) : null;
            if (!r) return null;
            return { c: { x: r.x, y: r.y }, pts: ringPoints(net, r).map(p => { const n = ops.nodeById(net, p.id)!; return { x: n.x, y: n.y, id: p.id }; }), picked: sel?.kind === "node" ? sel.id : null };
          })(),
          jgroup: (() => {
            // (a junction on its own, selected: its outline)
            if (u.selection?.kind === "junction") { const sid = u.selection.id, j = net.junctions?.find(x => x.id === sid); return j?.outline ? { hull: j.outline, ports: [], inside: false } : null; }
            const id = u.selection?.kind === "group" ? u.selection.id : u.groupEdit, g = id ? groupById(net, id) : null;
            return g ? { hull: groupHull(net, g, 4), ports: groupPorts(net, g), inside: u.groupEdit === g.id } : null;
          })(),
          ghost: (() => {
            const piece = placingPiece();
            if (!piece || !cursorWorld) return null;
            const at = gridSnap(cursorWorld), turn = u.placing!.turn, byId = new Map(piece.net.nodes.map(n => [n.id, n])), lines: number[][] = [], pts: Vec[] = [];
            for (const l of piece.net.links) {
              const A = byId.get(l.from), B = byId.get(l.to);
              if (!A || !B) continue;
              const line: number[] = [];
              for (let k = 0; k <= 12; k++) { const q = placePoint(ops.linkPoint(l, A, B, k / 12), at, turn); line.push(q.x, q.y); pts.push(q); }
              lines.push(line);
            }
            return { lines, hull: hull(pts, 4) };
          })(),
          alsoSelected: u.selection?.kind !== "link" ? [] : u.multi.length ? u.multi : u.tool === "segment" && u.segScope === "road" ? ops.chainLinks(net, u.selection.id).map(c => c.id).slice(1) : [],
        });
        noteDraw(performance.now() - drawT0);
        viewport.cx = cam.cx; viewport.cy = cam.cy; viewport.wm = cam.w / cam.scale; viewport.hm = cam.h / cam.scale; viewport.planId = u.planId;
        if (fitted === u.planId) rememberView();
        scaleBar(cam);
        dirty = false;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    function scaleBar(c: Camera) {
      const el = wrap.querySelector<HTMLElement>("[data-scalebar]");
      if (!el) return;
      const target = 110 / c.scale;
      const nice = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find(v => v >= target * 0.6) ?? 5000;
      el.style.width = `${nice * c.scale}px`;
      el.dataset.label = nice >= 1000 ? `${nice / 1000} km` : `${nice} m`;
      const lab = el.querySelector("span"); if (lab) lab.textContent = el.dataset.label;
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      subs.forEach(s => s.unsubscribe());
      mq.removeEventListener("change", onScheme);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDbl);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("contextmenu", noMenu);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    };
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="block touch-none select-none" aria-label="Street plan editor" />
      {menu && (
        <div role="menu" className="absolute z-20 min-w-48 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md" style={{ left: menu.x, top: menu.y }}>
          <a
            role="menuitem" target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-sm px-2 py-1.5 hover:bg-accent"
            href={`https://www.google.com/maps/search/?api=1&query=${menu.lat.toFixed(6)},${menu.lon.toFixed(6)}`}
            onClick={() => setMenu(null)}
          >
            <MapPin className="size-4" /> Open in Google Maps
          </a>
          <div className="px-2 pb-1 font-mono text-[11px] text-muted-foreground tabular">{menu.lat.toFixed(6)}, {menu.lon.toFixed(6)}</div>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 flex flex-col gap-1">
        <div data-scalebar className="h-1.5 border-x-2 border-b-2 border-foreground/70" style={{ width: 100 }}>
          <span className="relative -top-4 text-[11px] font-medium text-foreground/80 tabular">100 m</span>
        </div>
      </div>
    </div>
  );
}
