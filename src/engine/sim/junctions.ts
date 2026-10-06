import { conflicts, conflictEnd, throughConns, zipFrom, type CNode, type Conn, type Edge, type Piece } from "../compile";
import { DT, type Vehicle, type Occ, type NodeState, type PedCross, type Req, type CrossInfo } from "./base";
import { SimReversible } from "./reversible";


/** Junctions: who may enter (reservations of conflicting paths, stop and give-way signs, lights), roundabout entry, per-junction statistics. */
export abstract class SimJunctions extends SimReversible {
  /** a crossing nothing else at its junction crosses or joins: driven through without stopping or asking */
  protected drivesThrough(p: Piece): boolean {
    return p.kind === "conn" && p.role === "turn" && throughConns(this.net, p.node).has(p);
  }
  /** the reservations held at a junction: at its node, or over all the nodes it spans (see CNode.cluster) */
  protected occOf(st: NodeState): Occ[] {
    const cl = st.node.cluster;
    return cl.length === 1 ? st.occ : cl.flatMap(k => this.ns[k.idx].occ);
  }
  /** may go on into the junction ahead: let in, or driving through it */
  protected mayGo(u: Vehicle): boolean {
    if (u.granted && u.conn) return true;
    if (u.piece.kind !== "lane") return false;
    const c = this.crossingFor(u, u.ri, u.lane);
    return !!c && this.drivesThrough(c[0]);
  }
  /** all-way stop, or a stop sign on this approach to a priority junction */
  protected mustStop(node: CNode, e: Edge) {
    // (a junction drawn by hand: its road ends each have one road)
    if (!node.controlled || (node.degree < 2 && !node.hand)) return false;
    return node.def.control === "stop" || (node.def.control === "priority" && e.sign === "stop");
  }
  // ------------------------------------------------------------ pedestrians
  // (P.pedWalk: seconds at the start of a red in which pedestrians may step out; P.pedYield: seconds
  // held-up traffic gets at a zebra before the next group)
  /** the crossing of arm `k` at node `n` (a zebra on a plain road has one crossing for both sides) */
  protected pedCross(n: CNode, k: number): PedCross | undefined {
    const list = this.peds[n.idx];
    return list.length ? list[n.degree === 2 ? 0 : k] : undefined;
  }
  /** time (s) a group takes to cross the road of arm `k`, walking at 1.2 m/s */
  protected pedTime(n: CNode, k: number) { const a = n.arms[k]; return (a.hi - a.lo) / 1.2 + 1.5; }
  /**
   * Pedestrians arrive at each crossing at random (the junction's rate per hour), wait at the kerb,
   * and cross as a group: at traffic lights early in their road's red (the "walk" time: after that
   * it's "don't walk", so turning traffic gets through); elsewhere they have priority, so no new
   * vehicle may drive over the crossing once they are waiting, except that the vehicles held up by
   * a group get a few seconds to go before the next group steps out. Either way they step out only
   * once the vehicles already in the junction on that road have cleared.
   */
  protected updatePeds() {
    for (const st of this.ns) {
      const n = st.node, list = this.peds[n.idx];
      if (!list.length) continue;
      const lights = n.def.control === "lights", p1 = (n.peds / 3600) * DT;
      list.forEach((p, k) => {
        if (this.pedRng() < p1) { if (!p.waiting) p.since = this.tick; p.waiting++; }
        if (p.crossing && this.tick >= p.until) p.crossing = 0;
        const arms = n.degree === 2 ? [0, 1] : [k];
        const red = lights && arms.every(a => !n.arms[a].inEdge || this.signalFor(n.idx, a) === "red");
        if (lights) { if (!red) p.redSince = -1; else if (p.redSince < 0) p.redSince = this.tick; }
        if (!p.waiting || p.crossing) { p.claim = false; return; }
        // at lights: only in the walk time at the start of this road's red (both sides of a crossing
        // on a plain road); elsewhere: not until the traffic held up by the last group has had a go
        const allowed = lights ? red && (this.tick - p.redSince) * DT < this.P.pedWalk : this.tick >= p.until + this.P.pedYield / DT;
        p.claim = allowed;
        if (!allowed) return;
        const busy = st.occ.some(o => arms.includes(o.conn.inEdge.inArm) || (o.conn.outEdge.from === n && arms.includes(o.conn.outEdge.outArm)));
        if (busy) return;
        p.crossing = p.waiting; p.from = this.tick; p.until = this.tick + Math.ceil(this.pedTime(n, arms[0]) / DT);
        p.crossed += p.waiting; p.waitSum += p.waiting * (this.tick - p.since) * DT;
        p.waiting = 0; p.claim = false;
      });
    }
  }
  /**
   * Pedestrians at the crossings drawn by hand: they arrive at random, wait at the kerb and cross as a
   * group, as at a junction's crossings (see updatePeds): at lights early in the red of the straight-on
   * traffic over the crossing, elsewhere with priority. They step out once nothing is on the crossing,
   * nor too close to stop for them, nor let through the junction over it.
   */
  protected updateCrossings() {
    this.crosses.forEach((info, k) => {
      const c = this.net.crossings[k], def = c.def, p = info.ped;
      if (this.pedRng() < (def.peds / 3600) * DT) { if (!p.waiting) p.since = this.tick; p.waiting++; }
      if (p.crossing && this.tick >= p.until) p.crossing = 0;
      const lights = !!info.lit && info.through.length > 0;
      const red = lights && info.through.every(x => this.connSignal(x) === "red");
      if (lights) { if (!red) p.redSince = -1; else if (p.redSince < 0) p.redSince = this.tick; }
      if (!p.waiting || p.crossing) { p.claim = false; return; }
      const allowed = lights ? red && (this.tick - p.redSince) * DT < this.P.pedWalk : this.tick >= p.until + this.P.pedYield / DT;
      p.claim = allowed;
      if (!allowed || this.crossingBusy(info)) return;
      p.crossing = p.waiting; p.from = this.tick; p.until = this.tick + Math.ceil((c.len / 1.2 + 1.5) / DT);
      p.crossed += p.waiting; p.waitSum += p.waiting * (this.tick - p.since) * DT;
      p.waiting = 0; p.claim = false;
    });
  }
  /** a vehicle is on the crossing, too close to stop before it, or let through a junction over it */
  protected crossingBusy(info: CrossInfo): boolean {
    for (const o of info.on) {
      for (const u of this.index.get(o.piece.id) ?? []) {
        if (u.dead) continue;
        if (u.s - u.len < o.s1 + 0.5 && u.s > o.s0 - 0.5) return true;
        if (u.s <= o.s0 && u.v > 1 && o.s0 - u.s < (u.v * u.v) / (2 * u.b) + 1) return true;
      }
      if (o.piece.kind === "conn") {
        const n = o.piece.node;
        for (const k of n.cluster) for (const x of this.ns[(k.lead ?? k).idx].occ) if (x.conn === o.piece && !(x.entered && x.v.piece !== o.piece)) return true;
      }
    }
    return false;
  }
  /** pedestrians are on, or have claimed, a crossing drawn by hand over this connector (or just past it, on its exit lane) */
  protected handCrossingBlocks(c: Conn): boolean {
    if (!this.crosses.length) return false;
    const exit = c.outEdge.lanes[c.outLane];
    for (const [piece, near] of [[c, Infinity], [exit, 15]] as const) {
      for (const o of this.crossOn.get(piece.id) ?? []) {
        if (o.s0 > near) continue;
        const p = this.crosses[o.k].ped;
        if (p.crossing > 0 || p.claim) return true;
      }
    }
    return false;
  }
  /** pedestrians are on, or have claimed, a crossing this connector drives over */
  protected pedBlocks(n: CNode, c: Conn): boolean {
    if (this.handCrossingBlocks(c)) return true;
    if (!this.peds[n.idx].length) return false;
    for (const k of c.outEdge.from === n ? [c.inEdge.inArm, c.outEdge.outArm] : [c.inEdge.inArm]) {
      const p = this.pedCross(n, k);
      if (p && (p.crossing > 0 || p.claim)) return true;
    }
    return false;
  }
  /** pedestrians at a crossing drawn by hand (net.crossings index): crossed, average wait (s), waiting now, crossing now and how far (0..1) */
  crossingStats(k: number): { crossed: number; avgWait: number; waiting: number; crossing: number; progress: number } | null {
    const p = this.crosses[k]?.ped;
    if (!p) return null;
    return { crossed: p.crossed, avgWait: p.crossed ? p.waitSum / p.crossed : 0, waiting: p.waiting, crossing: p.crossing, progress: p.crossing ? Math.min(1, (this.tick - p.from) / Math.max(1, p.until - p.from)) : 0 };
  }
  /** pedestrians who crossed at node `idx` and their average wait (s), or null where there are none */
  pedStats(idx: number): { crossed: number; avgWait: number; waiting: number } | null {
    const list = this.peds[idx];
    if (!list?.length) return null;
    const crossed = list.reduce((a, p) => a + p.crossed, 0), sum = list.reduce((a, p) => a + p.waitSum, 0);
    return { crossed, avgWait: crossed ? sum / crossed : 0, waiting: list.reduce((a, p) => a + p.waiting, 0) };
  }
  /** each crossing at node `idx`: arm, people waiting, people crossing and how far across (0..1) */
  pedView(idx: number): { arm: number; waiting: number; crossing: number; progress: number }[] {
    return (this.peds[idx] ?? []).map((p, k) => ({ arm: k, waiting: p.waiting, crossing: p.crossing, progress: p.crossing ? Math.min(1, (this.tick - p.from) / Math.max(1, p.until - p.from)) : 0 }));
  }

