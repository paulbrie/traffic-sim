/**
 * Builds the TomTom experiment's printable report: docs/experiments/tomtom-321/index.html, one self-contained HTML file
 * (inline SVG charts, light and dark, an A4 print layout), from the runs recorded in docs/experiments/tomtom-321
 * (calib-*.json, check.json, optimize.json, final.json, plan.json, changes.svg) and TomTom's network-wide speed by
 * time of day (profile.json, made from the export with --export).
 *
 *   npx tsx scripts/tomtom-321-report.ts [--export /tmp/t321/traffic-….json] [--out docs/experiments/tomtom-321/index.html]
 *
 * The app serves it at /experiments/tomtom-321/report; its download (?download) leaves out the ticket (download.ts).
 */
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { laneLength, pointAt, type Sketch } from "../src/lib/lane-sketch";
import { DOWNLOAD_NAME } from "../src/lib/experiments/tomtom-321/download";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const DIR = join(__dirname, "../docs/experiments/tomtom-321");
const OUT = arg("out", join(DIR, "index.html"));
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), "utf8"));

// ---------------------------------------------------------------- the data
type Stats = { trips: number; tripTime: number; netTime: number; centreDelay: number; centreKm: number; collisions: number; deadlocks: number; waiting: number };
type Eval = { key: string; score: number; peaks: Record<string, Stats[]> };
type Fit = { loss: number; corr: number; n: number; bias: number };
type Round = { round: number; total: number; phi: number; fit: Fit; heldOut: Fit | null; jammed: boolean };
type Street = { id: string; name: string; roads: string[]; kind: "1" | "1+1" | "2"; cls: Record<string, number>; lengthM: number };
type Profile = { weekday: Record<string, number>; weekend: Record<string, number>; days: { weekdays: number; weekends: number } };

const plan = read("plan.json"), sk: Sketch = plan.sketch;
const calib = { morning: { half: read("calib-morning-half.json"), all: read("calib-morning-all.json") }, evening: { half: read("calib-evening-half.json"), all: read("calib-evening-all.json") } };
const check = read("check.json"), opt = read("optimize.json"), fin = read("final.json");
const PEAKS = [
  { id: "morning", key: "tomtom-morning", name: "Morning", hour: "07:30–08:30", window: ["06:00", "09:00"], series: 1 },
  { id: "evening", key: "tomtom-evening", name: "Evening", hour: "16:00–17:00", window: ["16:00", "19:00"], series: 2 },
] as const;

