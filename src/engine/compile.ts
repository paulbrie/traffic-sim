/**
 * Compiles an editable Network (nodes + links) into drivable geometry:
 * directed edges with lane polylines trimmed back from the junctions, junction
 * areas, turn movements with lane allowances, lane connectors, signal phases
 * and bus stops. The simulator and both renderers read this structure.
 */
import polygonClipping from "polygon-clipping";
import { Poly, connectorPoints, connectorReach, cubicPoints, signedAngle, normAngle, hull, dist } from "./geom";
import { MAX_LANES, type ConnShape, type ConnectorDef, type FlowDef, type JunctionDef, type LaneTargets, type LinkDef, type ReversibleDef, Network, NodeDef, StopDef, LineDef, Vec, ZoneDef, ZoneFlowDef } from "./types";
import { attachBuildings, type Place } from "./buildings";
import { compileCrossings, type CCrossing } from "./crossings";
import { compileParking, type CParking } from "./parking";

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
  /** lane 0 is the road's reversible middle lane (shared with the other direction's lane 0) */
  rev: boolean;
  /** its reversible corridor (index into Compiled.corridors; -1 = none or not usable) and which of its directions this is (1, 2) */
  corr: number; cdir: 0 | 1 | 2;
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
  /** lane connections set by hand (NodeDef.laneMap): per incoming lane the (usual) outgoing lane, -1 = none */
  map?: number[];
  /** ...and every outgoing lane it may take, when some lane has several */
  multi?: number[][];
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
  /** crossings that drive straight through, nothing else at the junction crossing or joining them (see throughConns; worked out when first needed) */
  through?: Set<Conn>;
  /** connector curves set by hand, by connShapeKey (from the written-out connectors, or NodeDef.connShape) */
  shapes: Map<string, ConnShape>;
  /** the junction's connectors are written out (NodeDef.connectors): roads that have some get exactly those */
  manual: boolean;
  /**
   * The nodes making one junction with this one (itself included): linked by connectors from a road ending
   * at one to a road starting at another nearby. They grant their crossings as one (each sees the others'),
   * so paths crossing between them never go together.
   */
  cluster: CNode[];
  /** the node whose lights run this one's (itself, or with lights per connector the junction's controller) */
  signals: CNode;
  /** a road end on the outline of a junction drawn by hand (see JunctionDef), and that junction's leading node */
  hand: JunctionDef | null;
  lead: CNode | null;
  /** on a junction drawn by hand's leading node: all its road ends (itself first); its outline covers them all */
  handNodes: CNode[] | null;
  /** lights per connector (on the controller): per phase the keys (connShapeKey) of the connectors green in it */
  connPhases?: Set<string>[];
}

export interface CFlow { idx: number; def: FlowDef; from: CNode; to: CNode }
/** a zone's trip ends: its entry points, and its buildings with a road to use (by trip weight) */
export interface CZone { idx: number; def: ZoneDef; entries: CNode[]; places: Place[]; placeW: number }
export interface CZoneFlow { idx: number; def: ZoneFlowDef; from: CZone; to: CZone }

/**
 * A reversible corridor: its roads in order from `def.start` (direction 1) to the far end, and the
 * edges of each direction in travel order (`edges[0]` direction 1, `edges[1]` direction 2).
 */
