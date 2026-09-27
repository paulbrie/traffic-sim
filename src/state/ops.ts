/** Pure network edit operations. Each returns a new Network (never mutates). */
import { newId, makeNode } from "@/engine/sample";
import type { LineDef, LinkDef, Network, NodeDef, SignalGroup, SignalGroupMember, StopDef, Vec } from "@/engine/types";
import type { Compiled } from "@/engine/compile";
import { greenWaveOffsets } from "@/engine/signals";

export const nodeById = (net: Network, id: string) => net.nodes.find(n => n.id === id);
export const linkById = (net: Network, id: string) => net.links.find(l => l.id === id);

export function addNode(net: Network, p: Vec): [Network, NodeDef] {
  const n = makeNode(round(p.x), round(p.y));
  return [{ ...net, nodes: [...net.nodes, n] }, n];
}

export function updateNode(net: Network, id: string, patch: Partial<NodeDef>): Network {
  return { ...net, nodes: net.nodes.map(n => (n.id === id ? { ...n, ...patch } : n)) };
}

/** Move a node; curve handles of attached links move along so curves keep their shape. */
export function moveNode(net: Network, id: string, p: Vec): Network {
  const n = nodeById(net, id);
  if (!n) return net;
  const dx = round(p.x) - n.x, dy = round(p.y) - n.y;
  if (!dx && !dy) return net;
  return {
    ...net,
    nodes: net.nodes.map(m => (m.id === id ? { ...m, x: m.x + dx, y: m.y + dy } : m)),
    links: net.links.map(l => {
      if (!l.c1 || !l.c2) return l;
      if (l.from === id) return { ...l, c1: { x: l.c1.x + dx, y: l.c1.y + dy } };
      if (l.to === id) return { ...l, c2: { x: l.c2.x + dx, y: l.c2.y + dy } };
      return l;
    }),
  };
}

export function deleteNode(net: Network, id: string): Network {
  const links = net.links.filter(l => l.from !== id && l.to !== id);
  return pruneRefs({ ...net, nodes: net.nodes.filter(n => n.id !== id), links });
}

export function addLink(net: Network, from: string, to: string, draft: Pick<LinkDef, "lanesF" | "lanesB" | "busF" | "busB" | "speed">): [Network, LinkDef | null] {
  if (from === to) return [net, null];
  if (net.links.some(l => (l.from === from && l.to === to) || (l.from === to && l.to === from))) return [net, null];
  const { lanesF, lanesB, busF, busB, speed } = draft;
  const link: LinkDef = { id: newId("l"), name: "", from, to, c1: null, c2: null, lanesF, lanesB, busF, busB, speed };
  return [{ ...net, links: [...net.links, link] }, link];
}

export function updateLink(net: Network, id: string, patch: Partial<LinkDef>): Network {
  return { ...net, links: net.links.map(l => (l.id === id ? { ...l, ...patch } : l)) };
}

export function deleteLink(net: Network, id: string): Network {
  return pruneRefs({ ...net, links: net.links.filter(l => l.id !== id) });
}

/** Swap the drawing direction of a link (keeps traffic as it is on the ground). */
export function reverseLink(net: Network, id: string): Network {
  return updateLinkWith(net, id, l => ({ ...l, from: l.to, to: l.from, c1: l.c2, c2: l.c1, lanesF: l.lanesB, lanesB: l.lanesF, busF: l.busB, busB: l.busF, turnsF: l.turnsB ?? null, turnsB: l.turnsF ?? null, signF: l.signB ?? null, signB: l.signF ?? null, splitF: l.splitB ?? null, splitB: l.splitF ?? null }), true);
}

function updateLinkWith(net: Network, id: string, f: (l: LinkDef) => LinkDef, flipStops = false): Network {
  return {
    ...net,
    links: net.links.map(l => (l.id === id ? f(l) : l)),
    stops: flipStops ? net.stops.map(s => (s.link === id ? { ...s, dir: (s.dir === 1 ? -1 : 1) as 1 | -1, pos: 1 - s.pos } : s)) : net.stops,
  };
}

