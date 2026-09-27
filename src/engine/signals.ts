import type { Compiled, Edge } from "./compile";
import type { SignalGroup } from "./types";

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
