/**
 * Compiles an editable Network (nodes + links) into drivable geometry:
 * directed edges with lane polylines trimmed back from the junctions, junction
 * areas, turn movements with lane allowances, lane connectors, signal phases
 * and bus stops. The simulator and both renderers read this structure.
 */
import { Poly, connectorPoints, signedAngle, normAngle, hull, dist } from "./geom";
import type { LinkDef, Network, NodeDef, StopDef, LineDef, Vec } from "./types";

export const LW = 3.2;          // lane width (m)
export const CURB = 0.6;        // kerb / shoulder beyond the outer lane (m)
export type Turn = "L" | "S" | "R" | "U";

export interface PieceBase { id: number; poly: Poly; len: number; vmax: number }
export interface LanePiece extends PieceBase { kind: "lane"; edge: Edge; lane: number; offset: number }
export interface Conn extends PieceBase {
  kind: "conn"; node: CNode; move: Movement;
  /** turn = whole junction crossing; entry/exit = joining/leaving a roundabout ring */
  role: "turn" | "entry" | "exit";
  inEdge: Edge; inLane: number; outEdge: Edge; outLane: number;
  ring: boolean; mask: number; entryKey: number;
  /** for roundabout entries: the arm index */
  arm: number;
}
/** a stretch of a roundabout's circulating lane */
export interface RingPiece extends PieceBase { kind: "ring"; node: CNode; arm: number; part: "pass" | "between" }
export type Piece = LanePiece | Conn | RingPiece;

export interface RingArm { angle: number; J: Vec; X: Vec; pass: RingPiece; between: RingPiece }

export interface Edge {
  idx: number; key: string; link: LinkDef; dir: 1 | -1;
  from: CNode; to: CNode;
  n: number; bus: boolean; speed: number; base: number;
  /** a single-lane direction reserved for buses: other vehicles never route onto it */
  busOnly: boolean;
  /** sign at the junction this edge runs into (only used at priority junctions) */
  sign: "yield" | "stop" | null;
  center: Poly;          // full centreline in travel direction
  trimA: number; trimB: number;
  lanes: LanePiece[];
  length: number;        // trimmed centreline length
  reverse: Edge | null;
}

export interface Arm {
  link: LinkDef; angle: number; u: Vec;
  inEdge: Edge | null; outEdge: Edge | null;
  lo: number; hi: number; // lateral extent in outward right-normal coordinates
  w: number; setback: number;
}

export interface Movement {
  node: CNode; in: Edge; out: Edge; turn: Turn; delta: number;
  lo: number; hi: number; rank: number;
}

export interface CNode {
  idx: number; def: NodeDef; pos: Vec;
  arms: Arm[]; degree: number;
  controlled: boolean; gateway: boolean; deadEnd: boolean;
  ringR: number;
  polygon: Vec[];
  phases: number[][];              // arm indices that share a green
  /** fixed-time plan when the junction belongs to a coordinated signal group */
  coord: SignalPlan | null;
  moves: Map<number, Movement[]>;  // by in-edge idx
  conns: Map<string, Conn>;
  ring: RingArm[] | null;
}

export interface CStop { def: StopDef; edge: Edge; s: number; waiting: number }
export interface CLine { def: LineDef; stops: CStop[] }

/** one junction's share of a coordinated group: phase `seq[0]` turns green at `offset` s into each `cycle` */
export interface SignalPlan {
  group: string; groupName: string; cycle: number; offset: number;
  seq: { phase: number; green: number }[];
  yellow: number; allRed: number;
  /** the cycle had to be lengthened to fit every phase (s); 0 = fits */
  stretched: number;
}

export interface Compiled {
  nodes: CNode[]; edges: Edge[]; pieces: Piece[];
  nodeById: Map<string, CNode>; edgeByKey: Map<string, Edge>;
  stops: CStop[]; stopById: Map<string, CStop>; lines: CLine[];
  warnings: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  getConn(move: Movement, a: number, b: number): Conn;
  /** pieces a vehicle drives through to cross a junction (1 connector, or entry + ring + exit) */
  crossing(move: Movement, a: number, b: number): Piece[];
  ringEntry(move: Movement, a: number): Conn;
}

