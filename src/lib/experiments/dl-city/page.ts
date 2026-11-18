/**
 * The experiment's page (ticket #277): one self-contained HTML file (built by scripts/dl-city-html.ts) with the city
 * generator, the V2 simulation, the neural networks and every recorded run in it. The same script runs as the page and as
 * its Web Workers (from the same text, as a Blob): the page draws the city and the results, the workers simulate designs,
 * play a simulation for the map, cross-validate the networks and run a small search, so the page never stalls.
 * Plain DOM, canvas and SVG; no framework.
 */
import { generateCity, CONTROLS, STREETS, type City } from "./city";
import { baseline, designKey, designSketch, parseKey, randomDesign, stateOf, type Design } from "./design";
import { runDesign, corridorEff, score, type Metrics } from "./evaluate";
import { analyse, crossValidate, type RunRecord } from "./analysis";
import { dlPropose, gaPropose, type Tried } from "./search";
import { SketchSim } from "../../lane-sketch-sim";
import { connectorPts, samples, type Sketch } from "../../lane-sketch";
import { rng } from "./city";

interface PageData { runs: RunRecord[]; city: number; built: string; commit: string }
type Pose = { p: { x: number; y: number }; d: { x: number; y: number }; share: number };

// ------------------------------------------------------------------ the worker side

function workerMain() {
  const ctx = self as unknown as { onmessage: (e: MessageEvent) => void; postMessage: (m: unknown, t?: Transferable[]) => void };
  let city: City | null = null, watching = 0;
  ctx.onmessage = (e: MessageEvent) => {
    const msg = e.data as { type: string; id: number; city: number; [k: string]: unknown };
    city = city && city.seed === msg.city ? city : generateCity(msg.city ?? 1);
    try {
      if (msg.type === "run") {
        const m = runDesign(city, parseKey(msg.key as string), { seed: msg.seed as number, warmupMin: msg.warmupMin as number, measureMin: msg.measureMin as number }, f => ctx.postMessage({ id: msg.id, progress: f }));
        ctx.postMessage({ id: msg.id, done: m });
      } else if (msg.type === "cv") {
        const a = analyse(msg.runs as RunRecord[]);
        const cv = crossValidate(city, a, 5, { onFold: k => ctx.postMessage({ id: msg.id, progress: k / 5 }) });
        ctx.postMessage({ id: msg.id, done: { keys: a.designs.map(d => d.key), ...cv } });
      } else if (msg.type === "dl") {
        const R = rng(msg.seed as number), tried = (msg.tried as { key: string; m: Metrics; score: number }[]).map(t => ({ ...t, d: parseKey(t.key) }));
        const { proposals } = dlPropose(city, tried, msg.base as Metrics, msg.n as number, R, { kappa: msg.kappa as number });
        ctx.postMessage({ id: msg.id, done: proposals.map(p => ({ key: designKey(p.d), pred: p.pred, sd: p.sd })) });
      } else if (msg.type === "watch") {
        const me = ++watching, b = designSketch(city, parseKey(msg.key as string), { seed: msg.seed as number, warmupMin: 0 });
        const sim = new SketchSim(b.sketch, { rate: 0, speed: 50, seed: msg.seed as number }, msg.seed as number);
        const nr: unknown[] = []; nr.push = () => 0; (sim as unknown as { replay: unknown[] }).replay = nr;
        let speed = msg.speed as number, last = performance.now();
        const tick = () => {
          if (me !== watching) return;
          const now = performance.now(), want = Math.min(2, ((now - last) / 1000) * speed);
          last = now;
          const t0 = sim.t;
          while (sim.t < t0 + want - 1e-9 && performance.now() - now < 40) sim.step(0.1);
          const poses = sim.poses() as Pose[], buf = new Float32Array(poses.length * 5);
          poses.forEach((q, i) => { buf.set([q.p.x, q.p.y, q.d.x, q.d.y, q.share], i * 5); });
          const st = sim.stats();
          ctx.postMessage({ id: msg.id, frame: buf, t: sim.t, vehicles: st.vehicles, meanSpeed: st.meanSpeed, stuck: st.stuck }, [buf.buffer]);
          setTimeout(tick, 16);
        };
        (self as unknown as { onspeed?: (s: number) => void }).onspeed = s => (speed = s);
        tick();
      } else if (msg.type === "speed") {
        (self as unknown as { onspeed?: (s: number) => void }).onspeed?.(msg.speed as number);
      } else if (msg.type === "stop") {
        watching++;
      }
    } catch (err) {
      ctx.postMessage({ id: msg.id, error: String((err as Error)?.stack ?? err) });
    }
  };
}

/** a pool of workers made from this very script */
class Pool {
  private free: Worker[] = [];
  private queue: { msg: Record<string, unknown>; resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (f: number) => void }[] = [];
  private nextId = 1;
  all: Worker[] = [];
  constructor(private url: string, n: number) { for (let k = 0; k < n; k++) { const w = new Worker(url); this.all.push(w); this.free.push(w); } }
  run<T>(msg: Record<string, unknown>, progress?: (f: number) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => { this.queue.push({ msg, resolve: resolve as (v: unknown) => void, reject, progress }); this.pump(); });
  }
  private pump() {
    while (this.free.length && this.queue.length) {
      const w = this.free.pop()!, job = this.queue.shift()!, id = this.nextId++;
      w.onmessage = (e: MessageEvent) => {
        const d = e.data as { id: number; progress?: number; done?: unknown; error?: string };
        if (d.id !== id) return;
        if (d.progress !== undefined) { job.progress?.(d.progress); return; }
        this.free.push(w);
        if (d.error) job.reject(new Error(d.error)); else job.resolve(d.done);
        this.pump();
      };
      w.postMessage({ ...job.msg, id });
    }
  }
  cancel() { this.queue = []; for (const w of this.all) w.terminate(); this.all = []; this.free = []; }
}

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of kids) e.append(typeof c === "string" ? document.createTextNode(c) : c);
  return e;
}
const SVG = "http://www.w3.org/2000/svg";
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pct = (r: number) => `${r < 1 ? "−" : "+"}${Math.abs((r - 1) * 100).toFixed(1)}%`;
const fmt = (v: number, d = 0) => v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });
const METHOD_LABEL: Record<string, string> = { baseline: "Status quo", init: "Random start (shared)", ga: "Genetic algorithm (simulation only)", dl: "Neural-network surrogate" };
const SERIES: Record<string, string> = { ga: "--series-1", dl: "--series-2", init: "--series-3" };

