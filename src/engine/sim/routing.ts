import { exitLane, type CNode, type Edge, type Movement, type Piece } from "../compile";
import type { Vec } from "../types";
import { DT, type Dest, type Vehicle } from "./base";
import { SimBase } from "./base";

/** Routes: A* over the directed edges, the pieces a vehicle drives through at each junction (and which exit lane it takes), re-planning on the way, turning proportions. */
export abstract class SimRouting extends SimBase {
  // ------------------------------------------------------------ routing
  /**
   * A* over directed edges from the end of `start` to a destination.
   * Returns the list of edges after `start`, or null.
   */
  plan(start: Edge, dest: Dest, opts: { avoid?: Movement; firstOuts?: Set<Edge>; bus?: boolean } = {}): Edge[] | null {
    const goal = (e: Edge) =>
      dest.kind === "gateway" ? e.to === dest.node : dest.kind === "edge" ? e === dest.edge : e === dest.stop.edge;
    const target: Vec = dest.kind === "gateway" ? dest.node.pos : dest.kind === "edge" ? dest.edge.to.pos : dest.stop.edge.to.pos;
    // search buffers are kept between calls (sized to the network) and invalidated by a generation
    // stamp, so a search costs what it explores rather than the size of the whole network
    const E = this.net.edges.length;
    if (this.aG.length !== E) { this.aG = new Float64Array(E); this.aPar = new Int32Array(E); this.aSeen = new Uint32Array(E); this.aClosed = new Uint32Array(E); }
    const gen = ++this.aGen;
    const gOf = (e: number) => (this.aSeen[e] === gen ? this.aG[e] : Infinity);
    const par = this.aPar;
    // binary heap in parallel typed arrays (same order of operations as a heap of {f, e} objects)
    let hf = this.aHeapF, he = this.aHeapE, n = 0;
    const push = (f: number, e: number) => {
      if (n === hf.length) { const nf = new Float64Array(n * 2), ne = new Int32Array(n * 2); nf.set(hf); ne.set(he); hf = this.aHeapF = nf; he = this.aHeapE = ne; }
      let i = n++;
      hf[i] = f; he[i] = e;
      while (i > 0) { const q = (i - 1) >> 1; if (hf[q] <= f) break; const tf = hf[q], te = he[q]; hf[q] = hf[i]; he[q] = he[i]; hf[i] = tf; he[i] = te; i = q; }
    };
    const pop = () => {
      const top = he[0];
      n--;
      if (n > 0) {
        hf[0] = hf[n]; he[0] = he[n]; let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && hf[c + 1] < hf[c]) c++;
          if (hf[c] >= hf[i]) break;
          const tf = hf[c], te = he[c]; hf[c] = hf[i]; he[c] = he[i]; hf[i] = tf; he[i] = te; i = c;
        }
      }
      return top;
    };
    if (dest.kind === "gateway" && start.to === dest.node) return [];
    const h = (e: Edge) => Math.hypot(e.to.pos.x - target.x, e.to.pos.y - target.y) / this.maxSpeed;
    // expand from start without counting it
    const tt = this.freeTime, ema = this.ema;
    const expandFrom = (e: Edge, base: number, first: boolean) => {
      const moves = this.movesFrom[e.idx]; if (!moves) return;
      const ctl = this.nodeDelay[e.to.idx];
      for (const m of moves) {
        if (first && opts.firstOuts && !opts.firstOuts.has(m.out)) continue;
        if (m.out.busOnly && !opts.bus) continue;
        const t0 = tt[m.out.idx];
        let c = base + t0 + Math.max(0, ema[m.out.idx] - t0);
        c += ctl + (m.turn === "L" ? 3 : m.turn === "U" ? 25 : m.turn === "R" ? 1 : 0);
        if (opts.avoid && m === opts.avoid) c += 400;
        const oi = m.out.idx;
        if (c < gOf(oi)) { this.aG[oi] = c; this.aSeen[oi] = gen; par[oi] = first ? -2 : e.idx; push(c + h(m.out), oi); }
      }
    };
    expandFrom(start, 0, true);
    let guard = 0;
    while (n > 0 && guard++ < 50000) {
      const ei = pop();
      if (this.aClosed[ei] === gen) continue;
      this.aClosed[ei] = gen;
      const e = this.net.edges[ei];
      if (goal(e)) {
        const out: Edge[] = [];
        let cur = ei;
        while (cur >= 0) { out.push(this.net.edges[cur]); cur = par[cur]; }
        return out.reverse();
      }
      expandFrom(e, gOf(ei), false);
    }
    return null;
  }
  /** pieces this vehicle would drive through at the end of edge route[ri] from `lane` */
  protected crossingFor(v: Vehicle, ri: number, lane: number): readonly Piece[] | null {
    const e = v.route[ri], next = v.route[ri + 1];
    if (!e || !next) return null;
    const m = this.moveOf(e, next);
    if (!m) return null;
    const a = Math.min(lane, e.n - 1);
    // a granted crossing is kept, so the choice below can't change under the vehicle's wheels
    if (v.conn && !e.to.ring && v.conn.role === "turn" && v.conn.move === m && v.conn.inLane === a) return this.net.crossing(m, a, v.conn.outLane);
    // a pending request keeps its exit lane too (no flip-flopping while waiting at a red light),
    // unless that lane has no room any more
    const rq = v.reqFor;
    if (rq && !e.to.ring && rq.role === "turn" && rq.move === m && rq.inLane === a && this.exitRoom(this.ns[e.to.idx], rq, v)) return this.net.crossing(m, a, rq.outLane);
    return this.net.crossing(m, a, this.chooseExitLane(v, m, a, ri + 1));
  }
  /**
   * Exit lane for a vehicle crossing from lane `a`: when the road it joins has more lanes than
   * the turn uses, pick the one that suits the vehicle's *next* turn (left lane before a left
   * turn, and so on), staying within this lane's share of the exit so parallel turns don't cross.
   */
  protected chooseExitLane(v: Vehicle, m: Movement, a: number, outIdx: number): number {
    const isBus = v.kind === "bus";
    const b0 = exitLane(m, a, isBus);
    if (m.turn === "U" || (isBus && m.out.bus)) return b0;
    const out = m.out;
    const usable = out.bus && !isBus ? out.n - 1 : out.n;
    const k = m.hi - m.lo + 1, j = Math.min(k - 1, Math.max(0, a - m.lo));
    if (usable <= k) return b0;
    const bLo = Math.floor((j * usable) / k), bHi = Math.max(bLo, Math.floor(((j + 1) * usable) / k) - 1);
    const want = this.laneTarget(v, outIdx);
    let target = b0;
    if (want) target = Math.min(Math.max(b0, want.lo), want.hi);
    target = Math.min(bHi, Math.max(bLo, target));
    if (target === b0) return b0;
    // only worth it if that lane isn't backed up to the junction; otherwise take the usual lane
    const lp = out.lanes[target];
    let rear = Infinity;
    for (const u of this.index.get(lp.id) ?? []) rear = Math.min(rear, u.s - u.len);
    return rear > 10 ? target : b0;
  }
  /** lanes the vehicle will need on route edge `idx` for the next junction it turns at */
  protected laneTarget(v: Vehicle, idx: number): { lo: number; hi: number } | null {
    const e0 = v.route[idx];
    if (!e0) return null;
    for (let k = idx, hop = 0; hop < 5; k++, hop++) {
      const ek = v.route[k], nk = v.route[k + 1];
      if (!ek || !nk || ek.n !== e0.n) return null;
      const mk = this.moveOf(ek, nk);
      if (!mk) return null;
      if (ek.to.controlled || ek.to.degree !== 2) {
        const many = (ek.to.moves.get(ek.idx)?.length || 0) > 1;
        return many ? { lo: mk.lo, hi: mk.hi } : null;
      }
    }
    return null;
  }
  /** re-plan the rest of the route after entering a new edge */
  protected replan(v: Vehicle) {
    const e = v.route[v.ri];
    if (v.dest.kind === "edge" && v.dest.edge === e) { v.route = v.route.slice(0, v.ri + 1); return; }
    if (v.dest.kind === "stop" && v.dest.stop.edge === e) { v.route = v.route.slice(0, v.ri + 1); return; }
    if (v.dest.kind === "gateway" && e.to === v.dest.node) { v.route = v.route.slice(0, v.ri + 1); return; }
    if (this.rng() < 0.5 || v.route.length <= v.ri + 1) {
      // keep the turn at the coming junction if we already sit in a lane for it (we picked the
      // lane on the way in); only re-think the route beyond it
      const oldNext = v.route[v.ri + 1], m0 = oldNext ? this.moveOf(e, oldNext) : undefined;
      let rest: Edge[] | null = null;
      if (m0 && v.lane >= m0.lo && v.lane <= m0.hi) {
        const tail = oldNext.to === (v.dest.kind === "gateway" ? v.dest.node : null) || (v.dest.kind === "edge" && v.dest.edge === oldNext) || (v.dest.kind === "stop" && v.dest.stop.edge === oldNext) ? [] : this.plan(oldNext, v.dest, { bus: v.kind === "bus" });
        if (tail) rest = [oldNext, ...tail];
      }
      rest ??= this.plan(e, v.dest, { bus: v.kind === "bus" });
      if (rest) v.route = [...v.route.slice(0, v.ri + 1), ...rest];
    }
    this.applySplit(v);
    if (v.route.length > 60) { const cut = v.ri; v.route = v.route.slice(cut); v.ri = 0; }
  }
  /**
   * Turning proportions: when a vehicle starts along an edge whose junction has a split set,
   * it draws its exit from the split and re-plans from there (keeping its destination if it
   * can still get there, otherwise heading for the nearest way out).
   */
  protected applySplit(v: Vehicle) {
    // buses follow their line, transit vehicles their own exit
    if (v.kind === "bus" || v.flow >= 0) return;
    // decide this junction and the next one, so there is a whole road to get into the right lane
    this.applySplitAt(v, v.ri);
    this.applySplitAt(v, v.ri + 1);
  }
  protected applySplitAt(v: Vehicle, i: number) {
    const e = v.route[i];
    if (!e) return;
    if ((v.dest.kind === "edge" && v.dest.edge === e) || (v.dest.kind === "gateway" && e.to === v.dest.node)) return;
    const split = e.dir === 1 ? e.link.splitF : e.link.splitB;
    if (!split) return;
    const moves = (e.to.moves.get(e.idx) ?? []).filter(m => !m.out.busOnly);
    let out = v.splits?.get(e.idx);
    if (!out || !moves.some(m => m.out === out)) {
      const weights = moves.map(m => split[m.out.link.id] ?? 0);
      const total = weights.reduce((a, b) => a + b, 0);
      if (total <= 0) return;
      let x = this.rng() * total, k = 0;
      for (; k < moves.length - 1; k++) { x -= weights[k]; if (x <= 0) break; }
      out = moves[k].out;
      (v.splits ??= new Map()).set(e.idx, out);
    }
    if (v.route[i + 1] === out) return;
    let rest = this.plan(out, v.dest);
    if (!rest && !(v.dest.kind === "edge" && v.dest.edge === out)) {
      // the old destination is behind us: leave by whichever exit is reachable
      for (const g of this.shuffled(this.gateways)) {
        const d: Dest = { kind: "gateway", node: g };
        const r = out.to === g ? [] : this.plan(out, d);
        if (r) { v.dest = d; rest = r; break; }
      }
    }
    v.route = [...v.route.slice(0, i + 1), out, ...(rest ?? [])];
  }
  protected recordEma(v: Vehicle, e: Edge) {
    if (v.kind === "bus") return;
    const dur = (this.tick - v.enterT) * DT;
    this.ema[e.idx] = this.ema[e.idx] > 0 ? this.ema[e.idx] * 0.8 + dur * 0.2 : dur;
  }
  /** the turn this vehicle plans at the end of its current road, and the lanes that allow it */
  nextTurn(v: Vehicle): { node: CNode; move: Movement } | null {
    const e = v.route[v.ri], next = v.route[v.ri + 1];
    if (!e || !next || v.piece.kind !== "lane") return null;
    const m = this.moveOf(e, next);
    return m ? { node: e.to, move: m } : null;
  }
}
