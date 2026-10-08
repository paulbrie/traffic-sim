/**
 * Junction groups (Network.groups, GroupDef): roads and the junctions between them kept together as one
 * junction — selected, moved, rotated, copied and saved as one — with entry and exit points where other
 * roads join it, or could. Copying takes the group out as a small plan of its own (a "junction piece"); placing
 * one gives everything new ids, and roads it lands on are cut at its edge and joined to its entry and exit points.
 */
import { newId } from "@/engine/sample";
import type { GroupDef, Network, NodeDef, Vec } from "@/engine/types";
import { boxAround, crossing, linkNear } from "./junctions";
import * as ops from "./ops";

/** a junction taken out of a plan to be placed again: its roads, points and what is on them, in its own coordinates (centred on 0, 0) */
export interface JunctionPiece { kind: "gridlock-junction"; version: 1; name: string; net: Network }

/** an entry or exit point: where traffic goes in or out of the group */
export interface Port {
  node: string; link: string; at: Vec;
  /** pointing out of the group, along its road */
  out: Vec;
  /** lanes going into the group here, and out of it */
  lanesIn: number; lanesOut: number;
  /** a road of the plan joins it here (or it is a loose end, waiting for one) */
  joined: boolean;
}

const unit = (v: Vec): Vec => { const d = Math.hypot(v.x, v.y) || 1; return { x: v.x / d, y: v.y / d }; };

export const groupById = (net: Network, id: string) => net.groups?.find(g => g.id === id) ?? null;
/** the group a road is in */
export const groupOfLink = (net: Network, linkId: string) => net.groups?.find(g => g.links.includes(linkId)) ?? null;
/** the group a point is in: one of its roads' */
export function groupOfNode(net: Network, nodeId: string): GroupDef | null {
  for (const l of net.links) if ((l.from === nodeId || l.to === nodeId) && groupOfLink(net, l.id)) return groupOfLink(net, l.id);
  return null;
}
/** the group's points */
export function groupNodes(net: Network, g: GroupDef): Set<string> {
  const ids = new Set(g.links), out = new Set<string>();
  for (const l of net.links) if (ids.has(l.id)) { out.add(l.from); out.add(l.to); }
  return out;
}

/** the group's entry and exit points: its loose ends, and its points other roads join */
export function groupPorts(net: Network, g: GroupDef): Port[] {
  const mine = new Set(g.links), out: Port[] = [];
  for (const id of groupNodes(net, g)) {
    const at = net.links.filter(l => l.from === id || l.to === id), inner = at.filter(l => mine.has(l.id)), outer = at.filter(l => !mine.has(l.id));
    if (inner.length !== 1 || outer.length > 1) continue;
    const l = inner[0], n = ops.nodeById(net, id)!, A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!;
    const atEnd = l.to === id, t = atEnd ? 0.98 : 0.02, q = ops.linkPoint(l, A, B, t);
    out.push({
      node: id, link: l.id, at: { x: n.x, y: n.y }, out: unit({ x: n.x - q.x, y: n.y - q.y }),
      // (lanes along the road arrive at its `to` end: at the group's edge they leave it)
      lanesIn: atEnd ? l.lanesB : l.lanesF, lanesOut: atEnd ? l.lanesF : l.lanesB, joined: outer.length === 1,
    });
  }
  return out;
}

/** a group of these roads (taken out of any group they were in) */
export function makeGroup(net: Network, linkIds: string[], name?: string): [Network, GroupDef | null] {
  const ids = [...new Set(linkIds)].filter(id => ops.linkById(net, id));
  if (!ids.length) return [net, null];
  const g: GroupDef = { id: newId("g"), name: name || `Junction ${(net.groups?.length ?? 0) + 1}`, links: ids };
  const rest = (net.groups ?? []).map(x => ({ ...x, links: x.links.filter(id => !ids.includes(id)) })).filter(x => x.links.length);
  return [{ ...net, groups: [...rest, g] }, g];
}
export function ungroup(net: Network, id: string): Network {
  const rest = (net.groups ?? []).filter(g => g.id !== id);
  return { ...net, groups: rest.length ? rest : undefined };
}
export function renameGroup(net: Network, id: string, name: string): Network {
  return { ...net, groups: net.groups?.map(g => (g.id === id ? { ...g, name: name.slice(0, 80) } : g)) };
}
/** the group, its roads and points, and what is on them, gone (roads of the plan joining it keep loose ends) */
export function deleteGroup(net: Network, id: string): Network {
  const g = groupById(net, id);
  if (!g) return net;
  for (const lid of g.links) net = ops.deleteLink(net, lid);
  return ungroup(net, id);
}