/** TomTom's network-wide share of free flow by local time, weekdays and weekends: the mean of each day's sample */
function profileOf(file: string): Profile {
  const e = JSON.parse(readFileSync(file, "utf8")) as { samples: { day: string; weekday: string; slot: string; rel?: number }[] };
  const acc = { weekday: new Map<string, number[]>(), weekend: new Map<string, number[]>() }, days = { weekday: new Set<string>(), weekend: new Set<string>() };
  for (const s of e.samples) {
    if (typeof s.rel !== "number") continue;
    const k = s.weekday === "Sat" || s.weekday === "Sun" ? "weekend" : "weekday";
    const [h, m] = s.slot.split(":").map(Number), t = (h + 2) * 60 + m; // (UTC+2: Bistrița in November)
    const slot = `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
    (acc[k].get(slot) ?? acc[k].set(slot, []).get(slot)!).push(s.rel);
    days[k].add(s.day);
  }
  const mean = (m: Map<string, number[]>) => Object.fromEntries([...m].sort().map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(3)]));
  return { weekday: mean(acc.weekday), weekend: mean(acc.weekend), days: { weekdays: days.weekday.size, weekends: days.weekend.size } };
}
const exportFile = arg("export", "");
if (exportFile) writeFileSync(join(DIR, "profile.json"), JSON.stringify(profileOf(exportFile), null, 1) + "\n");
if (!existsSync(join(DIR, "profile.json"))) throw new Error("no profile.json: run once with --export <TomTom export>");
const profile: Profile = read("profile.json");

// ---------------------------------------------------------------- words for the moves
const short = (n: string) => n.replace(/^Strada /, "Str. ").replace(/^Bulevardul /, "Bd. ");
const lanes = new Map(sk.lanes.map(l => [l.id, l]));
/** the compass heading of some lanes, from their starts to their ends (the plan's y grows southward) */
function heading(ids: string[]): string {
  let x = 0, y = 0;
  for (const id of ids) {
    const l = lanes.get(id); if (!l) continue;
    const L = laneLength(l.shape), a = pointAt(l.shape, 0).p, b = pointAt(l.shape, L).p;
    x += b.x - a.x; y += b.y - a.y;
  }
  const deg = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
  return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(deg / 45) % 8];
}
const streets = new Map<string, Street>(opt.streets.map((s: Street) => [s.id, s]));
function moveLabel(key: string): string {
  const [id, to] = key.split(":"), s = streets.get(id);
  if (!s) return key;
  const name = short(s.name) + (s.kind === "1" && opt.streets.some((o: Street) => o.id !== s.id && o.name === s.name && o.kind !== s.kind) ? " (its one-lane part)" : "");
  const cls = (k: number) => Object.entries(s.cls).filter(([, c]) => c === k).map(([l]) => l);
  if (to === "oneway0" || to === "oneway1") return `${name} one-way, ${heading(cls(to === "oneway0" ? 0 : 1))}bound`;
  if (to === "twoway") return `${name} one lane each way`;
  return `${name} turned round (now ${opposite(heading(Object.keys(s.cls)))}bound)`;
}
const opposite = (h: string) => ({ north: "south", south: "north", east: "west", west: "east", "north-east": "south-west", "south-west": "north-east", "north-west": "south-east", "south-east": "north-west" } as Record<string, string>)[h] ?? h;
const newMove = (key: string, current: string) => key.split(" ").filter(k => !current.split(" ").includes(k)).map(moveLabel).join(", ") || "nothing new";

// ---------------------------------------------------------------- numbers
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fmt = (x: number, d = 0) => x.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
const sign = (x: number) => (x > 0 ? "+" : x < 0 ? "−" : "±") + Math.abs(x);
const pct = (a: number, b: number) => `${sign(Math.round((100 * (b - a)) / a))}%`;
const evals: Eval[] = fin.evals, [today, design, plus] = evals;
const m = (e: Eval, peak: string, k: keyof Stats) => mean(e.peaks[peak].map(s => s[k]));
/** the centre's delay, the mean of each run's change against today on the same seed (as the score counts it) */
const dDelay = (e: Eval, peak: string) => `${sign(Math.round(100 * mean(e.peaks[peak].map((s, i) => s.centreDelay / today.peaks[peak][i].centreDelay - 1))))}%`;

// ---------------------------------------------------------------- charts (inline SVG; colours from the page's CSS variables)
let W = 560; // (a chart's viewBox width: smaller for the charts shown two abreast, so their text prints legible)
type Pad = { l: number; r: number; t: number; b: number };
const lin = (d0: number, d1: number, r0: number, r1: number) => (v: number) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
const tip = (s: string) => ` data-tip="${esc(s)}"`;
function frame(h: number, p: Pad, xs: { v: number; label: string }[], ys: { v: number; label: string }[], x: (v: number) => number, y: (v: number) => number, xLabel: string, yLabel: string) {
  let s = `<g class="axes">`;
  for (const t of ys) s += `<line class="grid" x1="${p.l}" x2="${W - p.r}" y1="${y(t.v)}" y2="${y(t.v)}"/><text class="tick" x="${p.l - 6}" y="${y(t.v) + 4}" text-anchor="end">${t.label}</text>`;
  for (const t of xs) s += `<text class="tick" x="${x(t.v)}" y="${h - p.b + 16}" text-anchor="middle">${t.label}</text>`;
  s += `<line class="baseline" x1="${p.l}" x2="${W - p.r}" y1="${h - p.b}" y2="${h - p.b}"/>`;
  s += `<text class="axis-label" x="${(p.l + W - p.r) / 2}" y="${h - 4}" text-anchor="middle">${xLabel}</text>`;
  s += `<text class="axis-label" x="${p.l - 36}" y="${p.t - 10}">${yLabel}</text></g>`;
  return s;
}
const svg = (h: number, label: string, body: string) => `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">${body}</svg>`;
const legend = (items: { cls: string; label: string; dash?: boolean; dot?: boolean }[]) =>
  `<ul class="legend">${items.map(i => `<li>${i.dot ? `<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="4.5" class="${i.cls}"/></svg>` : `<svg width="22" height="10" aria-hidden="true"><line x1="1" y1="5" x2="21" y2="5" class="${i.cls}"${i.dash ? ' stroke-dasharray="4 3"' : ""}/></svg>`}${esc(i.label)}</li>`).join("")}</ul>`;

/** TomTom's share of free flow over a peak's recorded hours, weekdays and weekends, the worst hour shaded */
function profileChart(peak: (typeof PEAKS)[number]): string {
  W = 420;
  const toMin = (t: string) => { const [h, mm] = t.split(":").map(Number); return h * 60 + mm; };
  const [a, b] = peak.window.map(toMin), [w0, w1] = peak.hour.split("–").map(toMin);
  const slots = (k: "weekday" | "weekend") => Object.entries(profile[k]).map(([t, v]) => ({ t: toMin(t), v })).filter(p => p.t >= a && p.t <= b);
  const wd = slots("weekday"), we = slots("weekend");
  const h = 230, p = { l: 40, r: 12, t: 30, b: 40 }, x = lin(a, b, p.l, W - p.r), y = lin(0.4, 1.02, h - p.b, p.t);
  const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
  let s = frame(h, p, [0, 60, 120, 180].map(d => ({ v: a + d, label: hhmm(a + d) })), [0.4, 0.6, 0.8, 1].map(v => ({ v, label: `${v * 100}%` })), x, y, "local time (weekday means)", "speed, share of free flow");
  s += `<rect class="band" x="${x(w0)}" y="${p.t}" width="${x(w1) - x(w0)}" height="${h - p.b - p.t}"/><text class="band-label" x="${(x(w0) + x(w1)) / 2}" y="${p.t + 14}" text-anchor="middle">worst hour</text>`;
  const path = (pts: { t: number; v: number }[]) => pts.map((q, i) => `${i ? "L" : "M"}${x(q.t).toFixed(1)},${y(q.v).toFixed(1)}`).join("");
  s += `<path class="line muted" stroke-dasharray="4 3" d="${path(we)}"/><path class="line s${peak.series}" d="${path(wd)}"/>`;
  const low = wd.reduce((q, r) => (r.v < q.v ? r : q));
  s += `<circle class="dot s${peak.series}" cx="${x(low.t)}" cy="${y(low.v)}" r="4.5"/><text class="direct" x="${x(low.t)}" y="${y(low.v) + 18}" text-anchor="middle">${Math.round(low.v * 100)}% at ${hhmm(low.t)}</text>`;
  const step = (x(a + 5) - x(a)) || 1;
  for (const q of wd) {
    const e = we.find(r => r.t === q.t);
    s += `<rect class="hit" x="${x(q.t) - step / 2}" y="${p.t}" width="${step}" height="${h - p.b - p.t}"${tip(`${hhmm(q.t)} · weekdays ${Math.round(q.v * 100)}%${e ? ` · weekends ${Math.round(e.v * 100)}%` : ""} of free flow`)}/>`;
  }
  return svg(h, `${peak.name}: TomTom's speed across the town as a share of free flow, by time of day; slowest ${Math.round(low.v * 100)}% at ${hhmm(low.t)}`, s);
}

/** the half-roads calibration: the error on the roads it never saw, round by round, both peaks */
function calibChart(): string {
  W = 640;
  const rounds = (id: "morning" | "evening") => (calib[id].half.rounds as Round[]).map(r => ({ r: r.round, v: r.heldOut!.loss, total: r.total, jammed: r.jammed }));
  const all = PEAKS.flatMap(pk => rounds(pk.id).map(q => q.v)), lo = Math.floor(Math.min(...all) * 100 - 0.5) / 100, hi = Math.ceil(Math.max(...all) * 100 + 0.5) / 100;
  const n = Math.max(...PEAKS.map(pk => rounds(pk.id).length));
  const h = 260, p = { l: 46, r: 70, t: 30, b: 40 }, x = lin(1, n, p.l, W - p.r), y = lin(lo, hi, h - p.b, p.t);
  const yt: number[] = []; for (let v = lo; v <= hi + 1e-9; v += 0.01) yt.push(+v.toFixed(2));
  let s = frame(h, p, Array.from({ length: n }, (_, i) => ({ v: i + 1, label: String(i + 1) })), yt.map(v => ({ v, label: v.toFixed(2) })), x, y, "round of the calibration", "error on held-out roads (RMSE)");
  for (const pk of PEAKS) {
    const q = rounds(pk.id), best = calib[pk.id].half.best.round as number;
    s += `<path class="line s${pk.series}" d="${q.map((r, i) => `${i ? "L" : "M"}${x(r.r)},${y(r.v).toFixed(1)}`).join("")}"/>`;
    for (const r of q) s += `<circle class="dot s${pk.series}" cx="${x(r.r)}" cy="${y(r.v)}" r="4"${tip(`${pk.name}, round ${r.r}: held-out RMSE ${r.v.toFixed(3)} · ${fmt(r.total)} vehicles an hour coming in${r.jammed ? " · gridlocked: 15% off" : ""}${r.r === best ? " · kept" : ""}`)}/>`;
    const b = q.find(r => r.r === best)!;
    s += `<circle class="hover-ring" cx="${x(b.r)}" cy="${y(b.v)}" r="8"/>`;
    const last = q[q.length - 1];
    s += `<text class="direct" x="${x(last.r) + 14}" y="${y(last.v) + 4}">${pk.name}</text>`;
  }
  return svg(h, "The calibration's error on roads it never saw, by round: it falls from the start in both peaks", s);
}

/** TomTom against the simulation, road by road (the calibration on all roads, re-run on fresh seeds) */
function scatter(pk: (typeof PEAKS)[number]): string {
  W = 420;
  const c = check[pk.id], pts = c.pts as { id: string; name: string; tomtom: number; sim: number; w: number }[];
  const h = 400, p = { l: 40, r: 12, t: 30, b: 40 }, x = lin(0, 1.05, p.l, W - p.r), y = lin(0, 1.05, h - p.b, p.t);
  const t = [0, 0.2, 0.4, 0.6, 0.8, 1].map(v => ({ v, label: v.toFixed(1) }));
  let s = frame(h, p, t, t, x, y, "TomTom: speed as a share of free flow", "simulated");
  for (const v of [0.2, 0.4, 0.6, 0.8, 1]) s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${p.t}" y2="${h - p.b}"/>`;
  s += `<line class="marker-line" x1="${x(0)}" y1="${y(0)}" x2="${x(1.05)}" y2="${y(1.05)}"/><text class="tick" x="${x(1.02)}" y="${y(1.02) + 14}" text-anchor="end">same</text>`;
  s += `<line class="marker-line" x1="${x(0)}" x2="${x(1.05)}" y1="${y(c.phi)}" y2="${y(c.phi)}"/><text class="tick" x="${x(0.02)}" y="${y(c.phi) - 5}">φ = ${c.phi}: friction, no traffic</text>`;
  for (const q of pts) s += `<circle class="dot s${pk.series} faint" cx="${x(q.tomtom).toFixed(1)}" cy="${y(Math.min(q.sim, 1.05)).toFixed(1)}" r="4"${tip(`${short(q.name)} (${q.id}) · TomTom ${Math.round(q.tomtom * 100)}% · simulated ${Math.round(q.sim * 100)}%`)}/>`;
  return svg(h, `${pk.name}: each road one way, TomTom's speed share against the simulation's (${pts.length} roads, RMSE ${c.fit.loss}, correlation ${c.fit.corr})`, s);
}

/** the search's first round: every sound change on its own, scored against today */
function candidatesChart(): string {
  W = 860;
  const r = opt.log[0], tried = (r.tried as { key: string; score: number }[]).filter(t => t.key !== "today").sort((a, b) => a.score - b.score);
  const row = 24, p = { l: 470, r: 30, t: 30, b: 40 }, h = p.t + p.b + row * tried.length;
  const lo = 0.9, hi = Math.max(1.1, Math.ceil(Math.max(...tried.map(t => t.score)) * 20) / 20), x = lin(lo, hi, p.l, W - p.r + 0);
  let s = `<g class="axes">`;
  for (let v = lo; v <= hi + 1e-9; v += 0.05) s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${p.t - 6}" y2="${h - p.b}"/><text class="tick" x="${x(v)}" y="${h - p.b + 16}" text-anchor="middle">${v.toFixed(2)}</text>`;
  s += `<text class="axis-label" x="${(p.l + W - p.r) / 2}" y="${h - 4}" text-anchor="middle">score (today = 1, lower is better)</text></g>`;
  s += `<line class="marker-line" x1="${x(1)}" x2="${x(1)}" y1="${p.t - 12}" y2="${h - p.b}"/><text class="tick" x="${x(1)}" y="${p.t - 16}" text-anchor="middle">today</text>`;
  tried.forEach((t, i) => {
    const cy = p.t + row * i + row / 2, kept = i === 0;
    s += `<text class="${kept ? "row-label strong" : "row-label"}" x="${p.l - 10}" y="${cy + 4}" text-anchor="end">${esc(moveLabel(t.key))}</text>`;
    s += `<line class="stem" x1="${x(1)}" x2="${x(t.score)}" y1="${cy}" y2="${cy}"/><circle class="dot ${kept ? "s1" : "muted-fill"}" cx="${x(t.score)}" cy="${cy}" r="5"${tip(`${moveLabel(t.key)}: ${t.score.toFixed(3)}${kept ? " · kept" : ""}`)}/>`;
  });
  return svg(h, "The search's first round: each sound change scored alone; Ecaterina Teodoroiu one-way scored best", s);
}

/** the centre's delay on each fresh seed, today and with the design */
function seedsChart(pk: (typeof PEAKS)[number]): string {
  W = 420;
  const a = today.peaks[pk.key].map(s => s.centreDelay), b = design.peaks[pk.key].map(s => s.centreDelay), seeds = fin.seeds as number[];
  const row = 26, p = { l: 50, r: 40, t: 10, b: 40 }, h = p.t + p.b + row * seeds.length;
  const hi = Math.ceil(Math.max(...a, ...b) + 0.5), x = lin(0, hi, p.l, W - p.r);
  let s = `<g class="axes">`;
  for (let v = 0; v <= hi; v += 2) s += `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="${p.t - 6}" y2="${h - p.b}"/><text class="tick" x="${x(v)}" y="${h - p.b + 16}" text-anchor="middle">${v}</text>`;
  s += `<text class="axis-label" x="${(p.l + W - p.r) / 2}" y="${h - 4}" text-anchor="middle">delay in the centre, vehicle-hours an hour</text></g>`;
  seeds.forEach((seed, i) => {
    const cy = p.t + row * i + row / 2, d = pct(a[i], b[i]);
    s += `<text class="row-label" x="${p.l - 10}" y="${cy + 4}" text-anchor="end">run ${i + 1}</text>`;
    s += `<line class="stem" x1="${x(a[i])}" x2="${x(b[i])}" y1="${cy}" y2="${cy}"/>`;
    s += `<circle class="dot muted-fill" cx="${x(a[i])}" cy="${cy}" r="5"${tip(`${pk.name}, run ${i + 1} (seed ${seed}): today ${a[i].toFixed(2)}`)}/>`;
    s += `<circle class="dot s1" cx="${x(b[i])}" cy="${cy}" r="5"${tip(`${pk.name}, run ${i + 1} (seed ${seed}): with the change ${b[i].toFixed(2)} (${d})`)}/>`;
    s += `<text class="tick" x="${x(Math.max(a[i], b[i])) + 10}" y="${cy + 4}">${d}</text>`;
  });
  return svg(h, `${pk.name}: the centre's delay on each of six fresh runs, today against Ecaterina Teodoroiu one-way`, s);
}

// ---------------------------------------------------------------- the page
let commit = "uncommitted";
try { commit = execSync("git rev-parse --short HEAD", { cwd: DIR }).toString().trim(); } catch { /* not a checkout */ }
const built = new Date().toISOString().slice(0, 10);
const mapSvg = readFileSync(join(DIR, "changes.svg"), "utf8").replace(/<\?xml[^>]*>\s*/, "").replace(/<text x="12" y="20"[^>]*>[^<]*<\/text>/, "")
  .replace("<svg ", `<svg role="img" aria-label="The centre's streets: Str. Ecaterina Teodoroiu, on the east side, made one-way southbound (red arrows)" `);

const heldRow = (pk: (typeof PEAKS)[number]) => { const h = check[pk.id].heldOut; return `<tr><td>${pk.name}</td><td class="num">${h.start.loss.toFixed(3)}</td><td class="num"><strong>${h.best.loss.toFixed(3)}</strong></td><td class="num">${h.start.corr.toFixed(2)}</td><td class="num"><strong>${h.best.corr.toFixed(2)}</strong></td><td class="num">${h.best.n}</td></tr>`; };
const total = (id: "morning" | "evening") => calib[id].all.best.total as number;
const lowOf = (k: "weekday", from: string, to: string) => Object.entries(profile[k]).filter(([t]) => t >= from && t <= to).reduce((q, r) => (r[1] < q[1] ? r : q));
const [mLowT, mLow] = lowOf("weekday", "06:00", "09:00"), [eLowT, eLow] = lowOf("weekday", "16:00", "19:00");

const finalRows: [string, (e: Eval) => string][] = [
  ["Score (today = 1, lower is better)", e => e.score.toFixed(3)],
  ["Morning: delay in the centre, veh-h an hour", e => m(e, "tomtom-morning", "centreDelay").toFixed(2) + (e === today ? "" : ` (${dDelay(e, "tomtom-morning")})`)],
  ["Evening: delay in the centre", e => m(e, "tomtom-evening", "centreDelay").toFixed(2) + (e === today ? "" : ` (${dDelay(e, "tomtom-evening")})`)],
  ["Traffic in the centre, veh-km (morning / evening)", e => `${fmt(m(e, "tomtom-morning", "centreKm"))} / ${fmt(m(e, "tomtom-evening", "centreKm"))}`],
  ["Time per trip across the town, s", e => `${fmt(m(e, "tomtom-morning", "netTime"))} / ${fmt(m(e, "tomtom-evening", "netTime"))}`],
  ["Trips made an hour", e => `${fmt(m(e, "tomtom-morning", "trips"))} / ${fmt(m(e, "tomtom-evening", "trips"))}`],
  ["Collisions a run", e => `${m(e, "tomtom-morning", "collisions").toFixed(1)} / ${m(e, "tomtom-evening", "collisions").toFixed(1)}`],
  ["Deadlocks the simulation broke up, a run", e => `${m(e, "tomtom-morning", "deadlocks").toFixed(1)} / ${m(e, "tomtom-evening", "deadlocks").toFixed(1)}`],
];
const searchRows = (opt.log as { round: number; current: string; currentScore: number; tried: { key: string; score: number }[] }[]).map(r => {
  const t = [...r.tried].sort((a, b) => a.score - b.score), best = t[0], kept = best.score < r.currentScore - 0.01, cur = r.current === "today" ? "" : r.current;
  return `<tr><td class="num">${r.round}</td><td>${kept ? esc(newMove(best.key, cur)) : `nothing better by 0.01 (best: ${esc(newMove(best.key, cur))}, ${best.score.toFixed(3)})`}</td><td class="num">${kept ? best.score.toFixed(3) : ""}</td><td>${esc(newMove(t[1].key, cur))}, ${t[1].score.toFixed(3)}</td></tr>`;
}).join("");
const seedDelta = (pk: string) => today.peaks[pk].map((s, i) => pct(s.centreDelay, design.peaks[pk][i].centreDelay)).join(", ");

const CSS = `
:root {
  color-scheme: light dark;
  --page: #f9f9f7; --surface-1: #fcfcfb; --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11, 11, 11, 0.10); --band: rgba(137, 135, 129, 0.12);
  --series-1: #2a78d6; --series-2: #eb6834; --critical: #d03b3b;
  accent-color: var(--series-1);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #0d0d0d; --surface-1: #1a1a19; --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255, 255, 255, 0.10); --band: rgba(195, 194, 183, 0.10);
    --series-1: #3987e5; --series-2: #d95926; --critical: #e66767;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text-primary); line-height: 1.5; }
main { max-width: 1080px; margin: 0 auto; padding: 24px 20px 64px; }
h1 { font-size: 1.7rem; line-height: 1.25; margin: 0 0 6px; text-wrap: balance; }
h2 { font-size: 1.25rem; margin: 40px 0 8px; text-wrap: balance; }
h3 { font-size: 1rem; margin: 20px 0 6px; }
p, li { max-width: 80ch; }
.lede { color: var(--text-secondary); font-size: 1.05rem; }
.meta { color: var(--text-muted); font-size: 0.85rem; }
.card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.answer { border-left: 4px solid var(--series-1); }
.answer > :first-child { margin-top: 0; } .answer > :last-child { margin-bottom: 0; }
.heroes { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 16px 0; }
.tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
.tile-label { color: var(--text-secondary); font-size: 0.85rem; }
.tile-value { font-size: 1.6rem; font-weight: 600; margin: 2px 0; font-variant-numeric: tabular-nums; }
.tile-sub { color: var(--text-muted); font-size: 0.85rem; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 10px 0 0; }
.download, .actions button { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 0.9rem; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--axis); background: var(--surface-1); color: var(--text-primary); text-decoration: none; cursor: pointer; }
.download:hover, .actions button:hover { border-color: var(--text-muted); }
.download:focus-visible, .actions button:focus-visible { outline: 2px solid var(--series-1); outline-offset: 2px; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
figure { margin: 16px 0; }
figcaption { color: var(--text-secondary); font-size: 0.85rem; margin-top: 4px; max-width: 80ch; }
.chart { position: relative; }
.chart > svg { display: block; width: 100%; height: auto; overflow: visible; }
.legend svg { flex: none; }
.chart h3 { margin: 4px 0 2px; }
.axes .grid { stroke: var(--grid); stroke-width: 1; }
.axes .baseline { stroke: var(--axis); stroke-width: 1; }
.tick { fill: var(--text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.axis-label { fill: var(--text-secondary); font-size: 12px; }
.row-label { fill: var(--text-secondary); font-size: 12px; }
.row-label.strong { fill: var(--text-primary); font-weight: 600; }
.direct { fill: var(--text-secondary); font-size: 12px; font-weight: 600; paint-order: stroke; stroke: var(--surface-1); stroke-width: 4px; stroke-linejoin: round; }
.band { fill: var(--band); }
.band-label { fill: var(--text-muted); font-size: 11px; }
.marker-line { stroke: var(--text-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.line.s1, .legend .s1 { stroke: var(--series-1); } .line.s2, .legend .s2 { stroke: var(--series-2); } .line.muted, .legend .muted { stroke: var(--text-muted); }
.legend line { stroke-width: 2; }
.dot { stroke: var(--surface-1); stroke-width: 2; }
.dot.s1 { fill: var(--series-1); } .dot.s2 { fill: var(--series-2); } .dot.muted-fill { fill: var(--text-muted); }
.dot.faint { fill-opacity: 0.6; stroke-width: 1; }
.stem { stroke: var(--axis); stroke-width: 2; }
.hover-ring { fill: none; stroke: var(--text-primary); stroke-width: 1.5; }
.hit { fill: transparent; } .hit:hover { fill: var(--band); }
[data-tip] { cursor: default; }
circle[data-tip]:hover { stroke: var(--text-primary); }
.legend { list-style: none; display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; margin: 0 0 6px; font-size: 0.85rem; color: var(--text-secondary); }
.legend li { display: inline-flex; gap: 6px; align-items: center; }
.legend circle.s1 { fill: var(--series-1); stroke: none; } .legend circle.muted-fill { fill: var(--text-muted); stroke: none; }
.tip { position: fixed; pointer-events: none; background: var(--surface-1); border: 1px solid var(--border); box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14); border-radius: 8px; padding: 6px 10px; font-size: 0.85rem; z-index: 5; max-width: 320px; }
.tip[hidden] { display: none; }
.map { max-width: 640px; background: #fcfcfb; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; color-scheme: light; }
.map svg { display: block; width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
td:first-child { min-width: 9em; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--text-secondary); font-weight: 600; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.num { white-space: nowrap; }
.scroll { overflow-x: auto; }
ol.steps > li { margin-bottom: 10px; }
code { font-family: ui-monospace, monospace; font-size: 0.88em; }
.limits li { margin-bottom: 6px; }
@page { size: A4; margin: 14mm 12mm; }
@media print {
  :root {
    color-scheme: light;
    --page: #fff; --surface-1: #fff; --text-primary: #000; --text-secondary: #3d3c39; --text-muted: #6b6a66;
    --grid: #e1e0d9; --axis: #b5b3ab; --border: rgba(0, 0, 0, 0.18); --band: rgba(137, 135, 129, 0.16);
    --series-1: #2a78d6; --series-2: #eb6834; --critical: #d03b3b;
  }
  * { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  body { font-size: 10pt; }
  main { max-width: none; padding: 0; }
  h1 { font-size: 18pt; } h2 { font-size: 13pt; margin-top: 18pt; }
  h2, h3 { break-after: avoid; }
  figure, table, .tile, .card, .chart, tr { break-inside: avoid; }
  .pagebreak { break-before: page; }
  .noprint, .tip { display: none !important; }
  .scroll { overflow: visible; }
  .map { max-width: 125mm; margin: 0 auto; }
  .two { grid-template-columns: 1fr 1fr; }
  .heroes { grid-template-columns: repeat(4, 1fr); }
  .tile-value { font-size: 14pt; }
  a { color: inherit; }
  p, li { max-width: none; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;

const JS = `
(() => {
  const tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; tip.setAttribute("role", "status"); document.body.append(tip);
  const show = (el, x, y) => { tip.textContent = el.getAttribute("data-tip"); tip.hidden = false; const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, x + 12) + "px"; tip.style.top = (y - h - 12 < 4 ? y + 16 : y - h - 12) + "px"; };
  document.addEventListener("pointermove", e => { const el = e.target.closest && e.target.closest("[data-tip]"); if (el) show(el, e.clientX, e.clientY); else tip.hidden = true; });
  document.addEventListener("pointerleave", () => { tip.hidden = true; });
  document.addEventListener("keydown", e => { if (e.key === "Escape") tip.hidden = true; });
  const print = document.getElementById("print"); if (print) print.addEventListener("click", () => print && window.print());
  // (printed: every "the numbers" table open)
  let shut = [];
  addEventListener("beforeprint", () => { shut = [...document.querySelectorAll("details:not([open])")]; shut.forEach(d => d.open = true); });
  addEventListener("afterprint", () => { shut.forEach(d => d.open = false); shut = []; });
})();
`;

const icon = {
  download: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`,
  print: `<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`,
};

