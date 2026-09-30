/** Routes on the compiled network without running traffic (for the route tracer). */
import type { Compiled, Edge } from "./compile";

/** time (s) added for passing through a junction with rules, on top of driving the roads */
const JUNCTION_S = 4;

/**
 * The fastest way from entry point `from` to exit `to` with free-flowing traffic (road lengths at
 * their speed limits, a few seconds per junction): the roads in order, or null when there is none.
 */
export function routeBetween(c: Compiled, from: string, to: string): Edge[] | null {
  const g = c.nodeById.get(from), d = c.nodeById.get(to);
  if (!g?.gateway || !d?.gateway || g === d) return null;
  const start = g.arms[0]?.outEdge;
  if (!start || start.busOnly) return null;
  const N = c.edges.length, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  // binary heap of [time, edge idx]
  const heap: [number, number][] = [];
  const push = (t: number, i: number) => {
    heap.push([t, i]);
    for (let k = heap.length - 1; k > 0;) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let k = 0; ;) { const a = 2 * k + 1, b = a + 1; let m = k; if (a < heap.length && heap[a][0] < heap[m][0]) m = a; if (b < heap.length && heap[b][0] < heap[m][0]) m = b; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; }
    }
    return top;
  };
  dist[start.idx] = start.length / start.speed;
  push(dist[start.idx], start.idx);
  while (heap.length) {
    const [t, i] = pop();
    if (t > dist[i]) continue;
    const e = c.edges[i];
    if (e.to === d) {
      const out: Edge[] = [];
      for (let k = i; k >= 0; k = prev[k]) out.push(c.edges[k]);
      return out.reverse();
    }
    for (const m of e.to.moves.get(e.idx) ?? []) {
      const o = m.out;
      if (o.busOnly) continue;
      const nt = t + o.length / o.speed + (e.to.controlled ? JUNCTION_S : 0);
      if (nt < dist[o.idx]) { dist[o.idx] = nt; prev[o.idx] = i; push(nt, o.idx); }
    }
  }
  return null;
}

/** the route as x, y points along its roads (and smoothly across the junctions between them), with its length (m) and free-flow time (s) */
export function routeShape(route: Edge[]): { pts: number[]; length: number; time: number; junctions: number } {
  const pts: number[] = [];
  let length = 0, time = 0, junctions = 0;
  route.forEach((e, k) => {
    const c = e.center.slice(e.trimA, Math.max(e.trimA + 0.1, e.center.len - e.trimB));
    if (k > 0) {
      // across the junction: a curve leaving the last road and joining this one along their directions
      const px = pts[pts.length - 2], py = pts[pts.length - 1], tp = route[k - 1].center.tangent(route[k - 1].center.len - route[k - 1].trimB);
      const q = c.at(0), tq = c.tangent(0), d = Math.hypot(q.x - px, q.y - py);
      for (let s = 1; s < 8; s++) {
        const t = s / 8, u = 1 - t, c1x = px + tp.x * d / 3, c1y = py + tp.y * d / 3, c2x = q.x - tq.x * d / 3, c2y = q.y - tq.y * d / 3;
        pts.push(u * u * u * px + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * q.x, u * u * u * py + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * q.y);
      }
      length += d;
      if (route[k - 1].to.controlled) junctions++;
    }
    for (let i = 0; i < c.pts.length; i++) pts.push(c.pts[i]);
    length += c.len; time += c.len / e.speed;
  });
  return { pts, length, time, junctions };
}