/** the group's points, the curves of its roads (and of the roads joining it, at their end), its parking rows, moved by `f` */
function transform(net: Network, g: GroupDef, f: (p: Vec) => Vec, turn: number): Network {
  const nodes = groupNodes(net, g), mine = new Set(g.links), cos = Math.cos(turn), sin = Math.sin(turn);
  const rot = (v: Vec) => ({ x: ops.round(v.x * cos - v.y * sin), y: ops.round(v.x * sin + v.y * cos) });
  const F = (p: Vec) => { const q = f(p); return { x: ops.round(q.x), y: ops.round(q.y) }; };
  const moved = new Map<string, Vec>();
  const out: Network = {
    ...net,
    nodes: net.nodes.map(n => {
      if (!nodes.has(n.id)) return n;
      const q = F(n);
      moved.set(n.id, { x: q.x - n.x, y: q.y - n.y });
      // (outlines and painted areas are relative to their point: they turn with it)
      return { ...n, ...q, ...(n.outline ? { outline: n.outline.map(rot) } : {}), ...(n.paint ? { paint: n.paint.map(a => ({ ...a, pts: a.pts.map(rot) })) } : {}) };
    }),
    links: net.links.map(l => (mine.has(l.id) ? { ...l, c1: l.c1 && F(l.c1), c2: l.c2 && F(l.c2) } : l)),
    parking: net.parking?.map(p => (mine.has(p.link) ? { ...p, line: { ...p.line, a: F(p.line.a), b: F(p.line.b) } } : p)),
  };
  // (roads joining it: the handle at the end that moved goes with it)
  out.links = out.links.map(l => {
    if (mine.has(l.id)) return l;
    const da = nodes.has(l.from) ? moved.get(l.from) : undefined, db = nodes.has(l.to) ? moved.get(l.to) : undefined;
    if (!da && !db) return l;
    return { ...l, c1: l.c1 && da ? { x: ops.round(l.c1.x + da.x), y: ops.round(l.c1.y + da.y) } : l.c1, c2: l.c2 && db ? { x: ops.round(l.c2.x + db.x), y: ops.round(l.c2.y + db.y) } : l.c2 };
  });
  return out;
}
export const moveGroup = (net: Network, g: GroupDef, dx: number, dy: number) => transform(net, g, p => ({ x: p.x + dx, y: p.y + dy }), 0);
/** the middle of the group (its points' bounding box) */
export function groupCentre(net: Network, g: GroupDef): Vec {
  const ns = [...groupNodes(net, g)].map(id => ops.nodeById(net, id)!).filter(Boolean);
  const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}
export function rotateGroup(net: Network, g: GroupDef, turn: number): Network {
  const c = groupCentre(net, g), cos = Math.cos(turn), sin = Math.sin(turn);
  return transform(net, g, p => ({ x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin, y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos }), turn);
}

