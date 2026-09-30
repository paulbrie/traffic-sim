import { BUILDING_USES, LANE_WIDTH, LEVELS, MAX_BAYS, MAX_LANES, MAX_LANES_AT_LINE, MAX_MEDIAN, MAX_PHASES, DEFAULT_SETTINGS, DEFAULT_SIGNAL, LANE_TURNS, type ApproachSign, type BuildingDef, type BuildingUse, type GeoArea, type Bays, type LaneDrop, type LaneTurns, type Network, type PlanSettings } from "./types";

const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === "number" && isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const str = (v: unknown, def = "", max = 200) => (typeof v === "string" ? v.slice(0, max) : def);
const vec = (v: unknown) => (v && typeof v === "object" && isFinite((v as { x: number }).x) && isFinite((v as { y: number }).y) ? { x: +(v as { x: number }).x, y: +(v as { y: number }).y } : null);

const sign = (v: unknown): ApproachSign | null => (v === "stop" || v === "yield" ? v : null);
/** turning weights: finite, non-negative numbers keyed by link id (dangling ids are ignored at compile time) */
function split(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [k, w] of Object.entries(v as Record<string, unknown>)) if (typeof w === "number" && isFinite(w) && w >= 0 && k.length < 64) out[k] = Math.min(1000, w);
  return Object.keys(out).length ? out : null;
}

/** per-lane turn overrides: kept only when they list a valid value for every lane */
function turns(v: unknown, lanes: number): LaneTurns | null {
  if (!Array.isArray(v) || v.length !== Math.round(lanes) || !v.length) return null;
  return v.every(x => (LANE_TURNS as string[]).includes(x as string)) ? (v as LaneTurns) : null;
}

/** custom signal phases: 2..MAX_PHASES of them, or null (automatic) */
function phases(v: unknown) {
  if (!Array.isArray(v) || v.length < 2) return null;
  return v.slice(0, MAX_PHASES).map((p: Record<string, unknown>) => ({
    ...(typeof p?.name === "string" && p.name ? { name: str(p.name, "", 60) } : {}),
    green: num(p?.green, 3, 180, DEFAULT_SIGNAL.green),
    ...(typeof p?.minGreen === "number" ? { minGreen: num(p.minGreen, 1, 120, DEFAULT_SIGNAL.minGreen) } : {}),
  }));
}

/** per-lane green phases: one list of phase indexes per lane */
function greens(v: unknown, lanes: number) {
  if (!Array.isArray(v) || v.length !== Math.round(lanes) || !v.length) return null;
  return v.map(x => (Array.isArray(x) ? [...new Set(x.filter((i: unknown) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < MAX_PHASES) as number[])].sort((a, b) => a - b) : []));
}

/**
 * Turn bays of one direction: 0–2 per side, 10–400 m long; none on the kerb side of a direction
 * with a bus lane, and never more than MAX_LANES_AT_LINE lanes at the stop line.
 */
function bays(v: unknown, lanes: number, bus: boolean): Bays | null {
  if (!v || typeof v !== "object" || lanes <= 0) return null;
  const b = v as Record<string, unknown>;
  const left = Math.round(num(b.left, 0, MAX_BAYS, 0));
  let right = bus ? 0 : Math.round(num(b.right, 0, MAX_BAYS, 0));
  right = Math.min(right, MAX_LANES_AT_LINE - lanes - left);
  if (left + right <= 0) return null;
  return { left, leftLen: Math.round(num(b.leftLen, 10, 400, 60)), right, rightLen: Math.round(num(b.rightLen, 10, 400, 40)) };
}