/** Split a link at parameter t (0..1 along its centre line); returns the new node. */
export function splitLink(net: Network, id: string, t: number, at: Vec): [Network, NodeDef] {
  const l = linkById(net, id)!;
  const A = nodeById(net, l.from)!, B = nodeById(net, l.to)!;
  const node = makeNode(round(at.x), round(at.y));
  let first: LinkDef, second: LinkDef;
  if (l.c1 && l.c2) {
    // de Casteljau split of the cubic
    const lerp = (p: Vec, q: Vec, u: number) => ({ x: p.x + (q.x - p.x) * u, y: p.y + (q.y - p.y) * u });
    const p01 = lerp(A, l.c1, t), p12 = lerp(l.c1, l.c2, t), p23 = lerp(l.c2, B, t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t);
    first = { ...l, id: newId("l"), to: node.id, c1: p01, c2: p012, turnsF: null, signF: null, splitF: null };
    second = { ...l, id: newId("l"), from: node.id, c1: p123, c2: p23, turnsB: null, signB: null, splitB: null };
    const mid = lerp(p012, p123, t);
    node.x = round(mid.x); node.y = round(mid.y);
  } else {
    first = { ...l, id: newId("l"), to: node.id, turnsF: null, signF: null, splitF: null };
    second = { ...l, id: newId("l"), from: node.id, turnsB: null, signB: null, splitB: null };
  }
  const stops = net.stops.map(s => {
    if (s.link !== id) return s;
    return s.pos <= t ? { ...s, link: first.id, pos: s.pos / Math.max(1e-6, t) } : { ...s, link: second.id, pos: (s.pos - t) / Math.max(1e-6, 1 - t) };
  });
  return [{ ...net, nodes: [...net.nodes, node], links: [...net.links.filter(x => x.id !== id), first, second], stops }, node];
}

/** Merge a node into another (used when a drawn road ends on an existing node). */
export function mergeNodes(net: Network, keep: string, drop: string): Network {
  if (keep === drop) return net;
  const links = net.links
    .map(l => ({ ...l, from: l.from === drop ? keep : l.from, to: l.to === drop ? keep : l.to }))
    .filter(l => l.from !== l.to);
  return pruneRefs({ ...net, nodes: net.nodes.filter(n => n.id !== drop), links });
}

export function addStop(net: Network, link: string, dir: 1 | -1, pos: number): [Network, StopDef] {
  const n = net.stops.length + 1;
  const stop: StopDef = { id: newId("s"), name: `Stop ${n}`, link, dir, pos: Math.min(0.95, Math.max(0.05, pos)) };
  return [{ ...net, stops: [...net.stops, stop] }, stop];
}
export function updateStop(net: Network, id: string, patch: Partial<StopDef>): Network {
  return { ...net, stops: net.stops.map(s => (s.id === id ? { ...s, ...patch } : s)) };
}
export function deleteStop(net: Network, id: string): Network {
  return { ...net, stops: net.stops.filter(s => s.id !== id), lines: net.lines.map(l => ({ ...l, stops: l.stops.filter(x => x !== id) })) };
}

const LINE_COLORS = ["#D99800", "#2F6FB5", "#B5462F", "#3F8F4E", "#7A4FB0", "#1F8A8A"];
export function addLine(net: Network): [Network, LineDef] {
  const line: LineDef = { id: newId("b"), name: `Line ${net.lines.length + 1}`, color: LINE_COLORS[net.lines.length % LINE_COLORS.length], stops: [], buses: 2 };
  return [{ ...net, lines: [...net.lines, line] }, line];
}
export function updateLine(net: Network, id: string, patch: Partial<LineDef>): Network {
  return { ...net, lines: net.lines.map(l => (l.id === id ? { ...l, ...patch } : l)) };
}
export function deleteLine(net: Network, id: string): Network {
  return { ...net, lines: net.lines.filter(l => l.id !== id) };
}

