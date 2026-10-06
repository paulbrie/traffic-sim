import type { CLine, CNode, Conn, Edge, LanePiece, Piece } from "../compile";
import { laneAllowed } from "../compile";
import { DT, LOOK, NO_PIECES, type Dest, type Vehicle } from "./base";
import { SimJunctions } from "./junctions";
import { accessLen } from "../parking";

/** Driving: each vehicle's acceleration against what lies ahead (IDM), lane changes (MOBIL-style), moving along pieces, buses at their stops. */
export abstract class SimMotion extends SimJunctions {
  protected think(v: Vehicle) {
    // broken down (rolls to a stop) or wrecked (stopped where it was hit): an obstacle in its lane, no
    // longer asking for junctions, until towed away. (Not towed as "stuck": its wait isn't counted.)
    if (v.broken) {
      v.acc = v.v > 0 ? -Math.min(v.broken === 2 ? v.bmax : 2.5, v.v / DT) : 0;
      v.state = v.broken === 2 ? "wrecked" : "broken down"; v.leader = null; v.gap = Infinity; v.wait = 0;
      if ((this.tick - v.brokenAt) * DT > this.P.brokenTowAfter) this.kill(v, v.broken === 2 ? "destroyed" : "towed");
      return;
    }
    v.lcCool -= DT;
    if (v.lcT > 0) v.lcT = Math.max(0, v.lcT - DT / 1.4);
    if (v.blendT) v.blendT = Math.max(0, v.blendT - DT);
    if (v.bayMove) { this.bayThink(v); return; }
    if (v.dwell > 0) { v.state = "boarding"; v.acc = 0; v.leader = null; v.gap = Infinity; return; }

    let acc = -v.s, gap = Infinity, lv = 0, leader: Vehicle | null = null;
    let stopD = Infinity, stopKind: "junction" | "stop" | null = null, brake = Infinity, tailGap = Infinity, tailV = 0;
    let pendConn: Conn | null = null, pendD = 0;
    // the next junction, when it is not the end of the road the vehicle is on (a short road after the
    // junction it is crossing or let into, or a joint between road segments): it may ask early
    let aheadConn: Conn | null = null, aheadD = 0;
    // driving through a junction while queued behind a vehicle that may not go: not sure to get past
    // it, so the junction after isn't asked early (the booking would hold up traffic there meanwhile)
    let held = false;
    const curLim = this.lim(v, v.piece);

    // walk pieces ahead
    let p: Piece | null = v.piece, ri = v.ri, lane = v.lane, first = true;
    // pieces still to come on the current crossing: q[qi..]
    let q: readonly Piece[] = v.queue, qi = 0;
    while (p && acc < LOOK) {
      // leaders on this piece (plus vehicles on sibling connectors from the same entry lane,
      // and vehicles about to merge onto a roundabout ring stretch)
      if (!leader) {
        if (p.kind === "conn" && p.role !== "exit") {
          const list = this.groupIndex.get(p.entryKey);
          if (list) for (const u of list) {
            if (u === v) continue;
            if (first && !(u.s > v.s || (u.s === v.s && u.id > v.id))) continue;
            const gg = acc + u.s - u.len;
            if (gg < gap) { gap = gg; lv = u.v; leader = u; }
          }
        } else {
          // (the same choice as scanning the whole list: the smallest gap ahead, ties to the earlier
          // in the list; walking by position we can stop once nobody further on can be closer)
          const list = this.index.get(p.id);
          if (list && list.length < 12) {
            // (a short list: scanning it is cheaper than sorting it)
            for (const u of list) {
              if (u === v) continue;
              if (first && !(u.s > v.s || (u.s === v.s && u.id > v.id))) continue;
              const gg = acc + u.s - u.len;
              if (gg < gap) { gap = gg; lv = u.v; leader = u; }
            }
          }
          const sv = list && list.length >= 12 ? this.index.sorted(p.id) : undefined;
          if (sv) {
            const vs = sv.vs, ord = sv.ord;
            let k = 0;
            if (first) { let lo = 0, hi = vs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (vs[m].s < v.s) lo = m + 1; else hi = m; } k = lo; }
            let bestOrd = Infinity, pick: Vehicle | null = null;
            for (; k < vs.length; k++) {
              const u = vs[k];
              if (acc + u.s - sv.maxLen > gap + 1e-6) break;
              if (u === v || (first && !(u.s > v.s || (u.s === v.s && u.id > v.id)))) continue;
              const gg = acc + u.s - u.len;
              if (gg < gap || (gg === gap && pick && ord[k] < bestOrd)) { gap = gg; bestOrd = ord[k]; pick = u; }
            }
            if (pick) { lv = pick.v; leader = pick; }
          }
        }
        // (the rear of one whose front has gone on into the junction at the end of this road, or through it:
        // followed as a leader would be, though it isn't the vehicle's leader — in the junction's eyes it is
        // the one ahead — and on a road only: in a junction, who goes where is the junction's to settle)
        if (p.kind === "lane") for (const z of this.tails.get(p.id) ?? []) {
          if (z.v === v || (first && p.len <= v.s)) continue;
          const gg = acc + z.s0;
          if (gg < tailGap) { tailGap = gg; tailV = z.v.v; }
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
      // its parking bay: stop by it (in the lane) to manoeuvre in
      if (p.kind === "lane" && v.park && v.dest.kind === "edge" && p.edge === v.dest.edge && ri === v.route.length - 1) {
        const d = acc + v.dest.s * (p.len / Math.max(1e-6, p.edge.length));
        if (d > -0.5 && d < stopD) { stopD = d; stopKind = "stop"; }
      }
      // a car on a bay's path (going in, or coming out): keep off the stretch it sweeps, if there is room to stop
      // (not in a junction: it would stop in there, keeping others waiting — a car only pulls out when those are
      // clear of it; nor once its front is well into the stretch: it carries on through. One let through the
      // junction ahead stops only for a car already on its way in or out: for one only waiting to go, it would
      // stop short of the junction holding its path there)
      if (this.bayHolds.size && !v.bayMove && v.piece.kind === "lane") for (const z of this.bayHolds.get(p.id) ?? []) {
        if (p.kind === "lane" && (v.granted || v.early?.granted) && !(z.v.bayMove?.way === "in" || z.v.bayMove?.go)) continue;
        // (one only waiting to pull out can't go while anything is in its way: a car at its stretch already drives on
        // through; one on its way is stopped for unless well into the stretch)
        if (z.v === v) continue;
        const moving = z.v.bayMove?.way === "in" || !!z.v.bayMove?.go;
        if (first && v.s > z.z0 + (moving ? 0.5 : -0.3)) {
          // (well into the stretch already: it stops behind the car coming out ahead of it, if it is ahead)
          const sp = moving ? this.bodyAlong(z.v, p as LanePiece) : null;
          if (sp && sp[0] > v.s - 0.5) { const d = Math.max(0.05, acc + sp[0] - 0.5); if (d < stopD) { stopD = d; stopKind = "stop"; } }
          continue;
        }
        const d = Math.max(0.05, acc + z.z0 - 0.5);
        if (d < (v.v * v.v) / (2 * v.b) * 0.8) {
          // (too close to stop short of the stretch comfortably: short of the car on it, whatever it takes)
          const sp = moving ? this.bodyAlong(z.v, p as LanePiece) : null;
          if (sp) { const db = Math.max(0.05, acc + sp[0] - 0.5); if (db < stopD) { stopD = db; stopKind = "stop"; } }
          continue;
        }
        if (d < stopD) { stopD = d; stopKind = "stop"; }
      }
      // a crossing drawn by hand that pedestrians are on, or waiting at (unless too close to stop for
      // them: they wait for it); a path through a junction stops at its line instead (see pedBlocks)
      if (this.crosses.length && !(p.kind === "conn" && (first || (v.granted && v.conn === p)))) {
        for (const o of this.crossOn.get(p.id) ?? []) {
          const ped = this.crosses[o.k].ped;
          if (!ped.crossing && !ped.claim) continue;
          if (first && v.s > o.s0 - 0.3) continue;
          const d = acc + o.s0 - 0.5;
          if (!ped.crossing && d < (v.v * v.v) / (2 * v.b) * 0.8) continue;
          if (d < stopD) { stopD = d; stopKind = "stop"; }
        }
      }
      const endD = acc + p.len;
      // what comes after this piece?
      if (p.kind === "lane") {
        const e = p.edge;
        const cross = this.crossingFor(v, ri, lane);
        if (!cross) break; // route ends on this edge (exit or destination)
        const node = e.to, c0 = cross[0] as Conn;
        const thru = node.controlled && this.drivesThrough(c0);
        if (thru && first && (this.index.get(p.id) ?? []).some(u => u !== v && u.s > v.s && !this.mayGo(u))) held = true;
        if (node.controlled && !(first && v.granted && v.conn === c0) && !thru) {
          let mayGo = false;
          if (first) { pendConn = c0; pendD = endD; }
          else if (!aheadConn && !held && (v.early?.conn === c0 || (endD < this.P.requestDist && !node.ring && !this.mustStop(node, e)))) {
            aheadConn = c0; aheadD = endD; mayGo = !!v.early?.granted && v.early.conn === c0;
          }
          if (!mayGo) {
            if (endD < stopD) { stopD = endD; stopKind = "junction"; }
            break;
          }
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
    if (v.early && v.early.conn !== aheadConn) v.early = null; // its plan changed (or the junction before took back its go)
    if (aheadConn) this.askEarly(v, aheadConn, aheadD);

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
    if (tailGap < gap) a = Math.min(a, this.idm(v, Math.max(0.1, tailGap), tailV, curLim));
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
      // (a junction drawn by hand takes every request at its leading node: one queue, in arrival order)
      const node = pendConn.node, st = this.ns[(node.lead ?? node).idx], e = pendConn.inEdge;
      // the vehicle's own movement (a roundabout entry piece is shared by all turns from that arm)
      const m = (v.route[v.ri] === e && v.route[v.ri + 1] ? this.moveOf(e, v.route[v.ri + 1]) : undefined) ?? pendConn.move;
      // wrong lane for the planned turn and too late to change: take a turn this lane allows
      const wrongLane = !laneAllowed(m, v.lane);
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
        if (v.wait > this.P.towAfter && !(leader && leader.piece === v.piece && gap < 12)) this.reportStuck(v, () => `waiting ${v.wait.toFixed(0)} s to enter roundabout ${this.nodeName(node)}`);
        return;
      }
      const stopFirst = this.mustStop(node, e);
      if (stopFirst && v.stoppedAt !== pendConn && pendD < 3 && v.v < 0.25) { v.stoppedAt = pendConn; if (v.reqFor === pendConn) v.reqFor = null; }
      const mayAsk = (!stopFirst || v.stoppedAt === pendConn) && laneOk;
      // only the first vehicle in a lane (or one following a vehicle that may go) asks for the junction
      const behindWaiting = !!leader && leader.piece === v.piece && !this.mayGo(leader);
      if (pendD < this.P.requestDist && mayAsk && !behindWaiting) {
        if (v.reqFor !== pendConn) {
          v.reqFor = pendConn; v.reqAt = this.tick;
          this.ev(node, v, "request", `${node.ring ? this.mv(m, v.lane) : this.mv(pendConn)} · ${pendD.toFixed(0)} m from the line, ${(v.v * 3.6).toFixed(0)} km/h${stopFirst ? " · after stopping" : ""}`);
        }
        const arm = this.armOf(node, e);
        if (arm >= 0) this.noteDemand(pendConn);
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

    // a vehicle that hasn't moved for long (the tow time) is never taken off: the console is told, every so
    // often while it lasts, about the one at the head of a queue (what it waits for, and behind whom), so a
    // road jammed for good — or locked — shows there to be put right
    if (v.wait > this.P.towAfter) {
      const told = this.denyWhy.get(v.id);
      if (!(leader && leader.piece === v.piece && gap < 12 && !leader.broken)) this.reportStuck(v, () => pendConn
        ? `waiting ${v.wait.toFixed(0)} s at junction ${this.nodeName(pendConn.node)} for ${this.mv(pendConn)}${told ? ` — last told: ${told}` : ""}`
        : `waiting ${v.wait.toFixed(0)} s (${v.state}${leader ? `, behind #${leader.id}: ${leader.state}, ${this.placeOf(leader)}` : ""})`);
    }
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
  /**
   * Ask the next junction early, while still crossing (or let into) the one before, or before a joint
   * between road segments: otherwise a road too short to stop on would have the vehicle slow down
   * for that junction's line before it may even ask. Not past a vehicle waiting on the road into it.
   */
  protected askEarly(v: Vehicle, c: Conn, d: number) {
    if (v.early) { v.early.d = d; if (v.early.granted) return; }
    const node = c.node, st = this.ns[(node.lead ?? node).idx], lp = c.inEdge.lanes[c.inLane];
    if ((this.index.get(lp.id) ?? []).some(u => u !== v && !this.mayGo(u))) return;
    if (!v.early) {
      v.early = { conn: c, at: this.tick, d, granted: false };
      const from = c.inEdge.from;
      const why = from.controlled ? `${this.nodeName(from)} is only ${c.inEdge.length.toFixed(0)} m before it` : `the road is split at ${this.nodeName(from)}`;
      this.ev(node, v, "request", `${this.mv(c)} · ${d.toFixed(0)} m from the line, ${(v.v * 3.6).toFixed(0)} km/h · asked early: ${why}`);
    }
    const arm = this.armOf(node, c.inEdge);
    if (arm >= 0) this.noteDemand(c);
    const cur = st.req.get(c.entryKey);
    if (!cur || d < cur.d) st.req.set(c.entryKey, { v, conn: c, d, at: v.early.at, early: true });
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
      // lane connections set by hand can leave a lane out in the middle: go to the nearest one that has it
      if (m.map && m.map[v.lane] < 0 && v.lane >= lo && v.lane <= hi) {
        let q = -1;
        for (let d = 1; d < e.n && q < 0; d++) for (const c of [v.lane - d, v.lane + d]) if (c >= lo && c <= hi && m.map[c] >= 0) { q = c; break; }
        if (q >= 0) { lo = hi = q; urgent = toEnd; }
      }
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
    // parking: in the kerb lane by its bay
    if (v.park && v.dest.kind === "edge" && v.dest.edge === e && v.ri === v.route.length - 1) {
      const k = this.net.parking[v.park.row].lane;
      if (hi >= k) { lo = hi = k; urgent = Math.min(urgent, Math.max(0, v.dest.s * (p.len / Math.max(1e-6, e.length)) - v.s)); }
    }
    if (v.kind === "bus") {
      const stopHere = v.dest.kind === "stop" && v.dest.stop.edge === e;
      if ((stopHere || e.bus) && hi >= e.kerb) { lo = e.kerb; urgent = Math.min(urgent, toEnd); }
    }
    // a reversible middle lane: not one to aim for unless it's open this way (those already in it may
    // stay while it clears); in it when it may not be (closed, or open the other way): out at once
    if (e.rev && !this.laneUsable(e, 0, v.lane === 0)) { lo = Math.max(lo, 1); if (v.lane === 0) urgent = 0; }
    if (lo > hi) lo = hi;
    return { lo, hi, urgent };
  }
  protected laneLeader(v: Vehicle, c: number) {
    const e = (v.piece as LanePiece).edge, piece = e.lanes[c];
    const s = v.s * (piece.len / (v.piece as LanePiece).len);
    let best: Vehicle | null = null, gap = Infinity;
    const list = this.index.get(piece.id);
    if (list) for (const u of list) { if (u === v || u.s <= s) continue; const gg = u.s - u.len - s; if (gg < gap) { gap = gg; best = u; } }
    // (and a long vehicle gone on out of the lane, its body still over its end)
    for (const z of this.tails.get(piece.id) ?? []) { if (z.v === v || piece.len <= s - v.len) continue; const gg = z.s0 - s; if (gg < gap) { gap = gg; best = z.v; } }
    return { u: best, gap, v: best ? best.v : 0 };
  }
  protected laneFollower(v: Vehicle, c: number) {
    const e = (v.piece as LanePiece).edge, piece = e.lanes[c];
    const s = v.s * (piece.len / (v.piece as LanePiece).len);
    let best: Vehicle | null = null, gap = Infinity;
    const list = this.index.get(piece.id);
    if (list) for (const u of list) { if (u === v || u.s > s) continue; const gg = s - v.len - u.s; if (gg < gap) { gap = gg; best = u; } }
    // (and one still in the junction behind, coming into that lane)
    if (s - v.len < 30) for (const u of this.intoLane.get(piece.id) ?? []) {
      if (u === v || u.dead || u.piece.kind !== "conn") continue;
      const gg = s - v.len - (u.s - u.piece.len);
      if (gg < gap) { gap = gg; best = u; }
    }
    return { u: best, gap };
  }
  protected considerLaneChange(v: Vehicle) {
    if (v.dwell > 0 || v.bayMove || v.lcCool > 0 || v.piece.kind !== "lane") return;
    const p = v.piece, e = p.edge;
    // (not before all of it is on the road: its rear is still on its way out of the junction behind)
    if (e.n <= 1 || v.s < Math.min(v.len + 0.5, p.len / 2) || v.s > p.len - (v.v < 1 ? 0.3 : 3) || v.granted) return;
    const need = this.neededLanes(v), a = v.lane;
    // stuck behind a broken-down vehicle in this lane: any lane beside will do to get round it
    // (back to the one it needs once past)
    const blocked = !!v.leader?.broken && v.leader.piece === p && v.gap < 60;
    const dir = blocked ? 0 : a < need.lo ? 1 : a > need.hi ? -1 : 0;
    const aCur = this.idm(v, v.gap, v.leader ? v.leader.v : 0, v.v0);
    let best = -1, bestGain = 0, bestMandatory = false;
    const bayRoad = e.left > 0 || e.right > 0 || e.dropLane >= 0;
    for (const c of [a - 1, a + 1]) {
      if (c < 0 || c >= e.n) continue;
      // a reversible middle lane only while it's open this way
      if (c === 0 && e.rev && !this.revOpenFor(e)) continue;
      // a turn bay only from where it opens
      if (e.open[c] > 0 && v.s * (e.lanes[c].len / p.len) < e.open[c]) continue;
      const mandatory = dir !== 0 && Math.sign(c - a) === dir;
      if (dir !== 0 && !mandatory) continue;
      if (!mandatory && !blocked && (c < need.lo || c > need.hi)) continue;
      // not into the start of a lane a vehicle at the junction behind is waiting to drive into for room (a truck
      // needs its length free there: cars changing in would take every gap)
      { const tp = e.lanes[c], w = this.exitWanted.get(tp.id); if (w !== undefined && this.tick - w < 10 && v.s * (tp.len / p.len) < 25) continue; }
      // never into a stretch a car going into or out of a bay is passing over, nor just short of one it is on
      // its way over (too close to stop for it in the new lane)
      if (this.bayHolds.size) {
        const tp = e.lanes[c], sc = v.s * (tp.len / p.len), stop = (v.v * v.v) / (2 * v.b) + 2;
        if ((this.bayHolds.get(tp.id) ?? []).some(z => z.v !== v && z.z1 > sc - v.len - 1 &&
          (z.z0 < sc + 2 || ((z.v.bayMove?.way === "in" || !!z.v.bayMove?.go) && z.z0 < sc + stop)))) continue;
      }
      const L = this.laneLeader(v, c), F = this.laneFollower(v, c);
      // never into a lane only to stop behind a broken-down vehicle there
      if (L.u?.broken && L.gap < 80) continue;
      // squeezing into a slow queue to reach a turning lane (or round a breakdown): neighbours let you in
      const courtesy = (mandatory || blocked) && v.v < 3 && (!F.u || F.u.v < 4);
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
      if (blocked) gain += 2;
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
    // (the road event above already records it for a logged vehicle)
    if (e.to.controlled && p.len - v.s < 150 && this.logging(e.to)) this.ev(e.to, v, "lane", `lane ${v.lane + 1} → ${best + 1} ${(p.len - v.s).toFixed(0)} m before the junction${this.neededLanes(v).lo !== 0 || this.neededLanes(v).hi !== e.n - 1 ? ` (needs lanes ${this.neededLanes(v).lo + 1}-${this.neededLanes(v).hi + 1})` : ""}`);
    v.piece = np; v.lane = best;
    // (in its new lane's index at once: another vehicle changing into it this same step sees it there — the
    // old lane keeps it until the index is built again, which only makes changes into that one more careful)
    this.index.add(np.id, v);
    if (v.reqFor && v.reqFor.inEdge === e) { v.reqFor = null; }
  }
  // ------------------------------------------------------------ movement
  protected move(v: Vehicle) {
    if (v.bayMove) { this.bayMoveOn(v); return; }
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
          this.kill(v, "removed", "its route ended here, short of where it was going"); return;
        }
        const cross = this.crossingFor(v, v.ri, v.lane);
        if (!cross) { this.kill(v, "removed", `no way on from lane ${v.lane + 1} at junction ${this.nodeName(e.to)} to ${next.link.name || next.link.id}`); return; }
        if (e.to.controlled && (!v.granted || v.conn !== cross[0]) && !this.drivesThrough(cross[0])) { v.s = p.len - 0.01; v.v = 0; return; }
        this.recordEma(v, e);
        this.evRoad(e, v, "leave-road", `into ${this.nodeName(e.to)}: ${cross[0].kind === "conn" ? this.mv(cross[0]) : "the junction"} at ${(v.v * 3.6).toFixed(0)} km/h, ${((this.tick - v.enterT) * DT).toFixed(0)} s on this road`);
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
        // the next junction, asked early: its go (or its place in the queue) carries over
        const early = v.early; v.early = null;
        if (early && early.conn.inEdge === np.edge && early.conn.inLane === v.lane) {
          if (early.granted) { v.conn = early.conn; v.granted = true; } else { v.reqFor = early.conn; v.reqAt = early.at; }
        }
        this.replan(v);
        if (this.roadLogged(np.edge) || this.vehLogged(v)) {
          const nt = this.nextTurn(v);
          this.evRoad(np.edge, v, "enter-road", `from ${this.nodeName(p.node)} at ${(v.v * 3.6).toFixed(0)} km/h${nt ? `; next: ${this.mv(nt.move)} at ${this.nodeName(nt.node)} (lanes ${nt.move.lo + 1}-${nt.move.hi + 1})` : "; ends on this road"}`);
        }
      } else { this.kill(v, "removed", "no road after the junction path it was on"); return; }
    }
    // destinations along an edge
    if (v.piece.kind === "lane" && v.ri === v.route.length - 1) {
      const e = v.piece.edge, f = v.piece.len / Math.max(1e-6, e.length);
      // (a car parking pulls up by its bay, as a bus at its stop: a little short of it)
      if (v.dest.kind === "edge" && v.dest.edge === e && v.s >= v.dest.s * f - (v.park ? 0.6 : 0)) {
        // (parking: it stops in the lane and manoeuvres in)
        // (it turns in once the lanes it crosses to the bay, a bus lane, are clear; until then it waits there)
        if (v.park) {
          // (from the bay's lane, once across into it: the way in starts there)
          if (v.lane === this.net.parking[v.park.row].lane && v.lcT <= 0.05 && this.sweepClear(v, v.park.row, v.park.bay, "in", false)) { v.parkWait = false; v.v = Math.min(v.v, 1); v.bayMove = { row: v.park.row, bay: v.park.bay, way: "in", s: 0, inLane: true, go: true }; }
          else {
            if (!v.parkWait) v.parkSince = this.tick;
            v.parkWait = true; v.v = 0; v.s = Math.min(v.s, v.dest.s * f);
            // (by its bay in another lane, with no way across to the bay's for a while: it drives on, as a
            // driver who can't get across would, and leaves the plan)
            if (v.lane !== this.net.parking[v.park.row].lane && this.tick - (v.parkSince ?? this.tick) > 200) this.giveUpBay(v);
          }
        }
        else this.kill(v, "arrived");
      }
      else if (v.dest.kind === "stop" && v.dest.stop.edge === e && v.s >= v.dest.stop.s * f - 0.6) { v.v = 0; this.busArrive(v); }
    }
  }
  // ------------------------------------------------------------ parking bays
  /** speed on a bay's path (m/s), and how far short of the lane a car pulling out waits for its gap (beyond its length, m) */
  private static readonly BAY_V = 3;
  private static readonly BAY_WAIT = 1.5;
  /**
   * A car on its bay's path: up to walking-to-jogging speed, easing to a stop at the end going in; going out
   * it stops just short of the lane until there is a gap in the lane's traffic (it gives way, as at a junction).
   */
  protected bayThink(v: Vehicle) {
    const bm = v.bayMove!, acc = this.net.parking[bm.row].access[bm.bay], L = accessLen(acc, bm.way);
    const vmax = SimMotion.BAY_V, rem = L - bm.s, turn = bm.way === "out" && acc.fwd ? acc.outPath.len : 0;
    // (up to its speed; into the bay, easing down so it rolls in at walking pace; backing out before driving
    // forwards, easing to a stop where it turns about)
    const vt = bm.way === "in" ? Math.min(vmax, Math.sqrt(0.25 + 2 * Math.max(0, rem - 0.3)))
      : bm.s < turn ? Math.min(vmax, Math.sqrt(0.25 + 2 * Math.max(0, turn - bm.s - 0.1))) : vmax;
    let a = v.v < vt ? Math.min(1.2, (vt - v.v) / DT) : Math.max(-3, (vt - v.v) / DT);
    if (bm.way === "out" && !bm.go) {
      if (this.mergeGap(v)) bm.go = true;
      else {
        // (in its bay when it has to back out across the lanes)
        const d = (acc.fwd ? 0 : L - (v.len + SimMotion.BAY_WAIT)) - bm.s;
        a = d <= 0.05 ? -v.v / DT : Math.min(a, -(v.v * v.v) / (2 * d));
      }
    }
    v.acc = Math.max(-v.bmax, a); v.v0 = vmax; v.leader = null; v.gap = Infinity;
    v.state = bm.way === "in" ? "parking" : bm.go ? "pulling out" : "waiting to pull out";
    v.wait = v.v < 0.3 ? v.wait + DT : 0;
  }
  /** room to pull out (see sweepClear): with priority traffic lets it out, giving way it waits for a gap */
  protected mergeGap(v: Vehicle): boolean {
    const bm = v.bayMove!, giveWay = !!this.net.parking[bm.row].def.giveWay;
    // ready: nothing standing in its way (a queue in a lane it crosses, another car manoeuvring there), so traffic
    // may be asked to let it out — see bayHolds; then out once it has its gap
    bm.ready = this.nothingStanding(v, bm.row, bm.bay);
    return bm.ready && this.sweepClear(v, bm.row, bm.bay, "out", giveWay);
  }
  /** on a bay's way out, nothing standing still (a queue), and no other car on a bay's path over it */
  protected nothingStanding(v: Vehicle, row: number, bay: number): boolean {
    for (const sp of this.sweeps[row]?.[bay]?.out ?? []) {
      for (const u of this.index.get(sp.piece.id) ?? []) if (u !== v && !u.dead && !u.bayMove && u.v < 0.5 && u.s - u.len < sp.s1 && u.s > sp.s0) return false;
      for (const o of this.bayHolds.get(sp.piece.id) ?? []) if (o.v !== v && (o.v.bayMove?.way === "in" || o.v.bayMove?.go) && o.z0 < sp.s1 && o.z1 > sp.s0) return false;
    }
    return true;
  }
  /**
   * Is the way into (or out of) a bay clear: on every lane and junction path the car's body would sweep, nothing
   * in the stretch, nothing coming that couldn't stop before it (`giveWay`: nothing coming within a few seconds,
   * as at a junction), no other car on a bay's path over it, and nothing about to come onto it from just before.
   * Going in from its lane, what is behind it there doesn't matter (it turns away from it).
   */
  protected sweepClear(v: Vehicle, row: number, bay: number, way: "in" | "out", giveWay: boolean, skip?: Piece): boolean {
    const coming = (u: Vehicle, d: number) => (giveWay ? d < Math.max(12, u.v * 4.5) : u.v > 0.5 && d < (u.v * u.v) / (2 * u.b) + 1);
    const spans = this.sweeps[row]?.[bay]?.[way] ?? [];
    // (a long vehicle whose front has gone on, its body still over the stretch: a truck through a junction)
    for (const u of this.vehicles) {
      if (u === v || u.dead || u.bayMove || u.s >= u.len) continue;
      let rest = u.len - u.s;
      for (const pc of u.trail) {
        const sp = spans.find(z => z.piece === pc);
        if (sp && sp.piece !== skip && !(way === "in" && pc === v.piece) && pc.len - rest < sp.s1) return false;
        rest -= pc.len;
        if (rest <= 0) break;
      }
    }
    for (const sp of spans) {
      if (sp.piece === skip) continue;
      const z0 = sp.s0, z1 = sp.s1;
      for (const u of this.index.get(sp.piece.id) ?? []) {
        if (u === v || u.dead || u.bayMove) continue;
        if (way === "in" && sp.piece === v.piece && u.s <= v.s) continue;
        if (u.s - u.len < z1 && u.s > z0) return false;
        // (one let through the junction ahead doesn't stop for it — see think — so it has to be well clear)
        if (u.s <= z0 && (coming(u, z0 - u.s) || ((u.granted || u.early?.granted) && z0 - u.s < Math.max(15, u.v * 4)))) return false;
      }
      for (const o of this.bayHolds.get(sp.piece.id) ?? []) if (o.v !== v && (o.v.bayMove?.way === "in" || o.v.bayMove?.go) && o.z0 < z1 && o.z1 > z0) return false;
      // (and one that has set off since: two neighbours pulling out at the same moment)
      for (const o of this.bayMovers) {
        const ob = o.bayMove;
        if (o === v || o.dead || !ob || !(ob.way === "in" || ob.go)) continue;
        for (const os of this.sweeps[ob.row]?.[ob.bay]?.[ob.way] ?? []) if (os.piece === sp.piece && os.s0 < z1 && os.s1 > z0) return false;
      }
      // (a stretch near a lane's start: those about to come onto it, out of the junction or along the road before)
      // (going in, not its own lane: what comes along it is behind it, and stops for it)
      if (sp.piece.kind === "lane" && z0 < 60 && !(way === "in" && sp.piece === v.piece)) {
        const lane = sp.piece, e = lane.edge;
        for (const u of this.vehicles) {
          if (u === v || u.dead || u.bayMove) continue;
          let d = Infinity;
          if (u.piece.kind === "conn" && u.piece.outEdge === e && u.piece.outLane === lane.lane) {
            // (in the junction heading for this lane: it won't stop in there, slow or not)
            d = u.piece.len - u.s + z0;
            if (d < 15) return false;
          } else if (u.piece.kind === "lane" && u.route[u.ri + 1] === e && u.piece.len - u.s < 60) d = u.piece.len - u.s + z0;
          if (d < Infinity && coming(u, d)) return false;
        }
      }
    }
    return true;
  }
  /** the stretch of a lane (from, to: m along it) that a car on a bay's path is over, if any */
  protected bodyAlong(u: Vehicle, lane: LanePiece): [number, number] | null {
    const q = this.pose(u), reach = lane.edge.lw / 2 + u.width / 2;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k <= 4; k++) {
      const pr = lane.poly.project(q.rx + ((q.fx - q.rx) * k) / 4, q.ry + ((q.fy - q.ry) * k) / 4);
      if (pr.d < reach) { lo = Math.min(lo, pr.s); hi = Math.max(hi, pr.s); }
    }
    return lo <= hi ? [lo, hi] : null;
  }
  /** tell the console a vehicle has stood still for long (at most once per tow time while it lasts); it stays */
  protected reportStuck(v: Vehicle, detail: () => string) {
    if (v.stuckAt !== undefined && this.tick - v.stuckAt <= this.P.towAfter / DT) return;
    v.stuckAt = this.tick;
    const at = v.piece.poly.at(Math.min(v.piece.len, Math.max(0, v.s)));
    this.problem({ kind: "stuck", veh: v.id, vkind: v.kind, x: at.x, y: at.y, at: this.placeOf(v), detail: detail() });
  }
  /** a car that couldn't get to its bay: the bay is free again, and it drives to the nearest exit it can reach */
  protected giveUpBay(v: Vehicle) {
    const e = (v.piece as LanePiece).edge, park = v.park!, st = this.parks[park.row];
    let best: Edge[] | null = null, gate: CNode | null = null, len = Infinity;
    for (const g of this.gateways) {
      if ((g.def.exitWeight ?? 1) <= 0) continue;
      const r = e.to === g ? [] : this.plan(e, { kind: "gateway", node: g });
      const l = r ? r.reduce((a, x) => a + x.length, 0) : Infinity;
      if (r && l < len) { best = r; gate = g; len = l; }
    }
    if (!best || !gate) return;
    if (st.until[park.bay] === -1) st.until[park.bay] = 0;
    v.park = null; v.parkWait = false;
    v.dest = { kind: "gateway", node: gate }; v.goal = v.dest;
    v.route = [...v.route.slice(0, v.ri + 1), ...best];
  }
  /** where a vehicle's front and rear are (see Sim.pose) */
  abstract pose(v: Vehicle): { fx: number; fy: number; rx: number; ry: number };
  /** is any part of a car on a bay's path (front, middle, rear) within the width of its lane */
  protected bodyInLane(v: Vehicle): boolean {
    const lane = v.piece as LanePiece, q = this.pose(v), reach = lane.edge.lw / 2 + v.width / 2 - 0.15;
    for (const [x, y] of [[q.fx, q.fy], [(q.fx + q.rx) / 2, (q.fy + q.ry) / 2], [q.rx, q.ry]]) if (lane.poly.project(x, y).d < reach) return true;
    return false;
  }
  /** along the bay's path: into the bay (the lane left behind once its rear is clear), or out and into the lane */
  protected bayMoveOn(v: Vehicle) {
    const bm = v.bayMove!, row = this.net.parking[bm.row], acc = row.access[bm.bay], L = accessLen(acc, bm.way);
    v.v = Math.max(0, v.v + v.acc * DT);
    const s0 = bm.s;
    bm.s = Math.min(L, bm.s + v.v * DT);
    // (backed out: it stops, and drives forwards from there)
    if (bm.way === "out" && acc.fwd && s0 < acc.outPath.len && bm.s >= acc.outPath.len) { bm.s = acc.outPath.len; v.v = 0; }
    if (bm.way === "in") {
      // (the lane is left behind once no part of the car is in it any more)
      if (bm.inLane && bm.s > 1 && !this.bodyInLane(v)) bm.inLane = false;
      if (bm.s >= L - 0.05) {
        // parked: in the bay until its stay is over
        const st = this.parks[bm.row];
        st.until[bm.bay] = this.tick + this.stayTicks(row.def.stay); st.parked++;
        v.bayMove = null; v.park = null; this.kill(v, "arrived");
      }
      return;
    }
    // (in the lane's traffic once it has its gap and comes into the lane: waiting, it is still in its bay)
    if (!bm.inLane && bm.go && this.bodyInLane(v)) bm.inLane = true;
    if (bm.s >= L) {
      // in the lane: the bay is free, and it drives on (from a standstill after backing out)
      this.parks[bm.row].until[bm.bay] = 0;
      // (where the way out left it, eased over a second into where it is in the lane: a way out cut short by the
      // road's end leaves it at an angle)
      const was = this.pose(v);
      v.bayMove = null; if (acc.reverse && !acc.fwd) v.v = 0;
      const now = this.pose(v);
      v.blend = { fx: was.fx - now.fx, fy: was.fy - now.fy, rx: was.rx - now.rx, ry: was.ry - now.ry }; v.blendT = 1;
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
    this.kill(v, "removed", "a bus at the end of its line with no way to an exit point");
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
