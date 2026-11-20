/**
 * The experiment's explainer video (ticket #277), drawn frame by frame on one 1920 × 1080 canvas: the city generated, its
 * traffic in the V2 simulation, what a design may change, the score, the two searches and what they found, from the
 * recorded runs (window.DATA). scripts/dl-city-video.ts bundles it, steps it in headless Chromium (`frame(i)` draws frame
 * i and returns it as a JPEG data URL) and encodes the frames. Deterministic: the same frame number, the same picture
 * (the simulations only ever step forward, so frames are drawn in order).
 */
import { generateCity, rng, STREETS, CONTROLS, type StreetId } from "./city";
import { baseline, designSketch, parseKey, randomDesign, stateOf, type Design } from "./design";
import { analyse, type RunRecord, type DesignResult } from "./analysis";
import { corridorEff, meanMetrics, score } from "./evaluate";
import { SketchSim } from "../../lane-sketch-sim";
import { connectorPts, samples, type Sketch } from "../../lane-sketch";

declare global { interface Window { DATA: { runs: RunRecord[]; probe: RunRecord[] }; frame: (i: number) => string; TOTAL: number; FPS: number; ready: boolean } }

const W = 1920, H = 1080, FPS = 30;
const C = {
  page: "#0d0d0d", surface: "#1a1a19", text: "#f0efec", text2: "#c3c2b7", muted: "#898781", grid: "#2c2c2a", axis: "#383835",
  s1: "#3987e5", s2: "#d95926", s3: "#199e70", critical: "#e66767", good: "#0ca30c",
  road: "#9a9890", conn: "#5d5c57", halo: "rgba(57, 135, 229, 0.42)", centre: "rgba(201, 133, 0, 0.16)", car: "#86b6ef", amber: "#c98500",
};
const FONT = "'Liberation Sans', 'DejaVu Sans', sans-serif";

const canvas = document.createElement("canvas");
canvas.width = W; canvas.height = H;
document.body.append(canvas);
const g = canvas.getContext("2d")!;

// ------------------------------------------------------------------ helpers
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (t: number) => { t = clamp(t); return t * t * (3 - 2 * t); };
/** 0 → 1 between seconds a and b */
const prog = (t: number, a: number, b: number) => ease((t - a) / (b - a));
const fmt = (v: number, d = 0) => v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: d });
const pct = (r: number) => `${r < 1 ? "−" : "+"}${Math.abs((r - 1) * 100).toFixed(0)}%`;

function font(size: number, weight = 400) { g.font = `${weight} ${size}px ${FONT}`; }
function text(s: string, x: number, y: number, o: { size?: number; weight?: number; color?: string; align?: CanvasTextAlign; alpha?: number; base?: CanvasTextBaseline; halo?: string } = {}) {
  g.save();
  font(o.size ?? 32, o.weight ?? 400);
  g.globalAlpha *= o.alpha ?? 1; g.textAlign = o.align ?? "left"; g.textBaseline = o.base ?? "alphabetic";
  if (o.halo) { g.lineWidth = 6; g.strokeStyle = o.halo; g.lineJoin = "round"; g.strokeText(s, x, y); }
  g.fillStyle = o.color ?? C.text; g.fillText(s, x, y);
  g.restore();
}
function wrap(s: string, maxW: number, size: number, weight = 400): string[] {
  font(size, weight);
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const w of para.split(" ")) {
      const t = line ? `${line} ${w}` : w;
      if (g.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}
function para(s: string, x: number, y: number, maxW: number, o: { size?: number; weight?: number; color?: string; alpha?: number; lh?: number } = {}) {
  const size = o.size ?? 32, lines = wrap(s, maxW, size, o.weight), lh = o.lh ?? size * 1.32;
  lines.forEach((l, i) => text(l, x, y + i * lh, { ...o, size }));
  return y + lines.length * lh;
}
/** the scene's heading, top left */
function heading(n: number, title: string, t: number) {
  const a = prog(t, 0.1, 0.6);
  text(String(n).padStart(2, "0"), 80, 92, { size: 26, weight: 700, color: C.amber, alpha: a });
  text(title, 130, 92, { size: 40, weight: 700, alpha: a });
}
/** what is being said, at the bottom: lines appearing at their times */
function caption(t: number, parts: { at: number; s: string }[], o: { x?: number; w?: number; y?: number } = {}) {
  const cur = [...parts].reverse().find(p => t >= p.at);
  if (!cur) return;
  const x = o.x ?? 80, w = o.w ?? W - 160, y = o.y ?? 978;
  const lines = wrap(cur.s, w - 64, 31);
  const a = prog(t, cur.at, cur.at + 0.45), h = lines.length * 41 + 34;
  g.save(); g.globalAlpha = a;
  g.fillStyle = "rgba(26, 26, 25, 0.92)"; roundRect(x, y - h + 30, w, h, 14); g.fill();
  g.fillStyle = C.amber; g.fillRect(x, y - h + 30, 6, h);
  lines.forEach((l, i) => text(l, x + 32, y - h + 30 + 50 + i * 41, { size: 31, color: C.text }));
  g.restore();
}
function roundRect(x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function arrow(x0: number, y0: number, x1: number, y1: number, color: string, w = 3, head = 14) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  g.save(); g.strokeStyle = color; g.fillStyle = color; g.lineWidth = w; g.lineCap = "round";
  g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1 - Math.cos(a) * head * 0.8, y1 - Math.sin(a) * head * 0.8); g.stroke();
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x1 - Math.cos(a - 0.45) * head, y1 - Math.sin(a - 0.45) * head); g.lineTo(x1 - Math.cos(a + 0.45) * head, y1 - Math.sin(a + 0.45) * head); g.closePath(); g.fill();
  g.restore();
}
function box(x: number, y: number, w: number, h: number, label: string, color: string, a = 1, sub?: string) {
  g.save(); g.globalAlpha *= a;
  g.fillStyle = C.surface; roundRect(x, y, w, h, 12); g.fill();
  g.strokeStyle = color; g.lineWidth = 2.5; roundRect(x, y, w, h, 12); g.stroke();
  const lines = wrap(label, w - 30, 27, 600), top = y + h / 2 - ((lines.length - 1) * 33) / 2 + (sub ? -12 : 9);
  lines.forEach((l, i) => text(l, x + w / 2, top + i * 33, { size: 27, weight: 600, align: "center" }));
  if (sub) text(sub, x + w / 2, top + lines.length * 33 - 2, { size: 22, color: C.text2, align: "center" });
  g.restore();
}

// ------------------------------------------------------------------ the data
const DATA = window.DATA;
const city = generateCity(1);
const townName = city.name.split(" (")[0];
const A = analyse(DATA.runs);
const BASE = baseline(city);
const fin = A.finalists;
const dlBest = fin.find(f => f.method === "dl")!, gaBest = fin.find(f => f.method === "ga")!;
const probe = (() => {
  const by = new Map<string, RunRecord[]>();
  for (const r of DATA.probe) (by.get(r.key) ?? by.set(r.key, []).get(r.key)!).push(r);
  const [key, rs] = [...by].find(([, rs]) => rs[0].method === "hybrid-four")!;
  const m = meanMetrics(rs.map(r => r.m));
  return { key, m, score: score(m, A.base5), corridor: corridorEff(m) / corridorEff(A.base5), centre: m.centreVehKm / A.base5.centreVehKm };
})();
const DL = parseKey(dlBest.key), GA = parseKey(gaBest.key), HY = parseKey(probe.key);
const countStates = (d: Design) => { const c = [0, 0, 0, 0]; for (const v of stateOf(city, d).values()) c[v]++; return c; };
const dlCounts = countStates(DL);
const nCentre = city.links.filter(l => l.centre).length;