/** the outline round a group (its roads' centre lines and points, convex, `margin` m out), for drawing and for placing */
export function groupHull(net: Network, g: GroupDef, margin = 4): Vec[] {
  const pts: Vec[] = [], mine = new Set(g.links);
  for (const l of net.links) {
    if (!mine.has(l.id)) continue;
    const A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!;
    for (let k = 0; k <= 8; k++) pts.push(ops.linkPoint(l, A, B, k / 8));
  }
  return hull(pts, margin);
}
/** convex hull, pushed out `margin` m */
export function hull(pts: Vec[], margin: number): Vec[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec[] = [], upper: Vec[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  const h = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  const cx = h.reduce((s, q) => s + q.x, 0) / h.length, cy = h.reduce((s, q) => s + q.y, 0) / h.length;
  return h.map(q => { const d = Math.hypot(q.x - cx, q.y - cy) || 1; return { x: q.x + ((q.x - cx) / d) * margin, y: q.y + ((q.y - cy) / d) * margin }; });
}

// ---------------------------------------------------------------- copying and placing

/** the group as a piece to place elsewhere (centred on 0, 0): its roads and points (loose where other roads joined), junctions, parking and stops on its roads */
export function takeOut(net: Network, g: GroupDef): JunctionPiece {
  const mine = new Set(g.links), nodes = groupNodes(net, g), c = groupCentre(net, g);
  const at = (p: Vec) => ({ x: ops.round(p.x - c.x), y: ops.round(p.y - c.y) });
  const ports = new Set(groupPorts(net, g).map(p => p.node));
  const piece: Network = {
    version: 1,
    // (its edge points become loose ends: entry / exit points until joined)
    nodes: net.nodes.filter(n => nodes.has(n.id)).map(n => ({ ...n, ...at(n), ...(ports.has(n.id) ? { gateway: true, inflow: undefined, exitWeight: undefined } : {}) })),
    links: net.links.filter(l => mine.has(l.id)).map(l => ({ ...l, c1: l.c1 && at(l.c1), c2: l.c2 && at(l.c2) })),
    stops: net.stops.filter(s => mine.has(s.link)),
    lines: [],
    ...(net.junctions?.some(j => j.nodes.every(id => nodes.has(id))) ? { junctions: net.junctions.filter(j => j.nodes.every(id => nodes.has(id))) } : {}),
    ...(net.parking?.some(p => mine.has(p.link)) ? { parking: net.parking.filter(p => mine.has(p.link)).map(p => ({ ...p, line: { ...p.line, a: at(p.line.a), b: at(p.line.b) } })) } : {}),
    ...(net.manualJunctions ? { manualJunctions: true } : {}),
    groups: [{ ...g, links: [...g.links] }],
  };
  return { kind: "gridlock-junction", version: 1, name: g.name, net: piece };
}

/** read a piece from text (the clipboard, the library): null if it isn't one */
export function readPiece(x: unknown): JunctionPiece | null {
  const o = typeof x === "string" ? (() => { try { return JSON.parse(x); } catch { return null; } })() : x;
  if (!o || typeof o !== "object" || (o as JunctionPiece).kind !== "gridlock-junction" || !(o as JunctionPiece).net) return null;
  const p = o as JunctionPiece;
  return Array.isArray(p.net.nodes) && Array.isArray(p.net.links) && p.net.links.length ? p : null;
}

/** how far a road's loose end, or a road cut at the piece's edge, may be from an entry / exit point to be joined to it (m) */
const JOIN = 25;
/** the piece's points as placed: turned by `turn` (rad) round its centre, which goes to `at` */
export function placePoint(p: Vec, at: Vec, turn: number): Vec {
  const cos = Math.cos(turn), sin = Math.sin(turn);
  return { x: ops.round(at.x + p.x * cos - p.y * sin), y: ops.round(at.y + p.x * sin + p.y * cos) };
}

/**
 * Place a piece at `at`, turned by `turn`: every id new, then (unless `join` is off) roads of the plan it lands
 * on are cut at its edge — what is under it goes — and their ends, and loose ends nearby, are joined to its
 * nearest entry / exit point with traffic going the right way. Returns the plan, the new group and how many
 * roads were joined.
 */
export function place(net: Network, piece: JunctionPiece, at: Vec, turn: number, join = true): { net: Network; group: string; joined: number } {
  // every id new (ids are unique words in the text: n_…, l_…, j_…, pk_…, s_…, g_…)
  const old = new Set<string>();
  for (const n of piece.net.nodes) old.add(n.id);
  for (const l of piece.net.links) old.add(l.id);
  for (const s of piece.net.stops ?? []) old.add(s.id);
  for (const j of piece.net.junctions ?? []) old.add(j.id);
  for (const p of piece.net.parking ?? []) old.add(p.id);
  for (const g of piece.net.groups ?? []) old.add(g.id);
  const map = new Map<string, string>();
  for (const id of old) map.set(id, newId(id.slice(0, id.indexOf("_")) || "x"));
  const text = JSON.stringify(piece.net).replace(/\b[a-z]+_[a-z0-9]+\b/g, w => map.get(w) ?? w);
  const p: Network = JSON.parse(text);
  const cos = Math.cos(turn), sin = Math.sin(turn), rot = (v: Vec) => ({ x: ops.round(v.x * cos - v.y * sin), y: ops.round(v.x * sin + v.y * cos) });
  const P = (q: Vec) => placePoint(q, at, turn);
  const nodes: NodeDef[] = p.nodes.map(n => ({ ...n, ...P(n), ...(n.outline ? { outline: n.outline.map(rot) } : {}), ...(n.paint ? { paint: n.paint.map(a => ({ ...a, pts: a.pts.map(rot) })) } : {}) }));
  const links = p.links.map(l => ({ ...l, c1: l.c1 && P(l.c1), c2: l.c2 && P(l.c2) }));
  const parking = (p.parking ?? []).map(x => ({ ...x, line: { ...x.line, a: P(x.line.a), b: P(x.line.b) } }));
  const g: GroupDef = { ...(p.groups?.[0] ?? { id: newId("g"), name: piece.name, links: [] }), links: links.map(l => l.id) };
  const before = new Set(net.links.map(l => l.id));
  net = {
    ...net,
    nodes: [...net.nodes, ...nodes], links: [...net.links, ...links], stops: [...net.stops, ...(p.stops ?? [])],
    ...(p.junctions?.length ? { junctions: [...(net.junctions ?? []), ...p.junctions] } : {}),
    ...(parking.length ? { parking: [...(net.parking ?? []), ...parking] } : {}),
    groups: [...(net.groups ?? []), g],
  };
  if (!join) return { net, group: g.id, joined: 0 };

  // the plan's roads it lands on: cut at its edge, what is under it goes
  const edge = groupHull(net, g, 2), inside = (q: Vec) => pointIn(edge, q), box = boxAround(edge, JOIN);
  for (const id of [...before]) { const l = ops.linkById(net, id); if (!l || !linkNear(net, l, box)) before.delete(id); }
  for (let guard = 0; guard < 500; guard++) {
    const hit = net.links.filter(l => before.has(l.id)).map(l => ({ l, t: crossing(net, l.id, edge) })).find(x => x.t !== null);
    if (!hit) break;
    const A = ops.nodeById(net, hit.l.from)!, B = ops.nodeById(net, hit.l.to)!;
    const [n2, cut] = ops.splitLink(net, hit.l.id, hit.t!, ops.linkPoint(hit.l, A, B, hit.t!));
    net = n2; before.delete(hit.l.id);
    for (const l of net.links) if ((l.from === cut.id || l.to === cut.id) && !g.links.includes(l.id)) before.add(l.id);
  }
  for (const l of [...net.links]) {
    if (!before.has(l.id)) continue;
    const A = ops.nodeById(net, l.from)!, B = ops.nodeById(net, l.to)!;
    if (inside(ops.linkPoint(l, A, B, 0.5))) net = ops.deleteLink(net, l.id);
  }
  // join: each of the plan's loose ends near it to the nearest free entry / exit point with traffic going its way
  const ports = groupPorts(net, groupById(net, g.id)!).filter(x => !x.joined);
  const used = new Set<string>();
  let joined = 0;
  const ends = net.nodes.filter(n => !groupNodes(net, groupById(net, g.id)!).has(n.id) && net.links.filter(l => l.from === n.id || l.to === n.id).length === 1);
  const options: { end: string; port: Port; score: number }[] = [];
  for (const n of ends) {
    const l = net.links.find(x => x.from === n.id || x.to === n.id)!;
    // (at its loose end: lanes arriving there go into the junction, lanes leaving come out of it)
    const arriving = l.to === n.id ? l.lanesF : l.lanesB, leaving = l.to === n.id ? l.lanesB : l.lanesF;
    for (const port of ports) {
      const d = Math.hypot(port.at.x - n.x, port.at.y - n.y);
      if (d > JOIN) continue;
      if ((arriving > 0) !== (port.lanesIn > 0) || (leaving > 0) !== (port.lanesOut > 0)) continue;
      options.push({ end: n.id, port, score: d + 3 * (Math.abs(arriving - port.lanesIn) + Math.abs(leaving - port.lanesOut)) });
    }
  }
  options.sort((a, b) => a.score - b.score);
  for (const o of options) {
    if (used.has(o.end) || used.has(o.port.node)) continue;
    used.add(o.end); used.add(o.port.node);
    net = ops.mergeNodes(net, o.port.node, o.end);
    net = ops.updateNode(net, o.port.node, { gateway: false, inflow: undefined, exitWeight: undefined });
    joined++;
  }
  return { net, group: g.id, joined };
}

function pointIn(poly: Vec[], p: Vec): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
