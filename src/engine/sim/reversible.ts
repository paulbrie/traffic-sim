import type { CCorridor } from "../compile";
import { DT, REV_STATES, type RevState, type RevStateCode } from "./base";
import { SimSignals } from "./signals";

/** the state that has a corridor's lane open to direction `d` */
const OPEN = (d: 1 | 2): RevStateCode => (d === 1 ? 1 : 3);
/** shortest time a clearing lane stays shut once it is empty, before it counts as closed (s) */
const CLEAR_MIN = 3;

/**
 * Reversible middle lanes: each corridor's lane is open to one direction at a time. What it should be
 * comes from the corridor's mode (a timer, the traffic each way, or set by hand) or a command; getting
 * there always goes through closing: its entries shut, the vehicles in it drive out, then it stays
 * closed for the corridor's gap before opening either way.
 */
export abstract class SimReversible extends SimSignals {
  /**
   * Set what a corridor's lane should be, overriding its mode ("auto" hands back to the mode). The page
   * does this through the plan's settings (PlanSettings.revHold), so it is kept with the plan.
   */
  reversibleCommand(idx: number, cmd: "closed" | "1" | "2" | "auto") {
    const c = this.net.corridors[idx];
    if (!c) return;
    const hold = { ...(this.settings.revHold ?? {}) };
    if (cmd === "auto") delete hold[c.def.id]; else hold[c.def.id] = cmd;
    this.settings = { ...this.settings, revHold: hold };
  }
  /** a corridor's state for the page: code (see REV_STATES), seconds in it, vehicles in the lane, density each way, set by hand */
  reversibleState(idx: number) {
    const st = this.revs[idx];
    return st ? { state: st.state, t: (this.tick - st.since) * DT, inside: st.inside, density: st.density, hold: st.hold } : null;
  }

  protected updateReversibles() {
    const cs = this.net.corridors;
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], st = this.revs[i], t = (this.tick - st.since) * DT;
      st.hold = this.settings.revHold?.[c.def.id] ?? null;
      if (c.def.mode === "dynamic" && this.tick % 50 === 0) st.density = [this.density(c, 1), this.density(c, 2)];
      if (st.state === 2 || st.state === 4) {
        // clearing: done once nobody is left in the lane
        if (this.tick % 5 === 0) st.inside = this.inLane(c);
        if (st.inside === 0 && t >= CLEAR_MIN) this.setRev(c, st, 0, "closed: the lane is empty");
        continue;
      }
      const want = st.hold ?? this.revTarget(c, st, t);
      if (st.state === 0) {
        if (want !== "closed" && t >= c.def.gap) this.setRev(c, st, OPEN(want === "1" ? 1 : 2), `opens to direction ${want}${st.hold ? " (set by hand)" : ""}`);
      } else {
        const open: "1" | "2" = st.state === 1 ? "1" : "2";
        if (want !== open) { st.inside = this.inLane(c); this.setRev(c, st, st.state === 1 ? 2 : 4, `closing to direction ${open}${st.hold ? " (set by hand)" : ""}: entries shut, ${st.inside} vehicle${st.inside === 1 ? "" : "s"} still in the lane`); }
      }
    }
  }
  /** what the corridor's mode wants now */
  private revTarget(c: CCorridor, st: RevState, t: number): "closed" | "1" | "2" {
    const d = c.def;
    if (d.mode === "manual") return d.initial;
    if (d.mode === "timer") {
      const dur = (x: 1 | 2) => (x === 1 ? d.open1 : d.open2);
      if (st.state === 1 || st.state === 3) {
        const x: 1 | 2 = st.state === 1 ? 1 : 2, o: 1 | 2 = x === 1 ? 2 : 1;
        if (dur(x) > 0 && t < dur(x)) return x === 1 ? "1" : "2";
        if (dur(o) > 0) return o === 1 ? "1" : "2";
        return dur(x) > 0 ? (x === 1 ? "1" : "2") : "closed";
      }
      // closed: the other way from last time (or the same way, when only that one has time)
      const o: 1 | 2 = st.last === 1 ? 2 : 1;
      return dur(o) > 0 ? (o === 1 ? "1" : "2") : dur(st.last) > 0 ? (st.last === 1 ? "1" : "2") : "closed";
    }
    // dynamic: open to the busier direction once it is busy; switch when the other is clearly busier
    const [d1, d2] = st.density;
    if (st.state === 0) return Math.max(d1, d2) >= d.minDensity ? (d1 >= d2 ? "1" : "2") : "closed";
    const x: 1 | 2 = st.state === 1 ? 1 : 2, dx = x === 1 ? d1 : d2, dOther = x === 1 ? d2 : d1, keep = x === 1 ? "1" : "2";
    if (t < d.minOpen) return keep;
    if (dOther >= d.minDensity && dOther >= d.ratio * dx) return x === 1 ? "2" : "1";
    if (dx < d.minDensity / 2 && dOther < d.minDensity / 2) return "closed";
    return keep;
  }
  private setRev(c: CCorridor, st: RevState, state: RevStateCode, why: string) {
    st.state = state; st.since = this.tick;
    if (state === 1) st.last = 1; else if (state === 3) st.last = 2;
    if (this.logAll || c.links.some(l => this.logLinks.has(l.id))) {
      this.events.push({ t: Math.round(this.tick) / 10, node: "", link: c.links[0].id, veh: null, vkind: null, kind: "reversible", detail: `${c.def.name}: ${REV_STATES[state]} · ${why}` });
      if (this.events.length > 60000) this.events.splice(0, 10000);
    }
  }
  /** vehicles in the corridor's middle lane, or crossing a junction into or out of it */
  protected inLane(c: CCorridor): number {
    let n = 0;
    for (const v of this.vehicles) {
      if (v.dead) continue;
      const p = v.piece;
      if (p.kind === "lane") { if (p.lane === 0 && p.edge.corr === c.idx && p.edge.rev) n++; }
      else if (p.kind === "conn" && ((p.inEdge.corr === c.idx && p.inLane === 0 && p.inEdge.rev) || (p.outEdge.corr === c.idx && p.outLane === 0 && p.outEdge.rev))) n++;
    }
    return n;
  }
  /** vehicles per km per lane going direction `d` along the corridor (its middle lane counts when open that way) */
  private density(c: CCorridor, d: 1 | 2): number {
    const st = this.revs[c.idx], withRev = st.state === OPEN(d) || st.state === OPEN(d) + 1;
    let n = 0, laneKm = 0;
    for (const e of c.edges[d - 1]) {
      for (const lp of e.lanes) {
        if (lp.lane === 0 && e.rev && !withRev) continue;
        n += this.index.get(lp.id)?.length ?? 0;
        laneKm += lp.len / 1000;
      }
    }
    return laneKm > 0 ? n / laneKm : 0;
  }
}