// ------------------------------------------------------------------ the map
interface Rect { x: number; y: number; w: number; h: number }
const xs = city.nodes.map(n => n.x), ys = city.nodes.map(n => n.y);
const BB = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
const CX = city.centre.reduce((a, p) => a + p.x, 0) / city.centre.length, CY = city.centre.reduce((a, p) => a + p.y, 0) / city.centre.length;
/** where to label a street: its outer end (the ring: its west side), and which way out from the centre that is */
const anchor = (id: StreetId) => {
  const ms = city.links.filter(l => l.street === id).map(l => ({ x: (city.nodes[l.a].x + city.nodes[l.b].x) / 2, y: (city.nodes[l.a].y + city.nodes[l.b].y) / 2 }));
  const p = id === "ring" ? ms.reduce((a, b) => (b.x < a.x ? b : a)) : ms.reduce((a, b) => (Math.hypot(b.x - CX, b.y - CY) > Math.hypot(a.x - CX, a.y - CY) ? b : a));
  const L = Math.hypot(p.x - CX, p.y - CY) || 1;
  return { p, ux: (p.x - CX) / L, uy: (p.y - CY) / L };
};
/** a street's name beside its outer end, out from the centre */
function streetLabel(m: MapView, id: StreetId, s: string, a: number, color = C.text) {
  if (a <= 0) return;
  const { p, ux, uy } = anchor(id), q = m.scr(p), x = q.x + ux * 26, y = Math.min(850, q.y + uy * 26 + 9);
  text(s, ux >= 0 ? x : Math.max(x, 40 + (font(26, 700), g.measureText(s).width)), y, { size: 26, weight: 700, alpha: a, halo: C.page, color, align: ux >= 0 ? "left" : "right" });
}

class MapView {
  sketch: Sketch;
  lanes: { path: Path2D; width: number; four: boolean }[];
  conns: Path2D;
  streetPaths = new Map<StreetId, Path2D>();
  s = 1; ox = 0; oy = 0;
  constructor(public d: Design, public r: Rect) {
    this.sketch = designSketch(city, d).sketch;
    const four = new Set<string>(d.four.map(k => STREETS[k].name)), fourLanes = new Set(this.sketch.roads.filter(x => four.has(x.name)).flatMap(x => x.lanes));
    this.lanes = this.sketch.lanes.map(l => { const p = new Path2D(); samples(l.shape, 4).forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y))); return { path: p, width: l.width, four: fourLanes.has(l.id) }; });
    this.conns = new Path2D();
    for (const c of this.sketch.connectors) { const pts = connectorPts(this.sketch, c); if (pts) pts.forEach((q, i) => (i ? this.conns.lineTo(q.x, q.y) : this.conns.moveTo(q.x, q.y))); }
    for (const st of STREETS) {
      const p = new Path2D();
      for (const l of city.links.filter(x => x.street === st.id)) { const a = city.nodes[l.a], b = city.nodes[l.b]; p.moveTo(a.x, a.y); p.lineTo(b.x, b.y); }
      this.streetPaths.set(st.id, p);
    }
    this.fit(r);
  }
  fit(r: Rect, zoom = 1, focus?: { x: number; y: number }) {
    this.r = r;
    this.s = Math.min(r.w / (BB.x1 - BB.x0 + 60), r.h / (BB.y1 - BB.y0 + 60)) * zoom;
    const cx = focus?.x ?? (BB.x0 + BB.x1) / 2, cy = focus?.y ?? (BB.y0 + BB.y1) / 2;
    this.ox = r.x + r.w / 2 - cx * this.s; this.oy = r.y + r.h / 2 - cy * this.s;
  }
  scr(p: { x: number; y: number }) { return { x: this.ox + p.x * this.s, y: this.oy + p.y * this.s }; }
  draw(o: { alpha?: number; changes?: boolean; cars?: Float32Array | null; highlight?: StreetId | null; reveal?: number; controls?: number[]; centre?: boolean; design?: Design; dim?: number } = {}) {
    const d = o.design ?? this.d, s = this.s, px = 1 / s;
    g.save();
    g.globalAlpha = o.alpha ?? 1;
    g.beginPath(); g.rect(this.r.x, this.r.y, this.r.w, this.r.h); g.clip();
    g.setTransform(s, 0, 0, s, this.ox, this.oy);
    g.lineCap = "round"; g.lineJoin = "round";
    if (o.centre !== false) { g.beginPath(); city.centre.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.fillStyle = C.centre; g.fill(); }
    const reveal = o.reveal ?? 1;
    if (reveal < 1) {
      // being generated: the city's links, from the centre out
      const cx = (BB.x0 + BB.x1) / 2, cy = (BB.y0 + BB.y1) / 2, R = Math.hypot(BB.x1 - cx, BB.y1 - cy) * 1.05;
      g.strokeStyle = C.road; g.lineWidth = 2.2 * px;
      g.beginPath();
      for (const l of city.links) {
        const a = city.nodes[l.a], b = city.nodes[l.b], dd = Math.hypot((a.x + b.x) / 2 - cx, (a.y + b.y) / 2 - cy) / R;
        if (dd > reveal) continue;
        g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
      }
      g.stroke();
      g.fillStyle = C.text2;
      for (const n of city.nodes) if (Math.hypot(n.x - cx, n.y - cy) / R < reveal) { g.beginPath(); g.arc(n.x, n.y, 2.6 * px, 0, 7); g.fill(); }
    } else {
      g.globalAlpha = (o.alpha ?? 1) * (o.dim ?? 1);
      g.strokeStyle = C.halo;
      for (const l of this.lanes) if (l.four) { g.lineWidth = Math.max(l.width * 2.6, 7 * px); g.stroke(l.path); }
      g.strokeStyle = C.road;
      for (const l of this.lanes) { g.lineWidth = Math.max(l.width * 0.7, 1.3 * px); g.stroke(l.path); }
      g.lineWidth = Math.max(1.4, 0.9 * px); g.strokeStyle = C.conn; g.stroke(this.conns);
      g.globalAlpha = o.alpha ?? 1;
    }
    if (o.highlight) { g.strokeStyle = C.amber; g.lineWidth = 9 * px; g.stroke(this.streetPaths.get(o.highlight)!); }
    if (o.changes) this.changes(d, px);
    if (o.controls) this.controls(o.controls, px);
    if (o.cars) {
      const f = o.cars, L = Math.max(5, 6.5 * px), Wd = Math.max(2.2, 3.2 * px);
      for (let i = 0; i < f.length; i += 5) {
        g.fillStyle = f[i + 4] < 0.2 ? C.critical : C.car;
        const a = Math.atan2(f[i + 3], f[i + 2]), c = Math.cos(a), sn = Math.sin(a);
        g.setTransform(s * c, s * sn, -s * sn, s * c, this.ox + f[i] * s, this.oy + f[i + 1] * s);
        g.fillRect(-L / 2, -Wd / 2, L, Wd);
      }
    }
    g.restore();
  }
  changes(d: Design, px: number) {
    const st = stateOf(city, d);
    for (const l of city.links) {
      const v = st.get(l.id) ?? 0;
      if (!v) continue;
      const a = city.nodes[l.a], b = city.nodes[l.b];
      if (v === 3) {
        g.save(); g.setLineDash([7 * px, 6 * px]); g.lineWidth = 4 * px; g.strokeStyle = C.critical;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.restore();
      } else {
        const [P, Q] = v === 1 ? [a, b] : [b, a], mx = (P.x + Q.x) / 2, my = (P.y + Q.y) / 2, L = Math.hypot(Q.x - P.x, Q.y - P.y), ux = (Q.x - P.x) / L, uy = (Q.y - P.y) / L, k = 11 * px;
        g.fillStyle = C.text;
        g.beginPath(); g.moveTo(mx + ux * k, my + uy * k); g.lineTo(mx - ux * k - uy * k * 0.7, my - uy * k + ux * k * 0.7); g.lineTo(mx - ux * k + uy * k * 0.7, my - uy * k - ux * k * 0.7); g.closePath(); g.fill();
      }
    }
  }
  controls(ctl: number[], px: number) {
    city.keys.forEach((k, i) => {
      const n = city.nodes[k.node], c = CONTROLS[ctl[i]], r = 13 * px;
      g.lineWidth = 3 * px; g.strokeStyle = C.text; g.fillStyle = C.page;
      if (c === "lights") { g.fillRect(n.x - r, n.y - r, 2 * r, 2 * r); g.strokeRect(n.x - r, n.y - r, 2 * r, 2 * r); g.fillStyle = C.good; g.beginPath(); g.arc(n.x, n.y, r * 0.5, 0, 7); g.fill(); }
      else if (c === "roundabout") { g.beginPath(); g.arc(n.x, n.y, r * 1.2, 0, 7); g.fill(); g.stroke(); g.beginPath(); g.arc(n.x, n.y, r * 0.45, 0, 7); g.stroke(); }
      else { g.beginPath(); g.moveTo(n.x - r, n.y - r * 0.8); g.lineTo(n.x + r, n.y - r * 0.8); g.lineTo(n.x, n.y + r); g.closePath(); g.fill(); g.strokeStyle = C.critical; g.stroke(); }
    });
  }
}