const dM = dDelay(design, "tomtom-morning"), dE = dDelay(design, "tomtom-evening");
const dT = (pk: string) => sign(Math.round(m(design, pk, "netTime") - m(today, pk, "netTime")));
const hM = check.morning.heldOut, hE = check.evening.heldOut;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Bistrița's peak-hour traffic inferred from TomTom, and one-way streets for the centre</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <p class="meta">trafficsim · <!--ticket-->ticket #321 · <!--/ticket-->built ${built} on commit ${commit} · plan “Bistrița Auto Search”, revision 101 · TomTom recorded 16–24 November 2026</p>
  <h1>Bistrița's peak-hour traffic inferred from TomTom, and one-way streets for the centre</h1>
  <p class="lede">TomTom records how fast traffic moves on each street, not how many cars there are. This report explains how the morning's and the evening's traffic were worked out from those speeds, and what the simulator found when the centre's streets were changed: two-way streets made one-way, one-way streets turned round or made two-way.</p>
  <div class="actions noprint">
    <!--download--><a class="download" href="?download" download="${DOWNLOAD_NAME}">${icon.download}Download this report</a><!--/download-->
    <button type="button" id="print">${icon.print}Print or save as PDF</button>
    <span class="meta">one HTML file that works offline; printed, it fits A4</span>
  </div>
