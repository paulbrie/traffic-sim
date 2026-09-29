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
}

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

/** Where the plan sits on Earth: the latitude/longitude of world point (0, 0). */
export interface GeoRef { lat: number; lon: number }

/** a latitude/longitude rectangle */
export interface GeoArea { south: number; west: number; north: number; east: number }

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
}

export const DEFAULT_SIGNAL: SignalTiming = { green: 18, yellow: 3, allRed: 2, minGreen: 6, actuated: true };

export const emptyNetwork = (): Network => ({ version: 1, nodes: [], links: [], stops: [], lines: [] });

export const DEFAULT_SETTINGS: PlanSettings = { cars: 80, trucks: 8, seed: 7 };