/** Normalises untrusted JSON into a well-formed Network (drops dangling references). */
export function sanitizeNetwork(input: unknown): Network {
  const src = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const arr = (k: string) => (Array.isArray(src[k]) ? (src[k] as Record<string, unknown>[]) : []);
  const nodes = arr("nodes").filter(n => typeof n.id === "string").map(n => {
    const s = (n.signal ?? {}) as Record<string, unknown>;
    return {
      id: str(n.id), x: num(n.x, -1e6, 1e6, 0), y: num(n.y, -1e6, 1e6, 0),
      control: (["priority", "free", "stop", "lights", "roundabout"].includes(n.control as string) ? n.control : "priority") as Network["nodes"][number]["control"],
      gateway: n.gateway !== false,
      junction: n.junction === true,
      smooth: n.smooth === true,
      inflow: typeof n.inflow === "number" && isFinite(n.inflow) ? Math.min(120, Math.max(0, n.inflow)) : null,
      exitWeight: typeof n.exitWeight === "number" && isFinite(n.exitWeight) ? Math.min(100, Math.max(0, n.exitWeight)) : null,
      phases: phases(n.phases),
      ...(n.ringLanes === 2 ? { ringLanes: 2 as const } : {}),
      ...(typeof n.peds === "number" && isFinite(n.peds) && n.peds > 0 ? { peds: Math.round(Math.min(3000, n.peds)) } : {}),
      signal: {
        green: num(s.green, 3, 180, DEFAULT_SIGNAL.green), yellow: num(s.yellow, 1, 10, DEFAULT_SIGNAL.yellow),
        allRed: num(s.allRed, 0, 10, DEFAULT_SIGNAL.allRed), minGreen: num(s.minGreen, 1, 120, DEFAULT_SIGNAL.minGreen),
        actuated: s.actuated !== false,
        separate: s.separate === true,
      },
    };
  });
  const ids = new Set(nodes.map(n => n.id));
  const links = arr("links").filter(l => typeof l.id === "string" && ids.has(l.from as string) && ids.has(l.to as string) && l.from !== l.to).map(l => {
    const lanesF = Math.round(num(l.lanesF, 0, MAX_LANES, 1)), lanesB = Math.round(num(l.lanesB, 0, MAX_LANES, 1));
    const busF = l.busF === true, busB = l.busB === true;
    const baysF = bays(l.baysF, lanesF, busF), baysB = bays(l.baysB, lanesB, busB);
    // a lane that ends: needs 2+ lanes, not on a side with turn bays or (right) a bus lane
    const drop = (v: unknown, lanes: number, bus: boolean, b: Bays | null): LaneDrop | null => {
      if (!v || typeof v !== "object" || lanes < 2) return null;
      const d = v as Record<string, unknown>, side = d.side === "left" ? "left" : d.side === "right" ? "right" : null;
      if (!side || (side === "right" && (bus || b?.right)) || (side === "left" && b?.left)) return null;
      return { side, len: Math.round(num(d.len, 10, 300, 60)) };
    };
    const dropF = drop(l.dropF, lanesF, busF, baysF), dropB = drop(l.dropB, lanesB, busB, baysB);
    const atF = lanesF + (baysF ? baysF.left + baysF.right : 0), atB = lanesB + (baysB ? baysB.left + baysB.right : 0);
    const median = lanesF > 0 && lanesB > 0 ? Math.round(num(l.median, 0, MAX_MEDIAN, 0) * 10) / 10 : 0;
    return {
      id: str(l.id), name: str(l.name, "", 120), from: str(l.from), to: str(l.to),
      c1: vec(l.c1), c2: vec(l.c2),
      lanesF, lanesB, busF, busB, speed: Math.round(num(l.speed, 10, 130, 50)),
      turnsF: turns(l.turnsF, atF), turnsB: turns(l.turnsB, atB),
      signF: sign(l.signF), signB: sign(l.signB), splitF: split(l.splitF), splitB: split(l.splitB),
      greenF: greens(l.greenF, atF), greenB: greens(l.greenB, atB),
      ...(l.counter === true ? { counter: true } : {}),
      ...(baysF ? { baysF } : {}), ...(baysB ? { baysB } : {}),
      ...(dropF ? { dropF } : {}), ...(dropB ? { dropB } : {}),
      ...(median > 0 ? { median, medianKind: l.medianKind === "raised" ? "raised" as const : "painted" as const } : {}),
      ...(typeof l.laneWidth === "number" && isFinite(l.laneWidth) && Math.abs(l.laneWidth - LANE_WIDTH.default) > 0.01 ? { laneWidth: Math.round(num(l.laneWidth, LANE_WIDTH.min, LANE_WIDTH.max, LANE_WIDTH.default) * 10) / 10 } : {}),
      ...(Number.isInteger(l.level) && (l.level as number) !== 0 ? { level: Math.min(LEVELS.max, Math.max(LEVELS.min, l.level as number)) } : {}),
      ...(typeof l.slip === "string" && ids.has(l.slip) && l.slip !== l.from && l.slip !== l.to ? { slip: l.slip } : {}),
    };
  }).filter(l => l.lanesF + l.lanesB > 0);
  const linkIds = new Set(links.map(l => l.id));
  const stops = arr("stops").filter(s => linkIds.has(s.link as string)).map(s => ({
    id: str(s.id), name: str(s.name, "Stop", 80), link: str(s.link), dir: (s.dir === -1 ? -1 : 1) as 1 | -1, pos: num(s.pos, 0, 1, 0.5),
  }));
  const stopIds = new Set(stops.map(s => s.id));
  const lines = arr("lines").map(l => ({
    id: str(l.id), name: str(l.name, "Line", 80), color: /^#[0-9a-fA-F]{6}$/.test(str(l.color)) ? str(l.color) : "#D99800",
    stops: (Array.isArray(l.stops) ? l.stops : []).filter((x: unknown) => typeof x === "string" && stopIds.has(x)) as string[],
    buses: Math.round(num(l.buses, 0, 30, 2)),
  }));
  // coordinated signal groups: members must be existing junctions, each in at most one group
  const nodeIds = new Set(nodes.map(n => n.id)), taken = new Set<string>();
  const signalGroups = arr("signalGroups").filter(g => typeof g.id === "string").map(g => ({
    id: str(g.id, "", 64), name: str(g.name, "Signal group", 80),
    cycle: Math.round(num(g.cycle, 20, 240, 90)),
    speed: num(g.speed, 10, 130, 50),
    members: (Array.isArray(g.members) ? g.members : [])
      .filter((m: Record<string, unknown>) => m && typeof m.node === "string" && nodeIds.has(m.node) && !taken.has(m.node) && (taken.add(m.node), true))
      .map((m: Record<string, unknown>) => ({ node: m.node as string, offset: num(m.offset, 0, 240, 0), phase: Math.round(num(m.phase, 0, 7, 0)), share: num(m.share, 0.2, 0.85, 0.5) })),
  }));
  const flows = arr("flows").filter(f => typeof f.id === "string" && nodeIds.has(f.from as string) && nodeIds.has(f.to as string) && f.from !== f.to).slice(0, 200).map(f => ({
    id: str(f.id, "", 64), from: str(f.from), to: str(f.to), rate: Math.round(num(f.rate, 0, 10000, 300)),
    ...(typeof f.trucks === "number" && isFinite(f.trucks) && f.trucks > 0 ? { trucks: Math.min(1, f.trucks) } : {}),
  }));
  const buildings = sanitizeBuildings(src.buildings);
  // zones: members must exist (entry points by node id, buildings by id), each in one zone at most
  const buildingIds = new Set(buildings.map(b => b.id)), inZone = new Set<string>();
  const zones = arr("zones").filter(z => typeof z.id === "string").slice(0, 100).map(z => ({
    id: str(z.id, "", 64), name: str(z.name, "Zone", 60), color: /^#[0-9a-fA-F]{6}$/.test(str(z.color)) ? str(z.color) : "#2f6fb5",
    members: (Array.isArray(z.members) ? z.members : []).filter((m: Record<string, unknown>) => m && ((m.kind === "entry" && nodeIds.has(m.id as string)) || (m.kind === "building" && buildingIds.has(m.id as string))) && !inZone.has(`${m.kind}:${m.id}`) && (inZone.add(`${m.kind}:${m.id}`), true))
      .map((m: Record<string, unknown>) => ({ kind: m.kind as "entry" | "building", id: m.id as string })),
  }));
  const zoneIds = new Set(zones.map(z => z.id));
  const zoneFlows = arr("zoneFlows").filter(f => typeof f.id === "string" && zoneIds.has(f.from as string) && zoneIds.has(f.to as string)).slice(0, 2000).map(f => ({
    id: str(f.id, "", 64), from: str(f.from), to: str(f.to), rate: Math.round(num(f.rate, 0, 20000, 0)),
    ...(typeof f.trucks === "number" && isFinite(f.trucks) && f.trucks > 0 ? { trucks: Math.min(1, f.trucks) } : {}),
  }));
  const geo = sanitizeGeo(src.geo);
  return { version: 1, nodes, links, stops, lines, ...(signalGroups.length ? { signalGroups } : {}), ...(flows.length ? { flows } : {}), ...(zones.length ? { zones } : {}), ...(zoneFlows.length ? { zoneFlows } : {}), ...(buildings.length ? { buildings } : {}), ...(geo ? { geo } : {}) };
}