/** a design's simulation, stepped forward to the time wanted */
class SimView {
  sim: SketchSim;
  constructor(d: Design, warmS: number, seed = 1) {
    const b = designSketch(city, d, { seed, warmupMin: 0 });
    this.sim = new SketchSim(b.sketch, { rate: 0, speed: 50, seed }, seed);
    const nr: unknown[] = []; nr.push = () => 0; (this.sim as unknown as { replay: unknown[] }).replay = nr;
    this.to(warmS);
  }
  to(t: number) { while (this.sim.t < t - 1e-9) this.sim.step(0.1); }
  cars() {
    const ps = this.sim.poses() as { p: { x: number; y: number }; d: { x: number; y: number }; share: number }[], f = new Float32Array(ps.length * 5);
    ps.forEach((q, i) => f.set([q.p.x, q.p.y, q.d.x, q.d.y, q.share], i * 5));
    return f;
  }
}

// ------------------------------------------------------------------ charts
function axes(r: Rect, xd: [number, number], yd: [number, number], xt: number[], yt: number[], xl: string, yl: string, fx = (v: number) => fmt(v), fy = (v: number) => fmt(v, 1), a = 1) {
  const X = (v: number) => r.x + ((v - xd[0]) / (xd[1] - xd[0])) * r.w, Y = (v: number) => r.y + r.h - ((v - yd[0]) / (yd[1] - yd[0])) * r.h;
  g.save(); g.globalAlpha = a;
  g.lineWidth = 1; g.strokeStyle = C.grid;
  for (const v of yt) { g.beginPath(); g.moveTo(r.x, Y(v)); g.lineTo(r.x + r.w, Y(v)); g.stroke(); text(fy(v), r.x - 14, Y(v) + 8, { size: 22, color: C.muted, align: "right" }); }
  for (const v of xt) text(fx(v), X(v), r.y + r.h + 34, { size: 22, color: C.muted, align: "center" });
  g.strokeStyle = C.axis; g.lineWidth = 2; g.beginPath(); g.moveTo(r.x, r.y + r.h); g.lineTo(r.x + r.w, r.y + r.h); g.stroke();
  text(xl, r.x + r.w / 2, r.y + r.h + 72, { size: 24, color: C.text2, align: "center" });
  g.translate(r.x - 90, r.y + r.h / 2); g.rotate(-Math.PI / 2); text(yl, 0, 0, { size: 24, color: C.text2, align: "center" });
  g.restore();
  return { X, Y };
}
function legendRow(x: number, y: number, items: { label: string; color: string; kind: "line" | "dot" | "ring" | "diamond" }[], a = 1) {
  g.save(); g.globalAlpha = a;
  for (const it of items) {
    g.fillStyle = it.color; g.strokeStyle = it.color; g.lineWidth = 4;
    if (it.kind === "line") { g.beginPath(); g.moveTo(x, y - 8); g.lineTo(x + 30, y - 8); g.stroke(); }
    else if (it.kind === "ring") { g.lineWidth = 3; g.beginPath(); g.arc(x + 12, y - 8, 9, 0, 7); g.stroke(); }
    else if (it.kind === "diamond") { g.beginPath(); g.moveTo(x + 12, y - 19); g.lineTo(x + 23, y - 8); g.lineTo(x + 12, y + 3); g.lineTo(x + 1, y - 8); g.closePath(); g.fill(); }
    else { g.beginPath(); g.arc(x + 12, y - 8, 8, 0, 7); g.fill(); }
    text(it.label, x + 42, y, { size: 24, color: C.text2 });
    font(24); x += 42 + g.measureText(it.label).width + 40;
  }
  g.restore();
}
function mapLegend(x: number, y: number, items: ("four" | "oneway" | "closed" | "centre" | "car" | "slow")[], a = 1) {
  g.save(); g.globalAlpha = a;
  for (const it of items) {
    if (it === "four") { g.strokeStyle = C.halo; g.lineWidth = 12; g.beginPath(); g.moveTo(x, y - 9); g.lineTo(x + 34, y - 9); g.stroke(); g.strokeStyle = C.road; g.lineWidth = 2; g.stroke(); }
    if (it === "oneway") { g.fillStyle = C.text; g.beginPath(); g.moveTo(x + 28, y - 9); g.lineTo(x + 8, y - 20); g.lineTo(x + 8, y + 2); g.closePath(); g.fill(); }
    if (it === "closed") { g.strokeStyle = C.critical; g.setLineDash([7, 6]); g.lineWidth = 4; g.beginPath(); g.moveTo(x, y - 9); g.lineTo(x + 34, y - 9); g.stroke(); g.setLineDash([]); }
    if (it === "centre") { g.fillStyle = "rgba(201, 133, 0, 0.35)"; g.fillRect(x, y - 22, 34, 26); }
    if (it === "car" || it === "slow") { g.fillStyle = it === "car" ? C.car : C.critical; g.fillRect(x + 6, y - 14, 22, 10); }
    const label = { four: "four lanes", oneway: "one-way", closed: "closed to cars", centre: "centre (inside the ring)", car: "car", slow: "car crawling (under 20% of the limit)" }[it];
    text(label, x + 46, y, { size: 23, color: C.text2 });
    y += 40;
  }
  g.restore();
}

