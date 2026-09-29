import type { CNode, Compiled, Edge } from "./compile";
import type { Network, SignalGroup } from "./types";

/** Driving distance (m) from one node to another along the roads, or null when unreachable. */
export function roadDistance(c: Compiled, fromId: string, toId: string): number | null {
  const from = c.nodeById.get(fromId), to = c.nodeById.get(toId);
  if (!from || !to) return null;
  if (from === to) return 0;
  const out = new Map<number, Edge[]>();
  for (const e of c.edges) { const l = out.get(e.from.idx) ?? []; l.push(e); out.set(e.from.idx, l); }
  const dist = new Map<number, number>([[from.idx, 0]]);
  const open: { n: number; d: number }[] = [{ n: from.idx, d: 0 }];
  while (open.length) {
    open.sort((a, b) => a.d - b.d);
    const { n, d } = open.shift()!;
    if (n === to.idx) return d;
    if (d > (dist.get(n) ?? Infinity)) continue;
    for (const e of out.get(n) ?? []) {
      // full centre-line length (the part inside the junctions included)
      const nd = d + e.center.len;
      if (nd < (dist.get(e.to.idx) ?? Infinity)) { dist.set(e.to.idx, nd); open.push({ n: e.to.idx, d: nd }); }
    }
  }
  return null;
}

/**
 * Offsets for a green wave: each junction's coordinated green starts when a vehicle that left the
 * previous junction at the start of its green arrives, driving at the group's speed. Members are
 * taken in their listed (corridor) order; the first keeps its offset.
 */
export function greenWaveOffsets(c: Compiled, g: SignalGroup): { offsets: number[]; gaps: (number | null)[] } {
  const v = g.speed / 3.6;
  const offsets: number[] = [], gaps: (number | null)[] = [];
  g.members.forEach((m, i) => {
    if (i === 0) { offsets.push(m.offset); gaps.push(null); return; }
    const prev = g.members[i - 1];
    const d = roadDistance(c, prev.node, m.node) ?? roadDistance(c, m.node, prev.node);
    gaps.push(d);
    const t = d == null ? 0 : d / v;
    offsets.push(Math.round((((offsets[i - 1] + t) % g.cycle) + g.cycle) % g.cycle));
  });
  return { offsets, gaps };
}

/**
 * The same junction with custom (per-lane) phases that reproduce what it runs now: its current
 * phases, each lane in the phases it is green in, each phase with the junction's green time.
 * Returns the network unchanged if the junction has no lights with at least two phases.
 */
export function withCustomPhases(net: Network, compiled: Compiled, nodeId: string): Network {
  const cn = compiled.nodeById.get(nodeId);
  if (!cn || cn.phases.length < 2) return net;
  const lanesByEdge = new Map<string, number[][]>();
  cn.arms.forEach((a, i) => { if (a.inEdge) lanesByEdge.set(a.inEdge.key, cn.lanePhases[i].map(ps => [...ps])); });
  const links = net.links.map(l => {
    const f = l.to === nodeId ? lanesByEdge.get(`${l.id}:1`) : undefined, b = l.from === nodeId ? lanesByEdge.get(`${l.id}:-1`) : undefined;
    return f || b ? { ...l, ...(f ? { greenF: f } : {}), ...(b ? { greenB: b } : {}) } : l;
  });
  const phases = cn.phases.map((_, p) => ({ green: cn.phaseGreen[p] }));
  return { ...net, links, nodes: net.nodes.map(n => (n.id === nodeId ? { ...n, phases } : n)) };
}

export type Aspect = "green" | "yellow" | "red";

/**
 * Light shown to traffic arriving in `lane` of arm `armIdx` of a junction whose lights are in
 * `phase` / `stage` (0 green, 1 yellow, 2 all red); null = no lights there. Without a lane: the
 * approach as a whole (green when any of its lanes is green). A lane that is also green in the next
 * phase stays green through the change.
 */
export function signalAspect(n: CNode, phase: number, stage: number, armIdx: number, lane?: number): Aspect | null {
  if (!n.controlled || n.def.control !== "lights" || n.phases.length < 2) return null;
  const lanes = n.lanePhases[armIdx] ?? [];
  const greenIn = (p: number) => (lane === undefined ? lanes.some(ps => ps.includes(p)) : !!lanes[lane]?.includes(p));
  if (!greenIn(phase)) return "red";
  if (stage === 0) return "green";
  if (greenIn((phase + 1) % n.phases.length)) return "green";
  return stage === 1 ? "yellow" : "red";
}
