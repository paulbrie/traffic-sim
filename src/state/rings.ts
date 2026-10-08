/**
 * Rings: a roundabout's circulating road placed by hand, anywhere — a closed loop of one-way roads (LinkDef.ring),
 * anticlockwise on the map, joined to nothing. Lanes are joined to it by drawing lane connectors: dropped
 * anywhere on the ring, a connector gets a point of the ring there to join it at (and the lane it comes from
 * gives way); from any of the ring's points, connectors lead off it. Traffic on the ring drives on; traffic
 * joining it waits for a gap, and while it is nearly full (see the simulation's ring rules).
 */
import { compile, LW } from "@/engine/compile";
import { makeNode, newId } from "@/engine/sample";
import { RING_MAX, RING_MIN, type LinkDef, type Network, type NodeDef, type RingDef, type Vec } from "@/engine/types";
import { connectLanes } from "./connections";
import * as ops from "./ops";

/** the ring's points to start with (more are added where lanes join it, or by double-clicking it) */
const POINTS = 4;
const RING_SPEED = 30;
const TAU = 2 * Math.PI;

/** the circulating road's centre line for an outer kerb radius and its lanes */
export const ringCentre = (kerb: number, lanes: 1 | 2) => Math.max(RING_MIN, Math.min(RING_MAX, kerb)) - (lanes * LW) / 2;

/** a ring of `lanes` circulating lanes round `c`, its outer kerb `kerb` m out: four points to start with, joined to nothing */
export function createRing(net: Network, c: Vec, kerb: number, lanes: 1 | 2): { net: Network; ring: string } {
  const def: RingDef = { id: newId("rb"), x: ops.round(c.x), y: ops.round(c.y), kerb: ops.round(Math.max(RING_MIN, Math.min(RING_MAX, kerb))), lanes };
  const R = ringCentre(def.kerb, lanes);
  const nodes: NodeDef[] = Array.from({ length: POINTS }, (_, k) => makeNode(ops.round(c.x + R * Math.cos((k / POINTS) * TAU)), ops.round(c.y + R * Math.sin((k / POINTS) * TAU)), "priority", false));
  // (each road from a point to the one before it: decreasing angle, anticlockwise on the map)
  const links: LinkDef[] = nodes.map((n, k) => ({ id: newId("l"), name: "", from: n.id, to: nodes[(k - 1 + POINTS) % POINTS].id, lanesF: lanes, lanesB: 0, busF: false, busB: false, speed: RING_SPEED, ring: def.id, c1: null, c2: null }));
  net = { ...net, nodes: [...net.nodes, ...nodes], links: [...net.links, ...links], rings: [...(net.rings ?? []), def] };
  return { net: rebuildRing(net, def.id), ring: def.id };
}

export const ringById = (net: Network, id: string) => net.rings?.find(r => r.id === id) ?? null;
/** the ring (placed by hand) a road or point belongs to */
export function ringOfLink(net: Network, linkId: string): RingDef | null { const l = ops.linkById(net, linkId); return l?.ring ? ringById(net, l.ring) : null; }
export function ringOfNode(net: Network, nodeId: string): RingDef | null {
  for (const l of net.links) if (l.ring && (l.from === nodeId || l.to === nodeId)) { const r = ringById(net, l.ring); if (r) return r; }
  return null;
}
/** the ring's points, round it by angle (radians, 0..2π) */
export function ringPoints(net: Network, r: RingDef): { id: string; angle: number }[] {
  const ids = new Set<string>();
  for (const l of net.links) if (l.ring === r.id) { ids.add(l.from); ids.add(l.to); }
  return [...ids].map(id => { const n = ops.nodeById(net, id)!; return { id, angle: (Math.atan2(n.y - r.y, n.x - r.x) + TAU) % TAU }; }).sort((a, b) => a.angle - b.angle);
}

/**
 * The ring's roads redrawn from its definition: each point put on the circle (at its angle, or `at` for those
 * given), each road between neighbouring points an arc, its lanes the ring's, kept lane by lane through the points.
 */
