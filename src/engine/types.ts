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
}

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

export interface Network {
  version: 1;
  nodes: NodeDef[];
  links: LinkDef[];
  stops: StopDef[];
  lines: LineDef[];
  signalGroups?: SignalGroup[];
}

export interface PlanSettings {
  cars: number;
  trucks: number;
  seed: number;
}

export const DEFAULT_SIGNAL: SignalTiming = { green: 18, yellow: 3, allRed: 2, minGreen: 6, actuated: true };

export const emptyNetwork = (): Network => ({ version: 1, nodes: [], links: [], stops: [], lines: [] });

export const DEFAULT_SETTINGS: PlanSettings = { cars: 80, trucks: 8, seed: 7 };