  /** at a priority junction, approaches with a yield or stop sign give way to the others */
  protected minor(node: CNode, e: Edge) { return node.def.control === "priority" && !!e.sign; }
  /**
   * Crossings that vehicles on the major (unsigned) approaches of `node` will use within the
   * next few seconds. Minor approaches must not start a conflicting move in front of them.
   */
  protected majorTraffic(node: CNode): Conn[] {
    const out: Conn[] = [];
    for (const arm of node.cluster.length === 1 ? node.arms : node.cluster.flatMap(k => k.arms)) {
      const e = arm.inEdge;
      if (!e || e.sign) continue;
      for (const lp of e.lanes) {
        const list = this.index.get(lp.id); if (!list) continue;
        for (const u of list) {
          if (u.dead || u.route[u.ri] !== e) continue;
          // queued priority traffic that is standing still lets minor traffic in (zip merging)
          if (u.v < 3 && !u.granted) continue;
          const dist = lp.len - u.s, eta = dist / Math.max(u.v, 2);
          if (dist > 70 || eta > this.P.priorityHorizon) continue;
          const cross = this.crossingFor(u, u.ri, u.lane);
          if (cross && cross[0].kind === "conn") out.push(cross[0] as Conn);
        }
      }
    }
    return out;
  }
  /** gap acceptance for joining a roundabout ring at entry `c` */
  protected canEnterRing(v: Vehicle, c: Conn): boolean {
    // (a two-lane roundabout: the lane this entry joins)
    const n = c.node, lane = c.ringLane ?? 0, ring = lane ? n.ring2! : n.ring!, m = ring.length, k = c.arm;
    // only the front vehicle of its lane may commit
    for (const u of this.index.get(v.piece.id) || []) if (u !== v && u.s > v.s) return false;
    // one vehicle at a time per arm (and ring lane): nobody else entering or committed to enter here
    for (const u of this.ringClaims.get(n) ?? []) {
      if (u === v || u.dead) continue;
      if (u.piece.kind === "conn" && u.piece.role === "entry" && u.piece.node === n && u.piece.arm === k && (u.piece.ringLane ?? 0) === lane) return false;
      if (u.granted && u.conn && u.conn.role === "entry" && u.conn.node === n && u.conn.arm === k && (u.conn.ringLane ?? 0) === lane && u.piece.kind === "lane") return false;
    }
    // keep the ring from filling up (it would lock itself)
    let onRing = 0, circ = 0;
    for (const ra of ring) { circ += ra.pass.len + ra.between.len; onRing += (this.index.get(ra.pass.id)?.length || 0) + (this.index.get(ra.between.id)?.length || 0); }
    if (onRing + 1 > Math.max(2, Math.floor(circ / 11))) return false;
    const pass = ring[k].pass, prevBetween = ring[(k + 1) % m].between;
    const critical = this.P.ringGap;
    for (const u of this.index.get(pass.id) || []) {
      const d = pass.len - u.s;
      if (d < 8 || d / Math.max(u.v, 1) < critical) return false;
    }
    for (const u of this.index.get(prevBetween.id) || []) {
      const nextPiece = u.queue[0];
      if (nextPiece && nextPiece.kind === "conn" && nextPiece.role === "exit" && nextPiece.arm === k) continue; // leaving before us
      const d = prevBetween.len - u.s + pass.len;
      if (d < 8 || d / Math.max(u.v, 1) < critical) return false;
    }
    // room just after the merge point
    const between = ring[k].between;
    for (const u of this.index.get(between.id) || []) if (u.s - u.len < v.len + 2) return false;
    return true;
  }
  // ------------------------------------------------------------ junctions
  protected arbitrate(st: NodeState) {
    st.occ = st.occ.filter(o => {
      const v = o.v;
      if (v.dead) return false;
      // someone cut in ahead of a waiting grant holder (a late lane change): it must queue again
      if (!o.entered && v.piece.kind === "lane" && v.piece.edge === o.conn.inEdge) {
        const ahead = (this.index.get(v.piece.id) ?? []).some(u => u !== v && !u.dead && u.s > v.s && !this.mayGo(u));
        if (ahead) { this.ev(st.node, v, "revoke", "a vehicle cut in ahead in the same lane"); v.granted = false; v.conn = null; return false; }
      }
      if (v.piece === o.conn) { o.entered = true; return true; }
      if (!o.entered) return (v.conn === o.conn && v.granted) || (v.early?.conn === o.conn && v.early.granted);
      return v.piece.kind === "lane" && v.piece.edge === o.conn.outEdge && v.trail[0] === o.conn && v.s <= v.len + 1;
    });
    // a grant not yet used: how far the vehicle is from the line (on the road into the junction, or
    // asked early from before it), and taking it back
    const toLine = (o: Occ) => {
      const v = o.v;
      if (v.piece.kind === "lane" && v.piece.edge === o.conn.inEdge) return v.piece.len - v.s;
      return v.early?.conn === o.conn ? v.early.d : null;
    };
    const takeBack = (o: Occ) => { if (o.v.early?.conn === o.conn) o.v.early.granted = false; else { o.v.granted = false; o.v.conn = null; } };
    // at traffic lights a green-light grant is only a promise: if the light changes before the
    // vehicle reaches the stop line, it must stop unless it is too close to do so safely
    if (this.lit(st.node)) {
      st.occ = st.occ.filter(o => {
        if (o.entered || o.sneak) return true;
        const v = o.v, d = toLine(o);
        if (d === null) return true;
        const sig = this.connSignal(o.conn);
        if (sig === "green" || sig === null) return true;
        if (!this.mustGoOnSignal(v, d, sig)) { this.ev(st.node, v, "revoke", `light turned ${sig} ${d.toFixed(0)} m before the line; stops`); takeBack(o); return false; }
        return true;
      });
    }
    // give way / stop: a minor-road grant is withdrawn if priority traffic turns up before the
    // vehicle has committed (it can still stop comfortably at the line)
    const n0 = st.node;
    const signedNode = n0.def.control === "priority" && n0.cluster.some(k => k.arms.some(a => a.inEdge?.sign));
    const majorNow = signedNode ? this.majorTraffic(n0) : [];
    if (majorNow.length) {
      st.occ = st.occ.filter(o => {
        if (o.entered || !this.minor(n0, o.conn.inEdge)) return true;
        const v = o.v, d = toLine(o);
        if (d === null) return true;
        if (!majorNow.some(b => conflicts(o.conn, b) || (b.outEdge === o.conn.outEdge && b.outLane === o.conn.outLane))) return true;
        if (this.mustGoOnSignal(v, d, "yellow")) return true;
        this.ev(n0, v, "revoke", "priority traffic arrived; waits again"); takeBack(o); return false;
      });
    }
    if (!st.req.size) return;
    const reqs = [...st.req.values()];
    st.req.clear();
    const n = st.node, lights = this.lit(n);
    // free: vehicles waiting at the line take turns in arrival order (every entering lane gets its
    // go, like a zip), then the rest by distance; one still on its way can't jump the waiting ones
    const free = n.def.control === "free";
    const atLine = (r: Req) => r.d < this.P.freeQueue;
    if (lights) reqs.sort((a, b) => (a.conn.move.turn === "L" ? 1 : 0) - (b.conn.move.turn === "L" ? 1 : 0) || a.at - b.at || a.v.id - b.v.id);
    else if (free) reqs.sort((a, b) => +!atLine(a) - +!atLine(b) || (atLine(a) ? a.at - b.at : a.d - b.d) || a.v.id - b.v.id);
    else reqs.sort((a, b) => a.at - b.at || a.v.id - b.v.id);
    // priority junction with signed approaches: majors go first, minors wait for a gap
    const signed = signedNode;
    if (signed) reqs.sort((a, b) => (this.minor(n, a.conn.inEdge) ? 1 : 0) - (this.minor(n, b.conn.inEdge) ? 1 : 0));
    const major = majorNow;
    const blockers: Conn[] = [];
    const log = this.logging(n);
    const deny = (v: Vehicle, why: string) => {
      if ((!log && !this.vehLogged(v)) || this.lastDeny.get(v.id) === why) return;
      this.lastDeny.set(v.id, why);
      const code = why.startsWith("path") ? "conflict" : why.startsWith("crosses") ? "queue-conflict" : why.startsWith("gives") ? "give-way" : why.startsWith("no room") ? "exit-full" : why.includes("light") ? "signal" : "other";
      this.ev(n, v, "deny", why, { code });
    };
    const held = this.occOf(st);
    const who = (c: Conn) => { const o = held.find(x => x.conn === c); return o ? `#${o.v.id} (${this.mv(c)})` : this.mv(c); };
    for (const r of reqs) {
      const c = r.conn;
      let sneak = false;
      if (lights) {
        const sig = this.connSignal(c);
        // a permissive turn waiting at the line for oncoming traffic clears on the yellow / all-red
        // of its own phase, once oncoming traffic has stopped (the conflict checks below still apply)
        sneak = sig !== "green" && this.greenIn(c, st.phase) && (c.move.turn === "L" || c.move.turn === "U")
          && r.d < 4 && r.v.v < 1 && this.tick - r.at > 30;
        if (sig !== "green" && !sneak && !this.mustGoOnSignal(r.v, r.d, sig)) { deny(r.v, `${sig} light`); continue; }
      }
      // pedestrians on (or about to step onto) the crossing it would drive over
      if (this.pedBlocks(n, c)) { deny(r.v, "waits for pedestrians on the crossing"); continue; }
      let ok = true, why = "", yielded = false;
      for (const o of held) if (conflicts(c, o.conn) && !this.pastConflict(o, c, r)) { ok = false; why = log ? `path crosses ${who(o.conn)}` : ""; break; }
      if (ok) for (const b of blockers) if (conflicts(c, b)) { ok = false; why = log ? `crosses the path of a vehicle ahead in the queue (${this.mv(b)})` : ""; break; }
      if (ok && signed && this.minor(n, c.inEdge)) {
        // giving way means not crossing *or* joining the lane in front of priority traffic
        // (traffic in another lane of the road it joins doesn't matter)
        const clash = (b: Conn) => conflicts(c, b) || (b.outEdge === c.outEdge && b.outLane === c.outLane);
        for (const b of major) if (clash(b)) { ok = false; yielded = true; why = log ? `gives way to priority traffic (${this.mv(b)})` : ""; break; }
        if (ok) for (const o of held) if (!o.conn.inEdge.sign && clash(o.conn)) { ok = false; yielded = true; why = log ? `gives way to #${o.v.id} (${this.mv(o.conn)})` : ""; break; }
      }
      // a vehicle that can't go because its exit is full, or because it gives way, does not hold up
      // the others behind it in arrival order (keep the junction moving: "don't block the box")
      let holdsQueue = !yielded;
      if (ok && !this.exitRoom(st, c, r.v)) { ok = false; holdsQueue = false; why = log ? `no room on the exit (${c.outEdge.link.name || c.outEdge.link.id} lane ${c.outLane + 1})` : ""; }
      if (ok) {
        if (r.early) { if (r.v.early?.conn !== c) continue; r.v.early.granted = true; } else { r.v.conn = c; r.v.granted = true; }
        const occ: Occ = { v: r.v, conn: c, entered: false, sneak };
        st.occ.push(occ); if (held !== st.occ) held.push(occ);
        if (log || this.vehLogged(r.v)) { this.lastDeny.delete(r.v.id); this.ev(n, r.v, "grant", `${this.mv(c)} · ${r.d.toFixed(0)} m from the line, waited ${((this.tick - r.at) / 10).toFixed(1)} s${sneak ? " · clears on the change (oncoming stopped)" : ""}`, this.md(c.move, c.inLane, c.outLane)); }
      } else { if ((!free || atLine(r)) && holdsQueue) blockers.push(c); deny(r.v, why); }
    }
  }
  /**
   * The vehicle holding `o` has already driven past the part of its path that crosses `c` (its rear
   * is beyond it), so `c` is free as far as it is concerned: traffic on a green may go behind it
   * instead of waiting for it to leave the junction.
   */
  protected pastConflict(o: Occ, c: Conn, r?: Req): boolean {
    if (!o.entered) return false;
    const v = o.v;
    // free junction, both joining the same exit lane: follow it in (zip) once it is far enough
    // ahead, counted in distance to the exit lane as the car-following does
    if (r && c.node.def.control === "free" && isFinite(zipFrom(o.conn, c))) {
      const front = v.piece === o.conn ? v.s : v.trail[0] === o.conn ? o.conn.len + v.s : -Infinity;
      const gap = c.len + r.d - (o.conn.len - front) - v.len;
      return gap > 2 + this.P.zipHeadway * r.v.v;
    }
    const end = conflictEnd(o.conn, c);
    if (!isFinite(end)) return false;
    const front = v.piece === o.conn ? v.s : v.trail[0] === o.conn ? o.conn.len + v.s : -Infinity;
    return front - v.len > end + 1;
  }
  reservations(): Conn[] { const out: Conn[] = []; for (const st of this.ns) for (const o of st.occ) out.push(o.conn); return out; }
  /** live numbers for one junction (for labels and the inspector) */
  junctionStats(nodeIdx: number) {
    const n = this.net.nodes[nodeIdx];
    // (a junction drawn by hand: its leading node speaks for all its road ends)
    const all = this.handNodes(n);
    const since = this.tick - 600;
    let recentN = 0;
    for (const k of all) { const recent = this.nodeRecent[k.idx] ?? []; while (recent.length && recent[0] < since) recent.shift(); recentN += recent.length; }
    const window = Math.min(60, Math.max(1, this.time));
    const approaches = all.flatMap(k => k.arms).filter(a => a.inEdge).map(a => {
      const e = a.inEdge!;
      let waiting = 0, queueM = 0;
      for (const lp of e.lanes) for (const v of this.index.get(lp.id) ?? []) {
        if (v.dead || v.v > 1.5) continue;
        const d = lp.len - v.s;
        if (d > 250) continue;
        waiting++; queueM = Math.max(queueM, d + v.len);
      }
      return { link: e.link, dir: e.dir, waiting, queueM };
    });
    return {
      through: all.reduce((s, k) => s + (this.nodeThrough[k.idx] ?? 0), 0),
      perMin: (recentN * 60) / window,
      waiting: approaches.reduce((s, a) => s + a.waiting, 0),
      approaches,
    };
  }
}
