/**
 * Where the pedestrians are, for the 2D map and the 3D view alike: walking across a zebra (a junction's,
 * or one drawn by hand) or waiting at its kerb, in groups of three abreast, each facing the way they cross.
 */
import type { Compiled } from "@/engine/compile";
import type { SimMirror } from "@/engine/sim/mirror";

/** a pedestrian: where (m), the way they face (unit), and the elevation level they are on */
export interface PedSpot { x: number; y: number; dx: number; dy: number; lv: number }

/** (at most this many shown per crossing, crossing and waiting each; spaced this far apart, m) */
const MAX = 8, GAP = 1.0;

export function pedestrianSpots(c: Compiled, sim: SimMirror): PedSpot[] {
  const out: PedSpot[] = [];
  for (const n of c.nodes) {
    if (!n.peds) continue;
    for (const p of sim.pedView(n.idx)) {
      const a = n.degree === 2 ? n.arms[0] : n.arms[p.arm];
      if (!a) continue;
      const base = n.degree === 2 ? { x: n.pos.x, y: n.pos.y } : { x: a.mouth.x - a.mu.x * 2.1, y: a.mouth.y - a.mu.y * 2.1 };
      const u = n.degree === 2 ? a.u : a.mu, r = { x: -u.y, y: u.x };
      // (they walk across the road, the way the second coordinate grows)
      const at = (along: number, across: number) => out.push({ x: base.x + u.x * along + r.x * across, y: base.y + u.y * along + r.y * across, dx: r.x, dy: r.y, lv: n.level });
      for (let i = 0; i < Math.min(p.crossing, MAX); i++) at(((i % 3) - 1) * GAP, a.lo + 0.6 + p.progress * (a.hi - a.lo - 1.2) - Math.floor(i / 3) * GAP);
      for (let i = 0; i < Math.min(p.waiting, MAX); i++) at(((i % 3) - 1) * GAP, a.hi + GAP + Math.floor(i / 3) * GAP);
    }
  }
  // the crossings drawn by hand: from a to b, waiting at a's kerb
  for (const x of c.crossings) {
    const p = sim.crossingStats(x.idx);
    if (!p || (!p.crossing && !p.waiting)) continue;
    const at = (along: number, across: number) => out.push({ x: x.def.a.x + x.u.x * along + x.v.x * across, y: x.def.a.y + x.u.y * along + x.v.y * across, dx: x.u.x, dy: x.u.y, lv: 0 });
    for (let i = 0; i < Math.min(p.crossing, MAX); i++) at(0.6 + p.progress * (x.len - 1.2) - Math.floor(i / 3) * GAP, ((i % 3) - 1) * GAP);
    for (let i = 0; i < Math.min(p.waiting, MAX); i++) at(-GAP - Math.floor(i / 3) * GAP, ((i % 3) - 1) * GAP);
  }
  return out;
}