export function rebuildRing(net: Network, id: string, at: Map<string, number> = new Map()): Network {
  const r = ringById(net, id);
  if (!r) return net;
  const R = ringCentre(r.kerb, r.lanes), pts = ringPoints(net, r).map(p => ({ ...p, angle: at.get(p.id) ?? p.angle })).sort((a, b) => a.angle - b.angle);
  const pos = new Map(pts.map(p => [p.id, { x: ops.round(r.x + R * Math.cos(p.angle)), y: ops.round(r.y + R * Math.sin(p.angle)) }]));
  const ang = new Map(pts.map(p => [p.id, p.angle]));
  // the points, and the ends of other roads' curves at them, moved with them
  const moved = new Map<string, Vec>();
  const nodes = net.nodes.map(n => { const q = pos.get(n.id); if (!q) return n; moved.set(n.id, { x: q.x - n.x, y: q.y - n.y }); return { ...n, ...q }; });
  const links = net.links.map(l => {
    if (l.ring === id) {
      // (an arc from its start, round anticlockwise — decreasing angle — to its end)
      const a = ang.get(l.from)!, b0 = ang.get(l.to)!, d = ((a - b0) % TAU + TAU) % TAU || TAU, b = a - d;
      const h = (4 / 3) * Math.tan(d / 4) * R, pa = pos.get(l.from)!, pb = pos.get(l.to)!;
      return { ...l, lanesF: r.lanes, lanesB: 0, c1: { x: ops.round(pa.x + h * Math.sin(a)), y: ops.round(pa.y - h * Math.cos(a)) }, c2: { x: ops.round(pb.x - h * Math.sin(b)), y: ops.round(pb.y + h * Math.cos(b)) } };
    }
    const da = moved.get(l.from), db = moved.get(l.to);
    if (!da && !db) return l;
    return { ...l, c1: l.c1 && da ? { x: ops.round(l.c1.x + da.x), y: ops.round(l.c1.y + da.y) } : l.c1, c2: l.c2 && db ? { x: ops.round(l.c2.x + db.x), y: ops.round(l.c2.y + db.y) } : l.c2 };
  });
  net = { ...net, nodes, links };
  // round the ring each lane keeps to itself through its points
  for (const p of pts) {
    const into = net.links.find(l => l.ring === id && l.to === p.id), out = net.links.find(l => l.ring === id && l.from === p.id);
    if (!into || !out) continue;
    const key = `${into.id}:1>${out.id}:1`, n = ops.nodeById(net, p.id)!, rest = Object.fromEntries(Object.entries(n.laneMap ?? {}).filter(([k]) => !(k.startsWith(`${into.id}:1>`) && k.endsWith(`>${out.id}:1`))));
    const laneMap = r.lanes > 1 ? { ...rest, [key]: Array.from({ length: r.lanes }, (_, i) => i) } : rest;
    net = ops.updateNode(net, p.id, { laneMap: Object.keys(laneMap).length ? laneMap : undefined });
  }
  return net;
}

/** the ring's centre, radius or lanes changed: its roads redrawn */
export function setRing(net: Network, id: string, patch: Partial<Omit<RingDef, "id">>): Network {
  const r = ringById(net, id);
  if (!r) return net;
  const next = { ...r, ...patch, kerb: ops.round(Math.max(RING_MIN, Math.min(RING_MAX, patch.kerb ?? r.kerb))) };
  return rebuildRing({ ...net, rings: net.rings!.map(x => (x.id === id ? next : x)) }, id);
}

/** a point moved round the ring to `angle` (kept between its neighbours) */
export function moveRingPoint(net: Network, id: string, nodeId: string, angle: number): Network {
  const r = ringById(net, id);
  if (!r) return net;
  const pts = ringPoints(net, r), i = pts.findIndex(p => p.id === nodeId);
  if (i < 0 || pts.length < 2) return net;
  // (not past the points either side: a little short of them)
  const prev = pts[(i - 1 + pts.length) % pts.length].angle, next = pts[(i + 1) % pts.length].angle, cur = pts[i].angle;
  const room = 0.06, lo = ((cur - prev + TAU) % TAU), hi = ((next - cur + TAU) % TAU);
  let d = ((angle - cur + 3 * Math.PI) % TAU) - Math.PI;
  d = Math.max(-(lo - room), Math.min(hi - room, d));
  return rebuildRing(net, id, new Map([[nodeId, (cur + d + TAU) % TAU]]));
}

