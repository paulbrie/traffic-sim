/**
 * Junctions drawn by hand (Network.manualJunctions, JunctionDef): the outline is drawn as the junction
 * is on the ground, the roads are cut where they cross it, and the road ends on it make one junction,
 * joined by lane connectors from lanes ending on the border to lanes starting on it.
 */
import { compile } from "@/engine/compile";
import { pointInPoly } from "@/engine/buildings";
import { newId } from "@/engine/sample";
import { DEFAULT_SIGNAL, type Control, type ConnectorDef, type JunctionDef, type Network, type NodeDef, type SignalPhase, type Vec } from "@/engine/types";
import { nodeConnectors } from "./connections";
import * as ops from "./ops";

/** a road's loose end this close outside the outline (m) is moved onto it and joins the junction */
export const JUNCTION_SNAP = 6;

/** the junction drawn by hand that a node (road end) is on, if any */
export const junctionOf = (net: Network, nodeId: string): JunctionDef | null => net.junctions?.find(j => j.nodes.includes(nodeId)) ?? null;

/** nearest point on the outline's edges, and how far it is */
function nearestOnOutline(pts: Vec[], p: Vec): { pt: Vec; d: number } {
  let best = { pt: pts[0], d: Infinity };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)), q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { pt: q, d };
  }
  return best;
}

/** where a road's centre line first crosses the outline (parameter t), away from its ends; null = it doesn't */
function crossing(net: Network, id: string, pts: Vec[]): number | null {
  const l = ops.linkById(net, id)!, A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!;
  const at = (t: number) => ops.linkPoint(l, A, B, t), inside = (t: number) => { const q = at(t); return pointInPoly(pts, q.x, q.y); };
  const N = Math.max(16, Math.ceil(ops.linkLength(l, A, B) / 0.5));
  for (let k = 0; k < N; k++) {
    let lo = k / N, hi = (k + 1) / N;
    const a = inside(lo);
    if (a === inside(hi)) continue;
    for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (inside(m) === a) lo = m; else hi = m; }
    const t = (lo + hi) / 2, q = at(t);
    // (a crossing at a road's own end: it already stops on the outline)
    if (Math.hypot(q.x - A.x, q.y - A.y) > 0.3 && Math.hypot(q.x - B.x, q.y - B.y) > 0.3) return t;
  }
  return null;
}

/**
 * May these points be joined into one (a road drawn to end on one, or one dragged onto another)? In a plan
 * whose junctions are drawn by hand, only into a plain road point (two roads) and not on a junction's outline.
 */
export function canJoin(net: Network, ...ids: string[]): boolean {
  if (!net.manualJunctions) return true;
  return ids.every(id => !junctionOf(net, id)) && ids.reduce((s, id) => s + degree(net, id), 0) + (ids.length === 1 ? 1 : 0) <= 2;
}

const degree = (net: Network, id: string) => net.links.reduce((k, l) => k + (l.from === id ? 1 : 0) + (l.to === id ? 1 : 0), 0);

/**
 * A junction with this outline (world points): roads crossing it are cut there and what is inside goes;
 * road ends just outside it (JUNCTION_SNAP) move onto it. The road ends on it make the junction, with the
 * connectors the roads would have meeting at one point (lane arrows and all) to start from.
 */
export function createJunction(net: Network, outline: Vec[]): { net: Network; junction: JunctionDef } | { error: string } {
  if (outline.length < 3) return { error: "Draw at least three corners." };
  const taken = new Set((net.junctions ?? []).flatMap(j => j.nodes));
  // cut the roads where they cross the outline
  for (let guard = 0; guard < 1000; guard++) {
    const hit = net.links.map(l => ({ l, t: crossing(net, l.id, outline) })).find(x => x.t !== null);
    if (!hit) break;
    const A = ops.nodeById(net, hit.l.from)!, B = ops.nodeById(net, hit.l.to)!;
    [net] = ops.splitLink(net, hit.l.id, hit.t!, ops.linkPoint(hit.l, A, B, hit.t!));
  }
  // what is inside goes (roads, and the points left without one)
  for (const l of [...net.links]) {
    const A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!, mid = ops.linkPoint(l, A, B, 0.5);
    if (pointInPoly(outline, mid.x, mid.y)) net = ops.deleteLink(net, l.id);
  }
  // road ends on the outline, or just outside it (moved onto it)
  const members: string[] = [];
  for (const n of [...net.nodes]) {
    if (taken.has(n.id) || degree(net, n.id) !== 1 || pointInPoly(outline, n.x, n.y) && nearestOnOutline(outline, n).d > 0.5) continue;
    const near = nearestOnOutline(outline, n);
    if (near.d > JUNCTION_SNAP) continue;
    if (near.d > 0.05) net = ops.moveNode(net, n.id, near.pt);
    members.push(n.id);
  }
  if (members.length < 2) return { error: "At least two roads must reach the outline: draw it across them, or around their ends (up to 6 m away)." };
  const lead = ops.nodeById(net, members[0])!;
  const junction: JunctionDef = { id: newId("j"), nodes: members };
  for (const id of members) {
    net = ops.updateNode(net, id, {
      gateway: false, junction: undefined, connectors: undefined, closed: undefined, laneMap: undefined, connShape: undefined, phases: null, align: undefined,
      ...(id === lead.id ? { control: "priority", signal: { ...DEFAULT_SIGNAL }, outline: outline.map(p => ({ x: ops.round(p.x - lead.x), y: ops.round(p.y - lead.y) })) } : { outline: undefined, paint: undefined }),
    });
  }
  net = { ...net, junctions: [...(net.junctions ?? []), junction] };
  return { net: withDefaultConnectors(net, junction), junction };
}