/** centreline of a link from → to */
export function linkCenter(link: LinkDef, a: Vec, b: Vec): Poly {
  if (!link.c1 || !link.c2) return new Poly([a.x, a.y, b.x, b.y]);
  const approx = dist(a, link.c1) + dist(link.c1, link.c2) + dist(link.c2, b);
  const n = Math.max(12, Math.min(96, Math.round(approx / 2)));
  const pts: number[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = 1 - t;
    pts.push(
      u * u * u * a.x + 3 * u * u * t * link.c1.x + 3 * u * t * t * link.c2.x + t * t * t * b.x,
      u * u * u * a.y + 3 * u * u * t * link.c1.y + 3 * u * t * t * link.c2.y + t * t * t * b.y,
    );
  }
  return new Poly(pts);
}

/** lateral base of lane 0 in the travel direction's right-normal frame */
export const laneBase = (n: number, nOther: number) => (nOther === 0 ? -(n * LW) / 2 : 0);

/** lateral extent of a link in the from→to right-normal frame */
export function linkExtent(link: LinkDef): [number, number] {
  const nF = link.lanesF, nB = link.lanesB;
  let lo = Infinity, hi = -Infinity;
  if (nF > 0) { const b = laneBase(nF, nB); lo = Math.min(lo, b); hi = Math.max(hi, b + nF * LW); }
  if (nB > 0) { const b = laneBase(nB, nF); lo = Math.min(lo, -(b + nB * LW)); hi = Math.max(hi, -b); }
  if (!isFinite(lo)) { lo = -LW / 2; hi = LW / 2; }
  return [lo - CURB, hi + CURB];
}