/** most buildings a plan keeps (an imported district of a few km²) */
export const MAX_BUILDINGS = 80000;
const r1 = (v: number) => Math.round(v * 10) / 10;

function sanitizeBuildings(v: unknown): BuildingDef[] {
  if (!Array.isArray(v)) return [];
  const out: BuildingDef[] = [], seen = new Set<string>();
  for (const b of v.slice(0, MAX_BUILDINGS) as Record<string, unknown>[]) {
    if (!b || typeof b.id !== "string" || seen.has(b.id) || !Array.isArray(b.pts)) continue;
    const pts = (b.pts as unknown[]).slice(0, 200).map(vec).filter((p): p is { x: number; y: number } => !!p && Math.abs(p.x) < 1e6 && Math.abs(p.y) < 1e6).map(p => ({ x: r1(p.x), y: r1(p.y) }));
    if (pts.length < 3) continue;
    seen.add(b.id);
    out.push({
      id: str(b.id, "", 64), pts, height: r1(num(b.height, 2, 400, 9)),
      use: (BUILDING_USES as string[]).includes(b.use as string) ? (b.use as BuildingUse) : "other",
      ...(typeof b.name === "string" && b.name ? { name: str(b.name, "", 120) } : {}),
      ...(typeof b.trips === "number" && isFinite(b.trips) ? { trips: Math.min(1e5, Math.max(0, b.trips)) } : {}),
    });
  }
  return out;
}

