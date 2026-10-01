"use client";

import { useEffect, useRef, useState } from "react";
import { MapPin } from "lucide-react";
import { batch } from "subjecto";
import { buildRoadGeo, type RoadGeo } from "@/render/geometry";
import { buildPaths, connectorsOf, drawScene, toScreen, toWorld, underlayHandles, type Camera, type Overlay, type PathCache, type UnderlayHandle } from "@/render/draw2d";
import { readPalette, type Palette } from "@/render/palette";
import { connShapeKey, connectorHandles, connectorId, linkExtent, LW, type CNode } from "@/engine/compile";
import { pointInPoly } from "@/engine/buildings";
import type { Network, Vec } from "@/engine/types";
import { commit, endGesture, highlightedLayers, network$, select, toggleRoad, setUnderlay, ui, underlay$, type LayerId, type Selection, type UiState } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { noteDraw } from "@/state/perf";
import { changeConnection, connectLanes, lanesArrivingNear, lanesLeavingNear, setConnectorShape } from "@/state/connections";
import { viewCmd$, viewport } from "@/state/commands";
import { underlayImg$ } from "@/state/underlay-image";
import { worldToImage, type Underlay } from "@/lib/underlay";
import { unproject } from "@/lib/osm/area";
import { routeBetween, routeShape } from "@/engine/route";
import * as ops from "@/state/ops";

type Snap = { p: Vec; nodeId?: string; link?: { id: string; t: number } };
type Drag =
  | { mode: "pan"; sx: number; sy: number; cx: number; cy: number; moved: boolean; clickSel: boolean; right?: boolean }
  | { mode: "node"; id: string; moved: boolean; sx: number; sy: number }
  | { mode: "handle"; linkId: string; handle: "c1" | "c2" | "bend"; moved: boolean }
  | { mode: "conn"; id: string; which: "k1" | "k2" }
  | { mode: "connEnd"; id: string; which: "start" | "end" }
  | { mode: "outline"; node: string; idx: number }
  | { mode: "ul-move"; start: Vec; x0: number; y0: number }
  | { mode: "ul-rotate"; a0: number; rot0: number }
  | { mode: "ul-scale"; d0: number; mpp0: number }
  | null;

