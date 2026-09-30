import type { CLine, CNode, Conn, Edge, LanePiece, Piece } from "../compile";
import { DT, LOOK, NO_PIECES, type Dest, type Vehicle } from "./base";
import { SimJunctions } from "./junctions";

/** Driving: each vehicle's acceleration against what lies ahead (IDM), lane changes (MOBIL-style), moving along pieces, buses at their stops. */
export abstract class SimMotion extends SimJunctions {
  protected think(v: Vehicle) {
    v.lcCool -= DT;
    if (v.lcT > 0) v.lcT = Math.max(0, v.lcT - DT / 1.4);
    if (v.dwell > 0) { v.state = "boarding"; v.acc = 0; v.leader = null; v.gap = Infinity; return; }

    let acc = -v.s, gap = Infinity, lv = 0, leader: Vehicle | null = null;
    let stopD = Infinity, stopKind: "junction" | "stop" | null = null, brake = Infinity;
    let pendConn: Conn | null = null, pendD = 0;
    const curLim = this.lim(v, v.piece);

    // walk pieces ahead
    let p: Piece | null = v.piece, ri = v.ri, lane = v.lane, first = true;
    // pieces still to come on the current crossing: q[qi..]
    let q: readonly Piece[] = v.queue, qi = 0;
    while (p && acc < LOOK) {
      // leaders on this piece (plus vehicles on sibling connectors from the same entry lane,
      // and vehicles about to merge onto a roundabout ring stretch)
      if (!leader) {
        const list = p.kind === "conn" && p.role !== "exit" ? this.groupIndex.get(p.entryKey) : this.index.get(p.id);
        if (list) for (const u of list) {
          if (u === v) continue;
          if (first && !(u.s > v.s || (u.s === v.s && u.id > v.id))) continue;
          const gg = acc + u.s - u.len;
          if (gg < gap) { gap = gg; lv = u.v; leader = u; }
        }
        const vp = v.piece;
        const mergingHere = vp.kind === "conn" && vp.role === "entry" && p.kind === "ring" && vp.node === p.node && ringOf(p.node, vp.ringLane)[vp.arm].between === p;
        if (p.kind === "ring" && p.part === "between" && !first && !mergingHere) {
          const ring = ringOf(p.node, p.lane);
          for (const u of this.ringClaims.get(p.node) ?? []) {
            if (u === v || u.piece.kind !== "conn" || u.piece.role !== "entry" || u.piece.node !== p.node || (u.piece.ringLane ?? 0) !== p.lane || ring[u.piece.arm].between !== p) continue;
            if (u.s < u.piece.len - 4) continue;
            const gg = acc + (u.s - u.piece.len) - u.len;
            if (gg < gap) { gap = gg; lv = u.v; leader = u; }
          }
        }
        // two-lane roundabout, both lanes leaving into the same exit lane (or crossings of a free
        // junction joining the same exit lane): zip in by who is nearer the end
        if (p.kind === "conn" && (p.role === "exit" ? !!p.node.ring2 : p.role === "turn" && p.node.def.control === "free")) {
          const mine = acc + p.len; // acc starts at -v.s: this is the distance left to the end
          for (const o of p.node.conns.values()) {
            if (o === p || o.role !== p.role || o.outEdge !== p.outEdge || o.outLane !== p.outLane || (p.role === "exit" && o.ringLane === p.ringLane) || o.entryKey === p.entryKey) continue;
            for (const u of this.index.get(o.id) ?? []) {
              const theirs = o.len - u.s;
              if (theirs > mine || (theirs === mine && u.id > v.id)) continue;
              const gg = mine - theirs - u.len;
              if (gg < gap) { gap = gg; lv = u.v; leader = u; }
            }
          }
        }
      }
      if (!first) {
        const vl = this.lim(v, p);
        if (vl < v.v) { const need = (vl * vl - v.v * v.v) / (2 * Math.max(acc, 1)); if (need < brake) brake = need; }
      }
      // bus stop on this lane piece
      if (p.kind === "lane" && v.dest.kind === "stop" && p.edge === v.dest.stop.edge && ri === v.route.length - 1) {
        const sOn = v.dest.stop.s * (p.len / Math.max(1e-6, p.edge.length));
        const d = acc + sOn;
        if (d > -0.5 && d < stopD) { stopD = d; stopKind = "stop"; }
      }
      const endD = acc + p.len;
      // what comes after this piece?
      if (p.kind === "lane") {
        const e = p.edge;
        const cross = this.crossingFor(v, ri, lane);
        if (!cross) break; // route ends on this edge (exit or destination)
        const node = e.to, c0 = cross[0] as Conn;
        if (node.controlled && !(first && v.granted && v.conn === c0)) {
          if (first) { pendConn = c0; pendD = endD; }
          if (endD < stopD) { stopD = endD; stopKind = "junction"; }
          break;
        }
        p = cross[0]; q = cross; qi = 1;
      } else if (qi < q.length) {
        p = q[qi++];
      } else if (p.kind === "conn") {
        const np: LanePiece = p.outEdge.lanes[p.outLane];
        lane = p.outLane; ri++; p = np; q = NO_PIECES; qi = 0;
      } else break;
      acc = endD; first = false;
    }

    v.v0 = curLim;
    const sq = 2 * Math.sqrt(v.a * v.b);
    const fr = v.v / Math.max(curLim, 0.5), fr2 = fr * fr, free = 1 - fr2 * fr2;
    let a = this.idm(v, gap, lv, curLim);
    if (stopKind) {
      // a junction: pull up with the front about 0.4 m short of the line (0.2 + 0.2 at a standstill)
      const g2 = stopD - (stopKind === "stop" ? 0 : 0.2);
      const ss = 0.2 + Math.max(0, v.v * v.T * 0.6 + (v.v * v.v) / sq);
      const q2 = ss / Math.max(g2, 0.2);
      const a2 = v.a * (free - q2 * q2);
      if (a2 < a) a = a2;
    }
    if (brake < a) a = brake;
    // a lane that ends: wait at its end (behind the taper) until there is room in the lane beside
    if (v.piece.kind === "lane" && v.lane === v.piece.edge.dropLane) {
      const e = v.piece.edge, d = e.dropStop * (v.piece.len / Math.max(1e-6, e.length)) - v.s - 0.5;
      a = Math.min(a, this.idm(v, Math.max(0.2, d), 0, curLim));
    }
    // on a road with turn bays (or a lane that ends), a vehicle that must move across toward its bay…
    if (v.piece.kind === "lane" && !v.granted && v.lcT <= 0 && (v.piece.edge.left || v.piece.edge.right || v.piece.edge.dropLane >= 0)) {
      const e = v.piece.edge, lp = v.piece;
      const need = this.neededLanes(v), step = v.lane < need.lo ? 1 : v.lane > need.hi ? -1 : 0, c = v.lane + step;
      if (step !== 0 && need.urgent < 80 && c >= 0 && c < e.n) {
        const sc = v.s * (e.lanes[c].len / lp.len);
        // …eases off to slip in behind a vehicle alongside in that lane
        if (v.v > 2 && sc >= e.open[c]) {
          const L = this.laneLeader(v, c), F = this.laneFollower(v, c);
          if (L.u && L.gap < 1.5 + 0.25 * v.v) a = Math.min(a, Math.max(-3, this.idm(v, Math.max(0.3, L.gap), L.v, curLim)));
          else if (F.u && F.gap < 1.5) a = Math.min(a, -1.5);
        }
      }
      // …and when its bay is queued back toward the mouth, rolls up to wait behind the last vehicle in it
      const next = v.route[v.ri + 1], m = next ? this.moveOf(e, next) : undefined;
      if (m && (v.lane < m.lo || v.lane > m.hi)) {
        const k = m.hi < e.left ? m.hi : m.lo >= e.left + e.thru ? m.lo : -1;
        if (k >= 0) {
          let rear = Infinity;
          for (const u of this.index.get(e.lanes[k].id) ?? []) rear = Math.min(rear, u.s - u.len);
          const gapTo = rear * (lp.len / e.lanes[k].len) - v.s - 1;
          if (isFinite(rear) && gapTo > -1) a = Math.min(a, Math.max(-4, this.idm(v, Math.max(0.2, gapTo), 0, curLim)));
        }
      }
    }
    v.acc = Math.max(-v.bmax, a);
    v.gap = gap; v.leader = leader;

    v.wait = v.v < 0.3 ? v.wait + DT : 0;
    // junction request
    if (pendConn) {
      const node = pendConn.node, st = this.ns[node.idx], e = pendConn.inEdge;
      // the vehicle's own movement (a roundabout entry piece is shared by all turns from that arm)
      const m = (v.route[v.ri] === e && v.route[v.ri + 1] ? this.moveOf(e, v.route[v.ri + 1]) : undefined) ?? pendConn.move;
      // wrong lane for the planned turn and too late to change: take a turn this lane allows
      const wrongLane = v.lane < m.lo || v.lane > m.hi;
      // a turning share was drawn for this junction: keep trying to reach the right lane for a while
      // …but never for long while standing at the line, where it blocks everyone behind it
      const committed = !!v.splits?.has(e.idx) && !(pendD < 8 && v.wait > 6);
      if (pendD < 14 && wrongLane && v.fixedAt !== e && !committed) {
        v.fixedAt = e;
        const moves = node.moves.get(e.idx) || [];
        const ok = new Set(moves.filter(x => v.lane >= x.lo && v.lane <= x.hi).map(x => x.out));
        let rest = ok.size ? this.plan(e, v.dest, { firstOuts: ok, bus: v.kind === "bus" }) : null;
        let retarget = "";
        if (!rest && ok.size && v.kind !== "bus") {
          // the destination is only reachable through the turn it can no longer make: leave the
          // area by whichever exit is reachable from this lane
          for (const g of this.shuffled(this.gateways)) {
            const d: Dest = { kind: "gateway", node: g };
            const r = e.to === g ? null : this.plan(e, d, { firstOuts: ok });
            if (r) { v.dest = d; rest = r; retarget = " (new destination)"; break; }
          }
        }
        if (rest) {
          v.route = [...v.route.slice(0, v.ri + 1), ...rest]; v.reroutes++;
          v.splits?.delete(e.idx);
          const nm = this.moveOf(e, rest[0]);
          this.ev(node, v, "turn-changed", `in lane ${v.lane + 1}, which does not allow ${this.mv(m)} (lanes ${m.lo + 1}-${m.hi + 1}); takes ${nm ? this.mv(nm, v.lane) : "another way"} instead${retarget}`);
        } else this.ev(node, v, "wrong-lane", `in lane ${v.lane + 1}, needs lanes ${m.lo + 1}-${m.hi + 1} for ${this.mv(m)}; no allowed turn from this lane`);
        return;
      }
      if (wrongLane && pendD < 14 && v.reqFor !== pendConn && this.lastDeny.get(v.id) !== `wl${e.idx}`) {
        this.lastDeny.set(v.id, `wl${e.idx}`);
        this.ev(node, v, "wrong-lane", `in lane ${v.lane + 1}, needs lanes ${m.lo + 1}-${m.hi + 1} for ${this.mv(m)} (turning share); waits to change lane`);
      }
      // a wrong-lane vehicle doesn't ask for the junction until it has changed lane or picked a turn
      // its lane allows; only a vehicle that found no alternative at all goes as it is
      const laneOk = !wrongLane || (v.fixedAt === e && !committed);
      if (node.ring) {
        // roundabout: yield to circulating traffic, then commit
        if (pendD < 22 && laneOk && v.reqFor !== pendConn) {
          v.reqFor = pendConn; v.reqAt = this.tick;
          this.ev(node, v, "request", `${this.mv(m, v.lane)} · ${pendD.toFixed(0)} m from the line, ${(v.v * 3.6).toFixed(0)} km/h`);
        }
        if (pendD < 22 && laneOk && !(v.granted && v.conn === pendConn) && this.canEnterRing(v, pendConn)) {
          v.conn = pendConn; v.granted = true; this.claimRing(pendConn.node, v);
          this.ev(node, v, "grant", `gap in the roundabout · ${this.mv(m, v.lane)}`, this.md(m, v.lane));
        }
        v.state = v.v < 0.6 && pendD < 8 ? "yielding" : leader && gap < 30 ? "following" : "free";
        if (v.wait > this.P.towAfter && !(leader && leader.piece === v.piece && gap < 12)) { this.ev(node, v, "towed", `stuck ${this.P.towAfter} s waiting to enter the roundabout`); this.kill(v, "towed"); }
        return;
      }
      const stopFirst = this.mustStop(node, e);
      if (stopFirst && v.stoppedAt !== pendConn && pendD < 3 && v.v < 0.25) { v.stoppedAt = pendConn; if (v.reqFor === pendConn) v.reqFor = null; }
      const mayAsk = (!stopFirst || v.stoppedAt === pendConn) && laneOk;
      // only the first vehicle in a lane (or one following a vehicle that may go) asks for the junction
      const behindWaiting = !!leader && leader.piece === v.piece && !(leader.granted && leader.conn);
      if (pendD < this.P.requestDist && mayAsk && !behindWaiting) {
        if (v.reqFor !== pendConn) {
          v.reqFor = pendConn; v.reqAt = this.tick;
          this.ev(node, v, "request", `${node.ring ? this.mv(m, v.lane) : this.mv(pendConn)} · ${pendD.toFixed(0)} m from the line, ${(v.v * 3.6).toFixed(0)} km/h${stopFirst ? " · after stopping" : ""}`);
        }
        const arm = this.armOf(node, e);
        if (arm >= 0) for (const p of this.lanePhases(node, arm, pendConn.inLane)) st.demand[p] = this.tick;
        const cur = st.req.get(pendConn.entryKey);
        if (!cur || pendD < cur.d) st.req.set(pendConn.entryKey, { v, conn: pendConn, d: pendD, at: v.reqAt });
      }
    }

    // state + stuck handling
    if (stopKind === "junction" && stopD < 8 && v.v < 0.6 && pendConn) {
      const node = pendConn.node;
      const arm = this.armOf(node, pendConn.inEdge);
      const sig = arm >= 0 ? this.signalFor(node.idx, arm, pendConn.inLane) : null;
      v.state = sig && sig !== "green" ? "red light" : this.mustStop(node, pendConn.inEdge) ? "stop sign" : "yielding";
    } else if (leader && gap < 25 && v.v < 1) v.state = "queued";
    else if (leader && gap < 30) v.state = "following";
    else v.state = "free";

    // towing clears a vehicle that is itself stuck; one waiting in a queue behind others is left alone
    const inQueue = !!leader && leader.piece === v.piece && gap < 12;
    if (v.wait > this.P.towAfter && !inQueue) { if (pendConn) this.ev(pendConn.node, v, "towed", `stuck ${this.P.towAfter} s waiting for ${this.mv(pendConn)}`); this.kill(v, "towed"); }
    else if (v.wait > this.P.rerouteAfter && pendConn && v.rerouteAt !== pendConn.inEdge && v.kind !== "bus" && !v.splits?.has(pendConn.inEdge.idx)) {
      v.rerouteAt = pendConn.inEdge;
      const e = pendConn.inEdge, node = pendConn.node;
      const ok = new Set((node.moves.get(e.idx) || []).filter(x => v.lane >= x.lo && v.lane <= x.hi).map(x => x.out));
      const rest = this.plan(e, v.dest, { avoid: pendConn.move, firstOuts: ok.size ? ok : undefined, bus: false });
      if (rest && rest[0] !== pendConn.move.out) {
        v.route = [...v.route.slice(0, v.ri + 1), ...rest]; v.reroutes++;
        const nm = this.moveOf(e, rest[0]);
        this.ev(node, v, "reroute", `waited ${v.wait.toFixed(0)} s for ${this.mv(pendConn.move)}; now ${nm ? this.mv(nm, v.lane) : "?"}`);
      }
    }
  }
  // ------------------------------------------------------------ lane changes
  protected neededLanes(v: Vehicle): { lo: number; hi: number; urgent: number } {
    const p = v.piece as LanePiece, e = p.edge;
    let lo = 0, hi = this.maxLane(v, e);
    const toEnd = p.len - v.s;
    let urgent = Infinity;
    const next = v.route[v.ri + 1];
    const m = next ? this.moveOf(e, next) : undefined;
    // through road joints (two roads meeting, same lanes): line up early for the junction beyond
    if (m && !e.to.controlled && e.to.degree === 2 && m.out.n === e.n) {
      let dist = toEnd, k = v.ri + 1;
      for (let hop = 0; hop < 4; hop++) {
        const ek = v.route[k], nk = v.route[k + 1];
        if (!ek || !nk || ek.n !== e.n) break;
        dist += ek.length;
        const mk = this.moveOf(ek, nk);
        if (!mk) break;
        if (ek.to.controlled || ek.to.degree !== 2) {
          const manyK = (ek.to.moves.get(ek.idx)?.length || 0) > 1;
          if (manyK && (mk.lo > lo || mk.hi < hi) && dist < 250) { lo = Math.max(lo, mk.lo); hi = Math.min(hi, mk.hi); urgent = dist; }
          break;
        }
        k++;
      }
    }
    if (m) {
      const many = (e.to.moves.get(e.idx)?.length || 0) > 1 || e.to.controlled;
      if (many && (m.lo > lo || m.hi < hi)) { lo = Math.max(lo, m.lo); hi = Math.min(hi, m.hi); urgent = toEnd; }
      // lanes dropping at a plain road point: be in one that carries on
      const first = e.left + (m.skip ?? 0), cap = first + m.out.thru - 1;
      if (!e.to.controlled && (cap < hi || first > lo)) { lo = Math.max(lo, first); hi = Math.min(hi, cap); urgent = toEnd; }
    }
    // a lane that ends: leave it (the nearer its end, the more urgently)
    if (e.dropLane >= 0) {
      if (e.dropLane === e.left) lo = Math.max(lo, e.dropLane + 1); else hi = Math.min(hi, e.dropLane - 1);
      if (v.lane === e.dropLane) urgent = Math.min(urgent, Math.max(0, e.dropStop * (p.len / Math.max(1e-6, e.length)) - v.s));
    }
    // turn bays: until the bay the turn needs has opened, line up in the through lane beside it
    if ((e.left || e.right) && (hi < e.left || lo >= e.left + e.thru)) {
      const k = hi < e.left ? hi : lo, sk = v.s * (e.lanes[k].len / p.len);
      if (sk < e.open[k]) {
        const beside = hi < e.left ? e.left : e.left + e.thru - 1;
        lo = hi = beside; urgent = Math.min(urgent, e.open[k] - sk);
      }
    }
    if (v.kind === "bus") {
      const stopHere = v.dest.kind === "stop" && v.dest.stop.edge === e;
      if ((stopHere || e.bus) && hi >= e.kerb) { lo = e.kerb; urgent = Math.min(urgent, toEnd); }
    }
    if (lo > hi) lo = hi;
    return { lo, hi, urgent };
  }
  protected laneLeader(v: Vehicle, c: number) {
    const e = (v.piece as LanePiece).edge, piece = e.lanes[c];
    const s = v.s * (piece.len / (v.piece as LanePiece).len);
    let best: Vehicle | null = null, gap = Infinity;
    const list = this.index.get(piece.id);
    if (list) for (const u of list) { if (u === v || u.s <= s) continue; const gg = u.s - u.len - s; if (gg < gap) { gap = gg; best = u; } }
    return { u: best, gap, v: best ? best.v : 0 };
  }
  protected laneFollower(v: Vehicle, c: number) {
    const e = (v.piece as LanePiece).edge, piece = e.lanes[c];
    const s = v.s * (piece.len / (v.piece as LanePiece).len);
    let best: Vehicle | null = null, gap = Infinity;
    const list = this.index.get(piece.id);
    if (list) for (const u of list) { if (u === v || u.s > s) continue; const gg = s - v.len - u.s; if (gg < gap) { gap = gg; best = u; } }
    return { u: best, gap };
  }
  protected considerLaneChange(v: Vehicle) {
    if (v.dwell > 0 || v.lcCool > 0 || v.piece.kind !== "lane") return;
    const p = v.piece, e = p.edge;
    if (e.n <= 1 || v.s < 2 || v.s > p.len - (v.v < 1 ? 0.3 : 3) || v.granted) return;
    const need = this.neededLanes(v), a = v.lane;
    const dir = a < need.lo ? 1 : a > need.hi ? -1 : 0;
    const aCur = this.idm(v, v.gap, v.leader ? v.leader.v : 0, v.v0);
    let best = -1, bestGain = 0, bestMandatory = false;
    const bayRoad = e.left > 0 || e.right > 0 || e.dropLane >= 0;
    for (const c of [a - 1, a + 1]) {
      if (c < 0 || c >= e.n) continue;
      // a turn bay only from where it opens
      if (e.open[c] > 0 && v.s * (e.lanes[c].len / p.len) < e.open[c]) continue;
      const mandatory = dir !== 0 && Math.sign(c - a) === dir;
      if (dir !== 0 && !mandatory) continue;
      if (!mandatory && (c < need.lo || c > need.hi)) continue;
      const L = this.laneLeader(v, c), F = this.laneFollower(v, c);
      // squeezing into a slow queue to reach a turning lane: neighbours let you in
      const courtesy = mandatory && v.v < 3 && (!F.u || F.u.v < 4);
      if (L.gap < (courtesy ? 0.8 : 1.5 + 0.25 * v.v)) continue;
      let fLoss = 0;
      if (F.u) {
        if (F.gap < (courtesy ? 0.8 : 1.5)) continue;
        const fNew = this.idm(F.u, F.gap, v.v, F.u.v0);
        if (fNew < (courtesy ? -6 : mandatory && bayRoad ? -4.5 : -3)) continue;
        fLoss = Math.max(0, F.u.acc - fNew);
      }
      const aNew = this.idm(v, L.gap, L.v, v.v0);
      let gain = aNew - aCur - v.politeness * fLoss + (c > a ? 0.08 : -0.08);
      if (v.kind === "truck") gain += c > a ? 0.25 : -0.25;
      if (mandatory) gain += need.urgent < 60 ? 5 : 1;
      // getting to a turn bay (across to it, then into its queue): any safe gap will do
      if (mandatory && bayRoad) gain = Math.max(gain, 0.01);
      if (gain > (mandatory ? 0 : this.P.laneChangeGain) && gain > bestGain) { best = c; bestGain = gain; bestMandatory = mandatory; }
    }
    if (best < 0) return;
    const np = e.lanes[best];
    v.s = Math.min(np.len - 0.01, v.s * (np.len / p.len));
    v.lcOff = (v.lcT > 0 ? v.lcOff * v.lcT : 0) + (p.offset - np.offset);
    // on a road with turn bays, the steps across to a bay come quickly one after the other
    v.lcT = 1; v.lcCool = bestMandatory && (e.left || e.right || e.dropLane >= 0) ? 1.5 : this.P.laneChangeCooldown; v.laneChanges++; this.stats.laneChanges++;
    this.evRoad(e, v, "lane", `→ lane ${best + 1} ${(p.len - v.s).toFixed(0)} m before the end${bestMandatory ? ` (must: needs lanes ${this.neededLanes(v).lo + 1}-${this.neededLanes(v).hi + 1})` : " (faster)"} at ${(v.v * 3.6).toFixed(0)} km/h`);
    if (e.to.controlled && p.len - v.s < 150) this.ev(e.to, v, "lane", `lane ${v.lane + 1} → ${best + 1} ${(p.len - v.s).toFixed(0)} m before the junction${this.neededLanes(v).lo !== 0 || this.neededLanes(v).hi !== e.n - 1 ? ` (needs lanes ${this.neededLanes(v).lo + 1}-${this.neededLanes(v).hi + 1})` : ""}`);
    v.piece = np; v.lane = best;
    if (v.reqFor && v.reqFor.inEdge === e) { v.reqFor = null; }
  }
  // ------------------------------------------------------------ movement
  protected move(v: Vehicle) {
    if (v.dwell > 0) { v.dwell -= DT; if (v.dwell <= 0) this.busDepart(v); return; }
    v.v = Math.max(0, v.v + v.acc * DT);
    v.s += v.v * DT;
    // traffic counter at the middle of a counted road
    if (v.piece.kind === "lane" && this.counters[v.piece.edge.idx]) {
      const mid = v.piece.len / 2;
      if (v.s >= mid && v.s - v.v * DT < mid) this.countPass(v, v.piece.edge.idx);
    }
    let guard = 0;
    while (v.s >= v.piece.len && guard++ < 8) {
      const p = v.piece;
      if (p.kind === "lane") {
        const e = p.edge, next = v.route[v.ri + 1];
        if (!next) {
          this.recordEma(v, e);
          if (v.dest.kind === "gateway" && e.to === v.dest.node) { this.kill(v, "exit"); return; }
          this.kill(v, "removed"); return;
        }
        const cross = this.crossingFor(v, v.ri, v.lane);
        if (!cross) { this.kill(v, "removed"); return; }
        if (e.to.controlled && (!v.granted || v.conn !== cross[0])) { v.s = p.len - 0.01; v.v = 0; return; }
        this.recordEma(v, e);
        this.evRoad(e, v, "leave-road", `into ${e.to.def.id}: ${cross[0].kind === "conn" ? this.mv(cross[0]) : "the junction"} at ${(v.v * 3.6).toFixed(0)} km/h, ${((this.tick - v.enterT) * DT).toFixed(0)} s on this road`);
        v.s -= p.len; v.trail = [p, ...v.trail].slice(0, 2);
        v.piece = cross[0]; v.queue = cross.slice(1);
        if (cross[0].kind === "conn") {
          const realMove = this.moveOf(e, next);
          const sigNow = e.to.def.control === "lights" ? this.signalFor(e.to.idx, e.inArm, cross[0].inLane) : null;
          this.ev(e.to, v, "enter", `${e.to.ring && realMove ? this.mv(realMove, v.lane) : this.mv(cross[0])} at ${(v.v * 3.6).toFixed(0)} km/h${sigNow ? ` · light ${sigNow}` : ""}`,
            { ...this.md(realMove ?? cross[0].move, v.lane, e.to.ring ? undefined : cross[0].outLane), sig: sigNow });
          const k = `${e.idx}>${cross[0].move.out.idx}`; this.turnCounts.set(k, (this.turnCounts.get(k) ?? 0) + 1);
          const ni = e.to.idx; this.nodeThrough[ni] = (this.nodeThrough[ni] ?? 0) + 1;
          if (e.to.def.control === "lights") { const arm = e.inArm; if (arm >= 0) this.ns[ni].cyc[arm].count++; }
          (this.nodeRecent[ni] ??= []).push(this.tick);
        }
      } else if (v.queue.length) {
        v.s -= p.len; v.trail = [p, ...v.trail].slice(0, 2);
        v.piece = v.queue[0]; v.queue = v.queue.slice(1);
      } else if (p.kind === "conn") {
        const np = p.outEdge.lanes[p.outLane];
        v.s -= p.len; v.trail = [p, ...v.trail].slice(0, 2); v.piece = np;
        this.ev(p.node, v, "leave", `onto ${p.outEdge.link.name || p.outEdge.link.id} lane ${p.outLane + 1}`, { to: p.outEdge.link.id, outLane: p.outLane + 1 });
        v.ri++; v.lane = p.outLane; v.conn = null; v.granted = false; v.enterT = this.tick;
        v.stoppedAt = null; v.fixedAt = null;
        this.replan(v);
        if (this.roadLogged(np.edge)) {
          const nt = this.nextTurn(v);
          this.evRoad(np.edge, v, "enter-road", `from ${p.node.def.id} at ${(v.v * 3.6).toFixed(0)} km/h${nt ? `; next: ${this.mv(nt.move)} at ${nt.node.def.id} (lanes ${nt.move.lo + 1}-${nt.move.hi + 1})` : "; ends on this road"}`);
        }
      } else { this.kill(v, "removed"); return; }
    }
    // destinations along an edge
    if (v.piece.kind === "lane" && v.ri === v.route.length - 1) {
      const e = v.piece.edge, f = v.piece.len / Math.max(1e-6, e.length);
      if (v.dest.kind === "edge" && v.dest.edge === e && v.s >= v.dest.s * f) this.kill(v, "arrived");
      else if (v.dest.kind === "stop" && v.dest.stop.edge === e && v.s >= v.dest.stop.s * f - 0.6) { v.v = 0; this.busArrive(v); }
    }
  }
  protected busArrive(v: Vehicle) {
    if (v.dest.kind !== "stop") return;
    const stop = v.dest.stop;
    const alight = Math.floor(v.pax * (0.25 + this.rng() * 0.35));
    v.pax -= alight;
    const board = Math.min(Math.floor(stop.waiting), v.cap - v.pax);
    stop.waiting -= board; v.pax += board; this.stats.boarded += board;
    v.dwell = 3 + 0.5 * alight + 0.8 * board;
  }
  protected busDepart(v: Vehicle) {
    v.dwell = 0;
    const line = v.line;
    if (!line || line.stops.length < 2) { v.dwell = 5; return; }
    const e = v.route[v.ri];
    // next stop on the line; a stop that can't be reached from here (typically the first stop
    // again, when the line runs one way along roads that end at the edge of the map) is skipped
    for (let k = 1; k < line.stops.length; k++) {
      const idx = (v.stopIdx + k) % line.stops.length, next = line.stops[idx];
      if (next.edge === e && next.s * (v.piece.len / e.length) > v.s + 5) {
        v.stopIdx = idx; v.dest = { kind: "stop", stop: next }; v.route = v.route.slice(0, v.ri + 1); return;
      }
      const rest = this.plan(e, { kind: "stop", stop: next }, { bus: true });
      if (rest) { v.stopIdx = idx; v.dest = { kind: "stop", stop: next }; v.route = [...v.route.slice(0, v.ri + 1), ...rest]; return; }
    }
    // end of the line: drive on to the edge of the map and leave there, like a car (a new bus
    // starts the line). The exit is the one reached by the shortest drive, which is normally
    // straight on along the road the bus is on.
    let best: Edge[] | null = null, bestG: CNode | null = null, bestLen = Infinity;
    for (const g of this.gateways) {
      if (e.to === g) { best = []; bestG = g; break; }
      const r = this.plan(e, { kind: "gateway", node: g }, { bus: true });
      const len = r ? r.reduce((a, x) => a + x.length, 0) : Infinity;
      if (r && len < bestLen) { best = r; bestG = g; bestLen = len; }
    }
    if (best && bestG) { v.dest = { kind: "gateway", node: bestG }; v.route = [...v.route.slice(0, v.ri + 1), ...best]; v.line = null; v.state = "end of line"; return; }
    this.kill(v, "removed");
  }
  /** first stop index from which the line can carry on (used when placing new buses) */
  protected lineStart(line: CLine, k: number): number {
    const n = line.stops.length;
    for (let j = 0; j < n; j++) {
      const i = (k + j) % n, a = line.stops[i], b = line.stops[(i + 1) % n];
      if ((a.edge === b.edge && b.s > a.s + 5) || this.plan(a.edge, { kind: "stop", stop: b }, { bus: true })) return i;
    }
    return k % n;
  }
}

/** a roundabout's circulating lane: the inner one of a two-lane ring for lane 1 */
const ringOf = (n: CNode, lane?: number) => (lane && n.ring2) || n.ring!;
