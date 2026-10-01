import type { SimParams } from "./params";
/**
 * Plan data model — what the editor produces and what gets stored in Postgres.
 * All coordinates are in metres, x to the east and y to the south (screen convention).
 */

export type Vec = { x: number; y: number };

/** free = no rules: a vehicle goes whenever its path through the junction is clear */
export type Control = "priority" | "free" | "stop" | "lights" | "roundabout";

export interface SignalTiming {
  /** green time per phase (s) */
  green: number;
  yellow: number;
  allRed: number;
  /** minimum green before an idle phase may be cut short (s) */
  minGreen: number;
  /** end an idle green early when another phase is waiting */
  actuated: boolean;
  /** give every approach its own green instead of pairing opposite approaches */
  separate?: boolean;
}

export interface NodeDef {
  id: string;
  x: number;
  y: number;
  /** how the junction is controlled (used when 3+ roads meet, or at a 2-road point marked `junction`) */
  control: Control;
  /** a dead-end node where traffic enters and leaves the plan */
  gateway: boolean;
  signal: SignalTiming;
  /** make a point where only two roads meet a real junction (e.g. traffic lights at a crossing) */
  junction?: boolean;
  /** draw the junction with rounded kerbs that follow the roads (merges, slip roads, shallow angles) */
  smooth?: boolean;
  /**
   * Entry points only: vehicles per minute entering here. null/undefined = automatic
   * (entries share the plan's car and truck totals); 0 = nothing enters, vehicles only leave.
   */
  inflow?: number | null;
  /** Entry points only: relative share of trips that end here (1 = normal, 0 = nobody leaves here). */
  exitWeight?: number | null;
  /**
   * Traffic lights only: custom phases, run in this order (null/undefined = worked out automatically).
   * Which lanes get green in each phase is stored on the roads arriving here (`greenF` / `greenB`).
   */
  phases?: SignalPhase[] | null;
  /**
   * Pedestrians per hour crossing each road at this junction (on its zebra crossing, just past the
   * stop line); missing / 0 = none. At traffic lights they cross a road while its traffic has red;
   * elsewhere (priority, stop, a zebra on a plain road) they have priority over vehicles.
   */
  peds?: number | null;
  /**
   * Roundabouts: circulating lanes (1, or 2). With two, the outer lane is for the first exit (right
   * turns) and the inner lane for everything further round; on approaches with two or more lanes the
   * kerb lane is for the first exit and the others for the rest.
   */
  ringLanes?: 1 | 2;
  /**
   * Lane connections set by hand, per turn: key "inLink:dir>outLink:dir" (the directed roads in and
   * out), value per incoming lane (0 = leftmost) the outgoing lane it feeds, several (the first is the
   * usual one; vehicles pick the one that suits their next turn), or null for none. Turns without an
   * entry use the automatic connections. Ignored at roundabouts.
   */
  laneMap?: Record<string, LaneTargets[]>;
  /**
   * Lane connector shapes set by hand: key "inLink:dir|inLane>outLink:dir|outLane", value how far the
   * curve's handles reach (m) along the lane it leaves and back along the lane it joins, or (moved
   * freely) the two handle points relative to the node.
   */
  connShape?: Record<string, ConnShape>;
  /** junction outline drawn by hand (outer kerb edge), points relative to the node; replaces the automatic one */
  outline?: Vec[];
  /** painted areas on the junction: hatched (no driving) or kerbed islands; points relative to the node */
  paint?: { kind: "hatch" | "island"; pts: Vec[] }[];
  /** draw lane lines through the junction, between neighbouring lane paths */
  laneLines?: boolean;
  /**
   * Line up lanes: a one-way road carrying on one direction of a two-way road here has its lanes shifted
   * sideways (fading out along it) so they continue exactly where that direction's lanes are.
   */
  align?: boolean;
}

/** where one incoming lane goes on a turn set by hand: an outgoing lane, several, or none */
export type LaneTargets = number | number[] | null;

/** a lane connector's hand-set curve: handle lengths along the lanes, or free handle points (relative to its node) */
export type ConnShape = [number, number] | { c1: Vec; c2: Vec };

/** One green phase of a junction with custom lights. */
export interface SignalPhase {
  name?: string;
  /** green time (s) */
  green: number;
  /** minimum green before an idle phase may be cut short (s); default: the junction's */
  minGreen?: number | null;
}

/** most phases a junction may have */
export const MAX_PHASES = 8;