function sanitizeGeo(v: unknown): Network["geo"] {
  const g = v as Record<string, unknown> | null;
  if (!g || typeof g !== "object" || typeof g.lat !== "number" || typeof g.lon !== "number") return null;
  if (!(Math.abs(g.lat) <= 85 && Math.abs(g.lon) <= 180)) return null;
  const areas = (Array.isArray(g.areas) ? g.areas : []).slice(0, 200).filter((a: Record<string, unknown>) =>
    a && [a.south, a.north].every(x => typeof x === "number" && Math.abs(x) <= 85) && [a.west, a.east].every(x => typeof x === "number" && Math.abs(x) <= 180) && (a.south as number) < (a.north as number) && (a.west as number) < (a.east as number),
  ).map((a: Record<string, number>): GeoArea => ({ south: a.south, west: a.west, north: a.north, east: a.east }));
  return { lat: g.lat, lon: g.lon, ...(areas.length ? { areas } : {}) };
}

export function sanitizeSettings(input: unknown): PlanSettings {
  const s = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    cars: Math.round(num(s.cars, 0, 20000, DEFAULT_SETTINGS.cars)),
    trucks: Math.round(num(s.trucks, 0, 4000, DEFAULT_SETTINGS.trucks)),
    seed: Math.round(num(s.seed, 1, 1e9, DEFAULT_SETTINGS.seed)),
    ...(typeof s.through === "number" && isFinite(s.through) ? { through: Math.min(1, Math.max(0, s.through)) } : {}),
  };
}