/** the junction's roads brought together at one point in the middle of its outline (to work out what they would have there) */
function atOnePoint(net: Network, j: JunctionDef): { tmp: Network; id: string } {
  const lead = ops.nodeById(net, j.nodes[0])!, outline = (lead.outline ?? [{ x: 0, y: 0 }]).map(p => ({ x: lead.x + p.x, y: lead.y + p.y }));
  const ids = new Set(j.nodes), mid = { x: outline.reduce((s, p) => s + p.x, 0) / outline.length, y: outline.reduce((s, p) => s + p.y, 0) / outline.length };
  const at: NodeDef = { id: "__junction", x: mid.x, y: mid.y, control: lead.control, gateway: false, signal: { ...lead.signal } };
  const links = net.links.map(l => ({ ...l, from: ids.has(l.from) ? at.id : l.from, to: ids.has(l.to) ? at.id : l.to })).filter(l => l.from !== l.to);
  return { tmp: { ...net, nodes: [...net.nodes.filter(n => !ids.has(n.id)), at], links, junctions: undefined }, id: at.id };
}

/**
 * Set how a junction drawn by hand is controlled. Lights get phases connector by connector, grouped as
 * they would be with the roads meeting at one point (opposite approaches together, or one each).
 */
export function setJunctionControl(net: Network, j: JunctionDef, control: Control): Network {
  const leadId = j.nodes[0];
  if (control !== "lights") return ops.updateNode(net, leadId, { control, phases: null });
  net = ops.updateNode(net, leadId, { control });
  const { tmp, id } = atOnePoint(net, j), c = compile(tmp, { outlines: false }), at = c.nodeById.get(id)!;
  const conns = j.nodes.flatMap(n => ops.nodeById(net, n)?.connectors ?? []);
  const lead = ops.nodeById(net, leadId)!;
  const phases: SignalPhase[] = at.phases.filter(g => g.length).map(g => ({
    green: lead.signal.green,
    conns: conns.filter(x => { const e = c.edgeByKey.get(x.in); return !!e && g.includes(e.inArm); }).map(x => `${x.in}|${x.a}>${x.out}|${x.b}`),
  })).filter(p => p.conns.length);
  return ops.updateNode(net, leadId, { phases: phases.length >= 2 ? phases : null });
}

/**
 * The connectors the junction's roads would have if they met at one point in the middle of the outline
 * (the automatic ones: lane arrows, turn bays…), written out on the road ends they leave from.
 */
function withDefaultConnectors(net: Network, j: JunctionDef): Network {
  const { tmp, id: atId } = atOnePoint(net, j);
  const list = nodeConnectors(tmp, compile(tmp, { outlines: false }), atId);
  // each kept where its lane ends: the road end it arrives at
  const arrival = (key: string) => { const [lid, d] = key.split(":"), l = ops.linkById(net, lid); return l ? (d === "1" ? l.to : l.from) : null; };
  for (const id of j.nodes) {
    const mine: ConnectorDef[] = list.filter(c => arrival(c.in) === id);
    const keys = net.links.flatMap(l => (l.from === id || l.to === id ? [`${l.id}:1`, `${l.id}:-1`] : []));
    const closed = keys.filter(k => !mine.some(c => c.in === k || c.out === k));
    net = ops.updateNode(net, id, { connectors: mine, closed: closed.length ? closed : undefined });
  }
  return net;
}

/** Put a junction's connectors back to those its roads would have meeting at one point (lights follow them). */
export function resetJunctionConnectors(net: Network, j: JunctionDef): Network {
  net = withDefaultConnectors(net, j);
  const lead = ops.nodeById(net, j.nodes[0]);
  return lead?.control === "lights" ? setJunctionControl(net, j, "lights") : net;
}

/** Undo a junction drawn by hand: its road ends become loose ends again (entry points), the roads stay cut. */
export function deleteJunction(net: Network, id: string): Network {
  const j = net.junctions?.find(x => x.id === id);
  if (!j) return net;
  for (const n of j.nodes) net = ops.updateNode(net, n, { gateway: true, connectors: undefined, closed: undefined, outline: undefined, paint: undefined, phases: null, laneLines: undefined });
  const rest = (net.junctions ?? []).filter(x => x.id !== id);
  return { ...net, junctions: rest.length ? rest : undefined };
}