export interface CCorridor { idx: number; def: ReversibleDef; links: LinkDef[]; nodes: CNode[]; edges: [Edge[], Edge[]]; length: number }

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
  /** reversible-lane corridors (only those whose roads form one continuous road) */
  corridors: CCorridor[];
  /** zebra crossings drawn by hand, and rows of parking bays (see ./crossings, ./parking) */
  crossings: CCrossing[];
  parking: CParking[];
  warnings: string[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** each road's centre line as laid out (with any "line up lanes" shift), by link id */
  linkCenters: Map<string, Poly>;
  /** junctions still drawn with a simple outline (compiled with `outlines: "cached"`): node index, shape key */
  pendingShapes: { node: number; key: string }[];
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
/** the road has a reversible middle lane (two-way roads in a corridor) */
export const isRev = (link: LinkDef) => !!link.rev && link.lanesF > 0 && link.lanesB > 0;
/**
 * The space between the two directions as laid out: the median, or minus one lane on a road with a
 * reversible middle lane, whose lane 0 in both directions is then the same strip in the middle.
 */
export const laneMedian = (link: LinkDef) => (isRev(link) ? -laneWidth(link) : link.median ?? 0);

/** lanes of one direction along a link: through lanes plus turn bays, and the bays */
export function dirLanes(link: LinkDef, dir: 1 | -1) {
  // (a reversible middle lane counts as a through lane of both directions: lane 0)
  const rev = isRev(link) ? 1 : 0, own = Math.min(MAX_LANES, dir === 1 ? link.lanesF : link.lanesB), thru = own > 0 ? own + rev : 0;
  const b = thru > 0 ? (dir === 1 ? link.baysF : link.baysB) : null;
  const left = rev ? 0 : b?.left ?? 0, right = b?.right ?? 0;
  return { thru, left, right, n: thru > 0 ? thru + left + right : 0, leftLen: b?.leftLen ?? 0, rightLen: b?.rightLen ?? 0 };
}

/**
 * "Line up lanes" (NodeDef.align): at such a node, each one-way road carrying straight on from one
 * direction of a two-way road gets shifted sideways (in its from→to right-normal frame; `a` at its
 * from end, `b` at its to end) so its lanes continue where that direction's lanes are.
 */
/** nodes where "line up lanes" would change something (a one-way road carrying on from a two-way one) */
export function alignableNodes(net: Network): string[] {
  const pos = new Map(net.nodes.map(n => [n.id, { pos: { x: n.x, y: n.y } } as unknown as CNode]));
  const found = new Set<string>();
  alignShifts(net, pos, () => true, id => found.add(id));
  return [...found];
}
/** where a one-way road's lanes should be (a lane centre line: point `p`, direction `d` away from the node) */
interface AlignTarget { p: Vec; d: Vec }
function alignShifts(net: Network, nodeById: Map<string, CNode>, on = (nd: NodeDef) => !!nd.align, found?: (id: string) => void): Map<string, { a?: AlignTarget; b?: AlignTarget }> {
  const out = new Map<string, { a?: AlignTarget; b?: AlignTarget }>();
  for (const nd of net.nodes) {
    if (!on(nd)) continue;
    const at = net.links.flatMap(l => {
      if (l.from !== nd.id && l.to !== nd.id) return [];
      const A = nodeById.get(l.from), B = nodeById.get(l.to);
      if (!A || !B || A === B) return [];
      const c = linkCenter(l, A.pos, B.pos), atFrom = l.from === nd.id, t = c.tangent(atFrom ? 0 : c.len);
      return [{ l, atFrom, u: atFrom ? t : { x: -t.x, y: -t.y }, R: { x: -t.y, y: t.x } }];
    });
    for (const o of at) {
      if ((o.l.lanesF > 0) === (o.l.lanesB > 0)) continue; // one-way roads only
      const arrives = o.atFrom ? o.l.lanesB > 0 : o.l.lanesF > 0;
      // the two-way road it carries straight on from (the most nearly opposite direction)
      let best: (typeof at)[number] | null = null, bd = -0.94; // (within about 20° of straight on)
      for (const t of at) {
        if (t === o || !(t.l.lanesF > 0 && t.l.lanesB > 0)) continue;
        const d = o.u.x * t.u.x + o.u.y * t.u.y;
        if (d < bd) { bd = d; best = t; }
      }
      if (!best) continue;
      const T = best.l, lw = laneWidth(T), m = laneMedian(T), nF = dirLanes(T, 1).n, nB = dirLanes(T, -1).n;
      // the lanes it continues: those leaving here if it arrives, those arriving if it leaves
      const useF = arrives ? best.atFrom : !best.atFrom;
      // only a true continuation: as many lanes as that direction has (lanes added or dropped are mapped instead)
      if (dirLanes(o.l, o.l.lanesF > 0 ? 1 : -1).thru !== (useF ? dirLanes(T, 1).thru : dirLanes(T, -1).thru)) continue;
      const off = useF ? laneBase(nF, nB, m, lw) + (nF * lw) / 2 : -(laneBase(nB, nF, m, lw) + (nB * lw) / 2);
      // those lanes' centre line, carried straight on past the node
      const target: AlignTarget = { p: { x: nd.x + best.R.x * off, y: nd.y + best.R.y * off }, d: { x: -best.u.x, y: -best.u.y } };
      const cur = out.get(o.l.id) ?? {};
      if (o.atFrom) cur.a = target; else cur.b = target;
      out.set(o.l.id, cur);
      found?.(nd.id);
    }
  }
  return out;
}

/** lateral extent of a link in the from→to right-normal frame */
export function linkExtent(link: LinkDef): [number, number] {
  const nF = dirLanes(link, 1).n, nB = dirLanes(link, -1).n, m = laneMedian(link), lw = laneWidth(link);
  let lo = Infinity, hi = -Infinity;
  if (nF > 0) { const b = laneBase(nF, nB, m, lw); lo = Math.min(lo, b); hi = Math.max(hi, b + nF * lw); }
  if (nB > 0) { const b = laneBase(nB, nF, m, lw); lo = Math.min(lo, -(b + nB * lw)); hi = Math.max(hi, -b); }
  if (!isFinite(lo)) { lo = -lw / 2; hi = lw / 2; }
  return [lo - CURB, hi + CURB];
}

/**
 * `outlines: false` skips working out junction outlines from the lanes (the slow part; only drawing
 * needs them — the simulation doesn't), e.g. in the simulation worker. `"cached"` uses those already
 * worked out and lists the missing ones in `pendingShapes` (for a worker to do; see putShapes).
 */
export function compile(net: Network, opts: { outlines?: boolean | "cached" } = {}): Compiled {
  const pendingShapes: { node: number; key: string }[] = [];
  clearConflictCache();
  const warnings: string[] = [];
  const nodes: CNode[] = [];
  const nodeById = new Map<string, CNode>();
  // junctions drawn by hand: their road ends take the leading node's control (it is the junction's)
  const handOf = new Map<string, JunctionDef>();
  for (const j of net.junctions ?? []) for (const id of j.nodes) handOf.set(id, j);
  const defById = new Map(net.nodes.map(d => [d.id, d]));
  for (const own of net.nodes) {
    const hand = handOf.get(own.id) ?? null, leadDef = hand ? defById.get(hand.nodes[0]) : undefined;
    const def: NodeDef = leadDef && leadDef !== own ? { ...own, control: leadDef.control, signal: leadDef.signal, peds: leadDef.peds, laneLines: leadDef.laneLines } : own;
    const n: CNode = {
      idx: nodes.length, def, pos: { x: def.x, y: def.y }, arms: [], degree: 0,
      controlled: false, gateway: false, deadEnd: false, ringR: 0, polygon: [], surface: [], rounded: false, level: 0, peds: 0, phases: [], lanePhases: [], phaseGreen: [], phaseMinGreen: [], customPhases: false, coord: null,
      moves: new Map(), conns: new Map(), ring: null, ring2: null, ringR2: 0,
      shapes: new Map(def.connectors ? def.connectors.flatMap(c => (c.shape ? [[`${c.in}|${c.a}>${c.out}|${c.b}`, c.shape] as const] : [])) : Object.entries(def.connShape ?? {})),
      manual: !!def.connectors,
      cluster: [], hand, lead: null, handNodes: null,
    } as unknown as CNode;
    n.cluster.push(n); n.signals = n;
    nodes.push(n); nodeById.set(def.id, n);
  }
  for (const n of nodes) if (n.hand) n.lead = nodeById.get(n.hand.nodes[0]) ?? n;
  for (const n of nodes) if (n.lead) (n.lead.handNodes ??= []).push(n);

  // ---- edges (directed) ----
  const edges: Edge[] = [];
  const edgeByKey = new Map<string, Edge>();
  const linkInfo = new Map<string, { link: LinkDef; center: Poly; A: CNode; B: CNode; ef: Edge | null; eb: Edge | null }>();
  const linkCenters = new Map<string, Poly>();
  const shifts = alignShifts(net, nodeById);
  for (const link of net.links) {
    const A = nodeById.get(link.from), B = nodeById.get(link.to);
    if (!A || !B || A === B) { warnings.push(`Road "${link.name || link.id}" is not connected to two different junctions.`); continue; }
    const center = linkCenter(link, A.pos, B.pos);
    linkCenters.set(link.id, center);
    if (center.len < 1) continue;
    const mk = (dir: 1 | -1): Edge | null => {
      const d = dirLanes(link, dir), nOther = dirLanes(link, dir === 1 ? -1 : 1).n, n = d.n;
      if (n <= 0) return null;
      const e: Edge = {
        idx: edges.length, key: `${link.id}:${dir}`, link, dir,
        from: dir === 1 ? A : B, to: dir === 1 ? B : A,
        n, bus: (dir === 1 ? link.busF : link.busB) && d.thru >= 2, busOnly: (dir === 1 ? link.busF : link.busB) && d.thru === 1, sign: (dir === 1 ? link.signF : link.signB) ?? null,
        left: d.left, right: d.right, thru: d.thru, open: [], leftAt: 0, rightAt: 0, kerb: d.left + d.thru - 1, dropLane: -1, dropFrom: 0, dropEnd: 0, dropStop: 0,
        speed: Math.max(10, link.speed || 50) / 3.6, base: laneBase(n, nOther, laneMedian(link), laneWidth(link)), lw: laneWidth(link), rev: isRev(link), corr: -1, cdir: 0,
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

  /** a junction's outline and asphalt (worked out from its lanes, or drawn by hand) */
  function shapeOf(n: CNode) {
    // a junction's shape comes from the lanes through it: the road ends plus every lane path at its
    // full width, so the road always covers its lanes (and the kerbs follow the turns)
    if (opts.outlines !== false && !n.ringR && !(n.lead && n.lead !== n) && (n.degree >= 3 || n.controlled || n.rounded || outlineArms(n).length > n.arms.length)) {
      const inp = outlineInputs(n, 0), got = shapeCache.get(inp.key);
      if (got) { n.polygon = got.polygon; n.surface = got.surface; }
      else if (got === null) { /* merging failed before: keep the simple outline */ }
      else if (opts.outlines === "cached") pendingShapes.push({ node: n.idx, key: inp.key });
      else {
        const outer = mergeOutline(inp);
        const shape = outer ? { polygon: outer, surface: kerbInset(n, outer) ?? outer } : null;
        if (shapeCache.size > 20000) shapeCache.clear();
        shapeCache.set(inp.key, shape);
        if (shape) { n.polygon = shape.polygon; n.surface = shape.surface; }
      }
    }
    // an outline drawn by hand wins (its kerb band is worked out the same way)
    if (opts.outlines !== false && !n.ringR && (n.degree >= 2 || n.lead === n) && n.def.outline && n.def.outline.length >= 3) {
      const outer = orient(n.def.outline.map(p => ({ x: n.pos.x + p.x, y: n.pos.y + p.y })));
      n.polygon = outer; n.surface = kerbInset(n, outer) ?? outer;
    }
  }

  // ---- node classification, setbacks ----
  for (const n of nodes) {
    n.arms.sort((a, b) => a.angle - b.angle);
    n.arms.forEach((a, i) => { if (a.inEdge) a.inEdge.inArm = i; if (a.outEdge) a.outEdge.outArm = i; });
    n.degree = n.arms.length;
    n.level = n.arms.length ? Math.min(...n.arms.map(a => a.link.level ?? 0)) : 0;
    n.gateway = n.degree === 1 && n.def.gateway && !n.hand;
    n.deadEnd = n.degree === 1 && !n.def.gateway && !n.hand;
    n.controlled = n.degree > 0 && !n.gateway && (n.degree !== 2 || n.def.junction === true || !!n.hand);
    const roundabout = n.controlled && n.degree >= 3 && n.def.control === "roundabout";
    n.peds = n.controlled && !roundabout && n.degree >= 2 ? n.def.peds ?? 0 : 0;
    if (roundabout) {
      const maxW = Math.max(...n.arms.map(a => a.w));
      n.ringR = n.def.ringLanes === 2 ? Math.max(14, Math.min(36, maxW + 7)) : Math.max(9, Math.min(32, maxW + 5));
    }
    for (let i = 0; i < n.arms.length; i++) {
      const arm = n.arms[i];
      // (a dead end: lanes stop just short of its point, so their ends sit by it; the U-turn fits in between)
      // (a road end on a junction drawn by hand: its lanes reach the outline)
      if (n.degree === 1) { arm.setback = n.gateway || n.hand ? 0 : 3; continue; }
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
    // "line up lanes": the road's line shifted sideways, fully up to where it meets the junction,
    // then fading out along it
    const sh = shifts.get(link.id);
    if (sh && info.center.len > 2) {
      const base = info.center, Lb = base.len, T = Math.min(40, Lb * 0.45), ease = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
      const pa = Math.min(sa + 2, Lb * 0.4), pb = Math.min(sb + 2, Lb * 0.4);
      // sideways (right of from→to) so the road's centre at the mouth lies on the target line
      const toLine = (t: AlignTarget | undefined, at: number) => {
        if (!t) return 0;
        const M = base.at(at), tg = base.tangent(at), R = { x: -tg.y, y: tg.x };
        const den = t.d.x * R.y - t.d.y * R.x;
        if (Math.abs(den) < 0.2) return 0;
        const v = Math.max(-8, Math.min(8, -(t.d.x * (M.y - t.p.y) - t.d.y * (M.x - t.p.x)) / den));
        return Math.abs(v) < 0.05 ? 0 : v;
      };
      const da = toLine(sh.a, Math.min(sa, Lb * 0.4)), db = toLine(sh.b, Math.max(Lb - sb, Lb * 0.6));
      info.center = base.offsetBy(s => da * ease(1 - (s - pa) / T) + db * ease(1 - (Lb - s - pb) / T), 0, Lb, 2);
      if (info.ef) info.ef.center = info.center;
      if (info.eb) info.eb.center = info.center.reversed();
      linkCenters.set(link.id, info.center);
    }
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
      // a reversible middle lane (lane 0) carries straight on: turns are made from the fixed lanes
      // (at a roundabout every way round the ring is fine); with no way straight on it takes what
      // the lane beside it takes
      if (ein.rev && nl >= 2 && list.length && !n.ringR) {
        for (const m of list) if (m.turn !== "S" && m.lo === 0) { m.lo = 1; if (m.hi < 1) m.hi = 1; }
        if (!list.some(m => m.lo === 0)) for (const m of list) if (m.lo <= 1 && m.hi >= 1) m.lo = 0;
      }
      // per-lane turn overrides drawn on the road ("left only", "ahead + right", …)
      const custom = ein.dir === 1 ? ein.link.turnsF : ein.link.turnsB;
      if (custom && custom.length === nl && list.length) {
        const next: Movement[] = [];
        for (const m of list) {
          const ls = arrowLetters(list, m);
          const lanes = custom.map((t, i) => ([...ls].some(x => t.includes(x)) ? i : -1)).filter(i => i >= 0);
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
    markMerges(n);
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
    // connectors written out: the roads that have some (or are closed) get exactly those; the others keep
    // the automatic ones (a road added since is connected)
    if (n.def.connectors && !n.ringR) { applyConnectors(n, n.def.connectors, n.def.closed ?? [], edgeByKey); markMerges(n); }
    // a lane connection set by hand between two roads with no turn between them adds that turn
    // (classed by its angle, like the automatic ones)
    if (n.def.laneMap && !n.def.connectors && !n.ringR) for (const key of Object.keys(n.def.laneMap)) {
      const [ik, ok] = key.split(">"), ein = edgeByKey.get(ik), eout = edgeByKey.get(ok);
      if (!ein || !eout || ein.to !== n || eout.from !== n || !ein.lanes.length || !eout.lanes.length) continue;
      let list = n.moves.get(ein.idx);
      if (!list) n.moves.set(ein.idx, (list = []));
      if (list.some(m => m.out === eout)) continue;
      const tin = ein.lanes[0].poly.tangent(ein.lanes[0].len), tout = eout.lanes[0].poly.tangent(0);
      const uturn = ein.link === eout.link, delta = uturn ? Math.PI : signedAngle(tin, tout);
      const turn: Turn = uturn || Math.abs(delta) > 2.7 ? "U" : delta > 0.52 ? "R" : delta < -0.52 ? "L" : "S";
      list.push({ node: n, in: ein, out: eout, turn, delta, lo: 0, hi: ein.n - 1, rank: list.length });
    }
    // lane connections set by hand win over the automatic ones (a turn with no lane left is dropped)
    if (n.def.laneMap && !n.def.connectors && !n.ringR) for (const [k, list] of n.moves) {
      const next = list.filter(m => {
        const arr = n.def.laneMap![`${m.in.key}>${m.out.key}`];
        if (!arr) return true;
        const outs = Array.from({ length: m.in.n }, (_, a) => { const t = arr[a]; return (t == null ? [] : Array.isArray(t) ? t : [t]).filter(b => b < m.out.n); });
        m.map = outs.map(l => (l.length ? l[0] : -1));
        if (outs.some(l => l.length > 1)) m.multi = outs;
        const used = m.map.map((b, a) => (b >= 0 ? a : -1)).filter(a => a >= 0);
        if (!used.length) return false;
        m.lo = Math.min(...used); m.hi = Math.max(...used);
        return true;
      });
      if (next.length !== list.length) n.moves.set(k, next);
    }
    // (a junction drawn by hand: worked out once all its road ends have their turns, below)
    if (!n.handNodes) shapeOf(n);
    // (a junction drawn by hand is drawn once, by its leading node)
    if (n.lead && n.lead !== n) { n.polygon = []; n.surface = []; }
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
        // (lights per connector are checked connector by connector, below)
        if (dark.length && !defs.some(p => p.conns)) warnings.push(`Traffic lights: lane${dark.length > 1 ? "s" : ""} ${dark.map(l => l + 1).join(", ")} of ${e.link.name || "an unnamed road"} never get${dark.length > 1 ? "" : "s"} green; set ${dark.length > 1 ? "them" : "it"} in the junction's phases.`);
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

  // junctions drawn by hand: their shape, now that every road end has its turns
  for (const n of nodes) if (n.handNodes) shapeOf(n);

  // ---- junctions over several nodes: nodes linked by connectors grant their crossings as one ----
  {
    const up = nodes.map((_, i) => i), find = (i: number): number => (up[i] === i ? i : (up[i] = find(up[i])));
    let any = false;
    for (const n of nodes) for (const ms of n.moves.values()) for (const m of ms) if (m.out.from !== n) { up[find(m.out.from.idx)] = find(n.idx); any = true; }
    // (a junction drawn by hand is one even before its connectors are)
    for (const n of nodes) if (n.lead && n.lead !== n) { up[find(n.idx)] = find(n.lead.idx); any = true; }
    if (any) {
      const groups = new Map<number, CNode[]>();
      for (const n of nodes) { const r = find(n.idx); groups.set(r, [...(groups.get(r) ?? []), n]); }
      for (const g of groups.values()) if (g.length > 1) for (const n of g) {
        n.cluster = g;
        // (a plain road point in it is a junction now: traffic through it has paths joining or crossing it;
        // so is a road's loose end, an entry point or a dead end: its road carries on through connectors)
        if (n.degree === 1) { n.gateway = false; n.deadEnd = false; }
        if (n.degree >= 1) n.controlled = true;
      }
    }
  }

  // ---- lights per connector: green given connector by connector, for every node of the junction ----
  for (const n of nodes) {
    const defs = n.def.phases;
    if (!n.controlled || n.def.control !== "lights" || !defs || defs.length < 2 || !defs.some(p => p.conns) || n.signals !== n) continue;
    // (one controller per junction: the first such node)
    if (n.cluster.some(k => k !== n && k.signals !== k)) continue;
    const sets = defs.map(p => new Set(p.conns ?? []));
    n.connPhases = sets;
    // a connector in no phase (one added since the phases were set, e.g. a lane added to a road) goes with the
    // others from its approach: green whenever they are (the plan's phases stay as they are; set it there to change that)
    for (const k of n.cluster) for (const [, ms] of k.moves) for (const m of ms) for (let lane = 0; lane < m.in.n; lane++) {
      if (!laneAllowed(m, lane)) continue;
      for (const b of exitLanesOf(m, lane)) {
        const key = connShapeKey(m, lane, b);
        if (sets.some(x => x.has(key))) continue;
        const from = `${m.in.key}|`;
        for (const x of sets) if ([...x].some(o => o.startsWith(from))) x.add(key);
      }
    }
    const dark: string[] = [];
    for (const k of n.cluster) {
      k.signals = n; k.customPhases = true; k.controlled = true;
      k.lanePhases = k.arms.map(a => {
        const e = a.inEdge;
        if (!e) return [];
        const ms = k.moves.get(e.idx) ?? [];
        return Array.from({ length: e.n }, (_, lane) => {
          const keys = ms.flatMap(m => (laneAllowed(m, lane) ? exitLanesOf(m, lane).map(b => connShapeKey(m, lane, b)) : []));
          for (const key of keys) if (!sets.some(x => x.has(key))) dark.push(key);
          return sets.map((x, p) => (keys.some(key => x.has(key)) ? p : -1)).filter(p => p >= 0);
        });
      });
      k.phases = defs.map((_, p) => k.arms.map((_, i) => i).filter(i => k.lanePhases[i].some(ps => ps.includes(p))));
      k.phaseGreen = defs.map(d => d.green);
      k.phaseMinGreen = defs.map(d => d.minGreen ?? n.def.signal.minGreen);
    }
    if (dark.length) warnings.push(`Traffic lights at ${n.def.id}: ${dark.length} lane connector${dark.length > 1 ? "s" : ""} never get${dark.length > 1 ? "" : "s"} green; set ${dark.length > 1 ? "them" : "it"} in the junction's phases.`);
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

  // ---- reversible corridors: their roads must chain end to end ----
  const corridors: CCorridor[] = [];
  for (const def of net.reversibles ?? []) {
    const ls = net.links.filter(l => l.rev === def.id && isRev(l) && linkInfo.has(l.id));
    if (!ls.length) continue;
    const at = new Map<string, LinkDef[]>();
    for (const l of ls) for (const id of [l.from, l.to]) (at.get(id) ?? at.set(id, []).get(id)!).push(l);
    const ends = [...at].filter(([, v]) => v.length === 1).map(([id]) => id);
    if (ends.length !== 2 || [...at.values()].some(v => v.length > 2)) {
      warnings.push(`Reversible lane "${def.name}": its roads don't make one continuous road, so the lane stays closed.`);
      continue;
    }
    const start = ends.includes(def.start) ? def.start : ends[0];
    const links: LinkDef[] = [], chain: CNode[] = [nodeById.get(start)!], e1: Edge[] = [];
    let cur = start, prev: LinkDef | null = null;
    while (links.length < ls.length) {
      const l = at.get(cur)!.find(x => x !== prev);
      if (!l) break;
      const info = linkInfo.get(l.id)!, fwd = l.from === cur;
      links.push(l); e1.push((fwd ? info.ef : info.eb)!);
      cur = fwd ? l.to : l.from; prev = l; chain.push(nodeById.get(cur)!);
    }
    if (links.length !== ls.length) { warnings.push(`Reversible lane "${def.name}": its roads don't make one continuous road, so the lane stays closed.`); continue; }
    const e2 = e1.map(e => e.reverse!).reverse();
    const cc: CCorridor = { idx: corridors.length, def, links, nodes: chain, edges: [e1, e2], length: e1.reduce((a, e) => a + e.length, 0) };
    for (const e of e1) { e.corr = cc.idx; e.cdir = 1; }
    for (const e of e2) { e.corr = cc.idx; e.cdir = 2; }
    corridors.push(cc);
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of net.buildings ?? []) for (const p of b.pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  for (const n of net.nodes) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x); maxY = Math.max(maxY, n.y); }
  for (const l of net.links) for (const c of [l.c1, l.c2]) if (c) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); maxX = Math.max(maxX, c.x); maxY = Math.max(maxY, c.y); }
  if (!isFinite(minX)) { minX = -200; minY = -150; maxX = 200; maxY = 150; }

  const compiled: Compiled = {
    nodes, edges, pieces, nodeById, edgeByKey, stops, stopById, lines, places, flows, zones, zoneFlows, corridors, warnings,
    crossings: compileCrossings(net), parking: compileParking(net, edgeByKey),
    bounds: { minX, minY, maxX, maxY }, linkCenters, pendingShapes,
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

/** roads going (nearly) straight on into the same road join it side by side, the one on the right into its right-hand lanes */
function markMerges(n: CNode) {
  if (n.degree < 3 || n.ringR) return;
  const into = new Map<Edge, Movement[]>();
  for (const list of n.moves.values()) for (const m of list) { m.merge = undefined; if (Math.abs(m.delta) < 0.8 && m.turn !== "U" && m.out.from === n) (into.get(m.out) ?? into.set(m.out, []).get(m.out)!).push(m); }
  for (const [out, ms] of into) {
    if (ms.length < 2) continue;
    const u = n.arms[out.outArm].u, r = { x: -u.y, y: u.x };
    // how far to the right of the road ahead each incoming road lies
    const side = (m: Movement) => { const a = n.arms[m.in.inArm]; return a.u.x * r.x + a.u.y * r.y; };
    const sorted = ms.slice().sort((a, b) => side(a) - side(b));
    sorted[0].merge = "left"; sorted[sorted.length - 1].merge = "right";
  }
}

/** how far a connector may reach from the end of its lane to the start of a lane at another node (m) */
export const CROSS_REACH = 60;

/** the turns of a junction whose connectors are written out (see NodeDef.connectors) */
function applyConnectors(n: CNode, list: ConnectorDef[], closed: string[], edgeByKey: Map<string, Edge>) {
  // the valid ones, per turn: per incoming lane its outgoing lanes in order
  const turns = new Map<string, { ein: Edge; eout: Edge; outs: number[][] }>();
  const set = new Set<Edge>();
  for (const c of list) {
    const ein = edgeByKey.get(c.in), eout = edgeByKey.get(c.out);
    if (!ein || !eout || ein.to !== n || c.a >= ein.n || c.b >= eout.n || !ein.lanes.length || !eout.lanes.length) continue;
    // (into a road starting at another node: only one nearby, and not round a roundabout)
    // (across a junction drawn by hand: between any of its road ends)
    if (eout.from !== n && !(n.hand && eout.from.hand === n.hand) && (eout.from.ringR > 0 || n.ringR > 0 || dist(ein.lanes[c.a].poly.at(ein.lanes[c.a].len), eout.lanes[c.b].poly.at(0)) > CROSS_REACH)) continue;
    const k = `${c.in}>${c.out}`;
    const t = turns.get(k) ?? turns.set(k, { ein, eout, outs: Array.from({ length: ein.n }, () => []) }).get(k)!;
    if (!t.outs[c.a].includes(c.b)) t.outs[c.a].push(c.b);
    set.add(ein); set.add(eout);
  }
  for (const k of closed) { const e = edgeByKey.get(k); if (e && (e.to === n || e.from === n)) set.add(e); }
  // automatic turns stay only for roads with no connectors of their own…
  const auto = new Map<string, Movement>(), order = [...n.moves.values()].flat();
  for (const [k, ms] of n.moves) {
    const keep = ms.filter(m => !(set.has(m.in) && set.has(m.out)) || (auto.set(`${m.in.key}>${m.out.key}`, m), false));
    if (keep.length !== ms.length) n.moves.set(k, keep);
  }
  for (const [key, { ein, eout, outs }] of turns) {
    const ms = n.moves.get(ein.idx) ?? n.moves.set(ein.idx, []).get(ein.idx)!;
    // …or where the connectors are just what they would be (so a junction written out as it was drives the same)
    const was = auto.get(key);
    if (was && outs.every((l, a) => { const w = laneAllowed(was, a) ? exitLanesOf(was, a) : []; return w.length === l.length && w.every((b, i) => b === l[i]); })) { ms.push(was); continue; }
    {
      const tin = ein.lanes[0].poly.tangent(ein.lanes[0].len), tout = eout.lanes[0].poly.tangent(0);
      const uturn = ein.link === eout.link, delta = uturn ? Math.PI : signedAngle(tin, tout);
      const turn: Turn = uturn || Math.abs(delta) > 2.7 ? "U" : delta > 0.52 ? "R" : delta < -0.52 ? "L" : "S";
      const m: Movement = { node: n, in: ein, out: eout, turn, delta, lo: 0, hi: 0, rank: was?.rank ?? ms.length };
      ms.push(m);
      if (was) order[order.indexOf(was)] = m;
      m.map = outs.map(l => (l.length ? l[0] : -1));
      m.multi = outs.some(l => l.length > 1) ? outs : undefined;
      const used = m.map.map((b, a) => (b >= 0 ? a : -1)).filter(a => a >= 0);
      m.lo = Math.min(...used); m.hi = Math.max(...used);
    }
  }
  // (turns again in order from left to right, as the automatic ones are)
  for (const ms of n.moves.values()) {
    // (the turns kept in the order they had, the new ones after them, left to right)
    const at = (m: Movement) => { const i = order.indexOf(m); return i < 0 ? order.length + 4 + m.delta : i; };
    ms.sort((a, b) => at(a) - at(b));
    // only one "straight" per approach: the one closest to 0°, others become slight turns
    const straights = ms.filter(m => m.turn === "S").sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta));
    for (const m of straights.slice(1)) m.turn = m.delta > 0 ? "R" : "L";
  }
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
    // (a cubic's handles at `reach` take it 3/4 of that past the lanes' ends: up to just short of the dead end's point)
    const reach = Math.max(2, Math.min(9, (((n.pos.x - P.x) * tp.x + (n.pos.y - P.y) * tp.y) - 0.4) / 0.75));
    const c1 = { x: P.x + tp.x * reach, y: P.y + tp.y * reach }, c2 = { x: Q.x - tq.x * reach, y: Q.y - tq.y * reach };
    pts = [];
    for (let k = 0; k <= 16; k++) {
      const t = k / 16, u = 1 - t;
      pts.push(u * u * u * P.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * Q.x, u * u * u * P.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * Q.y);
    }
  } else {
    const shape = n.shapes.get(connShapeKey(move, a, b));
    pts = shape && !Array.isArray(shape)
      ? cubicPoints(P, { x: n.pos.x + shape.c1.x, y: n.pos.y + shape.c1.y }, { x: n.pos.x + shape.c2.x, y: n.pos.y + shape.c2.y }, Q, 14)
      : connectorPoints(P, tp, Q, tq, 14, shape);
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
/**
 * The lane-arrow letters a movement answers to: its own (a U-turn counts as left), and "S" for the
 * straightest one when the approach has no straight movement (a road merging at an angle: "ahead"
 * means carrying on into it), if it is within 60° of straight.
 */
export function arrowLetters(list: readonly Movement[], m: Movement): Set<string> {
  const out = new Set<string>([m.turn === "U" ? "L" : m.turn]);
  if (m.turn !== "U" && !list.some(x => x.turn === "S")) {
    let best: Movement | null = null;
    for (const x of list) if (x.turn !== "U" && (!best || Math.abs(x.delta) < Math.abs(best.delta))) best = x;
    if (best === m && Math.abs(m.delta) < 1.05) out.add("S");
  }
  return out;
}

/** a turn's lane connections as set or worked out now, one entry per incoming lane (as NodeDef.laneMap holds them) */
export function currentTargets(m: Movement): LaneTargets[] {
  return Array.from({ length: m.in.n }, (_, a) => {
    if (!laneAllowed(m, a)) return null;
    const l = exitLanesOf(m, a);
    return l.length > 1 ? [...l] : l[0];
  });
}
/** every outgoing lane lane `a` may take on movement `m` (several only when set so by hand), the usual one first */
export function exitLanesOf(m: Movement, a: number): number[] {
  return m.multi?.[a]?.length ? m.multi[a] : [exitLane(m, a, false)];
}

/** may vehicles in lane `a` of its approach take movement `m` */
export const laneAllowed = (m: Movement, a: number) => a >= m.lo && a <= m.hi && (!m.map || m.map[a] >= 0);

export function connectorPreview(c: Compiled, only?: (n: CNode, m: Movement) => boolean): ConnectorView[] {
  const out: ConnectorView[] = [];
  for (const n of c.nodes) {
    if (!n.controlled || n.ringR > 0) continue;
    for (const list of n.moves.values()) for (const m of list) if (!only || only(n, m)) for (let a = m.lo; a <= m.hi; a++) {
      if (!laneAllowed(m, a)) continue;
      for (const b of exitLanesOf(m, a)) out.push({ node: n, move: m, inLane: a, outLane: b, pts: Float32Array.from(buildConn(n, m, a, b, -1).poly.pts) });
    }
  }
  return out;
}
/**
 * The crossings of a junction that traffic drives through without stopping: their paths cross no other
 * path there and join no lane another path joins (e.g. the far direction of a two-way road where a side
 * road only turns right in and out). Only at priority and free junctions without pedestrians, never
 * past a stop sign or as a U-turn. Every lane-to-lane path the junction's turns use is built to check.
 */
export function throughConns(c: Compiled, n: CNode): Set<Conn> {
  if (n.through) return n.through;
  const out = (n.through = new Set<Conn>()), ctl = n.def.control;
  if (!n.controlled || n.degree < (n.cluster.length > 1 ? 2 : 3) || n.ringR > 0 || n.peds > 0 || (ctl !== "priority" && ctl !== "free")) return out;
  // (checked against every path of the junction, over all its nodes)
  const all: { m: Movement; cs: Conn[] }[] = [];
  for (const k of n.cluster) for (const list of k.moves.values()) for (const m of list) {
    const cs: Conn[] = [];
    for (let a = 0; a < m.in.n; a++) {
      if (!laneAllowed(m, a)) continue;
      for (const b of new Set([...exitLanesOf(m, a), exitLane(m, a, true)])) cs.push(c.getConn(m, a, b));
    }
    all.push({ m, cs });
  }
  for (const x of all) {
    if (x.m.node !== n || !x.cs.length || x.m.turn === "U" || (ctl === "priority" && x.m.in.sign === "stop")) continue;
    if (all.some(y => y.cs.some(b => x.cs.some(a => a !== b && conflicts(a, b))))) continue;
    for (const a of x.cs) out.add(a);
  }
  return out;
}

export interface ConnectionIssue {
  node: CNode;
  /** "error": traffic can't get through as drawn; "warn": probably not what was meant */
  level: "error" | "warn";
  message: string;
  /** the road it is about (for selecting it) */
  link?: string;
}
const TURN_WORD: Record<Turn, string> = { L: "left", R: "right", S: "straight", U: "U-turn" };
/** do two polylines (flat x,y lists) cross each other (touching within 0.5 m of an end doesn't count) */
function polylinesCross(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  const ends = [a[0], a[1], a[a.length - 2], a[a.length - 1], b[0], b[1], b[b.length - 2], b[b.length - 1]];
  const nearEnd = (x: number, y: number) => { for (let k = 0; k < 8; k += 2) if (Math.hypot(x - ends[k], y - ends[k + 1]) < 0.5) return true; return false; };
  for (let i = 0; i + 3 < a.length; i += 2) for (let j = 0; j + 3 < b.length; j += 2) {
    const px = a[i], py = a[i + 1], rx = a[i + 2] - px, ry = a[i + 3] - py;
    const qx = b[j], qy = b[j + 1], sx = b[j + 2] - qx, sy = b[j + 3] - qy;
    const d = rx * sy - ry * sx; if (Math.abs(d) < 1e-9) continue;
    const t = ((qx - px) * sy - (qy - py) * sx) / d, u = ((qx - px) * ry - (qy - py) * rx) / d;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && !nearEnd(px + rx * t, py + ry * t)) return true;
  }
  return false;
}
/**
 * Lane connection problems at junctions and road points: roads that lead nowhere, lanes with no
 * way on, exit lanes nothing feeds, and lanes of one approach whose paths cross each other.
 */
export function connectionIssues(c: Compiled, only?: CNode): ConnectionIssue[] {
  const out: ConnectionIssue[] = [];
  const name = (e: Edge) => e.link.name || e.link.id;
  for (const n of only ? [only] : c.nodes) {
    // (a junction drawn by hand is checked as a whole, from its leading node)
    if (n.lead && n.lead !== n) continue;
    if ((n.degree < 2 && !n.lead) || n.ringR > 0) continue;
    const group = n.lead ? n.cluster.filter(k => k.lead === n) : [n], arms = group.flatMap(k => k.arms.map(arm => ({ k, arm })));
    const plainJoint = n.degree === 2 && !n.controlled;
    const fed = new Map<Edge, Set<number>>();
    for (const { k, arm } of arms) {
      const e = arm.inEdge;
      if (!e) continue;
      const moves = k.moves.get(e.idx) ?? [];
      if (!moves.length) { out.push({ node: n, level: "error", message: `${name(e)} leads nowhere here: traffic on it has no way on`, link: e.link.id }); continue; }
      const views: { a: number; b: number; m: Movement; pts: ArrayLike<number> }[] = [];
      for (let a = 0; a < e.n; a++) {
        // (a lane that ends before the line, and bus lanes: only buses use them)
        if (a === e.dropLane || (e.bus && a === e.kerb)) continue;
        const ms = moves.filter(m => laneAllowed(m, a));
        if (!ms.length) { out.push({ node: n, level: "warn", message: `Lane ${a + 1} of ${name(e)} has no connection here`, link: e.link.id }); continue; }
        for (const m of ms) for (const b of exitLanesOf(m, a)) {
          (fed.get(m.out) ?? fed.set(m.out, new Set()).get(m.out)!).add(b);
          if (!plainJoint) views.push({ a, b, m, pts: buildConn(k, m, a, b, -1).poly.pts });
        }
      }
      // two lanes of the same approach whose paths cross (into different exit lanes)
      for (let i = 0; i < views.length; i++) for (let j = i + 1; j < views.length; j++) {
        const x = views[i], y = views[j];
        if (x.a === y.a || (x.m.out === y.m.out && x.b === y.b)) continue;
        if (polylinesCross(x.pts, y.pts)) out.push({ node: n, level: "warn", message: `From ${name(e)}, the paths of lane ${x.a + 1} (${TURN_WORD[x.m.turn]} to ${name(x.m.out)} lane ${x.b + 1}) and lane ${y.a + 1} (${TURN_WORD[y.m.turn]} to ${name(y.m.out)} lane ${y.b + 1}) cross`, link: e.link.id });
      }
    }
    // exit lanes that nothing feeds here (a lane that opens at a road point is expected)
    if (!plainJoint) for (const { arm } of arms) {
      const e = arm.outEdge;
      if (!e) continue;
      const got = fed.get(e);
      if (!got) { if (arms.some(o => o.arm.inEdge && o.arm.link !== e.link)) out.push({ node: n, level: "warn", message: `Nothing turns into ${name(e)} here`, link: e.link.id }); continue; }
      for (let b = e.left; b < e.left + e.thru; b++) if (!got.has(b) && !(e.bus && b === e.kerb)) out.push({ node: n, level: "warn", message: `Lane ${b + 1} of ${name(e)} is not fed by any lane here`, link: e.link.id });
    }
  }
  return out;
}

/** key of a connector's hand-set shape (NodeDef.connShape) */
export const connShapeKey = (move: Movement, a: number, b: number) => `${move.in.key}|${a}>${move.out.key}|${b}`;
/**
 * A lane connector's curve: where it starts and ends, the lane directions there, and how far its two
 * handles reach (the hand-set shape, or the automatic one). For drawing and dragging the handles.
 */
export function connectorHandles(n: CNode, move: Movement, a: number, b: number) {
  const lin = move.in.lanes[Math.min(a, move.in.lanes.length - 1)], lout = move.out.lanes[Math.min(b, move.out.lanes.length - 1)];
  const P = lin.poly.at(lin.len), tp = lin.poly.tangent(lin.len), Q = lout.poly.at(0), tq = lout.poly.tangent(0);
  const custom = n.shapes.get(connShapeKey(move, a, b));
  if (custom && !Array.isArray(custom)) {
    // free handles: report their reach along the lanes too (for the inspector)
    const h1 = { x: n.pos.x + custom.c1.x, y: n.pos.y + custom.c1.y }, h2 = { x: n.pos.x + custom.c2.x, y: n.pos.y + custom.c2.y };
    const k1 = (h1.x - P.x) * tp.x + (h1.y - P.y) * tp.y, k2 = (Q.x - h2.x) * tq.x + (Q.y - h2.y) * tq.y;
    return { P, tp, Q, tq, k1, k2, custom: true, free: true, h1, h2 };
  }
  const [k1, k2] = custom ?? connectorReach(P, tp, Q, tq);
  return { P, tp, Q, tq, k1, k2, custom: !!custom, free: false, h1: { x: P.x + tp.x * k1, y: P.y + tp.y * k1 }, h2: { x: Q.x - tq.x * k2, y: Q.y - tq.y * k2 } };
}

/** selection id of a lane connector */
export const connectorId = (v: { node: CNode; move: Movement; inLane: number; outLane: number }) => `${v.node.def.id}|${v.move.in.key}|${v.inLane}|${v.move.out.key}|${v.outLane}`;

/** which exit lane a vehicle in lane a ends up in for a movement (always a through lane of the exit: its bays open further on) */
/**
 * The lane movement `m` leads into from lane `a`: a reversible middle lane is entered only straight on
 * from the reversible lane before it (everyone else joins the fixed lanes; they may change into it
 * where it is open).
 */
export function exitLane(move: Movement, a: number, isBus: boolean): number {
  if (move.map) {
    // set by hand; a lane without one (inside lo..hi) follows its nearest connected neighbour
    let best = -1;
    for (let d = 0; d < move.map.length && best < 0; d++) for (const q of [a - d, a + d]) if (q >= 0 && q < move.map.length && move.map[q] >= 0) { best = move.map[q]; break; }
    return best >= 0 ? best : move.out.left;
  }
  const out = move.out;
  // from the reversible lane straight on into the next one; otherwise the reversible lanes don't count
  const fromRev = move.in.rev && a === 0, ra = move.in.rev && a > 0 ? 1 : 0;
  const r = out.rev && !(fromRev && move.turn === "S") && out.thru > 1 ? 1 : 0;
  const lo = out.left + r, nOut = out.thru - r;
  let b: number;
  if (move.turn === "U") b = 0;
  else if (move.turn === "L" || move.merge === "left") b = Math.min(Math.max(0, a - move.lo), nOut - 1);
  // (a vehicle can ask from a lane right of the turn's lanes, e.g. early, still on the junction before: the kerb lane then)
  else if (move.turn === "R" || move.merge === "right") b = Math.min(nOut - 1, Math.max(0, nOut - 1 - (move.hi - a)));
  else b = Math.max(0, Math.min(a - move.in.left - ra - (move.in.dropLane === move.in.left ? 1 : 0) - (move.skip ?? 0) + (move.shift ?? 0), nOut - 1));
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
 * Junction outline from its lanes: a strip across each road end plus every lane path through the
 * junction, each as wide as its lane (and `CURB - inset` more), merged. Null if that fails.
 */
/** what a junction's outline is made of (and a key for it: the same shapes give the same outline) */
interface OutlineInputs { n: CNode; polys: Ring[][]; pieces: Ring[][]; key: string }
/**
 * The road ends a junction's outline is made of: its own, and those of other nodes its connectors lead into
 * (a junction over several nodes: the asphalt reaches the lanes they join)
 */
/** the nodes a junction's outline covers: itself, or a junction drawn by hand's road ends (from its leading node) */
const outlineNodes = (n: CNode): CNode[] => n.handNodes ?? [n];
function outlineArms(n: CNode): Arm[] {
  if (n.handNodes) {
    // (a junction drawn by hand: every road end's arm, and the roads its connectors lead into elsewhere)
    const out: Arm[] = [];
    for (const k of n.handNodes) for (const a of k.arms) if (!out.includes(a)) out.push(a);
    for (const k of n.handNodes) for (const ms of k.moves.values()) for (const m of ms) {
      if (n.handNodes.includes(m.out.from)) continue;
      const a = m.out.from.arms.find(x => x.outEdge === m.out);
      if (a && !out.includes(a)) out.push(a);
    }
    return out;
  }
  let out: Arm[] | null = null;
  for (const ms of n.moves.values()) for (const m of ms) {
    if (m.out.from === n) continue;
    const a = m.out.from.arms.find(x => x.outEdge === m.out);
    if (a && !(out ?? n.arms).includes(a)) (out ??= [...n.arms]).push(a);
  }
  return out ?? n.arms;
}
function outlineInputs(n: CNode, inset: number): OutlineInputs {
  const polys: Ring[][] = [], pieces: Ring[][] = [], extra = CURB - inset;
  for (const a of outlineArms(n)) {
    const r = { x: -a.mu.y, y: a.mu.x }, m = a.mouth, lo = a.lo + inset, hi = a.hi - inset;
    // (a junction drawn by hand's road ends have no setback: their whole width still reaches into it)
    const d = n.handNodes ? 1.5 : Math.min(1.5, Math.max(0.3, a.setback * 0.5));
    const pt = (side: number, back: number): Pair => [m.x + r.x * side - a.mu.x * back, m.y + r.y * side - a.mu.y * back];
    polys.push([[pt(lo, 0), pt(hi, 0), pt(hi, d), pt(lo, d), pt(lo, 0)]]);
  }
  for (const k of outlineNodes(n)) for (const list of k.moves.values()) for (const mv of list) for (let q = mv.lo; q <= mv.hi; q++) {
    if (!laneAllowed(mv, q)) continue;
    for (const b of exitLanesOf(mv, q)) {
      const P = buildConn(k, mv, q, b, -1).poly.pts, cnt = P.length / 2;
      if (cnt < 2) continue;
      const half = Math.max(mv.in.lw, mv.out.lw) / 2 + extra, left: Pair[] = [], right: Pair[] = [];
      for (let i = 0; i < cnt; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(cnt - 1, i + 1);
        const dx = P[i1 * 2] - P[i0 * 2], dy = P[i1 * 2 + 1] - P[i0 * 2 + 1], len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        left.push([P[i * 2] + nx * half, P[i * 2 + 1] + ny * half]);
        right.push([P[i * 2] - nx * half, P[i * 2 + 1] - ny * half]);
      }
      polys.push([[...left, ...right.reverse(), left[0]]]);
      // (the same path as small convex pieces, for when a tight turn folds its edges over each other)
      for (let i = 0; i + 1 < cnt; i++) {
        const h = hull([left[i], left[i + 1], right[cnt - 2 - i], right[cnt - 1 - i]].map(([x, y]) => ({ x, y })));
        if (h.length >= 3) pieces.push([[...h.map(v => [v.x, v.y] as Pair), [h[0].x, h[0].y]]]);
      }
    }
  }
  const key = `${inset}|` + polys.map(p => p[0].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")).join("|");
  return { n, polys, pieces, key };
}
/** the outline itself: those shapes merged (null if that fails) */
function mergeOutline({ n, polys, pieces }: OutlineInputs): Vec[] | null {
  let merged: Ring[][];
  // (on a 1 cm grid, without repeated points: the merge is robust then)
  const snap = (ps: Ring[][]) => ps.map(poly => poly.map(ring => ring.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pair).filter((q, i, r) => i === 0 || q[0] !== r[i - 1][0] || q[1] !== r[i - 1][1])).filter(ring => ring.length >= 4));
  polys.splice(0, polys.length, ...snap(polys).filter(p => p.length)); pieces.splice(0, pieces.length, ...snap(pieces).filter(p => p.length));
  const arms = polys.slice(0, outlineArms(n).length);
  try { merged = polygonClipping.union(polys[0], ...polys.slice(1)); }
  catch {
    // one shape at a time (a shape that trips the merge is retried nudged by a millimetre, then left out)
    merged = [arms[0]];
    for (const p of [...arms.slice(1), ...pieces]) {
      try { merged = polygonClipping.union(merged, p); }
      catch {
        try { merged = polygonClipping.union(merged, p.map(ring => ring.map(([x, y]) => [x + 0.001, y + 0.0007] as Pair))); } catch { /* left out */ }
      }
    }
  }
  // the biggest piece, without holes (asphalt all the way across)
  let best: Ring | null = null, bestA = 0;
  for (const poly of merged) {
    const ring = poly[0];
    let A = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) A += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    if (Math.abs(A) > bestA) { bestA = Math.abs(A); best = ring; }
  }
  return best && best.length >= 4 ? orient(best.slice(0, -1).map(([x, y]) => ({ x, y }))) : null;
}
/**
 * Junction shapes worked out so far, by their inputs' key: outline and asphalt (kerb inset). Filled by
 * full compiles; a compile with `outlines: "cached"` only reads it (see `putShapes`, the outline worker).
 */
export type JunctionShape = { polygon: Vec[]; surface: Vec[] } | null;
const shapeCache = new Map<string, JunctionShape>();
export const getShape = (key: string) => shapeCache.get(key);
export function putShapes(entries: [string, JunctionShape][]) {
  if (shapeCache.size > 20000) shapeCache.clear();
  for (const [k, v] of entries) shapeCache.set(k, v);
}
type Pair = [number, number];
type Ring = Pair[];

/**
 * The asphalt inside a junction outline: the outline less a kerb band (CURB wide) along every edge
 * except where a road meets it (the mouth lines), so the kerb is a thin border everywhere.
 */
const insetCache = new Map<string, Vec[] | null>();
function kerbInset(n: CNode, outline: Vec[]): Vec[] | null {
  const pts = simplify(outline, 0.03);
  if (pts.length < 3) return null;
  // which side of the edges is inside: test just off the middle of the longest edge
  let li = 0, ll = 0;
  for (let i = 0; i < pts.length; i++) { const b = pts[(i + 1) % pts.length], d = Math.hypot(b.x - pts[i].x, b.y - pts[i].y); if (d > ll) { ll = d; li = i; } }
  const la = pts[li], lb = pts[(li + 1) % pts.length], probe = { x: (la.x + lb.x) / 2 - ((lb.y - la.y) / ll) * 0.05, y: (la.y + lb.y) / 2 + ((lb.x - la.x) / ll) * 0.05 };
  const sgn = pointInPolygon(probe, pts) ? 1 : -1; // +1: the left of each edge (−dy, dx) is inside
  // the arms whose mouth line a point lies on (several where roads side by side overlap, e.g. where a
  // road splits into carriageways), and whether at an arm's kerb corner (where the road's kerb ends)
  const mouthsOf = (p: Vec) => {
    const out: { a: Arm; corner: boolean }[] = [];
    for (const a of outlineArms(n)) {
      const dx = p.x - a.mouth.x, dy = p.y - a.mouth.y, along = dx * a.mu.x + dy * a.mu.y, side = dx * -a.mu.y + dy * a.mu.x;
      if (Math.abs(along) < 0.3 && side > a.lo - 0.05 && side < a.hi + 0.05) out.push({ a, corner: side < a.lo + 0.1 || side > a.hi - 0.1 });
    }
    return out;
  };
  const bands: Ring[][] = [];
  const disc = (p: Vec, r: number): Ring[] => { const ring: Ring = []; for (let k = 0; k <= 8; k++) { const t = (k % 8) * Math.PI / 4; ring.push([p.x + Math.cos(t) * r, p.y + Math.sin(t) * r]); } return [ring]; };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    // (an edge along a mouth line, not one leaving it into the junction)
    const ma = mouthsOf(a), mb = mouthsOf(b), len0 = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const mouth = ma.some(x => mb.some(y => y.a === x.a) && Math.abs(((b.x - a.x) * x.a.mu.x + (b.y - a.y) * x.a.mu.y) / len0) < 0.5);
    if (!mouth) {
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      const nx = (-dy / len) * sgn, ny = (dx / len) * sgn; // inward normal
      const o = 0.02; // (a hair outside, so no sliver of kerb is left along the edge)
      bands.push([[[a.x - nx * o, a.y - ny * o], [b.x - nx * o, b.y - ny * o], [b.x + nx * CURB, b.y + ny * CURB], [a.x + nx * CURB, a.y + ny * CURB], [a.x - nx * o, a.y - ny * o]]]);
    }
    if (!ma.length || ma.every(x => x.corner)) bands.push(disc(a, CURB));
  }
  const ring: Ring = [...pts.map(p => [p.x, p.y] as Pair), [pts[0].x, pts[0].y]];
  const key = ring.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const hit = insetCache.get(key);
  if (hit !== undefined) return hit;
  if (insetCache.size > 20000) insetCache.clear();
  let res: Ring[][];
  const snapped = bands.map(poly => poly.map(r => r.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100] as Pair)));
  try { res = polygonClipping.difference([ring], ...snapped); }
  catch {
    // one band at a time (a band that trips the cut is retried nudged by a millimetre, then left out)
    res = [[ring]];
    for (const b of snapped) {
      try { res = polygonClipping.difference(res, b); }
      catch { try { res = polygonClipping.difference(res, b.map(r => r.map(([x, y]) => [x + 0.001, y + 0.0007] as Pair))); } catch { /* left out */ } }
    }
  }
  let best: Ring | null = null, bestA = 0;
  for (const poly of res) {
    const r = poly[0];
    let A = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) A += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    if (Math.abs(A) > bestA) { bestA = Math.abs(A); best = r; }
  }
  const out = best && best.length >= 4 ? orient(best.slice(0, -1).map(([x, y]) => ({ x, y }))) : null;
  insetCache.set(key, out);
  return out;
}
/**
 * The winding every road and junction outline uses (as `hull` gives): the renderer fills them all as one
 * path with the nonzero rule, where overlapping outlines wound the other way would cancel out.
 */
export function orient(pts: Vec[]): Vec[] {
  let A = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) A += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return A > 0 ? pts.slice().reverse() : pts;
}
function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let r = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if ((poly[i].y > p.y) !== (poly[j].y > p.y) && p.x < ((poly[j].x - poly[i].x) * (p.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) r = !r;
  return r;
}
/** Douglas–Peucker on a closed ring (exported for seeding an outline to edit by hand) */
export const simplifyRing = (pts: Vec[], tol: number) => simplify(pts, tol);
/** Douglas–Peucker on a closed ring: drop points within `tol` m of the line through their neighbours */
function simplify(pts: Vec[], tol: number): Vec[] {
  if (pts.length < 4) return pts.slice();
  const keep = new Array<boolean>(pts.length).fill(false);
  const rec = (i: number, j: number) => {
    let best = -1, bd = tol;
    const a = pts[i], b = pts[j], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    for (let k = i + 1; k < j; k++) { const d = Math.abs((pts[k].x - a.x) * dy - (pts[k].y - a.y) * dx) / L; if (d > bd) { bd = d; best = k; } }
    if (best >= 0) { keep[best] = true; rec(i, best); rec(best, j); }
  };
  // split at the point farthest from the first, so both halves are open chains
  let far = 1, fd = 0;
  for (let k = 1; k < pts.length; k++) { const d = Math.hypot(pts[k].x - pts[0].x, pts[k].y - pts[0].y); if (d > fd) { fd = d; far = k; } }
  keep[0] = keep[far] = true;
  rec(0, far);
  const closed = [...pts, pts[0]];
  const rec2 = (i: number, j: number) => {
    let best = -1, bd = tol;
    const a = closed[i], b = closed[j], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    for (let k = i + 1; k < j; k++) { const d = Math.abs((closed[k].x - a.x) * dy - (closed[k].y - a.y) * dx) / L; if (d > bd) { bd = d; best = k; } }
    if (best >= 0) { keep[best % pts.length] = true; rec2(i, best); rec2(best, j); }
  };
  rec2(far, pts.length);
  return pts.filter((_, k) => keep[k]);
}

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

