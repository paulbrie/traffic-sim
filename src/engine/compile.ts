/**
 * Compiles an editable Network (nodes + links) into drivable geometry:
 * directed edges with lane polylines trimmed back from the junctions, junction
 * areas, turn movements with lane allowances, lane connectors, signal phases
 * and bus stops. The simulator and both renderers read this structure.
 */
import { Poly, connectorPoints, signedAngle, normAngle, hull, dist } from "./geom";
import { MAX_LANES, type FlowDef, type LinkDef, Network, NodeDef, StopDef, LineDef, Vec, ZoneDef, ZoneFlowDef } from "./types";
import { attachBuildings, type Place } from "./buildings";

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
  /** roundabout entries and exits: the circulating lane they join or leave (1 = inner) */
  ringLane?: 0 | 1;
}
/** a stretch of a roundabout's circulating lane */
/** a stretch of a roundabout's circulating lane (`lane` 1 = the inner lane of a two-lane ring) */
export interface RingPiece extends PieceBase { kind: "ring"; node: CNode; arm: number; part: "pass" | "between"; lane: 0 | 1 }
export type Piece = LanePiece | Conn | RingPiece;

export interface RingArm { angle: number; J: Vec; X: Vec; pass: RingPiece; between: RingPiece }

export interface Edge {
  idx: number; key: string; link: LinkDef; dir: 1 | -1;
  from: CNode; to: CNode;
  n: number; bus: boolean; speed: number; base: number;
  /** lane width (m) */
  lw: number;
  /**
   * Turn bays: `left` lanes 0.. and `right` lanes at the kerb exist only over the last metres before
   * the stop line; the `thru` lanes between run the whole way. Vehicles enter the edge in the
   * through lanes and may move into a bay lane from `open[lane]` (m along that lane piece).
   */
  left: number; right: number; thru: number; open: number[];
  /** where the bays open, in m along the trimmed centreline (0 = no bay on that side) */
  leftAt: number; rightAt: number;
  /** the kerb-side through lane (bus stops, bus lane) */
  kerb: number;
  /**
   * A lane that ends before the junction ahead (-1 = none): from `dropFrom` it narrows away, and at
   * `dropEnd` (m along the trimmed centreline) it is gone; its traffic has merged into the lane beside.
   */
  dropLane: number; dropFrom: number; dropEnd: number;
  /** where a vehicle still in the ending lane waits for a gap (m along the trimmed centreline; enough of the lane left for a car) */
  dropStop: number;
  /** a single-lane direction reserved for buses: other vehicles never route onto it */
  busOnly: boolean;
  /** sign at the junction this edge runs into (only used at priority junctions) */
  sign: "yield" | "stop" | null;
  center: Poly;          // full centreline in travel direction
  trimA: number; trimB: number;
  lanes: LanePiece[];
  length: number;        // trimmed centreline length
  reverse: Edge | null;
  /** index of the arm this edge arrives on at `to`, and leaves from at `from` */
  inArm: number; outArm: number;
}

export interface Arm {
  link: LinkDef; angle: number; u: Vec;
  inEdge: Edge | null; outEdge: Edge | null;
  lo: number; hi: number; // lateral extent in outward right-normal coordinates
  w: number; setback: number;
  /** where the road leaves the junction area: the centreline point `setback` m along the (possibly curved) road, and the outward direction there */
  mouth: Vec; mu: Vec;
}

export interface Movement {
  node: CNode; in: Edge; out: Edge; turn: Turn; delta: number;
  lo: number; hi: number; rank: number;
  /** two roads merging into one: the side this one joins from (its lanes feed that side of the road ahead) */
  merge?: "left" | "right";
  /** lanes dropping at a plain road point: how many of the approach's left through lanes end there
   *  (the ones that carry on are those lined up with the road ahead) */
  skip?: number;
  /** lanes added at a plain road point: how many of the exit's left through lanes are new (the
   *  approach's lanes feed the ones they are lined up with) */
  shift?: number;
  /** connectors and crossings built for this movement, by inLane * 8 + outLane (filled lazily) */
  conns?: (Conn | undefined)[];
  crossings?: (readonly Piece[] | undefined)[];
}

export interface CNode {
  idx: number; def: NodeDef; pos: Vec;
  arms: Arm[]; degree: number;
  controlled: boolean; gateway: boolean; deadEnd: boolean;
  ringR: number;
  /** the junction area out to the kerb's outer edge (as the roads' kerbs), and its asphalt (inside the kerb) */
  polygon: Vec[]; surface: Vec[];
  /** drawn with rounded kerbs (set on the node, or roads meeting at a shallow angle) */
  rounded: boolean;
  /** elevation: the lowest level of the roads meeting here (a bridge meeting a ground road joins it on the ground) */
  level: number;
  /** pedestrians per hour crossing each road (0 = none; never at roundabouts or plain road points) */
  peds: number;
  phases: number[][];              // arm indices that share a green (an arm is listed when any of its lanes is green)
  /** per arm, per lane of its approach: the phases in which that lane has green */
  lanePhases: number[][][];
  /** green and minimum green time of each phase (s) */
  phaseGreen: number[]; phaseMinGreen: number[];
  /** the junction runs custom (per-lane) phases */
  customPhases: boolean;
  /** fixed-time plan when the junction belongs to a coordinated signal group */
  coord: SignalPlan | null;
  moves: Map<number, Movement[]>;  // by in-edge idx
  /** connectors built so far, by numeric key (see getConn / ringEntry / crossing) */
  conns: Map<number, Conn>;
  ring: RingArm[] | null;
  /** the inner circulating lane of a two-lane roundabout, and its radius */
  ring2: RingArm[] | null; ringR2: number;
}