export interface LinkDef {
  id: string;
  name: string;
  from: string;
  to: string;
  /** cubic Bézier handles in world coordinates; null = straight */
  c1: Vec | null;
  c2: Vec | null;
  /** lanes travelling from → to, and to → from (0 = one-way) */
  lanesF: number;
  lanesB: number;
  /** kerb lane reserved for buses in that direction (needs 2+ lanes) */
  busF: boolean;
  busB: boolean;
  /** speed limit, km/h */
  speed: number;
  /**
   * Allowed turns per lane where each direction reaches the junction ahead, lane 0 = leftmost
   * (next to the centre line). Each entry combines L (left), S (straight ahead), R (right),
   * e.g. "LS". Missing / null = worked out automatically.
   */
  turnsF?: LaneTurns | null;
  turnsB?: LaneTurns | null;
  /**
   * Sign where each direction reaches a priority junction: "yield" (give way / cédez le passage)
   * or "stop". Traffic on approaches without a sign has right of way.
   */
  signF?: ApproachSign | null;
  signB?: ApproachSign | null;
  /**
   * Turning proportions where each direction reaches the junction ahead: relative weight per
   * outgoing road (by link id). Missing / null = vehicles simply follow their own routes.
   */
  splitF?: Record<string, number> | null;
  splitB?: Record<string, number> | null;
  /**
   * Custom traffic lights at the junction ahead (when it has `phases`): for each lane of that
   * direction (0 = leftmost), the phases in which it has green. A lane in no phase never gets green.
   */
  greenF?: number[][] | null;
  greenB?: number[][] | null;
  /** count the vehicles passing the middle of this road (a traffic counter; off by default) */
  counter?: boolean;
  /**
   * Turn bays where each direction reaches the junction ahead: extra lanes on the left (next to
   * the centre / median) and on the right (kerb side) over the last metres before the stop line.
   * Lane numbering at the junction then counts them: left bays first, then the through lanes,
   * then right bays (so `turnsF` / `greenF` have lanesF + left + right entries).
   */
  baysF?: Bays | null;
  baysB?: Bays | null;
  /** width of the median between the two directions (m; 0 = none) and how it is built */
  median?: number;
  medianKind?: MedianKind;
  /**
   * A slip lane: this (one-way) road lets right-turning traffic bypass the junction with this node
   * id. The approach it leaves then has no right turn at that junction, and a kerbed island is
   * drawn between the slip lane and the junction corner.
   */
  slip?: string | null;
  /** width of each lane (m); missing = 3.2 */
  laneWidth?: number;
  /**
   * A lane that ends: in that direction the leftmost ("left") or kerb-side ("right") lane merges
   * into the lane beside it over the last `len` metres before the road's end (it narrows away).
   */
  dropF?: LaneDrop | null;
  dropB?: LaneDrop | null;
  /**
   * The reversible corridor (ReversibleDef id) this two-way road belongs to: it gets a reversible
   * middle lane, lane 0 of both directions (so `turnsF` / `greenF` have lanesF + 1 entries), opened
   * to one direction at a time. Turn bays and lanes ending on the centre side are not used then.
   */
  rev?: string | null;
  /**
   * Elevation order: 0 = ground (missing), 1, 2, … = bridges / flyovers above it, -1, … = underpasses
   * and tunnels. Roads only meet where they share a junction, so a bridge simply passes over what
   * is below; the level decides what is drawn on top, and the height in 3D (the roads leading onto
   * a bridge ramp up to it).
   */
  level?: number;
}

export const LEVELS = { min: -3, max: 5 };

export type MedianKind = "painted" | "raised";

export interface LaneDrop { side: "left" | "right"; len: number }

export interface Bays {
  /** extra lanes (0–2) and how far back from the stop line they reach (m) */
  left: number; leftLen: number;
  right: number; rightLen: number;
}

/** most through lanes per direction, most bay lanes per side, and most lanes at a stop line */
export const MAX_LANES = 6, MAX_BAYS = 2, MAX_LANES_AT_LINE = 8;
export const MAX_MEDIAN = 30;
export const LANE_WIDTH = { min: 2.5, max: 4.2, default: 3.2 };

/** lanes of one direction where it reaches the junction ahead (through lanes plus turn bays) */
export function lanesAtLine(link: LinkDef, dir: 1 | -1): number {
  const n = dir === 1 ? link.lanesF : link.lanesB;
  if (n <= 0) return 0;
  // a reversible middle lane (two-way roads) is lane 0 of both directions; it rules out left bays
  const rev = link.rev && link.lanesF > 0 && link.lanesB > 0 ? 1 : 0;
  const b = dir === 1 ? link.baysF : link.baysB;
  return n + rev + (b ? (rev ? 0 : b.left) + b.right : 0);
}

export type ApproachSign = "yield" | "stop";

export type LaneTurn = "L" | "LS" | "S" | "SR" | "R" | "LR" | "LSR";
export type LaneTurns = LaneTurn[];
export const LANE_TURNS: LaneTurn[] = ["L", "LS", "S", "SR", "R", "LR", "LSR"];

export interface StopDef {
  id: string;
  name: string;
  link: string;
  /** 1 = served by traffic going from → to, -1 = the other way */
  dir: 1 | -1;
  /** position along the link, 0..1 */
  pos: number;
}

export interface LineDef {
  id: string;
  name: string;
  color: string;
  stops: string[];
  buses: number;
}

/** A junction in a coordinated group. */
export interface SignalGroupMember {
  node: string;
  /** seconds into the group cycle at which this junction's coordinated phase turns green */
  offset: number;
  /** index of the junction's phase that is coordinated (the corridor direction) */
  phase: number;
  /** share of the cycle's green time given to the coordinated phase (0.2–0.85); the rest is split evenly */
  share: number;
}