/** Remove stops/lines that reference deleted links, and orphan nodes that are no longer used. */
function pruneRefs(net: Network): Network {
  const linkIds = new Set(net.links.map(l => l.id));
  const stops = net.stops.filter(s => linkIds.has(s.link));
  const stopIds = new Set(stops.map(s => s.id));
  const used = new Set(net.links.flatMap(l => [l.from, l.to]));
  const nodes = net.nodes.filter(n => used.has(n.id));
  const nodeIds = new Set(nodes.map(n => n.id));
  const groups = net.signalGroups?.map(g => ({ ...g, members: g.members.filter(m => nodeIds.has(m.node)) })).filter(g => g.members.length);
  return {
    ...net,
    nodes,
    stops,
    lines: net.lines.map(l => ({ ...l, stops: l.stops.filter(s => stopIds.has(s)) })),
    ...(net.signalGroups ? { signalGroups: groups } : {}),
  };
}

export const round = (v: number) => Math.round(v * 100) / 100;

/** Point on a link centre line at parameter t, plus the parameter nearest to a point. */
export function linkPoint(l: LinkDef, A: Vec, B: Vec, t: number): Vec {
  if (!l.c1 || !l.c2) return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
  const u = 1 - t;
  return {
    x: u * u * u * A.x + 3 * u * u * t * l.c1.x + 3 * u * t * t * l.c2.x + t * t * t * B.x,
    y: u * u * u * A.y + 3 * u * u * t * l.c1.y + 3 * u * t * t * l.c2.y + t * t * t * B.y,
  };
}
export function nearestT(l: LinkDef, A: Vec, B: Vec, p: Vec): { t: number; d: number; pt: Vec } {
  let best = { t: 0, d: Infinity, pt: A };
  const N = l.c1 ? 64 : 16;
  for (let k = 0; k <= N; k++) {
    const t = k / N, q = linkPoint(l, A, B, t), d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best.d) best = { t, d, pt: q };
  }
  // refine
  let lo = Math.max(0, best.t - 1 / N), hi = Math.min(1, best.t + 1 / N);
  for (let it = 0; it < 20; it++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const d1 = Math.hypot(linkPoint(l, A, B, m1).x - p.x, linkPoint(l, A, B, m1).y - p.y);
    const d2 = Math.hypot(linkPoint(l, A, B, m2).x - p.x, linkPoint(l, A, B, m2).y - p.y);
    if (d1 < d2) hi = m2; else lo = m1;
  }
  const t = (lo + hi) / 2, pt = linkPoint(l, A, B, t);
  return { t, d: Math.hypot(pt.x - p.x, pt.y - p.y), pt };
}

/** Arc length of a link centre line. */
export function linkLength(l: LinkDef, A: Vec, B: Vec): number {
  if (!l.c1 || !l.c2) return Math.hypot(B.x - A.x, B.y - A.y);
  let len = 0, prev = A;
  for (let k = 1; k <= 64; k++) { const q = linkPoint(l, A, B, k / 64); len += Math.hypot(q.x - prev.x, q.y - prev.y); prev = q; }
  return len;
}

// ---------------------------------------------------------------- smooth multi-curve roads
// A road with several bends is a chain of links joined at "road joints" (nodes with exactly
// two roads). Smoothing a joint aligns the curve handles on both sides so the road flows
// through it without a kink (a Catmull-Rom style tangent: parallel to the neighbours' chord).

export const linksAt = (net: Network, nodeId: string) => net.links.filter(l => l.from === nodeId || l.to === nodeId);
const otherEnd = (l: LinkDef, nodeId: string) => (l.from === nodeId ? l.to : l.from);

/** tangent direction a smooth curve should have at `at`, coming from `prev` and going to `next` */
export function smoothTangent(prev: Vec, at: Vec, next: Vec): Vec {
  let tx = next.x - prev.x, ty = next.y - prev.y;
  let m = Math.hypot(tx, ty);
  if (m < 1e-6) { tx = next.x - at.x; ty = next.y - at.y; m = Math.hypot(tx, ty) || 1; }
  return { x: tx / m, y: ty / m };
}