</header>

<section aria-labelledby="h-short">
  <h2 id="h-short">In short</h2>
  <div class="heroes">
    <div class="tile"><div class="tile-label">Traffic inferred, morning peak</div><div class="tile-value">${fmt(total("morning"))} veh/h</div><div class="tile-sub">coming into the plan, ${PEAKS[0].hour}</div></div>
    <div class="tile"><div class="tile-label">Traffic inferred, evening peak</div><div class="tile-value">${fmt(total("evening"))} veh/h</div><div class="tile-sub">coming into the plan, ${PEAKS[1].hour}</div></div>
    <div class="tile"><div class="tile-label">Delay in the centre, with the change</div><div class="tile-value">${dM} / ${dE}</div><div class="tile-sub">morning / evening, the mean change over 6 fresh runs each</div></div>
    <div class="tile"><div class="tile-label">The cost</div><div class="tile-value">${dT("tomtom-morning")} s / ${dT("tomtom-evening")} s</div><div class="tile-sub">a trip across the town, morning / evening;</div><div class="tile-sub">evening collisions ${m(today, "tomtom-evening", "collisions").toFixed(1)} → ${m(design, "tomtom-evening", "collisions").toFixed(1)} a run</div></div>
  </div>
  <div class="card answer">
    <p><strong>How the traffic was inferred.</strong> The plan was run in trafficsim's own simulator, and the number of cars coming in and where they head were adjusted, round after round, until the simulated streets slowed down where TomTom shows them slow. Checked on roads the fitting never saw, the inferred traffic predicts congestion better than a guess from lane counts (error ${hM.start.loss.toFixed(3)} → ${hM.best.loss.toFixed(3)} in the morning, ${hE.start.loss.toFixed(3)} → ${hE.best.loss.toFixed(3)} in the evening), but it explains only part of the street-by-street pattern.</p>
    <p><strong>What to change.</strong> Of the ${opt.streets.length} streets in the centre, one change clearly helps: <strong>Str. Ecaterina Teodoroiu one-way, southbound, along its whole length</strong>. The centre's delay falls ${dM.replace("−", "by ")} in the morning and ${dE.replace("−", "by ")} in the evening, with ${pct(m(today, "tomtom-evening", "centreKm"), m(design, "tomtom-evening", "centreKm")).replace("−", "")} less traffic in the centre in the evening, at ${dT("tomtom-evening").slice(1)}–${dT("tomtom-morning").slice(1)} seconds more a trip across the town. It brings more collisions and stalls at the street's ends in the simulation, so those junctions need a look before it is built.</p>
  </div>