export interface CFlow { idx: number; def: FlowDef; from: CNode; to: CNode }
/** a zone's trip ends: its entry points, and its buildings with a road to use (by trip weight) */
export interface CZone { idx: number; def: ZoneDef; entries: CNode[]; places: Place[]; placeW: number }
export interface CZoneFlow { idx: number; def: ZoneFlowDef; from: CZone; to: CZone }

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
  /** building access points (trip origins and destinations inside the plan) */
  places: Place[];
  /** transit flows between entry points (those whose ends are both entry points) */
  flows: CFlow[];
  /** zones (their usable entry points and buildings) and the demand between them */
  zones: CZone[];
  zoneFlows: CZoneFlow[];
  warnings: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  getConn(move: Movement, a: number, b: number): Conn;
  /** pieces a vehicle drives through to cross a junction (1 connector, or entry + ring + exit); shared, don't modify */
  crossing(move: Movement, a: number, b: number): readonly Piece[];
  buildCrossing(move: Movement, a: number, b: number): Piece[];
  ringEntry(move: Movement, a: number, lane?: 0 | 1): Conn;
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

/** the node at the far end of one of a node's roads, past plain bend points (2-road points that aren't junctions) */
export function armEnd(nodeById: Map<string, CNode>, n: CNode, arm: Arm): CNode {
  let cur = n, link = arm.link;
  for (let hop = 0; hop < 60; hop++) {
    const nx = nodeById.get(link.from === cur.def.id ? link.to : link.from);
    if (!nx) return cur;
    if (nx.degree !== 2 || nx.controlled) return nx;
    const other = nx.arms.find(a => a.link !== link);
    if (!other) return nx;
    cur = nx; link = other.link;
  }
  return cur;
}

/** height of one elevation level (m) */
export const LEVEL_H = 6;

/** length of road it takes to climb one level (m): 6 m in 100 m */
export const RAMP_PER_LEVEL = 100;

/**
 * Elevation (in levels) at fraction t (0..1, from → to) along a link `len` m long: from the height
 * of the junction at each end it climbs (smoothly, at most 45% of the link each side) to its own
 * level and stays there, so a bridge joining ground roads rises out of them and comes back down.
 */
export function linkZ(c: { nodeById: Map<string, CNode> }, link: LinkDef, t: number, len: number): number {
  const L = link.level ?? 0, a = c.nodeById.get(link.from)?.level ?? 0, b = c.nodeById.get(link.to)?.level ?? 0;
  if (a === L && b === L) return L;
  const d = Math.min(1, Math.max(0, t)) * len, sm = (u: number) => u * u * (3 - 2 * u);
  const ra = Math.min(0.45 * len, RAMP_PER_LEVEL * Math.abs(L - a)), rb = Math.min(0.45 * len, RAMP_PER_LEVEL * Math.abs(L - b));
  if (ra > 0 && d < ra) return a + (L - a) * sm(d / ra);
  if (rb > 0 && d > len - rb) return b + (L - b) * sm((len - d) / rb);
  return L;
}

/** elevation (in levels) of a point s metres along a piece (lane, connector or ring) */
export function pieceZ(c: { nodeById: Map<string, CNode> }, p: Piece, s: number): number {
  if (p.kind !== "lane") return p.node.level;
  const e = p.edge, along = e.trimA + (s / Math.max(1e-6, p.len)) * e.length, t = along / Math.max(1e-6, e.center.len);
  return linkZ(c, e.link, e.dir === 1 ? t : 1 - t, e.center.len);
}
/** the level a piece is drawn at (lanes: their road's; junction pieces: the junction's) */
export const pieceLevel = (p: Piece) => (p.kind === "lane" ? p.edge.link.level ?? 0 : p.node.level);

/** lateral base of lane 0 in the travel direction's right-normal frame (half the median on two-way roads) */
export const laneBase = (n: number, nOther: number, median = 0, lw = LW) => (nOther === 0 ? -(n * lw) / 2 : median / 2);
/** a road's lane width */
export const laneWidth = (link: LinkDef) => link.laneWidth ?? LW;

/** lanes of one direction along a link: through lanes plus turn bays, and the bays */
export function dirLanes(link: LinkDef, dir: 1 | -1) {
  const thru = Math.min(MAX_LANES, dir === 1 ? link.lanesF : link.lanesB);
  const b = thru > 0 ? (dir === 1 ? link.baysF : link.baysB) : null;
  const left = b?.left ?? 0, right = b?.right ?? 0;
  return { thru, left, right, n: thru > 0 ? thru + left + right : 0, leftLen: b?.leftLen ?? 0, rightLen: b?.rightLen ?? 0 };
}