// ------------------------------------------------------------------ the scenes
interface Scene { dur: number; init?: () => void; draw: (t: number) => void }
const FULL: Rect = { x: 40, y: 120, w: 1100, h: 800 };
const base = new MapView(BASE, FULL), sims: Record<string, SimView> = {};
const SIM_SPEED = 8, WARM = 420;
const simClock = (t: number) => WARM + t * SIM_SPEED;
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const scenes: Scene[] = [
  // 1 title
  {
    dur: 7,
    draw: t => {
      base.fit({ x: 0, y: -100, w: W, h: H + 200 }, 1.15 + t * 0.03);
      base.draw({ alpha: 0.28 });
      g.fillStyle = "rgba(13,13,13,0.55)"; g.fillRect(0, 0, W, H);
      text("Can deep learning redesign a town’s streets?", W / 2, 470, { size: 68, weight: 700, align: "center", alpha: prog(t, 0.3, 1.2) });
      text("A traffic experiment on a random city, run in trafficsim", W / 2, 550, { size: 36, color: C.text2, align: "center", alpha: prog(t, 1, 1.8) });
      text("Ticket #277", W / 2, 640, { size: 28, weight: 700, color: C.amber, align: "center", alpha: prog(t, 1.6, 2.3) });
    },
  },
  // 2 the ask
  {
    dur: 15,
    draw: t => {
      heading(1, "What the ticket asked", t);
      const items = [
        ["A new random city", "with the traits of the plan “Bistrița Auto Search”"],
        ["Speed up the main road", "from south-west to north-east…"],
        ["…while taking traffic out of the centre", ""],
        ["Only two main streets may have four lanes", "every other street two lanes at most"],
        ["Bonus: could deep learning find the best option?", ""],
      ];
      items.forEach(([a, b], i) => {
        const at = 0.8 + i * 1.6, al = prog(t, at, at + 0.5), y = 220 + i * 128;
        g.save(); g.globalAlpha = al; g.translate((1 - al) * 30, 0);
        g.fillStyle = i === 4 ? C.s2 : C.amber; g.beginPath(); g.arc(120, y - 12, 9, 0, 7); g.fill();
        text(a, 150, y, { size: 42, weight: 600 });
        if (b) text(b, 150, y + 46, { size: 30, color: C.text2 });
        g.restore();
      });
      caption(t, [{ at: 9.2, s: "How to run the experiment was left open, so here is the set-up I chose, and what came out of it." }]);
    },
  },
  // 3 the city
  {
    dur: 22, init: () => base.fit(FULL),
    draw: t => {
      heading(2, `The city: ${townName}`, t);
      const rev = prog(t, 0.5, 8), lanes = prog(t, 8, 9.5);
      if (lanes < 1) base.draw({ reveal: Math.max(0.001, rev), alpha: 1 - lanes, centre: rev > 0.3 });
      if (lanes > 0) base.draw({ alpha: lanes });
      if (t > 10) {
        const a = prog(t, 10, 11);
        const sw = base.scr(city.nodes[city.sw]), ne = base.scr(city.nodes[city.ne]);
        g.save(); g.globalAlpha = a; g.setLineDash([14, 10]); arrow(sw.x + 30, sw.y - 30, ne.x - 30, ne.y + 30, C.amber, 4, 22); g.restore();
        text("SW", sw.x + 6, sw.y + 4, { size: 30, weight: 700, color: C.amber, alpha: a, align: "right", halo: C.page });
        text("NE", ne.x - 4, ne.y - 6, { size: 30, weight: 700, color: C.amber, alpha: a, halo: C.page });
        const labels: [StreetId, string][] = [["mainC", "Strada Mare (main road, centre)"], ["ring", "ring boulevard"], ["station", "cross boulevard"], ["bypassSE", "south-east bypass"], ["bypassNW", "north-west bypass"]];
        labels.forEach(([id, name], i) => {
          const at = 11 + i * 0.8, hl = prog(t, at, at + 0.3) * (1 - prog(t, at + 1.4, at + 1.9));
          if (hl > 0) { g.save(); g.globalAlpha = hl; g.setTransform(base.s, 0, 0, base.s, base.ox, base.oy); g.strokeStyle = C.amber; g.lineWidth = 7 / base.s; g.lineCap = "round"; g.lineJoin = "round"; g.stroke(base.streetPaths.get(id)!); g.restore(); }
          streetLabel(base, id, name, prog(t, at, at + 0.5));
        });
      }
      // the comparison
      const a = prog(t, 14, 15), x = 1210, rows: [string, string, string][] = [
        ["", townName, "Bistrița Auto Search"], ["Size", "2.05 × 2.14 km", "2.3 × 2 km"], ["Junctions", "205", "266"], ["Roads", "427", "429"], ["Ways in and out", "72", "67"],
      ];
      g.save(); g.globalAlpha = a;
      rows.forEach((r, i) => {
        const y = 260 + i * 62, w = i === 0 ? 600 : 400;
        text(r[0], x, y, { size: 26, color: C.text2 });
        text(r[1], x + 400, y, { size: i ? 30 : 24, weight: i ? 600 : 700, align: "right", color: i ? C.text : C.amber });
        text(r[2], x + 650, y, { size: i ? 30 : 24, weight: i ? 400 : 700, align: "right", color: i ? C.text2 : C.muted });
        if (i < rows.length - 1) { g.strokeStyle = C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(x, y + 22); g.lineTo(x + 650 + (w - w), y + 22); g.stroke(); }
      });
      g.restore();
      mapLegend(1210, 640, ["four", "centre"], prog(t, 16, 16.6));
      caption(t, [
        { at: 0.6, s: "Generated from a seed: a grid turned 45° along the main road, 100 m blocks in the old centre growing to 210 m at the edge, warped and jittered so the streets bend." },
        { at: 8.2, s: "Then converted into the app’s lane-level V2 network, as an imported town would be." },
        { at: 10.5, s: "Like Bistrița: a ring boulevard round a dense centre, the main road straight through it, a cross boulevard, two bypasses, dead ends and car parks." },
        { at: 15.5, s: "Today, the main road has four lanes west and east of the ring (blue), and two through the centre." },
      ]);
    },
  },
  // 4 the traffic
  {
    dur: 18, init: () => { sims.base = new SimView(BASE, WARM); },
    draw: t => {
      heading(3, "Its evening peak, in the app’s simulator", t);
      sims.base.to(simClock(t));
      const cars = sims.base.cars();
      base.draw({ cars });
      text(`simulated ${clock(simClock(t))}  ·  ${SIM_SPEED}× real time`, 1210, 260, { size: 28, color: C.text2 });
      text(`${fmt(cars.length / 5)} cars on the road`, 1210, 310, { size: 34, weight: 600 });
      mapLegend(1210, 390, ["car", "slow", "centre"]);
      const a = prog(t, 9, 10);
      text("Today, measured over 20 minutes", 1210, 600, { size: 26, color: C.text2, alpha: a });
      text(`${fmt(A.base5.corridorTime)} s`, 1210, 670, { size: 56, weight: 700, alpha: a });
      text("main road, end to end", 1440, 670, { size: 26, color: C.text2, alpha: a });
      text(`${fmt(A.base5.centreVehKm)}`, 1210, 750, { size: 56, weight: 700, alpha: a });
      text("vehicle-km an hour in the centre", 1440, 740, { size: 26, color: C.text2, alpha: a });
      text(`${fmt(A.base5.trips)}`, 1210, 830, { size: 56, weight: 700, alpha: a });
      text("trips an hour across town", 1440, 820, { size: 26, color: C.text2, alpha: a });
      caption(t, [
        { at: 0.4, s: "The demand: 700 cars an hour each way along the main road, plus about 3,700 more between the other ways in, car parks and streets." },
        { at: 9, s: "Every design is run for 5 minutes to warm up, then 20 minutes measured: about 80 seconds of computing per run." },
      ]);
    },
  },
  // 5 the levers
  {
    dur: 28,
    draw: t => {
      heading(4, "What a design may change", t);
      const ph = t < 10 ? 0 : t < 20 ? 1 : 2;
      if (ph === 0) {
        const k = Math.min(6, Math.floor(clamp(t - 1, 0, 99) / 1.25)), id = STREETS[k].id;
        base.draw({ dim: 0.55, highlight: t > 1 ? id : null });
        if (t > 1) streetLabel(base, id, STREETS[k].name, 1, C.amber);
      } else if (ph === 1) {
        const R = rng(100 + Math.floor((t - 10) / 0.9)), d = t < 11 ? BASE : randomDesign(city, R, 0.15, 0.35);
        base.draw({ dim: 0.8, changes: true, design: { ...BASE, centre: d.centre } });
        mapLegend(60, 860, ["oneway", "closed"]);
      } else {
        const R = rng(300 + Math.floor((t - 20) / 0.9)), ctl = t < 21 ? BASE.control : BASE.control.map(() => Math.floor(R() * 3));
        base.draw({ dim: 0.6, controls: ctl });
      }
      const x = 1210, w = 640;
      const item = (i: number, title: string, body: string, count: string) => {
        const on = ph === i, y = [230, 470, 700][i], a = t >= i * 10 ? (on ? 1 : 0.45) : 0;
        if (!a) return;
        g.save(); g.globalAlpha = a;
        text(`${i + 1}`, x, y, { size: 40, weight: 700, color: C.amber });
        text(title, x + 44, y, { size: 32, weight: 700 });
        const e = para(body, x + 44, y + 42, w - 44, { size: 25, color: C.text2 });
        text(count, x + 44, e + 8, { size: 27, weight: 600, color: C.amber });
        g.restore();
      };
      item(0, "Four lanes", "on two of these seven main streets (the ticket’s rule); every other street one lane each way", "21 choices");
      item(1, "The centre’s streets", `each of its ${nCentre} streets two-way, one-way either way, or closed; repaired until every place still reaches every other`, `up to 4^${nCentre} choices`);
      item(2, "Nine key junctions", "give way, traffic lights or a roundabout", "3^9 = 19,683 choices");
      caption(t, [
        { at: 0.5, s: "Three kinds of change. Lanes add room, but drivers here take the shortest way in metres, so lanes alone don’t pull traffic off the centre." },
        { at: 10.5, s: "One-way streets and closures can: they make cutting through the centre longer, so through traffic goes round." },
        { at: 20.5, s: "And the busy junctions’ control." },
      ]);
    },
  },
  // 6 the score
  {
    dur: 15,
    draw: t => {
      heading(5, "One number to make smaller", t);
      const a1 = prog(t, 0.6, 1.4), a2 = prog(t, 3.5, 4.3), a3 = prog(t, 7, 7.8);
      text("score  =", 160, 340, { size: 52, weight: 700, alpha: a1 });
      text("½ × main road’s time", 420, 340, { size: 52, alpha: a1, color: C.text });
      text("+  ½ × centre’s traffic", 420, 420, { size: 52, alpha: a1 });
      text("each relative to today’s", 420, 470, { size: 28, color: C.muted, alpha: a1 });
      text("+  2 × share of trips lost", 420, 570, { size: 44, alpha: a2, color: C.text2 });
      text("+  2 × trips’ slow-down beyond 10%", 420, 640, { size: 44, alpha: a2, color: C.text2 });
      g.save(); g.globalAlpha = a3;
      g.fillStyle = C.surface; roundRect(1300, 250, 480, 380, 18); g.fill();
      text("Today", 1540, 330, { size: 30, color: C.text2, align: "center" });
      text("1.00", 1540, 430, { size: 100, weight: 700, align: "center" });
      text("lower is better", 1540, 490, { size: 28, color: C.text2, align: "center" });
      text(`the same design, another seed: ±${A.noise.toFixed(2)}`, 1540, 580, { size: 24, color: C.muted, align: "center" });
      g.restore();
      caption(t, [
        { at: 0.6, s: "Half for the main road, half for the centre: both goals in one number, today’s town scoring exactly 1." },
        { at: 3.8, s: "Penalties stop a design winning by sending traffic away: trips lost, or the rest of the town’s trips more than 10% slower." },
        { at: 8.5, s: "Cars still stuck at the end were in the first version of the score, but varied as much between seeds as between designs, so they are reported, not scored." },
      ]);
    },
  },
  // 7 too many to try
  {
    dur: 11,
    draw: t => {
      heading(6, "Far too many to try", t);
      text("21 × 4^74 × 19,683", W / 2, 360, { size: 64, weight: 600, align: "center", alpha: prog(t, 0.4, 1.2), color: C.text2 });
      text("≈ 10^50 designs", W / 2, 470, { size: 96, weight: 700, align: "center", alpha: prog(t, 1.4, 2.2) });
      text("at 80 s a run: a few hundred runs is the budget", W / 2, 580, { size: 38, color: C.text2, align: "center", alpha: prog(t, 3, 3.8) });
      text("282 runs each", W / 2, 680, { size: 44, weight: 700, color: C.amber, align: "center", alpha: prog(t, 5, 5.8) });
      caption(t, [{ at: 5.2, s: "So the real question: on the same few hundred simulator runs, which search finds better designs?" }]);
    },
  },
  // 8 the two searches
  {
    dur: 24,
    draw: t => {
      heading(7, "Two searches, same start, same budget", t);
      const L = 120, Rx = 1000, a1 = prog(t, 0.6, 1.4), a2 = prog(t, 4, 5);
      text("Genetic algorithm", L, 200, { size: 38, weight: 700, color: C.s1, alpha: a1 });
      text("learns only from the simulator", L, 240, { size: 26, color: C.text2, alpha: a1 });
      const gaBoxes: [number, number, string][] = [[L, 290, "Simulate 10 designs"], [L, 470, "Keep the best"], [L, 650, "Mix and mutate them"]];
      gaBoxes.forEach(([x, y, s], i) => box(x, y, 380, 110, s, C.s1, prog(t, 1 + i * 0.6, 1.6 + i * 0.6)));
      g.save(); g.globalAlpha = a1;
      arrow(L + 190, 400, L + 190, 466, C.s1); arrow(L + 190, 580, L + 190, 646, C.s1);
      g.strokeStyle = C.s1; g.lineWidth = 3; g.beginPath(); g.moveTo(L + 380, 705); g.lineTo(L + 460, 705); g.lineTo(L + 460, 345); g.stroke(); arrow(L + 460, 345, L + 384, 345, C.s1);
      g.restore();
      text("Neural-network surrogate", Rx, 200, { size: 38, weight: 700, color: C.s2, alpha: a2 });
      text("learns to predict the simulator, then searches the prediction", Rx, 240, { size: 26, color: C.text2, alpha: a2 });
      const dlBoxes: [number, number, string, string?][] = [[Rx, 290, "Simulate 10 designs"], [Rx, 470, "Train 5 networks on every run so far"], [Rx, 650, "Search thousands of designs on them", "a genetic algorithm, in milliseconds"]];
      dlBoxes.forEach(([x, y, s, sub], i) => box(x, y, 400, 110, s, C.s2, prog(t, 4.4 + i * 0.6, 5 + i * 0.6), sub));
      box(Rx + 470, 650, 330, 110, "Pick the 10 most promising", C.s2, prog(t, 6.4, 7), "predicted score − doubt");
      g.save(); g.globalAlpha = a2;
      arrow(Rx + 200, 400, Rx + 200, 466, C.s2); arrow(Rx + 200, 580, Rx + 200, 646, C.s2); arrow(Rx + 400, 705, Rx + 466, 705, C.s2);
      g.strokeStyle = C.s2; g.lineWidth = 3; g.beginPath(); g.moveTo(Rx + 635, 650); g.lineTo(Rx + 635, 345); g.stroke(); arrow(Rx + 635, 345, Rx + 404, 345, C.s2);
      g.restore();
      // the network
      const na = prog(t, 11, 12), nx = Rx + 470, ny = 380;
      if (na > 0) {
        g.save(); g.globalAlpha = na;
        g.fillStyle = C.page; g.fillRect(nx - 20, ny - 90, 360, 240);
        const layers = [{ n: 7, label: "262 in" }, { n: 6, label: "64" }, { n: 5, label: "32" }, { n: 4, label: "4 out" }];
        const pos = layers.map((l, i) => Array.from({ length: l.n }, (_, k) => ({ x: nx + 20 + i * 100, y: ny + 30 + (k - (l.n - 1) / 2) * 26 })));
        g.strokeStyle = "rgba(217, 89, 38, 0.25)"; g.lineWidth = 1;
        for (let i = 0; i < 3; i++) for (const p of pos[i]) for (const q of pos[i + 1]) { g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }
        g.fillStyle = C.s2; for (const col of pos) for (const p of col) { g.beginPath(); g.arc(p.x, p.y, 6, 0, 7); g.fill(); }
        layers.forEach((l, i) => text(l.label, nx + 20 + i * 100, ny + 145, { size: 20, color: C.text2, align: "center" }));
        text("× 5 networks", nx + 170, ny - 62, { size: 22, color: C.text2, align: "center" });
        g.restore();
      }
      caption(t, [
        { at: 0.6, s: "Both start from the same 40 random designs, then get 10 rounds of 10 designs each, every design simulated on 2 seeds." },
        { at: 7.5, s: "The networks (written by hand, no library) predict the score’s four parts: main road, centre, trips, and trip time." },
        { at: 15, s: "Where the five networks disagree, the search is unsure, and it tries there too: that’s how it learns where it was wrong." },
      ]);
    },
  },
  // 9 the race
  {
    dur: 19,
    draw: t => {
      heading(8, "Best score so far, run by run", t);
      const r = { x: 230, y: 170, w: 1400, h: 560 };
      const { X, Y } = axes(r, [0, 282], [0.6, 1.04], [0, 40, 82, 120, 160, 200, 240, 282], [0.6, 0.7, 0.8, 0.9, 1.0], "simulator runs", "best score (lower is better)", v => fmt(v), v => v.toFixed(1), prog(t, 0.2, 0.8));
      const p = prog(t, 1, 12) * 282;
      g.save(); g.globalAlpha = prog(t, 0.6, 1.2) * 0.6; g.fillStyle = C.grid; g.fillRect(X(0), r.y, X(82) - X(0), r.h);
      text("shared start", X(41), r.y + 36, { size: 22, color: C.text2, align: "center" }); g.restore();
      const line = (pts: { runs: number; best: number }[], color: string) => {
        g.save(); g.strokeStyle = color; g.lineWidth = 4; g.lineJoin = "round"; g.beginPath();
        let last = pts[0];
        pts.forEach((q, i) => { if (q.runs > p) return; if (i) { g.lineTo(X(q.runs), Y(last.best)); } g.lineTo(X(q.runs), Y(q.best)); last = q; });
        g.lineTo(X(p), Y(last.best)); g.stroke();
        g.fillStyle = color; g.beginPath(); g.arc(X(p), Y(last.best), 8, 0, 7); g.fill();
        g.restore();
        return last;
      };
      if (p > 0) {
        const ga = line(A.curves.ga, C.s1), dl = line(A.curves.dl, C.s2);
        if (p > 84) {
          text(`GA ${ga.best.toFixed(3)}`, X(p) + 16, Y(ga.best) + 8, { size: 26, weight: 700, color: C.text, halo: C.page });
          text(`networks ${dl.best.toFixed(3)}`, X(p) + 16, Y(dl.best) + 8, { size: 26, weight: 700, color: C.text, halo: C.page });
        }
      }
      legendRow(r.x, 862, [{ label: "Genetic algorithm", color: C.s1, kind: "line" }, { label: "Neural-network surrogate", color: C.s2, kind: "line" }], prog(t, 0.6, 1.2));
      caption(t, [
        { at: 1, s: "The first 82 runs are the shared start. From there each search spends its own 200 runs." },
        { at: 6, s: "The networks’ first round already found a 0.79; the GA crept down step by step." },
        { at: 12.5, s: "After 282 runs: 0.684 for the networks’ search, 0.834 for the GA (on the search’s two seeds)." },
      ]);
    },
  },
  // 10 the networks learning
  {
    dur: 16,
    draw: t => {
      heading(9, "How good were the networks’ predictions?", t);
      const r = { x: 230, y: 190, w: 1400, h: 560 }, br = A.prospective.byRound;
      const { X, Y } = axes(r, [0.5, 10.5], [0, 1.2], br.map(b => b.round), [0, 0.25, 0.5, 0.75, 1.0], "round", "mean error predicting the score", v => String(v), v => v.toFixed(2), prog(t, 0.2, 0.8));
      br.forEach((b, i) => {
        const a = prog(t, 1 + i * 0.35, 1.6 + i * 0.35), bw = 84, x = X(b.round) - bw / 2, y = Y(b.mae * a);
        g.fillStyle = b.round <= 4 ? C.s2 : C.s2; g.globalAlpha = b.round <= 4 ? 0.55 : 1;
        roundRect(x, y, bw, Y(0) - y, 4); g.fill(); g.globalAlpha = 1;
        if (a > 0.9) text(b.mae.toFixed(2), X(b.round), y - 14, { size: 22, color: C.text2, align: "center", halo: C.page });
      });
      const na = prog(t, 6, 6.8);
      g.save(); g.globalAlpha = na; g.setLineDash([10, 8]); g.strokeStyle = C.text; g.lineWidth = 2; g.beginPath(); g.moveTo(r.x, Y(A.noise)); g.lineTo(r.x + r.w, Y(A.noise)); g.stroke(); g.restore();
      g.save(); g.globalAlpha = na; g.strokeStyle = C.text; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(7.5), Y(0.3) + 12); g.lineTo(X(7.5), Y(A.noise) - 4); g.stroke(); g.restore();
      text(`dashed: the simulator’s own seed-to-seed noise (${A.noise.toFixed(2)})`, X(7.5), Y(0.3), { size: 24, color: C.text, align: "center", alpha: na, halo: C.page });
      caption(t, [
        { at: 1, s: "Each design’s predicted score, written down before it was simulated, against what the simulator then said." },
        { at: 6.5, s: "Poor for four rounds, while it had fewer than about 80 designs to learn from; from round 5 on, about as close as the simulator’s own noise." },
      ]);
    },
  },
  // 11 the trade-off
  {
    dur: 17,
    draw: t => {
      heading(10, "Every design simulated", t);
      const r = { x: 230, y: 160, w: 1050, h: 600 };
      const ds = A.designs.filter(d => d.method !== "baseline");
      const { X, Y } = axes(r, [0.6, 1.5], [0.3, 1.2], [0.6, 0.8, 1.0, 1.2, 1.4], [0.4, 0.6, 0.8, 1.0, 1.2], "main road’s time, relative to today", "centre’s traffic, relative to today", v => v.toFixed(1), v => v.toFixed(1), prog(t, 0.2, 0.8));
      const n = Math.floor(prog(t, 1, 9) * ds.length), col = (d: DesignResult) => (d.method === "ga" ? C.s1 : d.method === "dl" ? C.s2 : C.s3);
      g.save(); g.beginPath(); g.rect(r.x, r.y - 10, r.w + 10, r.h + 10); g.clip();
      for (let i = 0; i < n; i++) {
        const d = ds[i], x = X(d.corridor), y = Y(d.centre);
        g.fillStyle = col(d); g.strokeStyle = C.page; g.lineWidth = 2;
        g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill(); g.stroke();
      }
      g.restore();
      g.strokeStyle = C.text; g.lineWidth = 3; g.beginPath(); g.arc(X(1), Y(1), 13, 0, 7); g.stroke();
      text("today", X(1) + 20, Y(1) - 14, { size: 24, weight: 600, halo: C.page });
      const lab = (d: DesignResult, s: string, dx: number, dy: number, at: number) => {
        const a = prog(t, at, at + 0.6);
        if (!a) return;
        g.save(); g.globalAlpha = a; g.strokeStyle = C.text; g.lineWidth = 3; g.beginPath(); g.arc(X(d.corridor), Y(d.centre), 14, 0, 7); g.stroke(); g.restore();
        text(s, X(d.corridor) + dx, Y(d.centre) + dy, { size: 24, weight: 700, alpha: a, halo: C.page });
      };
      lab(dlBest, "networks’ best", 22, 8, 10);
      lab(gaBest, "GA’s best", 22, 30, 11);
      legendRow(1340, 260, [{ label: "random start", color: C.s3, kind: "dot" }], prog(t, 0.6, 1.2));
      legendRow(1340, 310, [{ label: "genetic algorithm", color: C.s1, kind: "dot" }], prog(t, 0.6, 1.2));
      legendRow(1340, 360, [{ label: "neural-network surrogate", color: C.s2, kind: "dot" }], prog(t, 0.6, 1.2));
      para("Bottom left is better: a quicker main road and a quieter centre.", 1340, 460, 500, { size: 26, color: C.text2, alpha: prog(t, 2, 2.6) });
      caption(t, [
        { at: 1, s: `All ${ds.length} designs: each dot is one, both axes relative to today (shown on the search’s two seeds).` },
        { at: 9.5, s: "The two searches went to opposite corners: the networks emptied the centre, the GA sped up the main road." },
      ]);
    },
  },
  // 12 the check on five seeds
  {
    dur: 15,
    draw: t => {
      heading(11, "Checked again, on five seeds", t);
      const r = { x: 520, y: 260, w: 1200, h: 420 };
      const { X } = axes(r, [0.6, 1.05], [0, 1], [0.6, 0.7, 0.8, 0.9, 1.0], [], "score, mean of five seeds (lower is better)", "", v => v.toFixed(1), () => "", prog(t, 0.2, 0.8));
      const rows: [string, string, DesignResult[]][] = [["Neural-network surrogate", C.s2, fin.filter(f => f.method === "dl")], ["Genetic algorithm", C.s1, fin.filter(f => f.method === "ga")]];
      rows.forEach(([name, color, fs], i) => {
        const y = r.y + 110 + i * 190, a = prog(t, 1 + i * 1.5, 1.8 + i * 1.5);
        text(name, r.x - 30, y + 8, { size: 28, weight: 600, align: "right", alpha: a });
        fs.forEach((f, k) => { const aa = prog(t, 1.4 + i * 1.5 + k * 0.12, 1.8 + i * 1.5 + k * 0.12); g.save(); g.globalAlpha = aa; g.fillStyle = color; g.strokeStyle = C.page; g.lineWidth = 2; g.beginPath(); g.arc(X(f.score5!), y, 13, 0, 7); g.fill(); g.stroke(); g.restore(); });
        if (a > 0) { const lo = Math.min(...fs.map(f => f.score5!)), hi = Math.max(...fs.map(f => f.score5!)); text(`${lo.toFixed(2)}–${hi.toFixed(2)}`, X(hi) + 30, y + 9, { size: 26, color: C.text2, alpha: prog(t, 4.5, 5) }); }
      });
      g.save(); g.globalAlpha = prog(t, 0.6, 1.2); g.setLineDash([8, 8]); g.strokeStyle = C.text2; g.lineWidth = 2; g.beginPath(); g.moveTo(X(1), r.y); g.lineTo(X(1), r.y + r.h); g.stroke(); g.restore();
      text("today", X(1), r.y - 16, { size: 24, color: C.text2, align: "center", alpha: prog(t, 0.6, 1.2) });
      caption(t, [
        { at: 1, s: "Each search’s six best designs, run again on three seeds they had never seen: five seeds in all." },
        { at: 6, s: "All six of the networks’ beat all six of the GA’s: 0.69–0.73 against 0.85–0.93." },
      ]);
    },
  },
  // 13 the winners, live
  {
    dur: 26, init: () => {
      sims.today = new SimView(BASE, WARM); sims.dl = new SimView(DL, WARM);
      maps.today = new MapView(BASE, { x: 20, y: 150, w: 930, h: 610 }); maps.dl = new MapView(DL, { x: 970, y: 150, w: 930, h: 610 });
    },
    draw: t => {
      heading(12, "The networks’ best design, against today", t);
      const st = simClock(t);
      sims.today.to(st); sims.dl.to(st);
      maps.today.draw({ cars: sims.today.cars() });
      maps.dl.draw({ cars: sims.dl.cars(), changes: true });
      text("Today", 485, 190, { size: 32, weight: 700, align: "center", halo: C.page });
      text("Networks’ best", 1435, 190, { size: 32, weight: 700, align: "center", halo: C.page, color: C.s2 });
      text(`simulated ${clock(st)}, same seed`, W / 2, 140, { size: 24, color: C.muted, align: "center" });
      const stat = (x: number, v: string, l: string, a: number) => { text(v, x, 810, { size: 44, weight: 700, align: "center", alpha: a }); text(l, x, 842, { size: 22, color: C.text2, align: "center", alpha: a }); };
      const a = prog(t, 6, 7);
      stat(250, "1.00", "score", a); stat(485, `${fmt(A.base5.corridorTime)} s`, "main road", a); stat(720, fmt(A.base5.centreVehKm), "centre veh-km/h", a);
      stat(1200, dlBest.score5!.toFixed(2), "score", a); stat(1435, pct(dlBest.corridor5!), "main road", a); stat(1670, pct(dlBest.centre5!), "centre", a);
      mapLegend(860, 640, ["oneway", "closed"], prog(t, 1, 1.6));
      caption(t, [
        { at: 0.6, s: `It turns the centre into one-way cells (${dlCounts[1] + dlCounts[2]} one-way streets, ${dlCounts[3]} closed) and keeps the four lanes where they are today.` },
        { at: 9, s: "Through traffic can no longer cut across the centre, so it goes round the ring: 59% less traffic in the centre." },
        { at: 17, s: "And the main road is no slower for it (−3%), with 1.5% more trips across town." },
      ]);
    },
  },
  // 14 GA's best and the hybrid
  {
    dur: 22, init: () => {
      sims.ga = new SimView(GA, WARM); sims.hy = new SimView(HY, WARM);
      maps.ga = new MapView(GA, { x: 20, y: 150, w: 930, h: 610 }); maps.hy = new MapView(HY, { x: 970, y: 150, w: 930, h: 610 });
    },
    draw: t => {
      heading(13, "The GA’s best, and the two combined", t);
      const st = simClock(t);
      sims.ga.to(st); sims.hy.to(st);
      maps.ga.draw({ cars: sims.ga.cars(), changes: true });
      maps.hy.draw({ cars: sims.hy.cars(), changes: true });
      text("GA’s best", 485, 190, { size: 32, weight: 700, align: "center", halo: C.page, color: C.s1 });
      text("Hybrid", 1435, 190, { size: 32, weight: 700, align: "center", halo: C.page });
      text(`simulated ${clock(st)}, same seed`, W / 2, 140, { size: 24, color: C.muted, align: "center" });
      const stat = (x: number, v: string, l: string, a: number) => { text(v, x, 810, { size: 44, weight: 700, align: "center", alpha: a }); text(l, x, 842, { size: 22, color: C.text2, align: "center", alpha: a }); };
      const a = prog(t, 2, 3), b = prog(t, 10, 11);
      stat(250, gaBest.score5!.toFixed(2), "score", a); stat(485, pct(gaBest.corridor5!), "main road", a); stat(720, pct(gaBest.centre5!), "centre", a);
      stat(1200, probe.score.toFixed(2), "score", b); stat(1435, pct(probe.corridor), "main road", b); stat(1670, pct(probe.centre), "centre", b);
      mapLegend(860, 600, ["four", "oneway", "closed"], prog(t, 1, 1.6));
      caption(t, [
        { at: 0.6, s: "The GA did the opposite: four lanes on Strada Mare, through the centre, and the main road 25% quicker, but the centre only 5% quieter." },
        { at: 10, s: `Afterwards I tried the two combined: the networks’ centre with the GA’s four lanes. It scores ${probe.score.toFixed(3)} and leaves ${fmt(probe.m.stuck)} cars stuck at the end, against ${fmt(dlBest.m5!.stuck)} for the networks’ best.` },
      ]);
    },
  },
  // 15 caveats
  {
    dur: 19,
    draw: t => {
      heading(14, "Before trusting it", t);
      const items = [
        ["The score left out stuck cars and collisions.", `The networks’ best ends with ${fmt(dlBest.m5!.stuck)} cars stuck (today ${fmt(A.base5.stuck)}) and ${fmt(dlBest.m5!.collisions)} collisions a run (today ${fmt(A.base5.collisions)}). Check its junctions in the editor first.`],
        ["One search per method, on one random city.", "Part of the networks’ lead could be luck."],
        ["Drivers here take the shortest route in metres.", "Extra lanes add room but never attract traffic; only closures and one-way streets move it."],
      ];
      items.forEach(([a, b], i) => {
        const at = 0.6 + i * 4, al = prog(t, at, at + 0.6), y = 230 + i * 220;
        g.save(); g.globalAlpha = al;
        g.fillStyle = C.critical; g.beginPath(); g.moveTo(120, y - 34); g.lineTo(144, y + 6); g.lineTo(96, y + 6); g.closePath(); g.fill();
        text("!", 120, y + 2, { size: 26, weight: 700, color: C.page, align: "center" });
        text(a, 180, y, { size: 40, weight: 700 });
        para(b, 180, y + 52, 1560, { size: 30, color: C.text2 });
        g.restore();
      });
    },
  },
  // 16 the answer
  {
    dur: 20,
    draw: t => {
      heading(15, "So, could deep learning find the best option?", t);
      const a = prog(t, 0.8, 1.6), b = prog(t, 5, 5.8), c = prog(t, 11, 11.8);
      para("As a guide for the simulator, yes: on the same budget of runs it found better designs than a plain genetic algorithm, and found them sooner.", 120, 260, 1680, { size: 44, weight: 600, alpha: a });
      para("But it isn’t an oracle: it needed about 80 simulated designs before its predictions were worth anything, and it only optimises what the score counts.", 120, 470, 1680, { size: 36, color: C.text2, alpha: b });
      g.save(); g.globalAlpha = c;
      g.fillStyle = C.surface; roundRect(120, 680, 1680, 230, 18); g.fill();
      text("See it all", 170, 750, { size: 30, weight: 700, color: C.amber });
      text("docs/experiments/dl-city-277/index.html: every run, the charts, and simulations you can re-run", 170, 805, { size: 28 });
      text(`The city “${townName}” and its four plans in the app  ·  ticket #277`, 170, 860, { size: 28, color: C.text2 });
      g.restore();
    },
  },
];
const maps: Record<string, MapView> = {};

// ------------------------------------------------------------------ the frame loop
const starts: number[] = [];
{ let s = 0; for (const sc of scenes) { starts.push(s); s += sc.dur; } window.TOTAL = Math.round(s * FPS); }
window.FPS = FPS;
const inited = new Set<number>();
window.frame = (i: number) => {
  const T = i / FPS;
  let k = starts.findIndex((s, j) => T >= s && T < s + scenes[j].dur);
  if (k < 0) k = scenes.length - 1;
  const sc = scenes[k], t = T - starts[k];
  if (!inited.has(k)) { inited.add(k); sc.init?.(); }
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1;
  g.fillStyle = C.page; g.fillRect(0, 0, W, H);
  sc.draw(t);
  // (in from black, out to black)
  const f = Math.max(1 - clamp(t / 0.35), k === scenes.length - 1 ? clamp((t - sc.dur + 1.2) / 1.2) : 1 - clamp((sc.dur - t) / 0.35));
  if (f > 0) { g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = f; g.fillStyle = "#000"; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
  return canvas.toDataURL("image/jpeg", 0.92);
};
window.ready = true;