</section>

<section aria-labelledby="h-tomtom">
  <h2 id="h-tomtom">1. What TomTom recorded</h2>
  <p>From 16 November, trafficsim saved TomTom's traffic flow for the plan every 5 minutes, 06:00–09:00 and 16:00–19:00 local time: 575 snapshots up to 24 November, over 692 roads, each counted one way (a “way”). For each way TomTom gives the speed driven, and that speed as a share of its free-flow speed, the speed at night with no traffic. A share of 1 means no slowdown; 0.5 means traffic moves at half its free speed.</p>
  <div class="two">
${PEAKS.map(pk => `    <figure class="chart"><h3>${pk.name}</h3>${legend([{ cls: `s${pk.series}`, label: `weekdays (${profile.days.weekdays} days)` }, { cls: "muted", label: `weekend (${profile.days.weekends} days)`, dash: true }])}${profileChart(pk)}</figure>`).join("\n")}
  </div>
  <p>On weekdays the town is slowest at ${mLowT} in the morning (${Math.round(mLow * 100)}% of free flow) and at ${eLowT} in the evening (${Math.round(eLow * 100)}%); weekends stay close to free flow. The worst hours, <strong>${PEAKS[0].hour}</strong> and <strong>${PEAKS[1].hour}</strong>, are the two peaks studied. Recording starts at 16:00, so the evening peak may begin earlier.</p>
  <p>For each way and peak, the figure used is the median, over the weekdays, of each day's mean share during the worst hour. Only ways TomTom covers for at least half their length, on at least 3 weekdays, count: <strong>303 ways</strong>. Days agree closely, typically within ±0.06. The slowest are Str. Ioan Slavici and Str. Crinilor (about 0.2 of free flow in both peaks), Bd. Republicii heading south-west, and Calea Moldovei.</p>
