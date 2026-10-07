import type { CFlow, CLine, CNode, CZone, CZoneFlow, Edge } from "../compile";
import { mulberry32 } from "../geom";
import { DT, KIND_PARAMS, emptyXMemo, type Kind, type Dest, type ParkingStats, type Vehicle } from "./base";
import { PARKING } from "../types";
import { SimMotion } from "./motion";

/** Demand: vehicles entering the plan (at entry points, buildings or along roads) and buses on their lines. */
export abstract class SimDemand extends SimMotion {
  // ------------------------------------------------------------ spawning
  protected makeVehicle(kind: Kind): Vehicle {
    const r = this.rng;
    const P = KIND_PARAMS(kind, r, this.P);
    // every field set here, in one order, so all vehicles share one object shape (fast property access)
    return {
      id: this.nextId++, kind, len: P.len, width: P.width, pref: P.pref, aggressive: P.aggressive, a: P.a, b: P.b, bmax: P.bmax, T: P.T, s0: P.s0, politeness: P.politeness,
      tint: (r() * 6) | 0,
      route: [], ri: 0, piece: this.net.pieces[0], s: 0, v: 0, acc: 0, lane: 0, queue: [], trail: [],
      conn: null, granted: false, dest: { kind: "gateway", node: this.net.nodes[0] }, state: "free", wait: 0,
      enterT: this.tick, bornT: this.tick, jam: 0, broken: 0, brokenAt: 0, gap: Infinity, leader: null, v0: 10,
      reroutes: 0, laneChanges: 0, lcCool: 0, lcOff: 0, lcT: 0, lcBy: undefined, blendT: 0, stuckAt: undefined, parkSince: undefined,
      reqAt: 0, reqFor: null, stoppedAt: null, fixedAt: null, rerouteAt: null,
      line: null, stopIdx: 0, pax: 0, cap: 50, dwell: 0, dead: false, metered: false, flow: -1, zflow: -1, goal: null,
      test: undefined, logState: undefined, splits: undefined, xm: [emptyXMemo(), emptyXMemo()], xmNext: 0,
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
  /** a trip end in a zone: one of its entry points, or (by trip weight) one of its buildings; half each when it has both */
  protected zoneEnd(z: CZone): { gate: CNode } | { at: { edge: Edge; s: number } } | null {
    const useEntry = z.entries.length > 0 && (z.places.length === 0 || this.rng() < 0.5);
    if (useEntry) return { gate: this.pick(z.entries) };
    if (!z.places.length || z.placeW <= 0) return null;
    const p = this.pickWeighted(z.places, x => x.w);
    return { at: this.pick(p.opts) };
  }

  /** one trip of zone-to-zone demand */
  /**
   * The lane a new vehicle starts in: the one picked, unless that lane can't take its first turn and a
   * lane that can (the nearest) has room at the same spot (no extra random draws, so runs stay as they were).
   */
  protected startLane(edge: Edge, route: Edge[], lane: number, lo: number, hi: number, s: number, room: number, len = 4.6) {
    let ln = lane, pc = edge.lanes[lane], sl = s * (pc.len / Math.max(1e-6, edge.length));
    const m0 = route[1] ? this.moveOf(edge, route[1]) : undefined;
    if (m0 && (ln < m0.lo || ln > m0.hi)) {
      const want = Math.min(Math.max(ln, Math.max(lo, m0.lo)), Math.min(hi, m0.hi));
      if (want !== ln && want >= lo && want <= hi) {
        const wp = edge.lanes[want], ws = s * (wp.len / Math.max(1e-6, edge.length));
        if (this.laneClear(wp, ws, room, len)) { ln = want; pc = wp; sl = ws; }
      }
    }
    return { ln, pc, sl };
  }
  protected spawnZoneTrip(f: CZoneFlow): boolean {
    const st = this.zoneFlowState[f.idx];
    const o = this.zoneEnd(f.from), d = this.zoneEnd(f.to);
    if (!o || !d) return false;
    let edge: Edge | null, s = 0, v0 = 0;
    if ("gate" in o) { edge = o.gate.arms[0].outEdge; v0 = edge ? Math.min(9, edge.speed) : 0; }
    else { edge = o.at.edge; s = o.at.s; }
    if (!edge || edge.busOnly || edge.length < 8) return false;
    const kind: Kind = this.rng() < (f.def.trucks ?? 0) ? "truck" : "car";
    const [lo, hi] = entryLanes(edge, kind), lane = lo + ((this.rng() * (hi - lo + 1)) | 0), piece = edge.lanes[lane];
    const sOnLane = s * (piece.len / Math.max(1e-6, edge.length));
    if (!this.laneClear(piece, sOnLane, "gate" in o ? 14 : 12)) return false;
    const dest: Dest = "gate" in d ? { kind: "gateway", node: d.gate } : { kind: "edge", edge: d.at.edge, s: d.at.s };
    if (dest.kind === "gateway" && dest.node === edge.from) return false;
    let route: Edge[];
    if (dest.kind === "edge" && dest.edge === edge && dest.s > sOnLane + 10) route = [edge];
    else {
      const rest = this.plan(edge, dest);
      if (!rest) { st.noRoute++; return false; }
      route = [edge, ...rest];
    }
    const { ln, pc, sl } = this.startLane(edge, route, lane, lo, hi, s, "gate" in o ? 14 : 12);
    const v = this.makeVehicle(kind);
    v.route = route; v.ri = 0; v.piece = pc; v.s = sl; v.v = v0; v.lane = ln; v.dest = dest;
    v.metered = true; v.zflow = f.idx; v.goal = dest; st.sent++;
    this.vehicles.push(v); this.addToIndex(v); this.logAppear(v);
    if ("gate" in o) this.countGate(edge.from.def.id, "in");
    return true;
  }

  /**
   * A test vehicle: a car entering at entry point `from` in lane `lane` of the entry road (counted
   * from the left; default: the kerb-side through lane), routed to entry / exit point `to`. It
   * doesn't count towards the plan's car total and uses its own random numbers, so the rest of the
   * run goes on as it would have. Returns its id, or why it can't go.
   */
  sendTest(from: string, to: string, lane?: number): { id: number } | { error: string } {
    const g = this.net.nodeById.get(from), d = this.net.nodeById.get(to);
    if (!g?.gateway || !d?.gateway) return { error: "Both ends must be entry / exit points." };
    if (g === d) return { error: "Pick two different points." };
    const edge = g.arms[0].outEdge;
    if (!edge || edge.busOnly) return { error: "No lane leads into the plan there." };
    const [lo, hi] = entryLanes(edge, "car"), ln = Math.min(hi, Math.max(lo, lane ?? hi));
    const piece = edge.lanes[ln];
    if (!this.laneClear(piece, 0, 8)) return { error: "That entry lane is full right now; try again in a moment." };
    const dest: Dest = { kind: "gateway", node: d };
    const rest = this.plan(edge, dest);
    if (!rest) return { error: "There is no way from there to there." };
    const rng = this.rng;
    this.rng = mulberry32(0x7e57 + this.tests.length);
    const v = this.makeVehicle("car");
    this.rng = rng;
    v.route = [edge, ...rest]; v.ri = 0; v.piece = piece; v.s = 0; v.v = Math.min(9, edge.speed); v.lane = ln; v.dest = dest; v.goal = dest;
    v.metered = true; v.test = this.tests.length;
    this.tests.push({ id: v.id, from, to, lane: ln, sentAt: this.tick * DT, done: null, time: 0 });
    this.vehicles.push(v); this.addToIndex(v); this.logAppear(v);
    return { id: v.id };
  }

  /** road event logs: a vehicle appearing on a logged road (entering the plan, from a building, a test vehicle, a bus) */
  protected logAppear(v: Vehicle) {
    if (v.piece.kind !== "lane" || (!this.logLinks.size && !this.vehLogged(v))) return;
    const e = v.piece.edge;
    this.evRoad(e, v, "appear", `${v.s < 1 && e.from.gateway ? "enters the plan" : `starts ${v.s.toFixed(0)} m along`}${v.test !== undefined ? " (test vehicle)" : ""}, heading for ${v.dest.kind === "gateway" ? this.nodeName(v.dest.node) : v.dest.kind === "stop" ? "a bus stop" : v.dest.edge.link.name || v.dest.edge.link.id}`);
  }

  /** a vehicle entering the plan; with `flow`, at that transit flow's entry point, bound for its exit */
  protected spawnGeneral(kind: Kind, gate?: CNode, flow?: CFlow): boolean {
    const r = this.rng;
    let edge: Edge | null = null, s = 0, v0 = 0;
    const auto = this.gateways.filter(g => g.def.inflow == null);
    const fromGate = !!gate || (auto.length > 0 && r() < this.throughShare(false));
    // (every trip through entry points: none starts along a road, even with no entry point free to use)
    if (!fromGate && this.throughShare(false) >= 1) return false;
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
    const [lo, hi] = entryLanes(edge, kind);
    const lane = lo + ((r() * (hi - lo + 1)) | 0);
    const piece = edge.lanes[lane];
    const sOnLane = s * (piece.len / Math.max(1e-6, edge.length));
    const len = kind === "car" ? 4.6 : 12;
    if (!this.laneClear(piece, sOnLane, fromGate ? 14 : 12, len)) return false;
    let dest: Dest;
    const exits = flow ? [] : this.gateways.filter(g => g !== edge!.from && (g.def.exitWeight ?? 1) > 0);
    if (flow) dest = { kind: "gateway", node: flow.to };
    else if (exits.length && r() < this.throughShare(true)) dest = { kind: "gateway", node: this.pickWeighted(exits, g => g.def.exitWeight ?? 1) };
    else {
      // (every trip through entry points: none ends along a road either)
      if (this.throughShare(true) >= 1) return false;
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
    const { ln, pc, sl } = this.startLane(edge, route, lane, lo, hi, s, fromGate ? 14 : 12, len);
    const v = this.makeVehicle(kind);
    v.route = route; v.ri = 0; v.piece = pc; v.s = sl; v.v = v0; v.lane = ln; v.dest = dest;
    v.metered = !!gate;
    if (flow) { v.flow = flow.idx; this.flowState[flow.idx].sent++; }
    this.applySplit(v);
    this.vehicles.push(v); this.addToIndex(v); this.logAppear(v);
    if (fromGate) this.countGate(edge.from.def.id, "in");
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
    // zone-to-zone demand: Poisson arrivals at the origin zone, each trip bound for the destination zone
    for (const f of this.net.zoneFlows) {
      const st = this.zoneFlowState[f.idx];
      if (this.rng() < (f.def.rate / 3600) * DT) st.backlog = Math.min(500, st.backlog + 1);
      if (st.backlog > 0 && this.vehicles.length < 30000 && this.spawnZoneTrip(f)) st.backlog--;
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
    const e = stop.edge, lane = e.kerb, piece = e.lanes[lane];
    const s = stop.s * (piece.len / Math.max(1e-6, e.length));
    if (!this.laneClear(piece, s, 16)) return false;
    const v = this.makeVehicle("bus");
    v.line = line; v.stopIdx = k;
    v.route = [e]; v.ri = 0; v.piece = piece; v.s = s; v.lane = lane; v.dest = { kind: "stop", stop };
    v.dwell = 2;
    this.vehicles.push(v); this.addToIndex(v); this.logAppear(v);
    return true;
  }
  // ------------------------------------------------------------ parking
  /**
   * Rows of parking bays: cars set off for a row at its rate (its usual share of bays taken over the
   * average stay, so it stays about that full), each with a free bay kept for it (none free: it doesn't
   * come); cars whose stay is over pull out when the lane by the bay is clear. Own random numbers.
   */
  protected parkingStep() {
    this.net.parking.forEach((row, r) => {
      const st = this.parks[r], occ = row.def.occupancy ?? PARKING.occupancy, stay = (row.def.stay ?? PARKING.stay) * 60;
      if (this.parkRng() < ((occ * row.bays.length) / stay) * DT) st.queue = Math.min(20, st.queue + 1);
      if (st.queue > 0 && this.vehicles.length < 30000) {
        const free: number[] = [];
        for (let i = 0; i < st.until.length; i++) if (st.until[i] === 0) free.push(i);
        if (!free.length) { st.full++; st.queue--; }
        else if (this.spawnParker(r, free[(this.parkRng() * free.length) | 0])) st.queue--;
      }
      // (one car pulls out per row and tick)
      for (let i = 0; i < st.until.length; i++) if (st.until[i] > 0 && this.tick >= st.until[i]) { if (this.spawnLeaver(r, i)) break; }
    });
  }
  /** where a parking trip starts or ends: an entry point (by the plan's through share) or a place inside the plan, by the row's own random numbers */
  protected parkEnd(): { gate: CNode } | { at: { edge: Edge; s: number } } | null {
    const r = this.parkRng, gates = this.gateways.filter(g => (g.def.exitWeight ?? 1) > 0);
    if (gates.length && r() < this.throughShare(false)) return { gate: gates[(r() * gates.length) | 0] };
    // (every trip through entry points: parking trips too)
    if (this.throughShare(false) >= 1) return null;
    const n = this.placeCum.length, total = n ? this.placeCum[n - 1] : 0;
    if (total > 0) {
      const x = r() * total;
      let lo = 0, hi = n - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (this.placeCum[mid] < x) lo = mid + 1; else hi = mid; }
      const opts = this.net.places[lo].opts;
      return { at: opts[(r() * opts.length) | 0] };
    }
    if (this.totalLen <= 0) return gates.length ? { gate: gates[(r() * gates.length) | 0] } : null;
    let x = r() * this.totalLen;
    for (let i = 0; i < this.net.edges.length; i++) {
      x -= this.edgeWeights[i];
      if (x <= 0) { const e = this.net.edges[i]; return e.length < 8 || e.busOnly ? null : { at: { edge: e, s: e.length * (0.2 + r() * 0.6) } }; }
    }
    return null;
  }
  /** a car (made with the parking random numbers, so the rest of the run goes on as it would) */
  protected parkCar(): Vehicle {
    const rng = this.rng;
    this.rng = this.parkRng;
    const v = this.makeVehicle("car");
    this.rng = rng;
    v.metered = true;
    return v;
  }
  /** a car setting off to park in bay `bay` of row `r` (kept for it) */
  protected spawnParker(r: number, bay: number): boolean {
    const row = this.net.parking[r], o = this.parkEnd();
    if (!o) return false;
    let edge: Edge | null, s = 0, v0 = 0;
    if ("gate" in o) { edge = o.gate.arms[0].outEdge; v0 = edge ? Math.min(9, edge.speed) : 0; }
    else { edge = o.at.edge; s = o.at.s; }
    if (!edge || edge.busOnly || edge.length < 8) return false;
    const [lo, hi] = entryLanes(edge, "car"), lane = lo + ((this.parkRng() * (hi - lo + 1)) | 0), piece = edge.lanes[lane];
    const sOnLane = s * (piece.len / Math.max(1e-6, edge.length));
    if (!this.laneClear(piece, sOnLane, "gate" in o ? 14 : 12)) return false;
    // (it drives to where its path into the bay leaves the lane)
    const dest: Dest = { kind: "edge", edge: row.edge, s: row.access[bay].sIn };
    let route: Edge[];
    if (row.edge === edge && dest.s > sOnLane + 10) route = [edge];
    else {
      const rest = this.plan(edge, dest);
      if (!rest) return false;
      route = [edge, ...rest];
    }
    const { ln, pc, sl } = this.startLane(edge, route, lane, lo, hi, s, "gate" in o ? 14 : 12);
    const v = this.parkCar();
    v.route = route; v.ri = 0; v.piece = pc; v.s = sl; v.v = v0; v.lane = ln; v.dest = dest; v.goal = dest;
    v.park = { row: r, bay }; this.parks[r].until[bay] = -1;
    this.vehicles.push(v); this.addToIndex(v); this.logAppear(v);
    if ("gate" in o) this.countGate(edge.from.def.id, "in");
    return true;
  }
  /** the car in bay `bay` of row `r` pulls out (the lane by the bay clear) and drives off; the bay is free */
  protected spawnLeaver(r: number, bay: number): boolean {
    const row = this.net.parking[r], e = row.edge, st = this.parks[r];
    // (it ends its way out with its front here, in the lane its way out leads to; it waits for its gap in its bay)
    const acc = row.access[bay], lane = acc.outLane, piece = e.lanes[lane], s = acc.sOut * (piece.len / Math.max(1e-6, e.length));
    // where it drives off to: a trip end as any (an entry / exit point, by the plan's through share), else the
    // first exit it can reach (the one at the end of its own road at least); none at all: it stays parked a
    // minute more and tries again (a parked car never just vanishes)
    const routeTo = (dest: Dest): Edge[] | null => {
      if (dest.kind === "edge" && dest.edge === e && dest.s > acc.sOut + 10) return [e];
      const rest = this.plan(e, dest);
      return rest ? [e, ...rest] : null;
    };
    let dest: Dest | null = null, route: Edge[] | null = null;
    const d = this.parkEnd();
    if (d) { dest = "gate" in d ? { kind: "gateway", node: d.gate } : { kind: "edge", edge: d.at.edge, s: d.at.s }; route = routeTo(dest); }
    if (!route) {
      const exits = this.gateways.filter(g => (g.def.exitWeight ?? 1) > 0), start = (this.parkRng() * Math.max(1, exits.length)) | 0;
      for (let k = 0; k < exits.length && !route; k++) { dest = { kind: "gateway", node: exits[(start + k) % exits.length] }; route = routeTo(dest); }
    }
    if (!route || !dest) { st.until[bay] = this.tick + 600; return false; }
    st.left++;
    // (the bay stays taken until the car is out of it)
    st.until[bay] = -2;
    const v = this.parkCar();
    v.route = route; v.ri = 0; v.piece = piece; v.s = s; v.v = 0; v.lane = lane; v.dest = dest; v.goal = dest;
    v.bayMove = { row: r, bay, way: "out", s: 0, inLane: false, go: false };
    this.vehicles.push(v); this.addToIndex(v); this.logAppear(v);
    return true;
  }
  /** per bay of every row (rows in order): 1 where a car is parked */
  parkedFlags(): Uint8Array {
    const out = new Uint8Array(this.parks.reduce((n, st) => n + st.until.length, 0));
    let k = 0;
    for (const st of this.parks) for (const u of st.until) out[k++] = u > 0 ? 1 : 0;
    return out;
  }
  /** a row of parking bays' numbers (null = no such row) */
  parkingStats(r: number): ParkingStats | null {
    const st = this.parks[r];
    if (!st) return null;
    let taken = 0, coming = 0;
    for (const u of st.until) { if (u > 0 || u === -2) taken++; else if (u === -1) coming++; }
    return { bays: st.until.length, taken, coming, parked: st.parked, left: st.left, full: st.full };
  }
  protected spawnLoop() {
    if (this.parks.length) this.parkingStep();
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
      else if (have > line.def.buses) { const b = this.vehicles.find(v => !v.dead && v.line === line); if (b) this.kill(b, "removed", false); }
    }
    if (this.tick % 10 === 0) for (const s of this.net.stops) if (this.rng() < 0.12) s.waiting = Math.min(80, s.waiting + 1);
  }
}

/** lanes a vehicle may start in: the through lanes (bays open further on), not the bus lane unless it is a bus */
function entryLanes(e: Edge, kind: Kind): [number, number] {
  // (not a lane that ends further on, nor a reversible middle lane: vehicles change into that where it's open)
  const lo = e.left + (e.dropLane === e.left || e.rev ? 1 : 0), hi = e.left + e.thru - 1 - (e.dropLane >= 0 && e.dropLane !== e.left ? 1 : 0);
  return [lo, kind !== "bus" && e.bus ? Math.max(lo, hi - 1) : hi];
}
