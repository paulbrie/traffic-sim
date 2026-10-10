/**
 * Connectors drawn so they turn back on themselves: a bend (a via point) where the line from one piece to the next turns
 * more than CONNECTOR_KINK_LIMIT, as a converted plan or a slip of the mouse can leave (Bob's finder, T56: on Bistrița a
 * loop shared by four connectors into l1764 at j534, 166°, and c5048 at j578, 175°). The cars on one double back across
 * the junction's other connectors. Found for the Problems console, and taken out by Tidy: the bends that make it dropped,
 * the sharpest first, until none turns that much (the ends stay where they are). Framework-free.
 */
import { contentsOf, insidePolygon, laneById, outlinePath, pointAt, type Pt, type Sketch } from "./lane-sketch";

/**
 * The sharpest turn (degrees) at a connector's bend still taken as drawn so: more is doubling back. An ordinary U-turn
 * connector turns about 117° at its one bend (two pieces of a half circle).
 */
export const CONNECTOR_KINK_LIMIT = 150;
/** pieces shorter than this (m) give no direction to turn from */
const SHORT = 0.05;

/** the turn (degrees) at each inner point of a line (0 where a piece next to it is too short to tell), by the point's index */
export function turnsAt(pts: Pt[]): number[] {
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return 0;
    const ax = p.x - pts[i - 1].x, ay = p.y - pts[i - 1].y, bx = pts[i + 1].x - p.x, by = pts[i + 1].y - p.y, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < SHORT || lb < SHORT) return 0;
    return (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180) / Math.PI;
  });
}

/** a line's inner points taken out, the one turning most first, while one turns more than `limit`: what is left, and how many went */
export function unkinkPts(pts: Pt[], limit = CONNECTOR_KINK_LIMIT): { pts: Pt[]; dropped: number } {
  let out = pts, dropped = 0;
  for (;;) {
    const t = turnsAt(out);
    let k = -1;
    for (let i = 1; i < out.length - 1; i++) if (t[i] > limit && (k < 0 || t[i] > t[k])) k = i;
    if (k < 0) return { pts: out, dropped };
    out = out.filter((_, i) => i !== k); dropped++;
  }
}

/** a connector's line through its ends and bends (null if a lane of it is gone) */
function lineOf(sk: Sketch, c: Sketch["connectors"][number]): Pt[] | null {
  const a = laneById(sk, c.from.lane), b = laneById(sk, c.to.lane);
  return a && b ? [pointAt(a.shape, c.from.s).p, ...(c.via ?? []), pointAt(b.shape, c.to.s).p] : null;
}

export interface ConnectorKink { connector: string; junction: string | null; angle: number; at: Pt }
/** the connectors turning back at a bend more than the limit: the sharpest turn of each and where it is, the sharpest first */
export function connectorKinks(sk: Sketch, limit = CONNECTOR_KINK_LIMIT): ConnectorKink[] {
  const found: ConnectorKink[] = [];
  for (const c of sk.connectors) {
    if (!c.via?.length) continue;
    const pts = lineOf(sk, c);
    if (!pts) continue;
    const t = turnsAt(pts);
    let k = 0;
    for (let i = 1; i < pts.length - 1; i++) if (t[i] > t[k]) k = i;
    if (t[k] > limit) found.push({ connector: c.id, junction: null, angle: Math.round(t[k]), at: pts[k] });
  }
  if (found.length) {
    const cs = contentsOf(sk);
    // (the junction it is on; on two that overlap, the one round the bend that turns back)
    for (const f of found) {
      const on = sk.junctions.filter(j => cs.get(j.id)?.connectors.includes(f.connector));
      f.junction = (on.find(j => insidePolygon(f.at, outlinePath(j))) ?? on[0])?.id ?? null;
    }
  }
  return found.sort((a, b) => b.angle - a.angle);
}

/** every connector turning back so made not to: the bends that do it dropped (the sharpest first; its ends kept), but on the ones in `keep` */
export function unkinkConnectors(sk: Sketch, keep: Set<string> = new Set(), limit = CONNECTOR_KINK_LIMIT): { sketch: Sketch; fixed: string[]; dropped: number } {
  const fixed: string[] = [];
  let dropped = 0;
  const connectors = sk.connectors.map(c => {
    if (!c.via?.length || keep.has(c.id)) return c;
    const pts = lineOf(sk, c);
    if (!pts) return c;
    const r = unkinkPts(pts, limit);
    if (!r.dropped) return c;
    fixed.push(c.id); dropped += r.dropped;
    const via = r.pts.slice(1, -1);
    const { via: _, ...rest } = c;
    return via.length ? { ...rest, via } : rest;
  });
  return fixed.length ? { sketch: { ...sk, connectors }, fixed, dropped } : { sketch: sk, fixed, dropped };
}