</section>

<section aria-labelledby="h-infer" class="pagebreak">
  <h2 id="h-infer">2. From speeds to traffic: how it was inferred</h2>
  <p>Speeds don't say how many cars there are, so a model has to turn traffic into speeds. Here that model is the simulator itself: the traffic was adjusted until the simulated slowdowns matched TomTom's.</p>
  <ol class="steps">
    <li><strong>Free flow in the simulator.</strong> The plan was run with almost no traffic (6 runs of 40 minutes). Each way's mean speed then is its free-flow speed in the simulator, the counterpart of TomTom's night-time speed. 485 ways are driven, 269 of the 303 TomTom ones.</li>
    <li><strong>A demand with few numbers: a gravity model.</strong> Each of the plan's 70 ways in sends <em>P</em> vehicles an hour, and each of its 68 ways out draws a share <em>A</em>: a trip from <em>i</em> to <em>j</em> is <em>P<sub>i</sub> · A<sub>j</sub> / ΣA</em>, never back out by the road it came in on. That is 138 numbers a peak instead of 4,700 trip-table cells, which a few hundred speeds could never pin down. It started from 60 vehicles an hour per lane of each way in, each way out weighted by its lanes.</li>
    <li><strong>Simulate, compare, adjust, repeat.</strong> Each round, the peak's demand was run on 4 seeds (10 minutes to fill the town, 20 minutes measured). Every car's way in, way out and the ways it drove were recorded. For each TomTom way, the error is the simulated share of free flow minus TomTom's. Each way in's <em>P</em> and each way out's <em>A</em> was then moved by the mean error over the ways its cars drove (weighted by the cars, and by each way's length × TomTom's cover): a way too fast in the simulator gets more traffic from the places that feed it, a way too slow gets less. 14 rounds; the best is kept.</li>
    <li><strong>Daytime friction.</strong> Traffic alone can't make the simulated town as slow as TomTom says: before it gets there, the simulation starts to gridlock (33 deadlocks a run at 6,600 vehicles an hour, still 0.21 too fast on average). TomTom's free flow is the night's, and by day parked cars, people crossing, buses and bikes slow town streets whatever the traffic; the simulator models none of them. So one network-wide factor φ scales the simulated shares, fitted between 0.75 and 1, and the demand explains the rest. It settled at its floor, <strong>φ = 0.75</strong>: by day a street is taken to run at 75% of its night-time speed before any traffic slows it further. Likewise, a round where the simulation gridlocks takes 15% off every way in, since Bistrița doesn't gridlock every day.</li>
    <li><strong>Real or just fitted? Roads held out.</strong> The roads were split in two. The calibration ran on one half only and was scored on the other half, which it never saw.</li>
  </ol>
  <figure class="chart"><h3>The error on roads the calibration never saw, round by round</h3>${legend(PEAKS.map(pk => ({ cls: `s${pk.series}`, label: pk.name })))}${calibChart()}<figcaption>r is the correlation between TomTom's and the simulation's shares, road by road. Root-mean-square error of the share of free flow on the held-out roads; the ringed round is the one kept. Hover a point for the demand that round.</figcaption></figure>
  <div class="scroll"><table>
    <thead><tr><th>Held-out roads</th><th class="num">RMSE, start</th><th class="num">RMSE, fitted</th><th class="num">r, start</th><th class="num">r, fitted</th><th class="num">ways</th></tr></thead>
    <tbody>${PEAKS.map(heldRow).join("")}</tbody>
  </table></div>
  <p>On roads it never saw, the inferred demand predicts congestion better than the lane-count guess it started from, so it learnt something true about where Bistrița's peak traffic goes. But the gain is modest and the correlation stays around 0.3: most of the way-by-way pattern in TomTom's speeds is <em>not</em> explained by this demand on this plan. Likely reasons: friction that differs street by street (a school, a car park, a market), traffic lights not drawn in the plan, and TomTom's matching of short streets.</p>

  <h3>The demand delivered: the calibration on all the roads</h3>
  <div class="scroll"><table>
    <thead><tr><th></th><th class="num">Morning (${PEAKS[0].hour})</th><th class="num">Evening (${PEAKS[1].hour})</th></tr></thead>
    <tbody>
      <tr><td>Vehicles an hour coming in</td><td class="num">${fmt(total("morning"))}</td><td class="num">${fmt(total("evening"))}</td></tr>
      <tr><td>Fit on all ${check.morning.fit.n} ways, fresh runs: RMSE, correlation</td><td class="num">${check.morning.fit.loss.toFixed(3)}, ${check.morning.fit.corr.toFixed(2)}</td><td class="num">${check.evening.fit.loss.toFixed(3)}, ${check.evening.fit.corr.toFixed(2)}</td></tr>
      <tr><td>Trips from the town's edge / to it</td><td class="num">40% / 33%</td><td class="num">38% / 40%</td></tr>
      <tr><td>Trips starting in the centre</td><td class="num">10.5%</td><td class="num">13.6%</td></tr>
    </tbody>
  </table></div>
  <p>The morning comes into town and the evening leaves it, as commuting would. The busiest destination in both is Str. Mihai Eminescu. In the plan they are two demand matrices, “Morning peak (TomTom)” (07:00–09:30) and “Evening peak (TomTom)” (15:30–18:30).</p>
  <div class="two">
