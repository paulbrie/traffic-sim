import { DEFAULT_SETTINGS, DEFAULT_SIGNAL, LANE_TURNS, type ApproachSign, type LaneTurns, type Network, type PlanSettings } from "./types";

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
      signal: {
        green: num(s.green, 3, 180, DEFAULT_SIGNAL.green), yellow: num(s.yellow, 1, 10, DEFAULT_SIGNAL.yellow),
        allRed: num(s.allRed, 0, 10, DEFAULT_SIGNAL.allRed), minGreen: num(s.minGreen, 1, 120, DEFAULT_SIGNAL.minGreen),
        actuated: s.actuated !== false,
        separate: s.separate === true,
      },
    };
  });
  const ids = new Set(nodes.map(n => n.id));
  const links = arr("links").filter(l => typeof l.id === "string" && ids.has(l.from as string) && ids.has(l.to as string) && l.from !== l.to).map(l => ({
    id: str(l.id), name: str(l.name, "", 120), from: str(l.from), to: str(l.to),
    c1: vec(l.c1), c2: vec(l.c2),
    lanesF: Math.round(num(l.lanesF, 0, 4, 1)), lanesB: Math.round(num(l.lanesB, 0, 4, 1)),
    busF: l.busF === true, busB: l.busB === true, speed: Math.round(num(l.speed, 10, 130, 50)),
    turnsF: turns(l.turnsF, num(l.lanesF, 0, 4, 1)), turnsB: turns(l.turnsB, num(l.lanesB, 0, 4, 1)),
    signF: sign(l.signF), signB: sign(l.signB), splitF: split(l.splitF), splitB: split(l.splitB),
  })).filter(l => l.lanesF + l.lanesB > 0);
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
  return { version: 1, nodes, links, stops, lines, ...(signalGroups.length ? { signalGroups } : {}) };
}

export function sanitizeSettings(input: unknown): PlanSettings {
  const s = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    cars: Math.round(num(s.cars, 0, 5000, DEFAULT_SETTINGS.cars)),
    trucks: Math.round(num(s.trucks, 0, 1000, DEFAULT_SETTINGS.trucks)),
    seed: Math.round(num(s.seed, 1, 1e9, DEFAULT_SETTINGS.seed)),
  };
}