/** what a design changes from the status quo, in words */
function describe(city: City, d: Design): string[] {
  const b = baseline(city), out: string[] = [];
  out.push(`Four lanes: ${d.four.map(k => STREETS[k].name).join(" and ")}${designKey(d) === designKey(b) ? " (as now)" : ""}`);
  const st = stateOf(city, d), counts = [0, 0, 0, 0];
  for (const v of st.values()) counts[v]++;
  if (counts[3]) out.push(`${counts[3]} street${counts[3] > 1 ? "s" : ""} in the centre closed to cars`);
  if (counts[1] + counts[2]) out.push(`${counts[1] + counts[2]} made one-way`);
  const mc = city.links.filter(l => l.street === "mainC" && st.get(l.id) === 3).length, mo = city.links.filter(l => l.street === "mainC" && (st.get(l.id) === 1 || st.get(l.id) === 2)).length;
  if (mc) out.push(`Strada Mare (the main road through the centre) closed on ${mc} of its blocks`);
  else if (mo) out.push(`Strada Mare one-way on ${mo} of its blocks`);
  city.keys.forEach((k, i) => { if (d.control[i] !== b.control[i]) out.push(`${k.name}: ${CONTROLS[d.control[i]]} (was ${CONTROLS[b.control[i]]})`); });
  return out;
}