${PEAKS.map(pk => `    <figure class="chart"><h3>${pk.name}: each road, TomTom against the simulation</h3>${scatter(pk)}<figcaption>${check[pk.id].pts.length} ways; on the diagonal the simulation matches TomTom. RMSE ${check[pk.id].fit.loss.toFixed(3)}, correlation ${check[pk.id].fit.corr.toFixed(2)}, on 4 runs the calibration never used.</figcaption></figure>`).join("\n")}
  </div>
  <p>The simulation slows many of the roads TomTom shows jammed: Calea Moldovei, Bd. Decebal, Str. Năsăudului and Str. Cuza Vodă in the morning; Bd. Republicii and Str. Gării in the evening, which it slows more than TomTom does. But most roads sit near φ: the simulation barely slows them, while TomTom shows them anywhere from 0.3 to 1.</p>
</section>

<section aria-labelledby="h-opt" class="pagebreak">
  <h2 id="h-opt">3. Optimizing the centre: which streets to change</h2>
  <p><strong>The centre</strong> is the area inside Bd. Republicii, Bd. Gen. Grigore Bălan, Str. Ecaterina Teodoroiu, Str. Parcului, Str. Dogarilor and Str. Alexandru Odobescu: Piața Centrală, Piața Mică, Piața Unirii, Str. Dornei, Str. Nicolae Titulescu and so on. It has no traffic lights.</p>
  <p><strong>The changes allowed:</strong></p>
  <ul>
    <li>a two-lane two-way street (one lane each way) made one-way on both lanes, in either direction;</li>
    <li>a two-lane one-way street made one lane each way;</li>
    <li>a one-lane one-way street turned round.</li>
  </ul>
  <p>A change applies to a whole street, all its pieces of the same name joined end to end, since turning round half a one-way street would point the halves at each other. The candidates are the centre's ${opt.streets.length} named streets, not the boulevards around it. Each change rebuilds the turns at both ends of the street the way one would draw them (straight on lane to lane, left from the leftmost lane, right from the rightmost, no U-turns), and is <strong>refused</strong> when it would cut any trip off, or leave any lane in the plan with no way onto it or off it. Most single changes in the centre are refused because they would cut a pocket of streets off: ${opt.log[0].tried.filter((t: { key: string }) => t.key !== "today").length} are sound.</p>
  <p><strong>The score.</strong> Each design was run in both peaks, with today's layout on the same seeds. Its score is half the centre's delay (vehicle-hours lost an hour on its streets) and half the time per trip across the whole town, both against today: 1 is today, lower is better. A trip the town can't make counts as 10 minutes, so pushing traffic out of the centre can't win by stranding it. The search is greedy: each round it tries every sound change on top of those already kept, and keeps the best if it beats the current design by more than 0.01, about the runs' noise.</p>
  <figure class="chart"><h3>The search's first round: each change on its own</h3>${legend([{ cls: "s1", label: "kept", dot: true }, { cls: "muted-fill", label: "not kept", dot: true }])}${candidatesChart()}<figcaption>Mean over 2 seeds a peak, both peaks. Changes right of “today” make things worse.</figcaption></figure>
  <div class="scroll"><table>
    <thead><tr><th class="num">Round</th><th>Kept</th><th class="num">Score</th><th>Runner-up</th></tr></thead>
    <tbody>${searchRows}</tbody>
  </table></div>

  <h3>Checked on 6 fresh runs a peak</h3>
  <p>Seeds the search never used, so the result isn't the search's luck. Where two figures are given, they are morning / evening; a delay's change is the mean of each run's change against today on the same seed.</p>
  <div class="scroll"><table>
    <thead><tr><th></th><th class="num">Today</th><th class="num">Ecaterina Teodoroiu one-way</th><th class="num">+ Dogarilor turned round</th></tr></thead>
    <tbody>${finalRows.map(([label, f]) => `<tr><td>${label}</td><td class="num">${f(today)}</td><td class="num"><strong>${f(design)}</strong></td><td class="num">${f(plus)}</td></tr>`).join("")}</tbody>
  </table></div>
  <div class="two">