export function compile(net: Network): Compiled {
  clearConflictCache();
  const warnings: string[] = [];
  const nodes: CNode[] = [];
  const nodeById = new Map<string, CNode>();
  for (const def of net.nodes) {
    const n: CNode = {
      idx: nodes.length, def, pos: { x: def.x, y: def.y }, arms: [], degree: 0,
      controlled: false, gateway: false, deadEnd: false, ringR: 0, polygon: [], phases: [], coord: null,
      moves: new Map(), conns: new Map(), ring: null,
    };
    nodes.push(n); nodeById.set(def.id, n);
  }

  // ---- edges (directed) ----
  const edges: Edge[] = [];
  const edgeByKey = new Map<string, Edge>();
  const linkInfo = new Map<string, { center: Poly; A: CNode; B: CNode; ef: Edge | null; eb: Edge | null }>();
  for (const link of net.links) {
    const A = nodeById.get(link.from), B = nodeById.get(link.to);
    if (!A || !B || A === B) { warnings.push(`Road "${link.name || link.id}" is not connected to two different junctions.`); continue; }
    const center = linkCenter(link, A.pos, B.pos);
    if (center.len < 1) continue;
    const mk = (dir: 1 | -1): Edge | null => {
      const n = dir === 1 ? link.lanesF : link.lanesB, nOther = dir === 1 ? link.lanesB : link.lanesF;
      if (n <= 0) return null;
      const e: Edge = {
        idx: edges.length, key: `${link.id}:${dir}`, link, dir,
        from: dir === 1 ? A : B, to: dir === 1 ? B : A,
        n: Math.min(4, n), bus: (dir === 1 ? link.busF : link.busB) && n >= 2, busOnly: (dir === 1 ? link.busF : link.busB) && n === 1, sign: (dir === 1 ? link.signF : link.signB) ?? null,
        speed: Math.max(10, link.speed || 50) / 3.6, base: laneBase(n, nOther),
        center: dir === 1 ? center : center.reversed(), trimA: 0, trimB: 0, lanes: [], length: 0, reverse: null,
      };
      edges.push(e); edgeByKey.set(e.key, e);
      return e;
    };
    const ef = mk(1), eb = mk(-1);
    if (ef && eb) { ef.reverse = eb; eb.reverse = ef; }
    linkInfo.set(link.id, { center, A, B, ef, eb });
    const [lo, hi] = linkExtent(link);
    // arms: outward direction from each end
    const tA = center.tangent(0), tB = center.tangent(center.len);
    const uA = { x: tA.x, y: tA.y }, uB = { x: -tB.x, y: -tB.y };
    A.arms.push({ link, angle: Math.atan2(uA.y, uA.x), u: uA, outEdge: ef, inEdge: eb, lo, hi, w: Math.max(-lo, hi), setback: 0 });
    // at B the outward direction is reversed, so the lateral frame flips
    B.arms.push({ link, angle: Math.atan2(uB.y, uB.x), u: uB, outEdge: eb, inEdge: ef, lo: -hi, hi: -lo, w: Math.max(-lo, hi), setback: 0 });
  }

  // ---- node classification, setbacks ----
  for (const n of nodes) {
    n.arms.sort((a, b) => a.angle - b.angle);
    n.degree = n.arms.length;
    n.gateway = n.degree === 1 && n.def.gateway;
    n.deadEnd = n.degree === 1 && !n.def.gateway;
    n.controlled = n.degree > 0 && !n.gateway && (n.degree !== 2 || n.def.junction === true);
    const roundabout = n.controlled && n.degree >= 3 && n.def.control === "roundabout";
    if (roundabout) {
      const maxW = Math.max(...n.arms.map(a => a.w));
      n.ringR = Math.max(9, Math.min(32, maxW + 5));
    }
    for (let i = 0; i < n.arms.length; i++) {
      const arm = n.arms[i];
      if (n.degree === 1) { arm.setback = n.gateway ? 0 : 9; continue; }
      if (roundabout) { arm.setback = n.ringR + 4.5; continue; }
      const nbrs = n.degree === 2 ? [n.arms[1 - i]] : [n.arms[(i + 1) % n.degree], n.arms[(i - 1 + n.degree) % n.degree]];
      let d = 0;
      for (const o of nbrs) {
        const th = Math.abs(normAngle(o.angle - arm.angle));
        let dd: number;
        if (th > 2.9) dd = 0.5;
        else if (th < 0.2) dd = 40;
        else dd = (o.w + arm.w * Math.cos(th)) / Math.sin(th);
        d = Math.max(d, dd);
      }
      arm.setback = Math.max(n.degree === 2 ? 0.5 : 2, Math.min(40, d + (n.degree === 2 ? 0.5 : 1.5)));
      // a 2-road junction (crossing) gets room for a stop line and a crosswalk
      if (n.degree === 2 && n.controlled) arm.setback = Math.max(arm.setback, 3.5);
    }
  }

  // ---- trim edges, build lane pieces ----
  const pieces: Piece[] = [];
  for (const link of net.links) {
    const info = linkInfo.get(link.id); if (!info) continue;
    const armA = info.A.arms.find(a => a.link === link)!, armB = info.B.arms.find(a => a.link === link)!;
    let sa = armA.setback, sb = armB.setback;
    const L = info.center.len;
    if (sa + sb > L - 2) {
      const f = Math.max(0.05, (L - 2) / (sa + sb));
      if (L < 6 || f < 0.6) warnings.push(`Road "${link.name || "unnamed"}" is very short for its junctions (${L.toFixed(1)} m); lanes are squeezed.`);
      sa *= f; sb *= f;
      armA.setback = sa; armB.setback = sb;
    }
    for (const e of [info.ef, info.eb]) {
      if (!e) continue;
      e.trimA = e.dir === 1 ? sa : sb;
      e.trimB = e.dir === 1 ? sb : sa;
      const c = e.center.slice(e.trimA, e.center.len - e.trimB);
      e.length = c.len;
      for (let k = 0; k < e.n; k++) {
        const off = e.base + (k + 0.5) * LW;
        const poly = c.offset(off);
        const r = poly.minRadius();
        const vmax = Math.min(e.speed, isFinite(r) ? Math.max(4, Math.sqrt(2.2 * r)) : e.speed);
        const lp: LanePiece = { id: pieces.length, kind: "lane", edge: e, lane: k, offset: off, poly, len: poly.len, vmax };
        pieces.push(lp); e.lanes.push(lp);
      }
    }
  }

  // ---- junction polygons, movements, phases ----
  for (const n of nodes) {
    if (n.degree === 0) continue;
    const pts: Vec[] = [];
    for (const a of n.arms) {
      const m = { x: n.pos.x + a.u.x * a.setback, y: n.pos.y + a.u.y * a.setback };
      const r = { x: -a.u.y, y: a.u.x };
      pts.push({ x: m.x + r.x * a.lo, y: m.y + r.y * a.lo }, { x: m.x + r.x * a.hi, y: m.y + r.y * a.hi });
    }
    if (n.degree >= 2 && n.def.smooth && !n.ringR) n.polygon = smoothOutline(n);
    else if (n.degree >= 2) { pts.push(n.pos); n.polygon = hull(pts); }
    else n.polygon = pts;

    for (const ain of n.arms) {
      const ein = ain.inEdge; if (!ein || ein.lanes.length === 0) continue;
      const tin = ein.lanes[0].poly.tangent(ein.lanes[0].len);
      const list: Movement[] = [];
      for (const aout of n.arms) {
        const eout = aout.outEdge; if (!eout || eout.lanes.length === 0) continue;
        const uturn = aout.link === ain.link;
        if (uturn && !n.deadEnd) continue;
        const tout = eout.lanes[0].poly.tangent(0);
        const delta = uturn ? Math.PI : signedAngle(tin, tout);
        const turn: Turn = uturn || Math.abs(delta) > 2.7 ? "U" : delta > 0.52 ? "R" : delta < -0.52 ? "L" : "S";
        list.push({ node: n, in: ein, out: eout, turn, delta, lo: 0, hi: 0, rank: 0 });
      }
      // only one "straight": the one closest to 0°, others become slight turns
      const straights = list.filter(m => m.turn === "S").sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
      for (const m of straights.slice(1)) m.turn = m.delta > 0 ? "R" : "L";
      list.sort((a, b) => a.delta - b.delta);
      const k = list.length, nl = ein.n;
      list.forEach((m, r) => {
        m.rank = r;
        if (m.turn === "S" || k === 1 || nl === 1) { m.lo = 0; m.hi = nl - 1; return; }
        m.lo = Math.min(nl - 1, Math.floor((r * nl) / k));
        m.hi = Math.max(m.lo, Math.min(nl - 1, Math.ceil(((r + 1) * nl) / k) - 1));
        if (r === 0) m.lo = 0;
        if (r === k - 1) m.hi = nl - 1;
      });
      // with a straight movement present, turns share the edge lanes with it
      const hasS = list.some(m => m.turn === "S");
      if (hasS) for (const m of list) if (m.turn !== "S" && k > 1 && nl > 1) {
        if (m.rank < list.findIndex(x => x.turn === "S")) { m.lo = 0; m.hi = 0; } else { m.lo = nl - 1; m.hi = nl - 1; }
      }
      // per-lane turn overrides drawn on the road ("left only", "ahead + right", …)
      const custom = ein.dir === 1 ? ein.link.turnsF : ein.link.turnsB;
      if (custom && custom.length === nl && list.length) {
        const letter = (m: Movement) => (m.turn === "U" ? "L" : m.turn);
        const next: Movement[] = [];
        for (const m of list) {
          const lanes = custom.map((t, i) => (t.includes(letter(m)) ? i : -1)).filter(i => i >= 0);
          if (!lanes.length) continue; // this turn is not allowed from any lane
          m.lo = Math.min(...lanes); m.hi = Math.max(...lanes);
          next.push(m);
        }
        if (!next.length) {
          warnings.push(`Road "${ein.link.name || "unnamed"}": the lane arrows allow no way through the junction ahead, so they are ignored.`);
        } else {
          // a lane whose arrows lead nowhere here (e.g. "ahead" at a T-junction) joins the nearest movement
          for (let k = 0; k < nl; k++) {
            if (next.some(m => k >= m.lo && k <= m.hi)) continue;
            let best = next[0], bd = Infinity;
            for (const m of next) { const d = k < m.lo ? m.lo - k : k - m.hi; if (d < bd) { bd = d; best = m; } }
            best.lo = Math.min(best.lo, k); best.hi = Math.max(best.hi, k);
          }
          list.length = 0; list.push(...next);
        }
      }
      n.moves.set(ein.idx, list);
    }

    // signal phases: group arms that face each other
    if (n.controlled && n.degree === 2) {
      // both directions share one green; the second phase is all-red (e.g. pedestrians crossing)
      n.phases.push(n.arms.map((a, i) => ({ a, i })).filter(x => x.a.inEdge).map(x => x.i), []);
    } else if (n.controlled && n.degree >= 3) {
      const used = new Set<number>();
      const withIn = n.arms.map((a, i) => ({ a, i })).filter(x => x.a.inEdge);
      if (n.def.signal.separate) for (const { i } of withIn) { n.phases.push([i]); used.add(i); }
      for (const { a, i } of withIn) {
        if (used.has(i)) continue;
        used.add(i);
        const group = [i];
        let best = -1, bestErr = 0.7;
        for (const { a: b, i: j } of withIn) {
          if (used.has(j)) continue;
          const err = Math.abs(Math.abs(normAngle(b.angle - a.angle)) - Math.PI);
          if (err < bestErr) { bestErr = err; best = j; }
        }
        if (best >= 0) { group.push(best); used.add(best); }
        n.phases.push(group);
      }
      // lights need at least two phases to do anything: with only two opposite approaches
      // coming in (e.g. a one-way side road), give each its own green; a single approach gets
      // an all-red phase (pedestrians) so it still stops sometimes
      if (n.phases.length === 1) {
        const only = n.phases[0];
        n.phases = only.length >= 2 ? only.map(i => [i]) : [only, []];
      }
    }
  }

  // ---- stops & lines ----
  const stops: CStop[] = [];
  const stopById = new Map<string, CStop>();
  for (const def of net.stops) {
    const e = edgeByKey.get(`${def.link}:${def.dir}`);
    if (!e) { warnings.push(`Stop "${def.name}" is on a road direction with no lanes.`); continue; }
    const s = Math.max(2, Math.min(e.length - 2, e.length * (def.dir === 1 ? def.pos : 1 - def.pos)));
    const cs: CStop = { def, edge: e, s, waiting: 4 };
    stops.push(cs); stopById.set(def.id, cs);
  }
  const lines: CLine[] = net.lines.map(def => ({ def, stops: def.stops.map(id => stopById.get(id)).filter((x): x is CStop => !!x) }));

  // ---- roundabout rings: circulate with decreasing screen angle (counter-clockwise on a map) ----
  for (const n of nodes) {
    if (!(n.ringR > 0)) continue;
    const R = n.ringR, C = n.pos, m = n.arms.length, off = Math.min(0.32, (Math.PI / m) * 0.45);
    const P = (th: number): Vec => ({ x: C.x + R * Math.cos(th), y: C.y + R * Math.sin(th) });
    const arc = (t0: number, t1: number) => {
      const steps = Math.max(2, Math.ceil(Math.abs(t0 - t1) / 0.1)), pts: number[] = [];
      for (let k = 0; k <= steps; k++) { const th = t0 + ((t1 - t0) * k) / steps; pts.push(C.x + R * Math.cos(th), C.y + R * Math.sin(th)); }
      return new Poly(pts);
    };
    const vmax = Math.min(7, Math.max(4, Math.sqrt(2.2 * R)));
    const ring: RingArm[] = n.arms.map((a) => ({ angle: a.angle, J: P(a.angle - off), X: P(a.angle + off), pass: null as unknown as RingPiece, between: null as unknown as RingPiece }));
    for (let k = 0; k < m; k++) {
      const a = n.arms[k].angle;
      const pass = arc(a + off, a - off);
      const nk = (k - 1 + m) % m;
      let an = n.arms[nk].angle; if (an >= a) an -= 2 * Math.PI;
      const between = arc(a - off, an + off);
      ring[k].pass = { id: pieces.length, kind: "ring", node: n, arm: k, part: "pass", poly: pass, len: pass.len, vmax };
      pieces.push(ring[k].pass);
      ring[k].between = { id: pieces.length, kind: "ring", node: n, arm: k, part: "between", poly: between, len: between.len, vmax };
      pieces.push(ring[k].between);
    }
    n.ring = ring;
  }

  // ---- coordinated signal groups ----
  for (const g of net.signalGroups ?? []) for (const m of g.members) {
    const n = nodeById.get(m.node);
    if (!n || !n.controlled || n.def.control !== "lights" || n.phases.length < 2) continue;
    const k = n.phases.length, { yellow, allRed } = n.def.signal;
    const MIN = 5;
    const need = k * (yellow + allRed + MIN);
    const cycle = Math.max(g.cycle, need);
    const greens = cycle - k * (yellow + allRed);
    const p0 = Math.min(k - 1, Math.max(0, m.phase));
    const main = Math.max(MIN, Math.min(greens - (k - 1) * MIN, greens * m.share));
    const rest = (greens - main) / (k - 1);
    const seq = Array.from({ length: k }, (_, i) => ({ phase: (p0 + i) % k, green: i === 0 ? main : rest }));
    n.coord = { group: g.id, groupName: g.name, cycle, offset: ((m.offset % cycle) + cycle) % cycle, seq, yellow, allRed, stretched: cycle > g.cycle ? cycle : 0 };
    if (cycle > g.cycle) warnings.push(`Signal group "${g.name}": a ${g.cycle} s cycle is too short for a junction with ${k} phases; it runs ${Math.ceil(cycle)} s there, so it drifts out of sync.`);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of net.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  for (const l of net.links) for (const c of [l.c1, l.c2]) if (c) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  if (!isFinite(minX)) { minX = -200; minY = -150; maxX = 200; maxY = 150; }

  const compiled: Compiled = {
    nodes, edges, pieces, nodeById, edgeByKey, stops, stopById, lines, warnings,
    bounds: { minX, minY, maxX, maxY },
    getConn(move, a, b) {
      const n = move.node, key = `${move.in.idx}:${a}:${move.out.idx}:${b}`;
      let c = n.conns.get(key);
      if (c) return c;
      c = buildConn(n, move, a, b, pieces.length);
      pieces.push(c); n.conns.set(key, c);
      return c;
    },
    ringEntry(move, a) {
      const n = move.node, key = `E:${move.in.idx}:${a}`;
      let c = n.conns.get(key);
      if (c) return c;
      const arm = n.arms.findIndex(x => x.inEdge === move.in), ra = n.ring![arm];
      const lin = move.in.lanes[Math.min(a, move.in.lanes.length - 1)];
      const th = ra.angle - Math.min(0.32, (Math.PI / n.arms.length) * 0.45);
      const pts = connectorPoints(lin.poly.at(lin.len), lin.poly.tangent(lin.len), ra.J, { x: Math.sin(th), y: -Math.cos(th) }, 10);
      const poly = new Poly(pts);
      c = { id: pieces.length, kind: "conn", role: "entry", node: n, move, inEdge: move.in, inLane: a, outEdge: move.in, outLane: a, ring: true, mask: 0, entryKey: move.in.idx * 8 + a, arm, poly, len: poly.len, vmax: 6 };
      pieces.push(c); n.conns.set(key, c);
      return c;
    },
    crossing(move, a, b) {
      const n = move.node;
      if (!n.ring) return [this.getConn(move, a, b)];
      const m = n.arms.length, ai = n.arms.findIndex(x => x.inEdge === move.in), ao = n.arms.findIndex(x => x.outEdge === move.out);
      const out: Piece[] = [this.ringEntry(move, a), n.ring[ai].between];
      let k = (ai - 1 + m) % m, guard = 0;
      while (k !== ao && guard++ < m + 1) { out.push(n.ring[k].pass, n.ring[k].between); k = (k - 1 + m) % m; }
      const key = `X:${move.out.idx}:${b}`;
      let x = n.conns.get(key);
      if (!x) {
        const ra = n.ring[ao], lout = move.out.lanes[Math.min(b, move.out.lanes.length - 1)];
        const th = ra.angle + Math.min(0.32, (Math.PI / m) * 0.45);
        const poly = new Poly(connectorPoints(ra.X, { x: Math.sin(th), y: -Math.cos(th) }, lout.poly.at(0), lout.poly.tangent(0), 10));
        x = { id: pieces.length, kind: "conn", role: "exit", node: n, move, inEdge: move.out, inLane: b, outEdge: move.out, outLane: b, ring: true, mask: 0, entryKey: -1 - pieces.length, arm: ao, poly, len: poly.len, vmax: 7 };
        pieces.push(x); n.conns.set(key, x);
      }
      out.push(x);
      return out;
    },
  };
  return compiled;
}

function buildConn(n: CNode, move: Movement, a: number, b: number, id: number): Conn {
  const lin = move.in.lanes[Math.min(a, move.in.lanes.length - 1)], lout = move.out.lanes[Math.min(b, move.out.lanes.length - 1)];
  const P = lin.poly.at(lin.len), tp = lin.poly.tangent(lin.len);
  const Q = lout.poly.at(0), tq = lout.poly.tangent(0);
  let pts: number[];
  let ring = false, mask = 0;
  if (n.ringR > 0) {
    ring = true;
    const C = n.pos, R = n.ringR;
    const te = Math.atan2(P.y - C.y, P.x - C.x) - 0.3;
    let tx = Math.atan2(Q.y - C.y, Q.x - C.x) + 0.3;
    while (tx >= te) tx -= 2 * Math.PI;
    while (te - tx > 2 * Math.PI) tx += 2 * Math.PI;
    const J = { x: C.x + R * Math.cos(te), y: C.y + R * Math.sin(te) }, tJ = { x: Math.sin(te), y: -Math.cos(te) };
    const X = { x: C.x + R * Math.cos(tx), y: C.y + R * Math.sin(tx) }, tX = { x: Math.sin(tx), y: -Math.cos(tx) };
    pts = connectorPoints(P, tp, J, tJ, 8);
    const steps = Math.max(3, Math.ceil((te - tx) / 0.12));
    const angles = n.arms.map(x => x.angle);
    for (let k = 1; k < steps; k++) {
      const th = te + ((tx - te) * k) / steps;
      pts.push(C.x + R * Math.cos(th), C.y + R * Math.sin(th));
      const na = normAngle(th);
      let sector = 0; while (sector < angles.length && angles[sector] <= na) sector++;
      mask |= 1 << (sector % angles.length);
    }
    pts.push(...connectorPoints(X, tX, Q, tq, 8));
  } else if (move.turn === "U" && n.deadEnd) {
    const reach = 9;
    const c1 = { x: P.x + tp.x * reach, y: P.y + tp.y * reach }, c2 = { x: Q.x - tq.x * reach, y: Q.y - tq.y * reach };
    pts = [];
    for (let k = 0; k <= 16; k++) {
      const t = k / 16, u = 1 - t;
      pts.push(u * u * u * P.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * Q.x, u * u * u * P.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * Q.y);
    }
  } else {
    pts = connectorPoints(P, tp, Q, tq, 14);
  }
  const poly = new Poly(pts);
  const r = poly.minRadius();
  let vmax = Math.min(move.in.speed, move.out.speed);
  if (isFinite(r)) vmax = Math.min(vmax, Math.max(4.5, Math.sqrt(3.0 * r)));
  if (ring) vmax = Math.min(vmax, 6.5);
  return {
    id, kind: "conn", role: "turn", node: n, move, inEdge: move.in, inLane: a, outEdge: move.out, outLane: b,
    poly, len: poly.len, vmax, ring, mask, entryKey: move.in.idx * 8 + a, arm: -1,
  };
}

/** which exit lane a vehicle in lane a ends up in for a movement */
export function exitLane(move: Movement, a: number, isBus: boolean): number {
  const nOut = move.out.n;
  let b: number;
  if (move.turn === "U") b = 0;
  else if (move.turn === "L") b = Math.min(Math.max(0, a - move.lo), nOut - 1);
  else if (move.turn === "R") b = Math.max(0, nOut - 1 - (move.hi - a));
  else b = Math.min(a, nOut - 1);
  if (move.out.bus) {
    if (isBus && move.in.bus && a === move.in.n - 1) b = nOut - 1;
    else if (!isBus && b >= nOut - 1) b = Math.max(0, nOut - 2);
  }
  return b;
}

/** conflict test between two connectors at the same junction (cached) */
const confCache = new Map<number, boolean>();
export function conflicts(A: Conn, B: Conn): boolean {
  if (A === B) return false;
  if (A.inEdge === B.inEdge && A.inLane === B.inLane) return false;
  const key = A.id * 1_000_003 + B.id;
  const hit = confCache.get(key);
  if (hit !== undefined) return hit;
  let c: boolean;
  if (A.outEdge === B.outEdge && A.outLane === B.outLane) c = true;
  else if (A.ring && B.ring) c = A.inEdge !== B.inEdge && (A.mask & B.mask) !== 0;
  else {
    c = false;
    const a = A.poly.pts, b = B.poly.pts;
    outer: for (let p = 0; p < a.length; p += 2) for (let q = 0; q < b.length; q += 2) {
      const dx = a[p] - b[q]; if (dx > 2 || dx < -2) continue;
      const dy = a[p + 1] - b[q + 1]; if (dy > 2 || dy < -2) continue;
      if (dx * dx + dy * dy < 4) { c = true; break outer; }
    }
  }
  confCache.set(key, c);
  return c;
}
export const clearConflictCache = () => confCache.clear();

/**
 * Junction outline with rounded kerbs: each road's mouth, joined to the next road (going round
 * the node) by a curve that leaves along one road's kerb and arrives along the other's. Between
 * two roads at a shallow angle (a slip road joining) this gives the pointed "gore" of a merge
 * instead of a boxy wedge.
 */
function smoothOutline(n: CNode): Vec[] {
  const out: Vec[] = [];
  const arms = n.arms, k = arms.length;
  const corner = (a: Arm, side: number) => {
    const m = { x: n.pos.x + a.u.x * a.setback, y: n.pos.y + a.u.y * a.setback };
    return { x: m.x - a.u.y * side, y: m.y + a.u.x * side };
  };
  for (let i = 0; i < k; i++) {
    const a = arms[i], b = arms[(i + 1) % k];
    const p0 = corner(a, a.lo), p1 = corner(a, a.hi), p3 = corner(b, b.lo);
    out.push(p0, p1);
    const chord = Math.hypot(p3.x - p1.x, p3.y - p1.y);
    // handles run back along each kerb toward the node, never past it
    const ha = Math.min(chord * 0.55, a.setback * 0.9 + 1), hb = Math.min(chord * 0.55, b.setback * 0.9 + 1);
    const c1 = { x: p1.x - a.u.x * ha, y: p1.y - a.u.y * ha }, c2 = { x: p3.x - b.u.x * hb, y: p3.y - b.u.y * hb };
    const seg = Math.max(4, Math.min(16, Math.ceil(chord / 1.5)));
    for (let s = 1; s < seg; s++) {
      const t = s / seg, mt = 1 - t;
      out.push({
        x: mt * mt * mt * p1.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * p3.x,
        y: mt * mt * mt * p1.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * p3.y,
      });
    }
  }
  return out;
}