// ------------------------------------------------------------------ the map
class CityMap {
  canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  sketch: Sketch | null = null; design: Design | null = null;
  private view = { cx: 0, cy: 0, scale: 0.3 };
  private lanePaths: { path: Path2D; width: number; four: boolean }[] = [];
  private connPaths: Path2D | null = null;
  private roadPts: { x: number; y: number; road: string }[] = [];
  cars: Float32Array | null = null;
  tip: HTMLElement;
  constructor(private host: HTMLElement, private city: City) {
    this.canvas = el("canvas", { role: "img", "aria-label": "Map of the city and the design shown" });
    this.ctx = this.canvas.getContext("2d")!;
    this.tip = el("div", { class: "tip", role: "status" });
    host.append(this.canvas, this.tip);
    new ResizeObserver(() => this.resize()).observe(host);
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => this.draw());
    let drag: { x: number; y: number; cx: number; cy: number } | null = null;
    this.canvas.addEventListener("pointerdown", e => { drag = { x: e.clientX, y: e.clientY, cx: this.view.cx, cy: this.view.cy }; this.canvas.setPointerCapture(e.pointerId); });
    this.canvas.addEventListener("pointerup", () => (drag = null));
    this.canvas.addEventListener("pointermove", e => {
      if (drag) { this.view.cx = drag.cx - (e.clientX - drag.x) / this.view.scale; this.view.cy = drag.cy - (e.clientY - drag.y) / this.view.scale; this.draw(); return; }
      this.hover(e);
    });
    this.canvas.addEventListener("pointerleave", () => (this.tip.hidden = true));
    this.canvas.addEventListener("wheel", e => {
      e.preventDefault();
      const r = this.canvas.getBoundingClientRect(), w = this.toWorld(e.clientX - r.left, e.clientY - r.top), k = Math.exp(-e.deltaY * 0.0015);
      this.view.scale = Math.min(6, Math.max(0.08, this.view.scale * k));
      const w2 = this.toWorld(e.clientX - r.left, e.clientY - r.top);
      this.view.cx += w.x - w2.x; this.view.cy += w.y - w2.y;
      this.draw();
    }, { passive: false });
  }
  private toWorld(px: number, py: number) { const W = this.canvas.clientWidth, H = this.canvas.clientHeight; return { x: this.view.cx + (px - W / 2) / this.view.scale, y: this.view.cy + (py - H / 2) / this.view.scale }; }
  resize() {
    const dpr = devicePixelRatio || 1, W = this.host.clientWidth, H = Math.max(420, Math.min(720, W * 0.75));
    this.canvas.style.width = `${W}px`; this.canvas.style.height = `${H}px`;
    this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
    this.fit(); this.draw();
  }
  fit() {
    if (!this.sketch) return;
    const xs = this.city.nodes.map(n => n.x), ys = this.city.nodes.map(n => n.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    this.view = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale: Math.min(this.canvas.clientWidth / (x1 - x0 + 80), this.canvas.clientHeight / (y1 - y0 + 80)) };
  }
  show(d: Design) {
    const first = !this.sketch;
    this.design = d;
    this.sketch = designSketch(this.city, d).sketch;
    const four = new Set<string>(d.four.map(k => STREETS[k].name)), fourLanes = new Set(this.sketch.roads.filter(r => four.has(r.name)).flatMap(r => r.lanes));
    this.lanePaths = this.sketch.lanes.map(l => { const p = new Path2D(), pts = samples(l.shape, 4); pts.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y))); return { path: p, width: l.width, four: fourLanes.has(l.id) }; });
    const cp = new Path2D();
    for (const c of this.sketch.connectors) { const pts = connectorPts(this.sketch, c); if (pts) pts.forEach((q, i) => (i ? cp.lineTo(q.x, q.y) : cp.moveTo(q.x, q.y))); }
    this.connPaths = cp;
    this.roadPts = [];
    for (const r of this.sketch.roads) { const l = this.sketch.lanes.find(x => x.id === r.lanes[0]); if (l) for (const q of samples(l.shape, 10)) this.roadPts.push({ x: q.x, y: q.y, road: r.id }); }
    if (first) this.fit();
    this.draw();
  }
  private hover(e: PointerEvent) {
    if (!this.sketch || !this.design) return;
    const r = this.canvas.getBoundingClientRect(), w = this.toWorld(e.clientX - r.left, e.clientY - r.top), lim = 14 / this.view.scale;
    let best: { d: number; road: string } | null = null;
    for (const q of this.roadPts) { const d = Math.hypot(q.x - w.x, q.y - w.y); if (d < lim && (!best || d < best.d)) best = { d, road: q.road }; }
    // (closed streets are no road of the sketch: the city's links)
    const st = stateOf(this.city, this.design);
    let closed: string | null = null;
    if (!best) for (const l of this.city.links) {
      if (st.get(l.id) !== 3) continue;
      const A = this.city.nodes[l.a], B = this.city.nodes[l.b], t = Math.max(0, Math.min(1, ((w.x - A.x) * (B.x - A.x) + (w.y - A.y) * (B.y - A.y)) / ((B.x - A.x) ** 2 + (B.y - A.y) ** 2)));
      if (Math.hypot(A.x + t * (B.x - A.x) - w.x, A.y + t * (B.y - A.y) - w.y) < lim) { closed = l.name; break; }
    }
    if (!best && !closed) { this.tip.hidden = true; return; }
    this.tip.replaceChildren();
    if (best) {
      const road = this.sketch.roads.find(x => x.id === best!.road)!;
      const lanes = road.lanes.length, oneWay = !road.align || road.align.lanes.every(x => !x.reverse);
      this.tip.append(el("strong", {}, road.name), el("br"), `${lanes} lane${lanes > 1 ? "s" : ""}${oneWay ? ", one-way" : ""}`);
    } else this.tip.append(el("strong", {}, closed!), el("br"), "closed to cars");
    this.tip.hidden = false;
    this.tip.style.left = `${e.clientX - r.left + 14}px`; this.tip.style.top = `${e.clientY - r.top + 14}px`;
  }
  draw() {
    const c = this.ctx, dpr = devicePixelRatio || 1, W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = css("--surface-1"); c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.sketch || !this.design) return;
    const s = this.view.scale * dpr;
    c.setTransform(s, 0, 0, s, (W / 2 - this.view.cx * this.view.scale) * dpr, (H / 2 - this.view.cy * this.view.scale) * dpr);
    const px = 1 / s;
    // the centre (inside the ring)
    c.beginPath(); this.city.centre.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath();
    c.fillStyle = css("--centre-fill"); c.fill();
    c.lineCap = "round"; c.lineJoin = "round";
    // the four-lane streets' halo, then every lane, then the connectors through junctions
    c.strokeStyle = css("--four-halo");
    for (const l of this.lanePaths) if (l.four) { c.lineWidth = Math.max(l.width * 2.4, 5 * px); c.stroke(l.path); }
    c.strokeStyle = css("--road");
    for (const l of this.lanePaths) { c.lineWidth = Math.max(l.width * 0.8, 1.2 * px); c.stroke(l.path); }
    if (this.connPaths) { c.lineWidth = Math.max(1.6, 0.8 * px); c.strokeStyle = css("--road-conn"); c.stroke(this.connPaths); }
    // what the design changed in the centre: closed (dashed), one-way (arrows)
    const st = stateOf(this.city, this.design);
    for (const l of this.city.links) {
      const v = st.get(l.id) ?? 0;
      if (!v) continue;
      const A = this.city.nodes[l.a], B = this.city.nodes[l.b];
      if (v === 3) {
        c.save(); c.setLineDash([6 * px, 5 * px]); c.lineWidth = 3 * px; c.strokeStyle = css("--critical");
        c.beginPath(); c.moveTo(A.x, A.y); c.lineTo(B.x, B.y); c.stroke(); c.restore();
      } else {
        const [P, Q] = v === 1 ? [A, B] : [B, A], mx = (P.x + Q.x) / 2, my = (P.y + Q.y) / 2, L = Math.hypot(Q.x - P.x, Q.y - P.y), ux = (Q.x - P.x) / L, uy = (Q.y - P.y) / L, a = 9 * px;
        c.fillStyle = css("--text-primary");
        c.beginPath(); c.moveTo(mx + ux * a, my + uy * a); c.lineTo(mx - ux * a - uy * a * 0.7, my - uy * a + ux * a * 0.7); c.lineTo(mx - ux * a + uy * a * 0.7, my - uy * a - ux * a * 0.7); c.closePath(); c.fill();
      }
    }
    // junction control at the key junctions (lights: a square; roundabouts are drawn as their ring)
    this.city.keys.forEach((k, i) => {
      const n = this.city.nodes[k.node], ctl = CONTROLS[this.design!.control[i]];
      if (ctl === "lights") { const r = 7 * px; c.fillStyle = css("--text-primary"); c.fillRect(n.x - r, n.y - r, 2 * r, 2 * r); c.fillStyle = css("--surface-1"); c.beginPath(); c.arc(n.x, n.y, r * 0.45, 0, 7); c.fill(); }
      if (ctl === "roundabout") { c.lineWidth = 2.5 * px; c.strokeStyle = css("--text-primary"); c.beginPath(); c.arc(n.x, n.y, 18, 0, 7); c.stroke(); }
    });
    // cars, while a simulation plays
    if (this.cars) {
      const f = this.cars, fast = css("--car"), slow = css("--critical");
      for (let i = 0; i < f.length; i += 5) {
        const x = f[i], y = f[i + 1], dx = f[i + 2], dy = f[i + 3], sh = f[i + 4];
        c.fillStyle = sh < 0.2 ? slow : fast;
        // (as long as a car, but never smaller than a few pixels)
        const L = Math.max(5.2, 5 * px), Wd = Math.max(2.2, 3 * px);
        c.save(); c.translate(x, y); c.rotate(Math.atan2(dy, dx)); c.fillRect(-L / 2, -Wd / 2, L, Wd); c.restore();
      }
    }
  }
}