/** a point taken off the ring (at least three stay): the roads either side of it one; lane connectors at it go */
export function removeRingPoint(net: Network, id: string, nodeId: string): Network | { error: string } {
  const r = ringById(net, id);
  if (!r) return net;
  if (ringPoints(net, r).length <= 3) return { error: "A ring keeps at least three points." };
  const into = net.links.find(l => l.ring === id && l.to === nodeId), out = net.links.find(l => l.ring === id && l.from === nodeId);
  if (!into || !out) return net;
  // (roads of the plan ending at it would be left hanging: take them off it first)
  if (net.links.some(l => !l.ring && (l.from === nodeId || l.to === nodeId))) return { error: "A road ends at this point: delete or move that road first." };
  const merged: LinkDef = { ...into, id: newId("l"), to: out.to };
  net = { ...net, links: [...net.links.filter(l => l.id !== into.id && l.id !== out.id), merged] };
  // (connectors from other lanes into it, or out of it, went with its roads)
  net = { ...net, nodes: net.nodes.map(n => (n.connectors?.some(c => [into.id, out.id].includes(c.in.split(":")[0]) || [into.id, out.id].includes(c.out.split(":")[0]))
    ? { ...n, connectors: n.connectors.filter(c => ![into.id, out.id].includes(c.in.split(":")[0]) && ![into.id, out.id].includes(c.out.split(":")[0])) } : n)) };
  // (the point, with no road now, goes)
  return rebuildRing(ops.deleteNode(net, nodeId), id);
}

/** the ring gone: its roads and points (connectors to and from it go with them) */
export function deleteRing(net: Network, id: string): Network {
  for (const l of net.links.filter(x => x.ring === id)) net = ops.deleteLink(net, l.id);
  return { ...net, rings: net.rings?.filter(r => r.id !== id) };
}

/** a ring's road (not just any road) */
export const isRing = (l: LinkDef | undefined) => !!l?.ring && l.lanesB === 0;

/**
 * A point on ring road `linkId` at `p` (nearest): the road split there (both pieces keep the ring, its group and
 * its lanes through), or an existing point of the ring within `snap` m. Returns the plan and the point.
 */
export function ringPointAt(net: Network, linkId: string, p: Vec, snap = 6): { net: Network; node: string } | null {
  const l = ops.linkById(net, linkId);
  if (!isRing(l)) return null;
  const A = ops.nodeById(net, l!.from)!, B = ops.nodeById(net, l!.to)!;
  for (const n of [A, B]) if (Math.hypot(n.x - p.x, n.y - p.y) <= snap) return { net, node: n.id };
  const { t } = ops.nearestT(l!, A, B, p);
  if (t < 0.03 || t > 0.97) return { net, node: (t < 0.5 ? A : B).id };
  const [split, node] = ops.splitLink(net, linkId, t, ops.linkPoint(l!, A, B, t));
  let out = ops.updateNode(split, node.id, { gateway: false });
  // (a ring placed by hand: its roads redrawn round it, the new point on the circle)
  if (ringById(out, l!.ring!)) return { net: rebuildRing(out, l!.ring!), node: node.id };
  // (lanes kept through the new point, as at the others)
  if (l!.lanesF > 1) {
    const into = out.links.find(x => x.to === node.id && x.ring === l!.ring)!, from = out.links.find(x => x.from === node.id && x.ring === l!.ring)!;
    out = ops.updateNode(out, node.id, { laneMap: { [`${into.id}:1>${from.id}:1`]: Array.from({ length: l!.lanesF }, (_, i) => i) } });
    // (and where the road was split, the points at its ends now meet the pieces)
  }
  return { net: out, node: node.id };
}

/**
 * Join lane `a` of the road arriving at edge `inKey` to the ring at `p` on ring road `linkId`: a point of the
 * ring there, a connector from the lane into the ring's lane `b` (the outer one unless given), and the lane gives way.
 */
export function joinRing(net: Network, inKey: string, a: number, linkId: string, p: Vec, b?: number): { net: Network; id: string } | { error: string } {
  const pt = ringPointAt(net, linkId, p);
  if (!pt) return { error: "That isn't a ring." };
  net = pt.net;
  const out = net.links.find(l => l.from === pt.node && isRing(l));
  if (!out) return { error: "That point of the ring has no way on." };
  const c = compile(net, { outlines: false });
  const lane = b ?? out.lanesF - 1;
  const r = connectLanes(net, c, inKey, a, `${out.id}:1`, lane);
  if (!r) return { error: "The ring is too far from that lane (it must be within 60 m of where the lane ends)." };
  // (joining the ring: give way to traffic on it)
  const [lid, d] = inKey.split(":"), road = ops.linkById(r.net, lid);
  const signed = road && !(d === "1" ? road.signF : road.signB) ? ops.updateLink(r.net, lid, d === "1" ? { signF: "yield" } : { signB: "yield" }) : r.net;
  return { net: signed, id: r.id };
}