const HIT_NODE = 10, HIT_HANDLE = 9;

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
    const viewKey = () => `trafficsim:view:${u.planId}`;
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
    /** the nearest lane connector through a junction */
    function hitConnector(p: Vec): string | null {
      let best: string | null = null, bd = Math.max(1.2, pxToM(8));
      for (const c of connectorsOf(simController.compiled)) {
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
     * "all layers" default): points and junctions, bus stops, vehicles, lane connectors (where drawn),
     * roads, lanes (where roads are off), buildings. Zones pick entry points and buildings.
     */
    function pickInLayers(layers: readonly LayerId[], sx: number, sy: number, w: Vec): Selection | null {
      const c = simController.compiled, on = (l: LayerId) => layers.includes(l);
      // (with roads on, every point of the drawing: road ends and joints too)
      const nodeOk = (n: CNode) => (on("junctions") && n.controlled && n.degree >= 2)
        || (on("signals") && n.controlled && n.def.control === "lights") || ((on("entries") || on("zones")) && n.gateway);
      const nodeId = hitNode(sx, sy, undefined, id => { if (on("roads")) return true; const n = c.nodeById.get(id); return !!n && nodeOk(n); });
      if (nodeId) return { kind: "node", id: nodeId };
      if (on("stops")) { const id = hitStop(w); if (id) return { kind: "stop", id }; }
      if (on("vehicles")) { const v = simController.sim?.vehicleNear(w.x, w.y, Math.max(3, pxToM(10))); if (v) return { kind: "vehicle", id: String(v.id) }; }
      // (connectors are only drawn when highlighted or switched on in the display options)
      if (on("connectors") && (u.display.connectors || highlightedLayers(layers).includes("connectors"))) { const id = hitConnector(w); if (id) return { kind: "connector", id }; }
      // (with road surfaces hidden, roads can always be picked: their outline is all there is to click)
      const roadsOn = on("roads") || u.display.maskRoads;
      if (roadsOn || on("counters")) { const l = hitLink(w); if (l && (roadsOn || ops.linkById(net, l.id)?.counter)) return { kind: "link", id: l.id }; }
      if (on("lanes")) { const id = hitLane(w); if (id) return { kind: "lane", id }; }
      if (on("buildings") || on("zones")) { const id = hitBuilding(w); if (id) return { kind: "building", id }; }
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
      const nodeId = hitNode(sx, sy, exclude);
      if (nodeId) { const n = ops.nodeById(net, nodeId)!; return { p: { x: n.x, y: n.y }, nodeId }; }
      const w = toWorld(cam, sx, sy);
      if (from && shift) return { p: angleSnap(from, w) };
      const l = hitLink(w);
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

      // drawing a lane connector: a click on a lane leaving the junction ends it there
      const cf = ui.getValue().connectFrom;
      if (cf) {
        const pick = connectTargets(cf)?.find(t => t.lp.poly.project(w.x, w.y).d < LW * 0.6);
        if (pick) {
          // (stay in picking: more lanes can be clicked; Esc or Done ends it)
          const [lid, dir, ln] = cf.split("|"), r = connectLanes(net, simController.compiled, `${lid}:${dir}`, Number(ln), pick.e.key, pick.lp.lane);
          if (r) commit(r.net);
        }
        markDirty();
        return;
      }
      // junction editor: clicks add points to the painted area being drawn, or pick outline points
      const sh = ui.getValue().shape;
      if (sh.paint) { const pp = sh.paint; sh.paint = { ...pp, pts: [...pp.pts, { x: ops.round(w.x), y: ops.round(w.y) }] }; markDirty(); return; }
      if (sh.edit) {
        const k = hitOutlinePoint(sx, sy);
        if (k >= 0) {
          const nd = ops.nodeById(net, sh.edit)!;
          if (e.altKey) { if (nd.outline!.length > 3) commit(ops.setOutline(net, nd.id, nd.outline!.filter((_, i) => i !== k))); return; }
          drag = { mode: "outline", node: nd.id, idx: k };
          return;
        }
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
        const n2 = link && u.draft.curved ? ops.smoothAt(added, a) : added;
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

      // the selected lane connector's curve handles (any layer)
      const ce = hitConnEnd(sx, sy);
      if (ce) { drag = { mode: "connEnd", id: ce.id, which: ce.which }; return; }
      const ch = hitConnHandle(sx, sy);
      if (ch) { drag = { mode: "conn", id: ch.id, which: ch.which }; return; }
      // select tool: the curve handles of the selected road, then whatever the layers that are on pick
      const h = u.layers.includes("roads") ? hitHandle(sx, sy) : null;
      if (h && u.selection?.kind === "link") { drag = { mode: "handle", linkId: u.selection.id, handle: h, moved: false }; return; }
      const pick = pickInLayers(u.layers, sx, sy, w);
      if (pick) {
        // Shift+click: add the road to the selected roads (or take it out)
        if (pick.kind === "link" && e.shiftKey && u.selection?.kind === "link") toggleRoad(pick.id); else select(pick);
        // junctions and points can be dragged; buildings, lanes and connectors cover so much of the map that a drag from them pans
        if (pick.kind === "node") drag = { mode: "node", id: pick.id, moved: false, sx, sy };
        else if (pick.kind === "building" || pick.kind === "lane" || pick.kind === "connector") drag = { mode: "pan", sx, sy, cx: cam.cx, cy: cam.cy, moved: false, clickSel: false };
        return;
      }
      drag = { mode: "pan", sx, sy, cx: cam.cx, cy: cam.cy, moved: false, clickSel: true };
    }

    function onPointerMove(e: PointerEvent) {
      const { sx, sy } = local(e);
      const w = toWorld(cam, sx, sy);
      cursorWorld = w;
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
        commit(ops.setOutline(net, nd.id, nd.outline.map((q, i) => (i === d.idx ? { x: p.x - nd.x, y: p.y - nd.y } : q))), `outline:${nd.id}`);
        return;
      }
      if (drag?.mode === "connEnd") { markDirty(); return; }
      if (drag?.mode === "conn") {
        const d = drag, v = connectorsOf(simController.compiled).find(x => connectorId(x) === d.id);
        if (!v) return;
        const h = connectorHandles(v.node, v.move, v.inLane, v.outLane);
        const key = connShapeKey(v.move, v.inLane, v.outLane), np = v.node.pos;
        if (e.shiftKey || h.free) {
          // Shift (or already free): the handle goes wherever it is dragged
          const rel = (p: Vec) => ({ x: p.x - np.x, y: p.y - np.y });
          const c1 = d.which === "k1" ? rel(w) : rel(h.h1), c2 = d.which === "k2" ? rel(w) : rel(h.h2);
          commit(setConnectorShape(net, v.node.def.id, key, { c1, c2 }), `conn:${d.id}`);
        } else {
          // each handle slides along its lane's direction (the path stays tangent to both lanes)
          const k = d.which === "k1" ? (w.x - h.P.x) * h.tp.x + (w.y - h.P.y) * h.tp.y : (h.Q.x - w.x) * h.tq.x + (h.Q.y - w.y) * h.tq.y;
          const reach: [number, number] = d.which === "k1" ? [Math.max(0.5, k), h.k2] : [h.k1, Math.max(0.5, k)];
          commit(setConnectorShape(net, v.node.def.id, key, reach), `conn:${d.id}`);
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
      canvas.style.cursor = drag ? "grabbing" : u.calib.active ? "crosshair" : ulCursor ?? (u.tool === "pan" || u.tool === "image" || spaceHeld ? "grab" : u.tool === "road" || u.tool === "stop" ? "crosshair" : hv ? "pointer" : "default");
      markDirty();
    }

    function onPointerUp(e: PointerEvent) {
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
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
      if (drag?.mode === "node" && drag.moved) {
        // dropped onto another node: merge them
        const { sx, sy } = local(e);
        const other = hitNode(sx, sy, drag.id);
        if (other) commit(ops.mergeNodes(net, other, drag.id));
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
      if (e.type === "keydown" && !typing && e.key === "Escape" && ui.getValue().connectFrom) { ui.getValue().connectFrom = null; e.stopPropagation(); markDirty(); return; }
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
      if (sh.paint) { finishPaint(); return; }
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
      if (nd && pts.length >= 3) commit(ops.addPaint(net, nd.id, p.kind, pts.map(q => ({ x: q.x - nd.x, y: q.y - nd.y }))));
      sh.paint = null;
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
          satellite: u.display.satellite, satBrightness: u.display.satBrightness, onTile: markDirty, connectors: u.display.connectors, highlight: highlightedLayers(u.layers), maskRoads: u.display.maskRoads, trace: traceFor(u.trace),
          connectPick: (() => {
            if (drag?.mode === "connEnd") {
              const t = connEndTargets(drag.id, drag.which);
              return t ? { from: t.fixed, targets: t.list.map(x => x.lp.poly.pts), cursor: cursorWorld } : null;
            }
            const cf = u.connectFrom, ts = cf ? connectTargets(cf) : null;
            if (!cf || !ts) return null;
            const [lid, dir, ln] = cf.split("|"), lp = simController.compiled.edgeByKey.get(`${lid}:${dir}`)!.lanes[Number(ln)];
            return { from: lp.poly.at(lp.len), targets: ts.map(t => t.lp.poly.pts), cursor: cursorWorld };
          })(),
          shape: (() => {
            const sh = u.shape, on = sh.edit ? ops.nodeById(net, sh.edit) : null;
            return { outline: on?.outline ? on.outline.map(p => ({ x: on.x + p.x, y: on.y + p.y })) : null, paint: sh.paint?.pts ?? null, cursor: cursorWorld };
          })(),
          alsoSelected: u.selection?.kind !== "link" ? [] : u.multi.length ? u.multi : u.tool === "segment" && u.segScope === "road" ? ops.chainLinks(net, u.selection.id).map(c => c.id).slice(1) : [],
        });
        noteDraw(performance.now() - drawT0);
        viewport.cx = cam.cx; viewport.cy = cam.cy; viewport.wm = cam.w / cam.scale; viewport.hm = cam.h / cam.scale;
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