// ------------------------------------------------------------------ charts (SVG, by hand)
interface Pt { x: number; y: number; key?: string; series: string; label?: string }
function axes(svg: SVGSVGElement, W: number, H: number, m: { l: number; r: number; t: number; b: number }, xd: [number, number], yd: [number, number], xl: string, yl: string, fmtX = (v: number) => fmt(v), fmtY = (v: number) => fmt(v, 2)) {
  const X = (v: number) => m.l + ((v - xd[0]) / (xd[1] - xd[0])) * (W - m.l - m.r), Y = (v: number) => H - m.b - ((v - yd[0]) / (yd[1] - yd[0])) * (H - m.t - m.b);
  const ticks = (d: [number, number], n: number) => { const step = niceStep((d[1] - d[0]) / n), o: number[] = []; for (let v = Math.ceil(d[0] / step) * step; v <= d[1] + 1e-9; v += step) o.push(+v.toFixed(10)); return o; };
  const g = sv("g", { class: "axes" });
  for (const v of ticks(yd, 5)) { g.append(sv("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: "grid" })); const t = sv("text", { x: m.l - 6, y: Y(v) + 4, "text-anchor": "end", class: "tick" }); t.textContent = fmtY(v); g.append(t); }
  for (const v of ticks(xd, 6)) { const t = sv("text", { x: X(v), y: H - m.b + 16, "text-anchor": "middle", class: "tick" }); t.textContent = fmtX(v); g.append(t); }
  g.append(sv("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: "baseline" }));
  const tx = sv("text", { x: (m.l + W - m.r) / 2, y: H - 4, "text-anchor": "middle", class: "axis-label" }); tx.textContent = xl;
  const ty = sv("text", { x: 12, y: m.t - 20, class: "axis-label" }); ty.textContent = yl;
  g.append(tx, ty);
  svg.append(g);
  return { X, Y };
}
function niceStep(raw: number) { const p = 10 ** Math.floor(Math.log10(raw)), f = raw / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }
function legend(items: { label: string; color: string; kind: "line" | "dot" | "diamond" | "dash" }[]) {
  const ul = el("ul", { class: "legend" });
  for (const it of items) {
    const key = sv("svg", { width: 18, height: 12, "aria-hidden": "true" });
    if (it.kind === "line") key.append(sv("line", { x1: 1, x2: 17, y1: 6, y2: 6, stroke: it.color, "stroke-width": 2, "stroke-linecap": "round" }));
    else if (it.kind === "dash") key.append(sv("line", { x1: 1, x2: 17, y1: 6, y2: 6, stroke: it.color, "stroke-width": 1.5, "stroke-dasharray": "3 3" }));
    else if (it.kind === "diamond") key.append(sv("path", { d: "M9 1 L14 6 L9 11 L4 6 Z", fill: it.color }));
    else key.append(sv("circle", { cx: 9, cy: 6, r: 4, fill: it.color }));
    ul.append(el("li", {}, key, it.label));
  }
  return ul;
}

/** a step chart of the best score so far, one line per search, with a crosshair tooltip */
function convergenceChart(host: HTMLElement, curves: Record<string, { runs: number; best: number }[]>, startRuns: number) {
  host.replaceChildren();
  const W = Math.max(320, host.clientWidth), H = 300, m = { l: 52, r: 16, t: 40, b: 38 };
  const all = Object.values(curves).flat(), xd: [number, number] = [0, Math.max(...all.map(p => p.runs))];
  const lo = Math.min(...all.map(p => p.best)), yd: [number, number] = [Math.floor((lo - 0.02) * 20) / 20, 1.02];
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": "Best score so far against simulator runs, per search" });
  const { X, Y } = axes(svg, W, H, m, xd, yd, "simulator runs", "best score so far (status quo = 1, lower is better)", v => fmt(v), v => fmt(v, 2));
  svg.append(sv("line", { x1: X(startRuns), x2: X(startRuns), y1: m.t, y2: H - m.b, class: "marker-line" }));
  const lab = sv("text", { x: X(startRuns) + 4, y: m.t + 12, class: "tick" }); lab.textContent = "the searches part"; svg.append(lab);
  const ends: number[] = [];
  for (const [k, pts] of Object.entries(curves)) {
    let d = "";
    pts.forEach((p, i) => { d += i ? ` H${X(p.runs)} V${Y(p.best)}` : `M${X(0)} ${Y(p.best)} H${X(p.runs)}`; });
    svg.append(sv("path", { d, fill: "none", stroke: `var(${SERIES[k]})`, "stroke-width": 2, "stroke-linejoin": "round" }));
    // (the end labels apart when the lines end close together)
    const last = pts[pts.length - 1];
    let y = Y(last.best) - 6;
    while (ends.some(e => Math.abs(e - y) < 14)) y += 16;
    ends.push(y);
    const t = sv("text", { x: X(last.runs) - 4, y, "text-anchor": "end", class: "direct" }); t.textContent = `${k === "ga" ? "GA" : "DL"} ${fmt(last.best, 3)}`; svg.append(t);
  }
  const cross = sv("line", { y1: m.t, y2: H - m.b, class: "crosshair", visibility: "hidden" });
  svg.append(cross);
  const tip = el("div", { class: "tip", hidden: "" });
  svg.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W, runs = xd[0] + ((x - m.l) / (W - m.l - m.r)) * (xd[1] - xd[0]);
    if (runs < 0 || runs > xd[1]) { cross.setAttribute("visibility", "hidden"); tip.hidden = true; return; }
    cross.setAttribute("x1", String(X(runs))); cross.setAttribute("x2", String(X(runs))); cross.setAttribute("visibility", "visible");
    tip.replaceChildren(el("div", { class: "tip-head" }, `after ${fmt(runs)} runs`));
    for (const [k, pts] of Object.entries(curves)) { const p = [...pts].reverse().find(q => q.runs <= runs) ?? pts[0]; tip.append(el("div", { class: "tip-row" }, el("span", { class: "key", style: `background:var(${SERIES[k]})` }), el("strong", {}, fmt(p.best, 3)), ` ${k === "ga" ? "genetic algorithm" : "NN surrogate"}`)); }
    tip.hidden = false; tip.style.left = `${e.clientX - host.getBoundingClientRect().left + 12}px`; tip.style.top = `${e.clientY - host.getBoundingClientRect().top - 10}px`;
  });
  svg.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; });
  host.append(legend(Object.keys(curves).map(k => ({ label: METHOD_LABEL[k], color: `var(${SERIES[k]})`, kind: "line" as const }))), svg, tip);
}

/** a scatter of designs, nearest-point tooltip, click to pick */
function scatterChart(host: HTMLElement, pts: Pt[], o: { xl: string; yl: string; series: string[]; front?: Pt[]; diag?: boolean; onPick?: (key: string) => void; fmt?: (v: number) => string; tipText?: (p: Pt) => (Node | string)[] }) {
  host.replaceChildren();
  const W = Math.max(320, host.clientWidth), H = 340, m = { l: 52, r: 16, t: 40, b: 40 };
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y), pad = (a: number, b: number) => (b - a) * 0.06 || 0.05;
  let xd: [number, number] = [Math.min(...xs), Math.max(...xs)], yd: [number, number] = [Math.min(...ys), Math.max(...ys)];
  if (o.diag) { const lo = Math.min(xd[0], yd[0]), hi = Math.max(xd[1], yd[1]); xd = [lo, hi]; yd = [lo, hi]; }
  xd = [xd[0] - pad(...xd), xd[1] + pad(...xd)]; yd = [yd[0] - pad(...yd), yd[1] + pad(...yd)];
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${o.yl} against ${o.xl}` });
  const f = o.fmt ?? (v => fmt(v, 2));
  const { X, Y } = axes(svg, W, H, m, xd, yd, o.xl, o.yl, f, f);
  if (o.diag) svg.append(sv("line", { x1: X(xd[0]), y1: Y(xd[0]), x2: X(xd[1]), y2: Y(xd[1]), class: "marker-line" }));
  if (o.front?.length) { const fr = [...o.front].sort((a, b) => a.x - b.x); svg.append(sv("path", { d: fr.map((p, i) => `${i ? "L" : "M"}${X(p.x)} ${Y(p.y)}`).join(" "), class: "front" })); }
  for (const s of o.series) for (const p of pts.filter(q => q.series === s)) {
    if (s === "baseline") { const cx = X(p.x), cy = Y(p.y); svg.append(sv("path", { d: `M${cx} ${cy - 7} L${cx + 7} ${cy} L${cx} ${cy + 7} L${cx - 7} ${cy} Z`, class: "baseline-mark" })); const t = sv("text", { x: cx + 10, y: cy - 8, class: "direct" }); t.textContent = "status quo"; svg.append(t); continue; }
    svg.append(sv("circle", { cx: X(p.x), cy: Y(p.y), r: 4, fill: `var(${SERIES[s]})`, class: "dot" }));
  }
  const ring = sv("circle", { r: 8, class: "hover-ring", visibility: "hidden" });
  svg.append(ring);
  const tip = el("div", { class: "tip", hidden: "" });
  let near: Pt | null = null;
  svg.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    near = null; let bd = 24;
    for (const p of pts) { const d = Math.hypot(X(p.x) - x, Y(p.y) - y); if (d < bd) { bd = d; near = p; } }
    if (!near) { ring.setAttribute("visibility", "hidden"); tip.hidden = true; svg.style.cursor = ""; return; }
    ring.setAttribute("cx", String(X(near.x))); ring.setAttribute("cy", String(Y(near.y))); ring.setAttribute("visibility", "visible");
    tip.replaceChildren(...(o.tipText ? o.tipText(near) : [el("strong", {}, `${f(near.x)} · ${f(near.y)}`), el("br"), METHOD_LABEL[near.series] ?? near.series]));
    tip.hidden = false; const hr = host.getBoundingClientRect(); tip.style.left = `${e.clientX - hr.left + 12}px`; tip.style.top = `${e.clientY - hr.top - 10}px`;
    svg.style.cursor = o.onPick && near.key ? "pointer" : "";
  });
  svg.addEventListener("pointerleave", () => { ring.setAttribute("visibility", "hidden"); tip.hidden = true; });
  svg.addEventListener("click", () => { if (near?.key) o.onPick?.(near.key); });
  const items = o.series.map(s => (s === "baseline" ? { label: "Status quo", color: "var(--text-primary)", kind: "diamond" as const } : { label: METHOD_LABEL[s] ?? s, color: `var(${SERIES[s]})`, kind: "dot" as const }));
  if (o.front?.length) items.push({ label: "Trade-off front (no design better on both)", color: "var(--text-secondary)", kind: "line" as unknown as "dot" });
  if (o.diag) items.push({ label: "Perfect prediction", color: "var(--text-muted)", kind: "dash" as unknown as "dot" });
  host.append(legend(items), svg, tip);
}

// ------------------------------------------------------------------ the page
async function uiMain() {
  const data = JSON.parse($("#data").textContent!) as PageData;
  const src = $("#app").textContent!, url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const city = generateCity(data.city), a = analyse(data.runs);
  const byKey = new Map(a.designs.map(d => [d.key, d]));
  const base = baseline(city), baseKey = designKey(base);
  const bestOf = (m: string) => a.finalists.find(d => d.method === m) ?? null;
  const best = a.finalists[0] ?? null;
  const cores = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));

  // headline numbers
  const heroes = $("#heroes");
  const tile = (label: string, value: string, sub: string) => el("div", { class: "tile" }, el("div", { class: "tile-label" }, label), el("div", { class: "tile-value" }, value), el("div", { class: "tile-sub" }, sub));
  // (the finalists' best on five seeds; before they are checked, the best so far on two)
  const top = best ?? [...a.designs].filter(d => d.method !== "baseline").sort((x, y) => x.score - y.score)[0];
  if (top) {
    const five = !!top.m5, b = five ? a.base5 : a.base, m = top.m5 ?? top.m;
    heroes.append(
      tile("Corridor trip, SW ↔ NE", `${fmt(corridorEff(m))} s`, `${pct(corridorEff(m) / corridorEff(b))} against ${fmt(corridorEff(b))} s now`),
      tile("Traffic in the centre", `${fmt(m.centreVehKm)} veh-km/h`, `${pct(m.centreVehKm / b.centreVehKm)} against ${fmt(b.centreVehKm)} now`),
      tile("Trips through the town", `${fmt(m.trips)} /h`, `${pct(m.trips / b.trips)}; mean trip ${fmt(m.tripTime)} s (${pct(m.tripTime / b.tripTime)})`),
      tile("Score (lower is better)", fmt(top.score5 ?? top.score, 3), `status quo 1.000; ${METHOD_LABEL[top.method].toLowerCase()}; mean of ${five ? 5 : 2} seeds`),
    );
  }
  for (const [id, v] of Object.entries({
    "n-runs": fmt(data.runs.length), "n-designs": fmt(a.designs.length), "noise": fmt(a.noise, 3), "built": data.built, "commit": data.commit,
    "pro-mae": fmt(a.prospective.mae, 3), "pro-rho": fmt(a.prospective.rho, 2), "pro-n": fmt(a.prospective.n),
    "ga-best": bestOf("ga")?.score5 !== undefined ? fmt(bestOf("ga")!.score5!, 3) : "–", "dl-best": bestOf("dl")?.score5 !== undefined ? fmt(bestOf("dl")!.score5!, 3) : "–",
  })) document.querySelectorAll(`[data-v="${id}"]`).forEach(e => (e.textContent = v));

  // the map, and what it shows
  const map = new CityMap($("#map"), city);
  const picker = $<HTMLSelectElement>("#pick");
  const options: [string, string][] = [[baseKey, "Status quo"]];
  if (bestOf("ga")) options.push([bestOf("ga")!.key, `Best by the genetic algorithm (score ${fmt(bestOf("ga")!.score5!, 3)})`]);
  if (bestOf("dl")) options.push([bestOf("dl")!.key, `Best by the NN surrogate (score ${fmt(bestOf("dl")!.score5!, 3)})`]);
  for (const [k, label] of options) picker.append(el("option", { value: k }, label));
  const custom = el("option", { value: "", hidden: "" }, "A design picked from the charts");
  picker.append(custom);
  const describeBox = $("#describe"), metricsBox = $("#design-metrics");
  const showKey = (key: string) => {
    const d = parseKey(key);
    map.show(d);
    if (![...picker.options].some(o => o.value === key && o !== custom)) { custom.value = key; custom.hidden = false; }
    picker.value = key;
    describeBox.replaceChildren(...describe(city, d).map(t => el("li", {}, t)));
    const r = byKey.get(key);
    metricsBox.replaceChildren();
    if (r) {
      const m = r.m5 ?? r.m, B = r.m5 ? a.base5 : a.base, sc = r.score5 ?? r.score;
      metricsBox.append(el("p", {}, el("strong", {}, `Score ${fmt(sc, 3)}`), ` (${r.m5 ? "mean of 5 seeds" : "mean of 2 seeds"}; ${METHOD_LABEL[r.method]}${r.round ? `, round ${r.round}` : ""}). Corridor ${fmt(corridorEff(m))} s (${pct(corridorEff(m) / corridorEff(B))}), centre ${fmt(m.centreVehKm)} veh-km/h (${pct(m.centreVehKm / B.centreVehKm)}), ${fmt(m.trips)} trips/h, ${fmt(m.stuck, 1)} cars stuck at the end.`));
    }
  };
  picker.addEventListener("change", () => showKey(picker.value));
  showKey(top ? top.key : baseKey);
  map.resize();

  // play a simulation on the map
  let watcher: Worker | null = null;
  const play = $<HTMLButtonElement>("#play"), speed = $<HTMLInputElement>("#speed"), simInfo = $("#sim-info");
  const stopWatch = () => { watcher?.terminate(); watcher = null; map.cars = null; map.draw(); play.textContent = "Play the simulation"; play.setAttribute("aria-pressed", "false"); };
  play.addEventListener("click", () => {
    if (watcher) { stopWatch(); return; }
    watcher = new Worker(url);
    watcher.onmessage = e => {
      const d = e.data as { frame?: Float32Array; t: number; vehicles: number; meanSpeed: number; stuck: number; error?: string };
      if (d.error) { simInfo.textContent = `The simulation stopped: ${d.error.split("\n")[0]}`; stopWatch(); return; }
      if (d.frame) { map.cars = d.frame; map.draw(); simInfo.textContent = `${Math.floor(d.t / 60)} min ${String(Math.floor(d.t % 60)).padStart(2, "0")} s · ${d.vehicles} vehicles · mean speed ${fmt(d.meanSpeed)} km/h · ${d.stuck} stuck`; }
    };
    watcher.postMessage({ type: "watch", id: 1, city: data.city, key: picker.value, seed: 1, speed: Number(speed.value) });
    play.textContent = "Stop"; play.setAttribute("aria-pressed", "true");
  });
  speed.addEventListener("input", () => { $("#speed-out").textContent = `${speed.value}×`; watcher?.postMessage({ type: "speed", id: 1, city: data.city, speed: Number(speed.value) }); });
  picker.addEventListener("change", () => { if (watcher) { stopWatch(); play.click(); } });

  // simulate the design shown, here
  const simBtn = $<HTMLButtonElement>("#simulate"), simOut = $("#simulate-out");
  simBtn.addEventListener("click", async () => {
    simBtn.disabled = true;
    const key = picker.value, seed = Number($<HTMLInputElement>("#sim-seed").value) || 1, pool = new Pool(url, 1);
    try {
      const m = await pool.run<Metrics>({ type: "run", city: data.city, key, seed, warmupMin: 5, measureMin: 20 }, f => (simOut.textContent = `Simulating 25 minutes of traffic… ${Math.round(f * 100)}%`));
      const rec = data.runs.find(r => r.key === key && r.seed === seed);
      simOut.textContent = `Seed ${seed}: corridor ${fmt(corridorEff(m))} s, centre ${fmt(m.centreVehKm)} veh-km/h, ${fmt(m.trips)} trips/h, ${m.stuck} stuck (${fmt(m.ms / 1000)} s here).` + (rec ? ` Recorded: corridor ${fmt(corridorEff(rec.m))} s, centre ${fmt(rec.m.centreVehKm)} veh-km/h, ${fmt(rec.m.trips)} trips/h. ${Math.abs(rec.m.centreVehKm - m.centreVehKm) < 1e-6 ? "The same, to the last digit." : "Not the same."}` : "");
    } catch (e) { simOut.textContent = `Failed: ${(e as Error).message.split("\n")[0]}`; }
    pool.cancel(); simBtn.disabled = false;
  });

  // charts
  const startRuns = (a.designs.filter(d => d.method === "init" || d.method === "baseline").length) * 2;
  const drawCharts = () => {
    convergenceChart($("#conv"), a.curves, startRuns);
    const pts: Pt[] = a.designs.map(d => ({ x: d.corridor, y: d.centre, key: d.key, series: d.method }));
    scatterChart($("#trade"), pts, {
      xl: "corridor trip time (status quo = 1)", yl: "traffic in the centre (status quo = 1)", series: ["init", "ga", "dl", "baseline"],
      front: a.designs.filter(d => a.pareto.includes(d.key)).map(d => ({ x: d.corridor, y: d.centre, series: d.method })), onPick: k => { showKey(k); $("#map").scrollIntoView({ block: "center" }); },
      tipText: p => { const d = byKey.get(p.key!)!; return [el("strong", {}, `score ${fmt(d.score, 3)}`), el("br"), `corridor ${pct(d.corridor)}, centre ${pct(d.centre)}`, el("br"), `${METHOD_LABEL[d.method]}${d.round ? `, round ${d.round}` : ""}`, el("br"), el("em", {}, "click to show it on the map")]; },
    });
    const pro = a.designs.filter(d => d.method === "dl" && d.pred);
    if (pro.length) scatterChart($("#pro"), pro.map(d => ({ x: d.pred![2], y: d.score, key: d.key, series: "dl" })), {
      xl: "score the networks predicted (before the run)", yl: "score simulated", series: ["dl"], diag: true, onPick: k => showKey(k),
      tipText: p => { const d = byKey.get(p.key!)!; return [el("strong", {}, `simulated ${fmt(d.score, 3)}`), el("br"), `predicted ${fmt(d.pred![2], 3)} ± ${fmt(d.sd![2], 3)} (round ${d.round})`]; },
    });
  };
  drawCharts();
  let rt = 0;
  new ResizeObserver(() => { clearTimeout(rt); rt = window.setTimeout(drawCharts, 120); }).observe($("#charts"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", drawCharts);

  // finalists
  const ft = $("#finalists tbody");
  for (const d of a.finalists) {
    const m = d.m5!, btn = el("button", { type: "button", class: "small" }, "Show");
    btn.addEventListener("click", () => { showKey(d.key); $("#map").scrollIntoView({ block: "center" }); });
    ft.append(el("tr", {}, el("td", {}, d.method === "dl" ? "NN surrogate" : "Genetic alg."), el("td", { class: "num" }, fmt(d.score5!, 3)), el("td", { class: "num" }, fmt(d.score, 3)), el("td", { class: "num" }, `${fmt(corridorEff(m))} s (${pct(d.corridor5!)})`), el("td", { class: "num" }, `${fmt(m.centreVehKm)} (${pct(d.centre5!)})`), el("td", { class: "num" }, fmt(m.trips)), el("td", { class: "num" }, fmt(m.stuck, 1)), el("td", {}, btn)));
  }
  // every design, as a table (the charts' data)
  const at = $("#all tbody");
  for (const d of a.designs) at.append(el("tr", {}, el("td", {}, METHOD_LABEL[d.method]), el("td", { class: "num" }, String(d.round || "")), el("td", { class: "num" }, fmt(d.score, 3)), el("td", { class: "num" }, pct(d.corridor)), el("td", { class: "num" }, pct(d.centre)), el("td", { class: "num" }, fmt(d.m.trips)), el("td", { class: "num" }, d.pred ? fmt(d.pred[2], 3) : ""), el("td", { class: "key-cell" }, d.key)));

  // cross-validation of the networks, here
  const cvBtn = $<HTMLButtonElement>("#cv"), cvOut = $("#cv-out");
  cvBtn.addEventListener("click", async () => {
    cvBtn.disabled = true;
    const pool = new Pool(url, 1);
    try {
      const r = await pool.run<{ keys: string[]; pred: number[][]; actual: number[][]; stats: { name: string; r2: number; rho: number }[] }>({ type: "cv", city: data.city, runs: data.runs }, f => (cvOut.textContent = `Training 5 × 5 networks on ${a.designs.length} designs… ${Math.round(f * 100)}%`));
      cvOut.replaceChildren(el("p", {}, `5-fold cross-validation over the ${a.designs.length} designs simulated (each predicted by networks that never saw it): `, ...r.stats.flatMap((s, i) => [i ? "; " : "", el("strong", {}, s.name), ` R² ${fmt(s.r2, 2)}, rank correlation ${fmt(s.rho, 2)}`]), "."));
      const host = el("div", { class: "chart" });
      cvOut.append(host);
      scatterChart(host, r.keys.map((k, i) => ({ x: r.pred[i][2], y: r.actual[i][2], key: k, series: byKey.get(k)!.method })), { xl: "score predicted (held out)", yl: "score simulated", series: ["init", "ga", "dl", "baseline"], diag: true, onPick: k => showKey(k) });
    } catch (e) { cvOut.textContent = `Failed: ${(e as Error).message.split("\n")[0]}`; }
    pool.cancel(); cvBtn.disabled = false;
  });

  // the experiment, here (small, by default)
  const runBtn = $<HTMLButtonElement>("#run"), log = $("#run-log"), runChart = $("#run-chart");
  let pool: Pool | null = null;
  runBtn.addEventListener("click", async () => {
    if (pool) { pool.cancel(); pool = null; runBtn.textContent = "Run the experiment here"; log.textContent += "Stopped.\n"; return; }
    const n = (id: string) => Math.max(1, Number($<HTMLInputElement>(id).value) || 1);
    const INIT = n("#r-init"), ROUNDS = n("#r-rounds"), BATCH = n("#r-batch"), W = Math.min(16, n("#r-workers")), MEASURE = n("#r-measure"), SEED = 1;
    pool = new Pool(url, W); runBtn.textContent = "Stop";
    log.textContent = `${W} workers; ${INIT} random designs, then ${ROUNDS} rounds of ${BATCH} per search; ${MEASURE} min counted after 5 min warm-up, seed ${SEED}.\n`;
    const p = pool, R = rng(Date.now() % 1e9), Rga = rng(1001), Rdl = rng(2002);
    const sim = async (d: Design) => p.run<Metrics>({ type: "run", city: data.city, key: designKey(d), seed: SEED, warmupMin: 5, measureMin: MEASURE });
    try {
      const B = await sim(base);
      log.textContent += `Status quo: corridor ${fmt(corridorEff(B))} s, centre ${fmt(B.centreVehKm)} veh-km/h.\n`;
      const T = (d: Design, m: Metrics): Tried => ({ d, key: designKey(d), m, score: score(m, B) });
      const init: Design[] = []; while (init.length < INIT) init.push(randomDesign(city, R, R() * 0.3, R() * 0.4));
      const im = await Promise.all(init.map(sim));
      const ga = [T(base, B), ...init.map((d, i) => T(d, im[i]))], dl = [...ga];
      const curves = { ga: [] as { runs: number; best: number }[], dl: [] as { runs: number; best: number }[] };
      const bestS = (t: Tried[]) => Math.min(...t.map(x => x.score));
      curves.ga.push({ runs: ga.length, best: bestS(ga) }); curves.dl.push({ runs: dl.length, best: bestS(dl) });
      log.textContent += `Random designs: best ${fmt(bestS(ga), 3)}.\n`;
      for (let round = 1; round <= ROUNDS && pool === p; round++) {
        const gd = gaPropose(city, ga, BATCH, Rga);
        const props = await p.run<{ key: string; pred: number[] }[]>({ type: "dl", city: data.city, tried: dl.map(t => ({ key: t.key, m: t.m, score: t.score })), base: B, n: BATCH, seed: Math.floor(Rdl() * 1e9), kappa: Math.max(0.1, 1 - round / ROUNDS) });
        const [gm, dm] = await Promise.all([Promise.all(gd.map(sim)), Promise.all(props.map(q => sim(parseKey(q.key))))]);
        ga.push(...gd.map((d, i) => T(d, gm[i]))); dl.push(...props.map((q, i) => T(parseKey(q.key), dm[i])));
        curves.ga.push({ runs: ga.length, best: bestS(ga) }); curves.dl.push({ runs: dl.length, best: bestS(dl) });
        log.textContent += `Round ${round}: genetic algorithm ${fmt(bestS(ga), 3)}, NN surrogate ${fmt(bestS(dl), 3)}.\n`;
        convergenceChart(runChart, curves, INIT + 1);
      }
      const top = [...ga, ...dl].sort((x, y) => x.score - y.score)[0];
      log.textContent += `Done. Best ${fmt(top.score, 3)}: ${describe(city, top.d).join("; ")}.\n`;
    } catch (e) { if (pool === p) log.textContent += `Failed: ${(e as Error).message.split("\n")[0]}\n`; }
    if (pool === p) { p.cancel(); pool = null; runBtn.textContent = "Run the experiment here"; }
  });
  $<HTMLInputElement>("#r-workers").value = String(cores);
}

// (last: everything above defined first)
if (typeof document === "undefined") workerMain();
else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => void uiMain());
else void uiMain();