/** Makes the road flow smoothly through a two-road joint. No-op for other nodes. */
export function smoothAt(net: Network, nodeId: string, tension = 1 / 3): Network {
  const N = nodeById(net, nodeId);
  const ls = linksAt(net, nodeId);
  if (!N || ls.length !== 2) return net;
  const P = nodeById(net, otherEnd(ls[0], nodeId)), Q = nodeById(net, otherEnd(ls[1], nodeId));
  if (!P || !Q) return net;
  const t = smoothTangent(P, N, Q); // points from P's side towards Q's side
  const patch = (l: LinkDef, toward: Vec, sign: number): LinkDef => {
    const O = toward, len = Math.hypot(O.x - N.x, O.y - N.y) * tension;
    const h = { x: round(N.x + t.x * sign * len), y: round(N.y + t.y * sign * len) };
    // the far end keeps its handle, or gets a straight one so the link becomes a cubic
    const far = { x: round(O.x + (N.x - O.x) / 3), y: round(O.y + (N.y - O.y) / 3) };
    return l.from === nodeId ? { ...l, c1: h, c2: l.c2 ?? far } : { ...l, c2: h, c1: l.c1 ?? far };
  };
  const a = patch(ls[0], P, -1), b = patch(ls[1], Q, 1);
  return { ...net, links: net.links.map(l => (l.id === a.id ? a : l.id === b.id ? b : l)) };
}

/** All road joints along the chain of links that contains `linkId` (stops at junctions and ends). */
export function chainJoints(net: Network, linkId: string): string[] {
  const start = linkById(net, linkId);
  if (!start) return [];
  const out: string[] = [];
  for (const end of [start.from, start.to]) {
    let node = end, via = start.id;
    const seen = new Set<string>();
    while (!seen.has(node)) {
      seen.add(node);
      const ls = linksAt(net, node);
      if (ls.length !== 2 || nodeById(net, node)?.junction) break;
      out.push(node);
      const next = ls.find(l => l.id !== via)!;
      via = next.id; node = otherEnd(next, node);
    }
  }
  return [...new Set(out)];
}

export function smoothChain(net: Network, linkId: string): Network {
  return chainJoints(net, linkId).reduce((n, id) => smoothAt(n, id), net);
}

// ---------------------------------------------------------------- lanes & direction
/** Road layouts offered as one-click variants: [lanes along the arrow, lanes against it]. */
export const LANE_PRESETS: [number, number][] = [[1, 0], [2, 0], [3, 0], [1, 1], [2, 1], [2, 2], [3, 1], [3, 2], [3, 3], [4, 4]];

/**
 * The links of the road `linkId` belongs to (through road joints), each flagged `aligned`
 * when its from→to runs the same way as `linkId`'s from→to.
 */
export function chainLinks(net: Network, linkId: string): { id: string; aligned: boolean }[] {
  const start = linkById(net, linkId);
  if (!start) return [];
  const out = [{ id: start.id, aligned: true }];
  const seen = new Set([start.id]);
  // walk forward from start.to (following links keep the orientation if they leave the joint)
  for (const [first, forward] of [[start.to, true], [start.from, false]] as const) {
    let node = first;
    for (;;) {
      const ls = linksAt(net, node);
      if (ls.length !== 2 || nodeById(net, node)?.junction) break;
      const next = ls.find(l => !seen.has(l.id));
      if (!next) break;
      seen.add(next.id);
      // going forward, an aligned link starts at the joint; going backward, it ends there
      const aligned = forward ? next.from === node : next.to === node;
      out.push({ id: next.id, aligned });
      node = next.from === node ? next.to : next.from;
    }
  }
  return out;
}

/** keep bus stops on a side that still has lanes */
function fixStops(net: Network, linkId: string, flip: boolean): Network {
  const l = linkById(net, linkId);
  if (!l) return net;
  return {
    ...net,
    stops: net.stops.map(s => {
      if (s.link !== linkId) return s;
      let dir = (flip ? -s.dir : s.dir) as 1 | -1;
      if (dir === 1 && l.lanesF === 0) dir = -1;
      if (dir === -1 && l.lanesB === 0) dir = 1;
      return dir === s.dir ? s : { ...s, dir };
    }),
  };
}

