import type { CFlow, CLine, CNode, Edge } from "../compile";
import { DT, KIND_PARAMS, type Kind, type Dest, type Vehicle } from "./base";
import { SimMotion } from "./motion";

/** Demand: vehicles entering the plan (at entry points, buildings or along roads) and buses on their lines. */
export abstract class SimDemand extends SimMotion {
  // ------------------------------------------------------------ spawning
  protected makeVehicle(kind: Kind): Vehicle {
    const r = this.rng;
    const P = KIND_PARAMS(kind, r);
    return {
      id: this.nextId++, kind, ...P, tint: (r() * 6) | 0,
      route: [], ri: 0, piece: this.net.pieces[0], s: 0, v: 0, acc: 0, lane: 0, queue: [], trail: [],
      conn: null, granted: false, dest: { kind: "gateway", node: this.net.nodes[0] }, state: "free", wait: 0,
      enterT: this.tick, bornT: this.tick, gap: Infinity, leader: null, v0: 10,
      reroutes: 0, laneChanges: 0, lcCool: 0, lcOff: 0, lcT: 0,
      reqAt: 0, reqFor: null, stoppedAt: null, fixedAt: null, rerouteAt: null,
      line: null, stopIdx: 0, pax: 0, cap: 50, dwell: 0, dead: false, metered: false, flow: -1,
    };
  }
  protected randomEdge(): Edge | null {
    if (this.totalLen <= 0) return null;
    let x = this.rng() * this.totalLen;
    for (let i = 0; i < this.net.edges.length; i++) { x -= this.edgeWeights[i]; if (x <= 0) return this.net.edges[i]; }
    return this.net.edges[this.net.edges.length - 1];
  }
  /**
   * A trip end inside the plan: at a building (by trip weight) when the plan has any, otherwise
   * anywhere along the roads (by length).
   */
  protected randomPlace(): { edge: Edge; s: number } | null {
    const n = this.placeCum.length, total = n ? this.placeCum[n - 1] : 0;
    if (total > 0) {
      const x = this.rng() * total;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.placeCum[mid] < x) lo = mid + 1; else hi = mid; }
      return this.pick(this.net.places[lo].opts);
    }
    // (checks before drawing s keep the random sequence of plans without buildings unchanged)
    const edge = this.randomEdge();
    if (!edge || edge.length < 8 || edge.busOnly) return null;
    return { edge, s: edge.length * (0.2 + this.rng() * 0.6) };
  }
  /** share of trips that start (and end) at entry points rather than inside the plan */
  protected throughShare(leaving: boolean) {
    const t = this.settings.through;
    if (typeof t === "number") return t;
    return this.placeCum.length ? 0.3 : leaving ? 0.6 : 0.65;
  }
  /** a vehicle entering the plan; with `flow`, at that transit flow's entry point, bound for its exit */
  protected spawnGeneral(kind: Kind, gate?: CNode, flow?: CFlow): boolean {
    const r = this.rng;
    let edge: Edge | null = null, s = 0, v0 = 0;
    const auto = this.gateways.filter(g => g.def.inflow == null);
    const fromGate = !!gate || (auto.length > 0 && r() < this.throughShare(false));
    if (fromGate) {
      const g = gate ?? this.pick(auto);
      edge = g.arms[0].outEdge;
      if (!edge || edge.busOnly) return false;
      v0 = Math.min(9, edge.speed);
    } else {
      const at = this.randomPlace();
      if (!at || at.edge.length < 8 || at.edge.busOnly) return false;
      edge = at.edge; s = at.s;
    }
    const maxL = kind === "bus" ? edge.n - 1 : Math.max(0, edge.n - (edge.bus ? 2 : 1));
    const lane = (r() * (maxL + 1)) | 0;
    const piece = edge.lanes[lane];
    const sOnLane = s * (piece.len / Math.max(1e-6, edge.length));
    if (!this.laneClear(piece, sOnLane, fromGate ? 14 : 12)) return false;
    let dest: Dest;
    const exits = flow ? [] : this.gateways.filter(g => g !== edge!.from && (g.def.exitWeight ?? 1) > 0);
    if (flow) dest = { kind: "gateway", node: flow.to };
    else if (exits.length && r() < this.throughShare(true)) dest = { kind: "gateway", node: this.pickWeighted(exits, g => g.def.exitWeight ?? 1) };
    else {
      const at = this.randomPlace(); if (!at || at.edge.length < 8 || at.edge.busOnly) return false;
      dest = { kind: "edge", edge: at.edge, s: at.s };
    }
    let route: Edge[];
    if (dest.kind === "edge" && dest.edge === edge && dest.s > sOnLane + 10) route = [edge];
    else {
      const rest = this.plan(edge, dest);
      if (!rest) { if (flow) this.flowState[flow.idx].noRoute++; return false; }
      route = [edge, ...rest];
    }
    const v = this.makeVehicle(kind);
    v.route = route; v.ri = 0; v.piece = piece; v.s = sOnLane; v.v = v0; v.lane = lane; v.dest = dest;
    v.metered = !!gate;
    if (flow) { v.flow = flow.idx; this.flowState[flow.idx].sent++; }
    this.applySplit(v);
    this.vehicles.push(v); this.addToIndex(v);
    if (fromGate) { const id = edge.from.def.id; this.entered.set(id, (this.entered.get(id) ?? 0) + 1); }
    return true;
  }
  /** entry points with a set flow: Poisson arrivals, queued while the entry lane is full */
  protected meteredSpawns() {
    const share = this.settings.trucks / Math.max(1, this.settings.cars + this.settings.trucks);
    for (const g of this.gateways) {
      const rate = g.def.inflow;
      if (rate == null || rate <= 0) continue;
      let q = this.backlog.get(g) ?? 0;
      if (this.rng() < (rate / 60) * DT) q = Math.min(30, q + 1);
      if (q > 0 && this.vehicles.length < 30000 && this.spawnGeneral(this.rng() < share ? "truck" : "car", g)) q--;
      this.backlog.set(g, q);
    }
    // transit flows: Poisson arrivals at the entry point, queued while its lane is full
    for (const f of this.net.flows) {
      const st = this.flowState[f.idx];
      if (f.def.rate <= 0) continue;
      if (this.rng() < (f.def.rate / 3600) * DT) st.backlog = Math.min(200, st.backlog + 1);
      if (st.backlog > 0 && this.vehicles.length < 30000 && this.spawnGeneral(this.rng() < (f.def.trucks ?? 0) ? "truck" : "car", f.from, f)) st.backlog--;
    }
  }
  protected spawnBus(line: CLine, k: number): boolean {
    if (line.stops.length < 2) return false;
    k = this.lineStart(line, k);
    const stop = line.stops[k];
    const e = stop.edge, lane = e.n - 1, piece = e.lanes[lane];
    const s = stop.s * (piece.len / Math.max(1e-6, e.length));
    if (!this.laneClear(piece, s, 16)) return false;
    const v = this.makeVehicle("bus");
    v.line = line; v.stopIdx = k;
    v.route = [e]; v.ri = 0; v.piece = piece; v.s = s; v.lane = lane; v.dest = { kind: "stop", stop };
    v.dwell = 2;
    this.vehicles.push(v); this.addToIndex(v);
    return true;
  }
  protected spawnLoop() {
    let cars = 0, trucks = 0;
    const busesPerLine = new Map<CLine, number>();
    this.meteredSpawns();
    for (const v of this.vehicles) if (!v.dead && !v.metered) {
      if (v.kind === "car") cars++; else if (v.kind === "truck") trucks++;
      else if (v.line) busesPerLine.set(v.line, (busesPerLine.get(v.line) || 0) + 1);
    }
    // fill up faster when far below the target (large plans with thousands of vehicles)
    if (this.tick % 2 === 0) for (let k = Math.min(40, 1 + Math.floor((this.settings.cars - cars) / 150)); k > 0 && cars < this.settings.cars; k--) { if (this.spawnGeneral("car")) cars++; }
    else for (let k = Math.min(20, 1 + Math.floor((this.settings.trucks - trucks) / 150)); k > 0 && trucks < this.settings.trucks; k--) { if (this.spawnGeneral("truck")) trucks++; }
    if (this.tick % 20 === 0) for (const line of this.net.lines) {
      const have = busesPerLine.get(line) || 0;
      if (have < line.def.buses) this.spawnBus(line, Math.floor((have * line.stops.length) / Math.max(1, line.def.buses)));
      else if (have > line.def.buses) { const b = this.vehicles.find(v => !v.dead && v.line === line); if (b) this.kill(b, "removed"); }
    }
    if (this.tick % 10 === 0) for (const s of this.net.stops) if (this.rng() < 0.12) s.waiting = Math.min(80, s.waiting + 1);
  }
}