/**
 * Traffic lights that run together: every member uses the same fixed cycle, and its coordinated
 * phase starts green at its own offset into that cycle (a "green wave" when offsets follow the
 * travel time between junctions). Members ignore their own green / actuated settings.
 */
export interface SignalGroup {
  id: string;
  name: string;
  /** cycle length shared by every member (s) */
  cycle: number;
  /** progression speed used to compute green-wave offsets (km/h) */
  speed: number;
  /** in corridor order */
  members: SignalGroupMember[];
}

/** What a building is used for; decides how much traffic it generates per m² of floor. */
export type BuildingUse = "home" | "shop" | "office" | "industry" | "school" | "civic" | "other" | "minor";
export const BUILDING_USES: BuildingUse[] = ["home", "shop", "office", "industry", "school", "civic", "other", "minor"];

/**
 * A building footprint. Trips inside the plan start and end at buildings (on the nearest road),
 * in proportion to their trip weight.
 */
export interface BuildingDef {
  id: string;
  /** outline, not closed (the last point connects back to the first) */
  pts: Vec[];
  /** metres */
  height: number;
  use: BuildingUse;
  name?: string;
  /** relative trip weight; null/undefined = worked out from use and floor area, 0 = no traffic */
  trips?: number | null;
}

/**
 * Transit: vehicles entering at one entry point and leaving at another, at a set rate (on top of
 * the plan's car and truck totals).
 */
export interface FlowDef {
  id: string;
  /** entry point where the vehicles come in, and the one they leave by (node ids) */
  from: string; to: string;
  /** vehicles per hour (arrivals are random around this average) */
  rate: number;
  /** share of trucks (0..1) */
  trucks?: number;
}

/** A zone: a named group of entry points and buildings where trips start and end (TransModeler's centroids). */
export interface ZoneDef {
  id: string;
  name: string;
  color: string;
  members: { kind: "entry" | "building"; id: string }[];
}

/** Demand between two zones: vehicles per hour from one to the other. */
export interface ZoneFlowDef {
  id: string;
  from: string; to: string;
  rate: number;
  /** share of trucks (0..1) */
  trucks?: number;
}

/** Where the plan sits on Earth: the latitude/longitude of world point (0, 0). */
export interface GeoRef { lat: number; lon: number }

/** a latitude/longitude rectangle */
export interface GeoArea { south: number; west: number; north: number; east: number }

/** how a reversible corridor decides which way its middle lane is open */
export type ReversibleMode = "timer" | "dynamic" | "manual";
/**
 * A reversible middle lane along a chain of roads (through the junctions on it). Direction 1 runs
 * from `start` (one end node of the chain) to the other end. The lane is open to one direction at
 * a time: closing shuts its entries and waits until the vehicles in it have driven out, then it
 * stays closed at least `gap` seconds before opening either way.
 */
export interface ReversibleDef {
  id: string;
  name: string;
  /** the node direction 1 starts from (an end of the chain) */
  start: string;
  mode: ReversibleMode;
  /** timer: seconds open to direction 1, then to direction 2 (0 = never that way), repeating */
  open1: number;
  open2: number;
  /** seconds the lane stays closed (empty) between directions */
  gap: number;
  /** dynamic: vehicles per km per lane in a direction's fixed lanes before it gets the lane */
  minDensity: number;
  /** dynamic: how many times busier the other direction must be to switch (> 1) */
  ratio: number;
  /** dynamic: least time open before switching or closing (s) */
  minOpen: number;
  /** manual (and when the simulation starts): "closed", or open to direction 1 or 2 */
  initial: "closed" | "1" | "2";
}

export interface Network {
  version: 1;
  nodes: NodeDef[];
  links: LinkDef[];
  stops: StopDef[];
  lines: LineDef[];
  signalGroups?: SignalGroup[];
  buildings?: BuildingDef[];
  /** transit flows between entry points */
  flows?: FlowDef[];
  /** zones and the demand between them */
  zones?: ZoneDef[];
  zoneFlows?: ZoneFlowDef[];
  /** reversible-lane corridors (their roads have `rev` set to the corridor's id) */
  reversibles?: ReversibleDef[];
  /** set for plans imported from a map, so later imports line up; `areas` are the frames imported so far */
  geo?: (GeoRef & { areas?: GeoArea[] }) | null;
}

export interface PlanSettings {
  cars: number;
  trucks: number;
  seed: number;
  /**
   * Share of trips that enter or leave through entry points (0..1); the rest start and end inside
   * the plan (at buildings when there are any). null/undefined = automatic.
   */
  through?: number | null;
  /** tuned simulation parameters (only those that differ from the defaults; see params.ts) */
  params?: Partial<SimParams>;
}

export const DEFAULT_SIGNAL: SignalTiming = { green: 18, yellow: 3, allRed: 2, minGreen: 6, actuated: true };

export const emptyNetwork = (): Network => ({ version: 1, nodes: [], links: [], stops: [], lines: [] });

export const DEFAULT_SETTINGS: PlanSettings = { cars: 80, trucks: 8, seed: 7 };
