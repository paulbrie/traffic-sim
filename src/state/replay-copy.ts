/**
 * The replay moment as text to paste into a conversation (with a developer, or an assistant): which plan
 * and revision, the moment, and what is on screen then — vehicles (where, which way, how fast, doing what),
 * the lights, parking and crossings in view — plus the logged events around it and what is selected. The
 * plan itself is not included: its id and revision identify it.
 */
import { junctionRefs, isJunction } from "@/engine/refs";
import { bayPose } from "@/engine/parking";
import { settings$, ui } from "./store";
import { simController } from "./sim-controller";
import { viewport } from "./commands";

/** at most this many vehicles and events (the nearest to the middle of the view, the nearest in time) */
const MAX_VEHICLES = 400, MAX_EVENTS = 1500, EVENT_WINDOW = 60;
const r1 = (x: number) => Math.round(x * 10) / 10;

export function replayMomentText(): string {
  const sim = simController.sim, c = simController.compiled, u = ui.getValue();
  if (!sim) return "";
  const live = !simController.replay, tick = simController.replay?.tick ?? sim.tick, t = tick / 10;
  // what is in view (with a margin)
  const m = 20, x0 = viewport.cx - viewport.wm / 2 - m, x1 = viewport.cx + viewport.wm / 2 + m, y0 = viewport.cy - viewport.hm / 2 - m, y1 = viewport.cy + viewport.hm / 2 + m;
  const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const vehicles = sim.vehicles
    .map(v => ({ v, x: (v.fx + v.rx) / 2, y: (v.fy + v.ry) / 2 }))
    .filter(o => inView(o.x, o.y))
    .sort((a, b) => Math.hypot(a.x - viewport.cx, a.y - viewport.cy) - Math.hypot(b.x - viewport.cx, b.y - viewport.cy))
    .slice(0, MAX_VEHICLES)
    .map(({ v, x, y }) => ({ id: v.id, kind: v.kind, state: v.state, x: r1(x), y: r1(y), heading: Math.round((Math.atan2(v.fy - v.ry, v.fx - v.rx) * 180) / Math.PI), kmh: Math.round(v.v * 3.6), len: r1(v.len) }));
  const refs = junctionRefs(c);
  const lights = c.nodes.filter(n => isJunction(n) && n.def.control === "lights" && inView(n.pos.x, n.pos.y) && refs.has(n.def.id)).map(n => {
    const st = sim.nodeState(n.idx);
    return { junction: refs.get(n.def.id), node: n.def.id, phase: st.phase, stage: ["green", "yellow", "all red"][st.stage] ?? st.stage, inStage: r1(st.t) };
  });
  const parking = c.parking.filter(p => p.bays.some((_, i) => { const q = bayPose(p, i); return inView(q.x, q.y); })).map(p => ({
    row: p.def.id, kind: p.def.kind, road: p.def.link, dir: p.def.dir, bays: p.bays.length,
    taken: p.bays.map((_, i) => (sim.parked(p.idx, i) ? 1 : 0)).join(""), stats: sim.parkingStats(p.idx),
  }));
  const crossings = c.crossings.filter(x => inView((x.def.a.x + x.def.b.x) / 2, (x.def.a.y + x.def.b.y) / 2)).map(x => ({ crossing: x.def.id, ...sim.crossingStats(x.idx) }));
  const events = sim.events.filter(e => Math.abs(e.t - t) <= EVENT_WINDOW).slice(-MAX_EVENTS);
  const data = {
    plan: u.planId, revision: u.save.revision, settings: settings$.getValue(),
    moment: { time: r1(t), tick, live, recorded: { from: simController.rec.from / 10, to: simController.rec.to / 10 } },
    view: { cx: r1(viewport.cx), cy: r1(viewport.cy), width: r1(viewport.wm), height: r1(viewport.hm) },
    selection: u.selection, stats: { ...sim.stats, history: undefined },
    vehicles, lights, parking, crossings,
    events: events.length ? events : "none logged (switch on the event log for junctions or roads to have them)",
  };
  return `Traffic replay at ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")} (${live ? "live" : "replay"}) · plan ${u.planId} rev ${u.save.revision}\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\`\n`;
}