/** lateral extent of a link in the from→to right-normal frame */
export function linkExtent(link: LinkDef): [number, number] {
  const nF = dirLanes(link, 1).n, nB = dirLanes(link, -1).n, m = link.median ?? 0, lw = laneWidth(link);
  let lo = Infinity, hi = -Infinity;
  if (nF > 0) { const b = laneBase(nF, nB, m, lw); lo = Math.min(lo, b); hi = Math.max(hi, b + nF * lw); }
  if (nB > 0) { const b = laneBase(nB, nF, m, lw); lo = Math.min(lo, -(b + nB * lw)); hi = Math.max(hi, -b); }
  if (!isFinite(lo)) { lo = -lw / 2; hi = lw / 2; }
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
      controlled: false, gateway: false, deadEnd: false, ringR: 0, polygon: [], surface: [], rounded: false, level: 0, peds: 0, phases: [], lanePhases: [], phaseGreen: [], phaseMinGreen: [], customPhases: false, coord: null,
      moves: new Map(), conns: new Map(), ring: null, ring2: null, ringR2: 0,
    };
    nodes.push(n); nodeById.set(def.id, n);
  }

  // ---- edges (directed) ----
  const edges: Edge[] = [];
  const edgeByKey = new Map<string, Edge>();
  const linkInfo = new Map<string, { link: LinkDef; center: Poly; A: CNode; B: CNode; ef: Edge | null; eb: Edge | null }>();
  for (const link of net.links) {
    const A = nodeById.get(link.from), B = nodeById.get(link.to);
    if (!A || !B || A === B) { warnings.push(`Road "${link.name || link.id}" is not connected to two different junctions.`); continue; }
    const center = linkCenter(link, A.pos, B.pos);
    if (center.len < 1) continue;
    const mk = (dir: 1 | -1): Edge | null => {
      const d = dirLanes(link, dir), nOther = dirLanes(link, dir === 1 ? -1 : 1).n, n = d.n;
      if (n <= 0) return null;
      const e: Edge = {
        idx: edges.length, key: `${link.id}:${dir}`, link, dir,
        from: dir === 1 ? A : B, to: dir === 1 ? B : A,
        n, bus: (dir === 1 ? link.busF : link.busB) && d.thru >= 2, busOnly: (dir === 1 ? link.busF : link.busB) && d.thru === 1, sign: (dir === 1 ? link.signF : link.signB) ?? null,
        left: d.left, right: d.right, thru: d.thru, open: [], leftAt: 0, rightAt: 0, kerb: d.left + d.thru - 1, dropLane: -1, dropFrom: 0, dropEnd: 0, dropStop: 0,
        speed: Math.max(10, link.speed || 50) / 3.6, base: laneBase(n, nOther, link.median ?? 0, laneWidth(link)), lw: laneWidth(link),
        center: dir === 1 ? center : center.reversed(), trimA: 0, trimB: 0, lanes: [], length: 0, reverse: null, inArm: -1, outArm: -1,
      };
      edges.push(e); edgeByKey.set(e.key, e);
      return e;
    };
    const ef = mk(1), eb = mk(-1);
    if (ef && eb) { ef.reverse = eb; eb.reverse = ef; }
    linkInfo.set(link.id, { link, center, A, B, ef, eb });
    const [lo, hi] = linkExtent(link);
    // arms: outward direction from each end
    const tA = center.tangent(0), tB = center.tangent(center.len);
    const uA = { x: tA.x, y: tA.y }, uB = { x: -tB.x, y: -tB.y };
    A.arms.push({ link, angle: Math.atan2(uA.y, uA.x), u: uA, outEdge: ef, inEdge: eb, lo, hi, w: Math.max(-lo, hi), setback: 0, mouth: A.pos, mu: uA });
    // at B the outward direction is reversed, so the lateral frame flips
    B.arms.push({ link, angle: Math.atan2(uB.y, uB.x), u: uB, outEdge: eb, inEdge: ef, lo: -hi, hi: -lo, w: Math.max(-lo, hi), setback: 0, mouth: B.pos, mu: uB });
    // a lane that has ended by the junction: the road is that much narrower where it gets there
    const lw = laneWidth(link), aA = A.arms[A.arms.length - 1], aB = B.arms[B.arms.length - 1];
    if (ef && link.dropF) { if (link.dropF.side === "right") aB.lo += lw; else if (!eb) aB.hi -= lw; }
    if (eb && link.dropB) { if (link.dropB.side === "right") aA.lo += lw; else if (!ef) aA.hi -= lw; }
  }

  // ---- node classification, setbacks ----
  for (const n of nodes) {
    n.arms.sort((a, b) => a.angle - b.angle);
    n.arms.forEach((a, i) => { if (a.inEdge) a.inEdge.inArm = i; if (a.outEdge) a.outEdge.outArm = i; });
    n.degree = n.arms.length;
    n.level = n.arms.length ? Math.min(...n.arms.map(a => a.link.level ?? 0)) : 0;
    n.gateway = n.degree === 1 && n.def.gateway;
    n.deadEnd = n.degree === 1 && !n.def.gateway;
    n.controlled = n.degree > 0 && !n.gateway && (n.degree !== 2 || n.def.junction === true);
    const roundabout = n.controlled && n.degree >= 3 && n.def.control === "roundabout";
    n.peds = n.controlled && !roundabout && n.degree >= 2 ? n.def.peds ?? 0 : 0;
    if (roundabout) {
      const maxW = Math.max(...n.arms.map(a => a.w));
      n.ringR = n.def.ringLanes === 2 ? Math.max(14, Math.min(36, maxW + 7)) : Math.max(9, Math.min(32, maxW + 5));
    }
    for (let i = 0; i < n.arms.length; i++) {
      const arm = n.arms[i];
      if (n.degree === 1) { arm.setback = n.gateway ? 0 : 9; continue; }
      if (roundabout) { arm.setback = n.ringR + 4.5; continue; }
      const nbrs = n.degree === 2 ? [n.arms[1 - i]] : [n.arms[(i + 1) % n.degree], n.arms[(i - 1 + n.degree) % n.degree]];
      let d = 0;
      for (const o of nbrs) {
        const rel = normAngle(o.angle - arm.angle), th = Math.abs(rel);
        // the edges that face each other: a neighbour turned toward this arm's right-normal side
        // meets its `hi` edge with its own `lo` edge, and the other way round (roads can be lopsided:
        // a lane that has ended, different lanes each way)
        const wa = rel > 0 ? arm.hi : -arm.lo, wo = rel > 0 ? -o.lo : o.hi;
        let dd: number;
        if (th > 2.9) dd = 0.5;
        else if (th < 0.2) dd = 40;
        else dd = (wo + wa * Math.cos(th)) / Math.sin(th);
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
    { const t = info.center.tangent(sa); armA.mouth = info.center.at(sa); armA.mu = { x: t.x, y: t.y }; }
    { const t = info.center.tangent(L - sb); armB.mouth = info.center.at(L - sb); armB.mu = { x: -t.x, y: -t.y }; }
    for (const e of [info.ef, info.eb]) {
      if (!e) continue;
      e.trimA = e.dir === 1 ? sa : sb;
      e.trimB = e.dir === 1 ? sb : sa;
      const c = e.center.slice(e.trimA, e.center.len - e.trimB);
      e.length = c.len;
      const d = dirLanes(link, e.dir);
      if (e.left) e.leftAt = Math.max(0, c.len - d.leftLen);
      if (e.right) e.rightAt = Math.max(0, c.len - d.rightLen);
      const drop = e.dir === 1 ? link.dropF : link.dropB;
      if (drop && e.thru >= 2) {
        e.dropLane = drop.side === "left" ? e.left : e.left + e.thru - 1;
        e.dropEnd = Math.max(1, c.len - 1); e.dropFrom = Math.max(0, e.dropEnd - drop.len);
        e.dropStop = e.dropFrom + 0.35 * (e.dropEnd - e.dropFrom);
      }
      for (let k = 0; k < e.n; k++) {
        const off = e.base + (k + 0.5) * e.lw;
        // a lane that ends follows its taper: it stays in the middle of what is left of it
        const toward = k === e.dropLane ? (k === e.left ? 1 : -1) : 0;
        const poly = toward && e.dropEnd > e.dropFrom
          ? c.offsetBy(s => off + toward * (e.lw / 2) * Math.min(1, Math.max(0, (s - e.dropFrom) / (e.dropEnd - e.dropFrom))), e.dropFrom, e.dropEnd)
          : c.offset(off);
        const r = poly.minRadius();
        const vmax = Math.min(e.speed, isFinite(r) ? Math.max(4, Math.sqrt(2.2 * r)) : e.speed);
        const lp: LanePiece = { id: pieces.length, kind: "lane", edge: e, lane: k, offset: off, poly, len: poly.len, vmax };
        pieces.push(lp); e.lanes.push(lp);
        const at = k < e.left ? e.leftAt : k >= e.left + e.thru ? e.rightAt : 0;
        e.open.push(c.len > 0 ? (at / c.len) * poly.len : 0);
      }
    }
  }

  // ---- junction polygons, movements, phases ----
  // slip lanes by the junction they bypass and the node they leave from: the nodes they lead to
  const slips = new Map<string, Set<string>>();
  for (const l of net.links) if (l.slip) { const k = `${l.slip}|${l.from}`; (slips.get(k) ?? slips.set(k, new Set()).get(k)!).add(l.to); }
  for (const n of nodes) {
    if (n.degree === 0) continue;
    // roads meeting at a shallow angle (a slip road, a fork) always get rounded kerbs and a pointed nose
    let shallow = false;
    if (n.degree >= 3) for (let i = 0; i < n.degree; i++) {
      const gap = i ? n.arms[i].angle - n.arms[i - 1].angle : n.arms[0].angle + 2 * Math.PI - n.arms[n.degree - 1].angle;
      if (gap < 0.6) shallow = true;
    }
    n.rounded = n.degree >= 2 && (!!n.def.smooth || shallow) && !n.ringR;
    const outline = (inset: number) => {
      const pts: Vec[] = [];
      for (const a of n.arms) {
        const m = a.mouth, r = { x: -a.mu.y, y: a.mu.x };
        pts.push({ x: m.x + r.x * (a.lo + inset), y: m.y + r.y * (a.lo + inset) }, { x: m.x + r.x * (a.hi - inset), y: m.y + r.y * (a.hi - inset) });
      }
      if (n.rounded) return smoothOutline(n, inset);
      if (n.degree >= 2) { pts.push(n.pos); return hull(pts); }
      return pts;
    };
    n.polygon = outline(0);
    n.surface = n.degree >= 2 ? outline(CURB) : n.polygon;

    for (const ain of n.arms) {
      const ein = ain.inEdge; if (!ein || ein.lanes.length === 0) continue;
      const tin = ein.lanes[0].poly.tangent(ein.lanes[0].len);
      const list: Movement[] = [];
      for (const aout of n.arms) {
        const eout = aout.outEdge; if (!eout || eout.lanes.length === 0) continue;
        const uturn = aout.link === ain.link;
        if (uturn && !n.deadEnd) continue;
        // a slip lane is entered only from its approach and leads only on along the exit (never
        // back toward the junction it bypasses)
        if (eout.link.slip && armEnd(nodeById, n, ain).def.id === eout.link.slip) continue;
        if (ein.link.slip && armEnd(nodeById, n, aout).def.id === ein.link.slip) continue;
        const tout = eout.lanes[0].poly.tangent(0);
        const delta = uturn ? Math.PI : signedAngle(tin, tout);
        const turn: Turn = uturn || Math.abs(delta) > 2.7 ? "U" : delta > 0.52 ? "R" : delta < -0.52 ? "L" : "S";
        list.push({ node: n, in: ein, out: eout, turn, delta, lo: 0, hi: 0, rank: 0 });
      }
      // a slip lane from this approach's start to the exit's end takes that turn off the junction
      if (list.length > 1 && slips.size) {
        const slipTo = slips.get(`${n.def.id}|${armEnd(nodeById, n, ain).def.id}`);
        if (slipTo) for (let q = list.length - 1; q >= 0 && list.length > 1; q--) if (slipTo.has(armEnd(nodeById, n, n.arms[list[q].out.outArm]).def.id)) list.splice(q, 1);
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
      // turn bays: left bays take the left turns (and U-turns), right bays the right turns, the
      // through lanes the rest as above (laid out over the through lanes only)
      if ((ein.left || ein.right) && list.length) {
        const L = ein.left, T = ein.thru, isLeft = (m: Movement) => m.turn === "L" || m.turn === "U";
        const sIdx = list.findIndex(x => x.turn === "S");
        for (const m of list) {
          const r = m.rank, kk = list.length;
          if (m.turn === "S" || kk === 1 || T === 1) { m.lo = L; m.hi = L + T - 1; }
          else if (sIdx >= 0) { m.lo = m.hi = r < sIdx ? L : L + T - 1; }
          else {
            m.lo = L + Math.min(T - 1, Math.floor((r * T) / kk));
            m.hi = Math.max(m.lo, L + Math.min(T - 1, Math.ceil(((r + 1) * T) / kk) - 1));
          }
          if (L && isLeft(m)) { m.lo = 0; m.hi = L - 1; }
          if (ein.right && m.turn === "R") { m.lo = L + T; m.hi = nl - 1; }
        }
        // a bay whose turn doesn't exist here (e.g. a left bay at a T with no left) serves the nearest movement
        for (let q = 0; q < nl; q++) {
          if (list.some(m => q >= m.lo && q <= m.hi)) continue;
          let best = list[0], bd = Infinity;
          for (const m of list) { const dd = q < m.lo ? m.lo - q : q - m.hi; if (dd < bd) { bd = dd; best = m; } }
          best.lo = Math.min(best.lo, q); best.hi = Math.max(best.hi, q);
        }
      }
      // a lane that ends before the junction leads nowhere there: its traffic has merged by then
      if (ein.dropLane >= 0 && nl >= 2 && list.length) {
        const leftEnds = ein.dropLane === ein.left;
        for (const m of list) {
          if (leftEnds) { if (m.lo === ein.dropLane) m.lo = Math.min(m.lo + 1, nl - 1); }
          else if (m.hi === ein.dropLane) m.hi = Math.max(m.hi - 1, 0);
          if (m.lo > m.hi) m.lo = m.hi;
        }
      }
      // two-lane roundabout, approach with 2+ lanes: the kerb lane to the first exit, the others further round
      if (n.ringR > 0 && n.def.ringLanes === 2 && nl >= 2 && list.length) {
        for (const m of list) { if (m.turn === "R") { m.lo = m.hi = nl - 1; } else { m.lo = 0; m.hi = nl - 2; } }
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
      // general traffic never drives in the bus lane (the kerb lane): a turn that only the bus lane
      // could make is also allowed from the lane beside it, so cars turn from there
      if (ein.bus) for (const m of list) if (m.lo === nl - 1) m.lo = nl - 2;
      n.moves.set(ein.idx, list);
    }

    // merges: roads going (nearly) straight on into the same road join it side by side, the one on
    // the right into its right-hand lanes
    if (n.degree >= 3 && !n.ringR) {
      const into = new Map<Edge, Movement[]>();
      for (const list of n.moves.values()) for (const m of list) if (Math.abs(m.delta) < 0.8 && m.turn !== "U") (into.get(m.out) ?? into.set(m.out, []).get(m.out)!).push(m);
      for (const [out, ms] of into) {
        if (ms.length < 2) continue;
        const u = n.arms[out.outArm].u, r = { x: -u.y, y: u.x };
        // how far to the right of the road ahead each incoming road lies
        const side = (m: Movement) => { const a = n.arms[m.in.inArm]; return a.u.x * r.x + a.u.y * r.y; };
        const sorted = ms.slice().sort((a, b) => side(a) - side(b));
        sorted[0].merge = "left"; sorted[sorted.length - 1].merge = "right";
      }
    }
    // a plain road point where the number of lanes changes: lanes carry on into the ones they are
    // lined up with (not always the left ones); the others end there, or open there
    if (!n.controlled && n.degree === 2) for (const list of n.moves.values()) for (const m of list) {
      const ein = m.in, eout = m.out;
      if (m.turn === "U" || ein.dropLane >= 0 || eout.thru === ein.thru) continue;
      const fewer = Math.min(ein.thru, eout.thru), spare = Math.abs(ein.thru - eout.thru);
      let best = 0, bestCost = Infinity;
      for (let w = 0; w <= spare; w++) {
        let cost = 0;
        for (let j = 0; j < fewer; j++) {
          const a = ein.lanes[ein.left + j + (ein.thru > eout.thru ? w : 0)], b = eout.lanes[eout.left + j + (ein.thru > eout.thru ? 0 : w)];
          const p = a.poly.at(a.len), q = b.poly.at(0);
          cost += Math.hypot(p.x - q.x, p.y - q.y);
        }
        // (a clear difference only: evenly placed lanes keep the left ones, as before)
        if (cost < bestCost - 0.5) { bestCost = cost; best = w; }
      }
      if (best) { if (ein.thru > eout.thru) m.skip = best; else m.shift = best; }
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
    // per-lane view of the phases: custom lights read it from the roads, automatic ones give
    // every lane of an approach its approach's phase
    const sig = n.def.signal, custom = n.controlled && n.def.control === "lights" && (n.def.phases?.length ?? 0) >= 2;
    if (custom) {
      const defs = n.def.phases!, k = defs.length;
      n.customPhases = true;
      n.lanePhases = n.arms.map(a => {
        const e = a.inEdge;
        if (!e) return [];
        const g = (e.dir === 1 ? e.link.greenF : e.link.greenB) ?? [];
        return Array.from({ length: e.n }, (_, lane) => (g[lane] ?? []).filter(p => p < k));
      });
      n.phases = defs.map((_, p) => n.arms.map((_, i) => i).filter(i => n.lanePhases[i].some(ps => ps.includes(p))));
      n.phaseGreen = defs.map(d => d.green);
      n.phaseMinGreen = defs.map(d => d.minGreen ?? sig.minGreen);
      n.arms.forEach(a => {
        const e = a.inEdge;
        if (!e) return;
        const dark = n.lanePhases[n.arms.indexOf(a)].map((ps, lane) => (ps.length ? -1 : lane)).filter(l => l >= 0);
        if (dark.length) warnings.push(`Traffic lights: lane${dark.length > 1 ? "s" : ""} ${dark.map(l => l + 1).join(", ")} of ${e.link.name || "an unnamed road"} never get${dark.length > 1 ? "" : "s"} green; set ${dark.length > 1 ? "them" : "it"} in the junction's phases.`);
      });
    } else {
      n.lanePhases = n.arms.map((a, i) => {
        const p = n.phases.findIndex(g => g.includes(i));
        return a.inEdge ? Array.from({ length: a.inEdge.n }, () => (p >= 0 ? [p] : [])) : [];
      });
      n.phaseGreen = n.phases.map(() => sig.green);
      n.phaseMinGreen = n.phases.map(() => sig.minGreen);
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
    const C = n.pos, m = n.arms.length, off = Math.min(0.32, (Math.PI / m) * 0.45);
    const build = (R: number, lane: 0 | 1): RingArm[] => {
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
        ring[k].pass = { id: pieces.length, kind: "ring", node: n, arm: k, part: "pass", poly: pass, len: pass.len, vmax, lane };
        pieces.push(ring[k].pass);
        ring[k].between = { id: pieces.length, kind: "ring", node: n, arm: k, part: "between", poly: between, len: between.len, vmax, lane };
        pieces.push(ring[k].between);
      }
      return ring;
    };
    n.ring = build(n.ringR, 0);
    // a two-lane roundabout: an inner lane one lane width in
    if (n.def.ringLanes === 2) { n.ringR2 = n.ringR - LW; n.ring2 = build(n.ringR2, 1); }
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

  const places = attachBuildings(net.buildings ?? [], [...linkInfo.values()]);

  // ---- transit flows: both ends must be entry points
  const flows: CFlow[] = [];
  for (const def of net.flows ?? []) {
    const from = nodeById.get(def.from), to = nodeById.get(def.to);
    if (!from || !to) continue;
    if (!from.gateway || !to.gateway) { warnings.push(`Transit flow: both ends must be entry / exit points (dead ends where traffic comes and goes).`); continue; }
    flows.push({ idx: flows.length, def, from, to });
  }

  // ---- zones: entry points and buildings grouped for zone-to-zone demand
  const placeOf = new Map(places.map(p => [p.building.id, p]));
  const zones: CZone[] = (net.zones ?? []).map((def, idx) => {
    const entries = def.members.filter(m => m.kind === "entry").map(m => nodeById.get(m.id)).filter((n): n is CNode => !!n && n.gateway);
    const zp = def.members.filter(m => m.kind === "building").map(m => placeOf.get(m.id)).filter((p): p is Place => !!p);
    return { idx, def, entries, places: zp, placeW: zp.reduce((a, p) => a + p.w, 0) };
  });
  const zoneById = new Map(zones.map(z => [z.def.id, z]));
  const zoneFlows: CZoneFlow[] = [];
  for (const def of net.zoneFlows ?? []) {
    const from = zoneById.get(def.from), to = zoneById.get(def.to);
    if (!from || !to || def.rate <= 0) continue;
    const usable = (z: CZone) => z.entries.length > 0 || z.places.length > 0;
    if (!usable(from) || !usable(to)) { warnings.push(`Zone demand ${from.def.name} → ${to.def.name}: a zone has no entry point or building with a road, so no trips run.`); continue; }
    zoneFlows.push({ idx: zoneFlows.length, def, from, to });
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of net.buildings ?? []) for (const p of b.pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  for (const n of net.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  for (const l of net.links) for (const c of [l.c1, l.c2]) if (c) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  if (!isFinite(minX)) { minX = -200; minY = -150; maxX = 200; maxY = 150; }

  const compiled: Compiled = {
    nodes, edges, pieces, nodeById, edgeByKey, stops, stopById, lines, places, flows, zones, zoneFlows, warnings,
    bounds: { minX, minY, maxX, maxY },
    getConn(move, a, b) {
      const cache = (move.conns ??= []), k = a * 8 + b;
      let c = cache[k];
      if (c) return c;
      c = buildConn(move.node, move, a, b, pieces.length);
      pieces.push(c); cache[k] = c;
      move.node.conns.set(1_000_000_000 + c.id, c); // (keys ≥ 1e9: plain crossings, < 0: roundabout pieces)
      return c;
    },
    ringEntry(move, a, lane = 0) {
      const n = move.node, key = -(move.in.idx * 8 + a) - 1 - lane * 10_000_000;
      let c = n.conns.get(key);
      if (c) return c;
      const arm = move.in.inArm, ra = (lane ? n.ring2 : n.ring)![arm];
      const lin = move.in.lanes[Math.min(a, move.in.lanes.length - 1)];
      const th = ra.angle - Math.min(0.32, (Math.PI / n.arms.length) * 0.45);
      const pts = connectorPoints(lin.poly.at(lin.len), lin.poly.tangent(lin.len), ra.J, { x: Math.sin(th), y: -Math.cos(th) }, 10);
      const poly = new Poly(pts);
      c = { id: pieces.length, kind: "conn", role: "entry", node: n, move, inEdge: move.in, inLane: a, outEdge: move.in, outLane: a, ring: true, mask: 0, entryKey: move.in.idx * 8 + a, arm, poly, len: poly.len, vmax: 6, ringLane: lane };
      pieces.push(c); n.conns.set(key, c);
      return c;
    },
    crossing(move, a, b) {
      const cache = (move.crossings ??= []), k = a * 8 + b;
      return (cache[k] ??= this.buildCrossing(move, a, b));
    },
    buildCrossing(move, a, b) {
      const n = move.node;
      if (!n.ring) return [this.getConn(move, a, b)];
      // two-lane roundabout: the first exit (a right turn) on the outer lane, the rest on the inner
      const lane: 0 | 1 = n.ring2 && move.turn !== "R" ? 1 : 0, ring = lane ? n.ring2! : n.ring;
      const m = n.arms.length, ai = move.in.inArm, ao = move.out.outArm;
      const out: Piece[] = [this.ringEntry(move, a, lane), ring[ai].between];
      let k = (ai - 1 + m) % m, guard = 0;
      while (k !== ao && guard++ < m + 1) { out.push(ring[k].pass, ring[k].between); k = (k - 1 + m) % m; }
      const key = -(edges.length * 8 + move.out.idx * 8 + b) - 1 - lane * 10_000_000;
      let x = n.conns.get(key);
      if (!x) {
        const ra = ring[ao], lout = move.out.lanes[Math.min(b, move.out.lanes.length - 1)];
        const th = ra.angle + Math.min(0.32, (Math.PI / m) * 0.45);
        const poly = new Poly(connectorPoints(ra.X, { x: Math.sin(th), y: -Math.cos(th) }, lout.poly.at(0), lout.poly.tangent(0), 10));
        x = { id: pieces.length, kind: "conn", role: "exit", node: n, move, inEdge: move.out, inLane: b, outEdge: move.out, outLane: b, ring: true, mask: 0, entryKey: -1 - pieces.length, arm: ao, poly, len: poly.len, vmax: 7, ringLane: lane };
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

/**
 * Every lane connector through every junction, as x, y points: from each lane a turn may start in,
 * to the lane it usually leads to. For drawing only: built outside the simulation's own pieces, so
 * showing them doesn't change a run. Roundabouts are left out (their ring is drawn instead).
 */
export interface ConnectorView { node: CNode; move: Movement; inLane: number; outLane: number; pts: Float32Array }
export function connectorPreview(c: Compiled, only?: (n: CNode, m: Movement) => boolean): ConnectorView[] {
  const out: ConnectorView[] = [];
  for (const n of c.nodes) {
    if (!n.controlled || n.ringR > 0) continue;
    for (const list of n.moves.values()) for (const m of list) if (!only || only(n, m)) for (let a = m.lo; a <= m.hi; a++) {
      const b = exitLane(m, a, false);
      out.push({ node: n, move: m, inLane: a, outLane: b, pts: Float32Array.from(buildConn(n, m, a, b, -1).poly.pts) });
    }
  }
  return out;
}
/** selection id of a lane connector */
export const connectorId = (v: { node: CNode; move: Movement; inLane: number; outLane: number }) => `${v.node.def.id}|${v.move.in.key}|${v.inLane}|${v.move.out.key}|${v.outLane}`;

/** which exit lane a vehicle in lane a ends up in for a movement (always a through lane of the exit: its bays open further on) */
export function exitLane(move: Movement, a: number, isBus: boolean): number {
  const out = move.out, lo = out.left, nOut = out.thru;
  let b: number;
  if (move.turn === "U") b = 0;
  else if (move.turn === "L" || move.merge === "left") b = Math.min(Math.max(0, a - move.lo), nOut - 1);
  else if (move.turn === "R" || move.merge === "right") b = Math.max(0, nOut - 1 - (move.hi - a));
  else b = Math.max(0, Math.min(a - move.in.left - (move.in.dropLane === move.in.left ? 1 : 0) - (move.skip ?? 0) + (move.shift ?? 0), nOut - 1));
  if (out.bus) {
    if (isBus && move.in.bus && a === move.in.kerb) b = nOut - 1;
    else if (!isBus && b >= nOut - 1) b = Math.max(0, nOut - 2);
  }
  return lo + b;
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
/**
 * How far along A (m from its start) its conflict with B ends: past this point A's centre line
 * stays more than CLEAR m from B's (wider than the conflict test, so that vehicle bodies, up to a
 * bus's width, are clear of each other). Infinity when the conflict lasts to the end (both end in the same
 * exit lane, or roundabout rings), so a vehicle on A only frees B once it has left the junction.
 */
const confEndCache = new Map<number, number>();
const CLEAR = 3.5;
export function conflictEnd(A: Conn, B: Conn): number {
  const key = A.id * 1_000_003 + B.id;
  const hit = confEndCache.get(key);
  if (hit !== undefined) return hit;
  let end = Infinity;
  if (!(A.outEdge === B.outEdge && A.outLane === B.outLane) && !(A.ring && B.ring)) {
    const a = A.poly.pts, b = B.poly.pts;
    let along = 0, last = -1;
    for (let p = 0; p < a.length; p += 2) {
      if (p > 0) along += Math.hypot(a[p] - a[p - 2], a[p + 1] - a[p - 1]);
      for (let q = 0; q < b.length; q += 2) {
        const dx = a[p] - b[q], dy = a[p + 1] - b[q + 1];
        if (dx * dx + dy * dy < CLEAR * CLEAR) { last = along; break; }
      }
    }
    // the samples are a few metres apart: count up to the next one
    if (last >= 0) end = Math.min(A.len, last + A.len / Math.max(1, a.length / 2 - 1));
  }
  confEndCache.set(key, end);
  return end;
}
/**
 * Two junction crossings that end in the same exit lane (and are not roundabout pieces) merge
 * into it like a zip: how far along A (m) it first comes within CLEAR of B. Infinity for any
 * other pair.
 */
const zipCache = new Map<number, number>();
export function zipFrom(A: Conn, B: Conn): number {
  if (A.outEdge !== B.outEdge || A.outLane !== B.outLane || A.ring || B.ring || A.role !== "turn" || B.role !== "turn") return Infinity;
  const key = A.id * 1_000_003 + B.id;
  const hit = zipCache.get(key);
  if (hit !== undefined) return hit;
  const a = A.poly.pts, b = B.poly.pts;
  let along = 0, at = A.len;
  outer: for (let p = 0; p < a.length; p += 2) {
    if (p > 0) along += Math.hypot(a[p] - a[p - 2], a[p + 1] - a[p - 1]);
    for (let q = 0; q < b.length; q += 2) {
      const dx = a[p] - b[q], dy = a[p + 1] - b[q + 1];
      if (dx * dx + dy * dy < CLEAR * CLEAR) { at = along; break outer; }
    }
  }
  zipCache.set(key, at);
  return at;
}
export const clearConflictCache = () => { confCache.clear(); confEndCache.clear(); zipCache.clear(); };

/**
 * Junction outline with rounded kerbs: each road's mouth, joined to the next road (going round
 * the node) by a curve that leaves along one road's kerb and arrives along the other's. Between
 * two roads at a shallow angle (a slip road joining) this gives the pointed "gore" of a merge
 * instead of a boxy wedge.
 */
function smoothOutline(n: CNode, inset = 0): Vec[] {
  const out: Vec[] = [];
  const arms = n.arms, k = arms.length;
  const corner = (a: Arm, side: number) => ({ x: a.mouth.x - a.mu.y * side, y: a.mouth.y + a.mu.x * side });
  for (let i = 0; i < k; i++) {
    const a = arms[i], b = arms[(i + 1) % k];
    const p0 = corner(a, a.lo + inset), p1 = corner(a, a.hi - inset), p3 = corner(b, b.lo + inset);
    out.push(p0, p1);
    const chord = Math.hypot(p3.x - p1.x, p3.y - p1.y);
    // handles run back along each kerb toward the node, never past it
    const ha = Math.min(chord * 0.55, a.setback * 0.9 + 1), hb = Math.min(chord * 0.55, b.setback * 0.9 + 1);
    const c1 = { x: p1.x - a.mu.x * ha, y: p1.y - a.mu.y * ha }, c2 = { x: p3.x - b.mu.x * hb, y: p3.y - b.mu.y * hb };
    const seg = Math.max(10, Math.min(24, Math.ceil(chord / 1.2)));
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