/** Reverse the direction of travel on a segment (lanes and bus lanes swap sides). */
export function flipTraffic(net: Network, id: string): Network {
  const l = linkById(net, id);
  if (!l) return net;
  const n2 = updateLink(net, id, { lanesF: l.lanesB, lanesB: l.lanesF, busF: l.busB, busB: l.busF, turnsF: null, turnsB: null, signF: l.signB ?? null, signB: l.signF ?? null, splitF: l.splitB ?? null, splitB: l.splitF ?? null });
  return fixStops(n2, id, true);
}

/** Set lanes as seen along `aligned` (true = the segment's own arrow direction). */
export function setLanes(net: Network, id: string, along: number, against: number, aligned = true): Network {
  const l = linkById(net, id);
  if (!l || along + against === 0) return net;
  const lanesF = aligned ? along : against, lanesB = aligned ? against : along;
  const n2 = updateLink(net, id, { lanesF, lanesB, busF: l.busF && lanesF > 0, busB: l.busB && lanesB > 0, turnsF: lanesF === l.lanesF ? l.turnsF : null, turnsB: lanesB === l.lanesB ? l.turnsB : null });
  return fixStops(n2, id, false);
}

// ---------------------------------------------------------------- coordinated signal groups
export const groupOf = (net: Network, nodeId: string) => net.signalGroups?.find(g => g.members.some(m => m.node === nodeId)) ?? null;

const withGroups = (net: Network, groups: SignalGroup[]): Network => ({ ...net, signalGroups: groups.filter(g => g.members.length) });

/** Puts a junction in a group (leaving any other group); creates the group when `groupId` is null. */
export function joinGroup(net: Network, nodeId: string, groupId: string | null): [Network, string] {
  const groups = (net.signalGroups ?? []).map(g => ({ ...g, members: g.members.filter(m => m.node !== nodeId) }));
  const member = { node: nodeId, offset: 0, phase: 0, share: 0.5 };
  let id = groupId;
  if (id && groups.some(g => g.id === id)) {
    return [withGroups(net, groups.map(g => (g.id === id ? { ...g, members: [...g.members, member] } : g))), id];
  }
  id = newId("g");
  const n = (net.signalGroups?.length ?? 0) + 1;
  return [withGroups(net, [...groups, { id, name: `Signal group ${n}`, cycle: 90, speed: 50, members: [member] }]), id];
}

export function leaveGroup(net: Network, nodeId: string): Network {
  return withGroups(net, (net.signalGroups ?? []).map(g => ({ ...g, members: g.members.filter(m => m.node !== nodeId) })));
}

export function updateGroup(net: Network, id: string, patch: Partial<Omit<SignalGroup, "id" | "members">>): Network {
  return withGroups(net, (net.signalGroups ?? []).map(g => (g.id === id ? { ...g, ...patch } : g)));
}

export function updateMember(net: Network, nodeId: string, patch: Partial<Omit<SignalGroupMember, "node">>): Network {
  return withGroups(net, (net.signalGroups ?? []).map(g => ({ ...g, members: g.members.map(m => (m.node === nodeId ? { ...m, ...patch } : m)) })));
}

/** Moves a junction one place up (-1) or down (+1) in its group's corridor order. */
export function moveMember(net: Network, nodeId: string, dir: -1 | 1): Network {
  return withGroups(net, (net.signalGroups ?? []).map(g => {
    const i = g.members.findIndex(m => m.node === nodeId), j = i + dir;
    if (i < 0 || j < 0 || j >= g.members.length) return g;
    const members = [...g.members]; [members[i], members[j]] = [members[j], members[i]];
    return { ...g, members };
  }));
}

export function deleteGroup(net: Network, id: string): Network {
  return withGroups(net, (net.signalGroups ?? []).filter(g => g.id !== id));
}

/** Sets every member's offset from the travel time between junctions (see engine/signals.ts). */
export function applyGreenWave(net: Network, compiled: Compiled, id: string): Network {
  const g = net.signalGroups?.find(x => x.id === id);
  if (!g) return net;
  const { offsets } = greenWaveOffsets(compiled, g);
  return withGroups(net, (net.signalGroups ?? []).map(x => (x.id === id ? { ...x, members: x.members.map((m, i) => ({ ...m, offset: offsets[i] })) } : x)));
}