${PEAKS.map(pk => `    <figure class="chart"><h3>${pk.name}: the centre's delay on each run</h3>${legend([{ cls: "muted-fill", label: "today", dot: true }, { cls: "s1", label: "Ecaterina Teodoroiu one-way", dot: true }])}${seedsChart(pk)}</figure>`).join("\n")}
  </div>
  <ul>
    <li><strong>The evening</strong> gain shows on every run (${seedDelta("tomtom-evening")}).</li>
    <li><strong>The morning</strong> is noisier (${seedDelta("tomtom-morning")}). In the run that got worse, the junction of Bd. Republicii and Str. Gării gridlocked. It is outside the centre and unchanged, it is a weak spot today too, and the change sends no more traffic through it.</li>
    <li><strong>Str. Dogarilor turned round</strong>, on top, helps the evening more (${dDelay(plus, "tomtom-evening")}) but makes the morning worse and riskier (${dDelay(plus, "tomtom-morning")} on average, against ${dM} without it, with one run where the centre jammed). Its gain in score, about 0.01, is within the noise: a candidate to look at, not a recommendation.</li>
    <li><strong>The cost:</strong> collisions in the evening rise from ${m(today, "tomtom-evening", "collisions").toFixed(1)} to ${m(design, "tomtom-evening", "collisions").toFixed(1)} a run, and stalls the simulation had to break up itself rise in both peaks. Look at the street's two ends before building it.</li>
  </ul>

  <figure><h3>The change recommended</h3><div class="map">${mapSvg}</div>
  <figcaption>Str. Ecaterina Teodoroiu, on the centre's east side (red: its lanes as they would run, all southbound). The shaded area is the centre.</figcaption></figure>
  <p><strong>What it does.</strong> Str. Ecaterina Teodoroiu carries two lanes south, from Piața Unirii and Str. Liviu Rebreanu to Str. Zorilor and Str. Barbu Lăutaru. Northbound traffic takes the ring, Bd. Gen. Grigore Bălan, instead of crossing that corner. The centre carries ${pct(m(today, "tomtom-morning", "centreKm"), m(design, "tomtom-morning", "centreKm")).replace("−", "")}–${pct(m(today, "tomtom-evening", "centreKm"), m(design, "tomtom-evening", "centreKm")).replace("−", "")} fewer vehicle-kilometres, at a few seconds more a trip.</p>
</section>

<section aria-labelledby="h-plan">
  <h2 id="h-plan">4. In the plan</h2>
  <p>The two demand matrices and the change were delivered to the plan as agent patches. The first, #7, made only one piece of Ecaterina Teodoroiu one-way and also turned Str. Liviu Rebreanu round. It was wrong: the street goes on north in three short pieces, joined outside any drawn junction, that weren't taken as part of it, and two lanes were left with no way onto or off them. The rule that refuses such changes for every lane in the plan, not only the lanes turned, was added then, and the search was run again; the results above are that second search's. Patch #9 corrects #7: Ecaterina Teodoroiu one-way along its whole length, Liviu Rebreanu back as it was, the matrices kept. Applied, it leaves the plan with the same ways in and out as before, no trip cut off, and exactly the layout simulated here.</p>
  <p>The patches don't switch the demand in use: to see a peak, pick “Morning peak (TomTom)” or “Evening peak (TomTom)” in Demand, or “By the time of day” with the clock at 07:30 or 16:00.</p>
</section>

<section aria-labelledby="h-limits">
  <h2 id="h-limits">Limits</h2>
  <ul class="limits">
    <li>TomTom gives speeds. Turning speeds into traffic needs a model, here the simulator plus a gravity demand, and a different demand that slows the same roads would fit as well. The held-out test shows this one is better than a guess, but only modestly.</li>
    <li>The friction factor sits at its floor of 0.75, and the demand is capped where the simulation starts gridlocking. So the absolute numbers (about 5,300 vehicles an hour) are the simulator's, not a count. Real counts on a few roads would pin them down.</li>
    <li>The evening peak may start before 16:00, when the recording begins.</li>
    <li>The search changes one street at a time. Changes that only work together, such as a whole loop of one-way streets turned round, were not tried.</li>
    <li>The simulation leaves out pedestrians, parking and buses (beyond the friction factor), and the collisions and stalls it reports are the simulator's, not a safety assessment.</li>
  </ul>
  <p class="meta">Reproducible with <code>scripts/tomtom-321.ts</code> (stages fetch, free, calibrate, optimize, final, patch, figures) and checked by <code>npm run tomtom-321:check</code>; every run behind this report is in <code>docs/experiments/tomtom-321</code>.</p>
</section>
</main>
<script>${JS}</script>
</body>
</html>
`;
writeFileSync(OUT, html);
console.log(`${OUT}: ${(html.length / 1024).toFixed(0)} KB`);
