/** Pure network edit operations. Each returns a new Network (never mutates). */
import { newId, makeNode } from "@/engine/sample";
import { MAX_PHASES, type BuildingDef, type LineDef, type LinkDef, type Network, type NodeDef, type SignalGroup, type SignalGroupMember, type SignalPhase, type StopDef, type Vec } from "@/engine/types";
import type { Compiled } from "@/engine/compile";
import { greenWaveOffsets, withCustomPhases } from "@/engine/signals";

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
  return updateLinkWith(net, id, l => ({ ...l, from: l.to, to: l.from, c1: l.c2, c2: l.c1, lanesF: l.lanesB, lanesB: l.lanesF, busF: l.busB, busB: l.busF, turnsF: l.turnsB ?? null, turnsB: l.turnsF ?? null, signF: l.signB ?? null, signB: l.signF ?? null, splitF: l.splitB ?? null, splitB: l.splitF ?? null, greenF: l.greenB ?? null, greenB: l.greenF ?? null }), true);
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
    first = { ...l, id: newId("l"), to: node.id, c1: p01, c2: p012, turnsF: null, signF: null, splitF: null, greenF: null };
    second = { ...l, id: newId("l"), from: node.id, c1: p123, c2: p23, turnsB: null, signB: null, splitB: null, greenB: null };
    const mid = lerp(p012, p123, t);
    node.x = round(mid.x); node.y = round(mid.y);
  } else {
    first = { ...l, id: newId("l"), to: node.id, turnsF: null, signF: null, splitF: null, greenF: null };
    second = { ...l, id: newId("l"), from: node.id, turnsB: null, signB: null, splitB: null, greenB: null };
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
  const n2 = updateLink(net, id, { lanesF: l.lanesB, lanesB: l.lanesF, busF: l.busB, busB: l.busF, turnsF: null, turnsB: null, signF: l.signB ?? null, signB: l.signF ?? null, splitF: l.splitB ?? null, splitB: l.splitF ?? null, greenF: null, greenB: null });
  return fixStops(n2, id, true);
}

/** Set lanes as seen along `aligned` (true = the segment's own arrow direction). */
export function setLanes(net: Network, id: string, along: number, against: number, aligned = true): Network {
  const l = linkById(net, id);
  if (!l || along + against === 0) return net;
  const lanesF = aligned ? along : against, lanesB = aligned ? against : along;
  const n2 = updateLink(net, id, {
    lanesF, lanesB, busF: l.busF && lanesF > 0, busB: l.busB && lanesB > 0, turnsF: lanesF === l.lanesF ? l.turnsF : null, turnsB: lanesB === l.lanesB ? l.turnsB : null,
    greenF: resizeGreens(l.greenF, lanesF), greenB: resizeGreens(l.greenB, lanesB),
  });
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

// ---------------------------------------------------------------- buildings
export function updateBuilding(net: Network, id: string, patch: Partial<BuildingDef>): Network {
  return { ...net, buildings: (net.buildings ?? []).map(b => (b.id === id ? { ...b, ...patch } : b)) };
}
export function deleteBuilding(net: Network, id: string): Network {
  return { ...net, buildings: (net.buildings ?? []).filter(b => b.id !== id) };
}

// ---------------------------------------------------------------- merging an imported area
export interface MergeReport { roads: number; buildings: number; joined: number; skippedRoads: number; skippedBuildings: number }

/**
 * Adds an imported network (in the same coordinates) to a plan. Roads that run over existing
 * ones are skipped, junctions that coincide with existing nodes are merged into them, and entry
 * roads that meet existing entry roads (neighbouring imports) are joined up. Buildings already in
 * the plan (same OpenStreetMap id) are skipped.
 */
export function mergeNetwork(net: Network, add: Network): [Network, MergeReport] {
  const byId = new Map(net.nodes.map(n => [n.id, n]));
  // existing road centrelines sampled every ~4 m, bucketed on a 10 m grid
  const CELL = 10, grid = new Map<string, Vec[]>();
  const put = (p: Vec) => { const k = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`; let c = grid.get(k); if (!c) grid.set(k, (c = [])); c.push(p); };
  const near = (p: Vec, r: number) => {
    const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL), k = Math.ceil(r / CELL);
    for (let dx = -k; dx <= k; dx++) for (let dy = -k; dy <= k; dy++) for (const q of grid.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(q.x - p.x, q.y - p.y) <= r) return true;
    return false;
  };
  for (const l of net.links) {
    const A = byId.get(l.from), B = byId.get(l.to);
    if (!A || !B) continue;
    const n = Math.max(2, Math.ceil(linkLength(l, A, B) / 4));
    for (let k = 0; k <= n; k++) put(linkPoint(l, A, B, k / n));
  }
  const degree = (links: LinkDef[]) => { const d = new Map<string, number>(); for (const l of links) { d.set(l.from, (d.get(l.from) ?? 0) + 1); d.set(l.to, (d.get(l.to) ?? 0) + 1); } return d; };
  const oldDeg = degree(net.links);
  const addById = new Map(add.nodes.map(n => [n.id, n]));
  const addDeg = degree(add.links);

  // new junctions / ends sitting on existing nodes become those nodes
  const remap = new Map<string, string>();
  for (const n of add.nodes) {
    let best: NodeDef | null = null, bd = 6;
    for (const o of net.nodes) { const d = Math.hypot(o.x - n.x, o.y - n.y); if (d < bd) { bd = d; best = o; } }
    if (best) remap.set(n.id, best.id);
  }
  const existingPairs = new Set(net.links.map(l => [l.from, l.to].sort().join("|")));
  const kept: LinkDef[] = [], skipped: LinkDef[] = [];
  let skippedRoads = 0;
  for (const l of add.links) {
    const a = remap.get(l.from) ?? l.from, b = remap.get(l.to) ?? l.to;
    if (a === b || existingPairs.has([a, b].sort().join("|"))) { skippedRoads++; continue; }
    const A = addById.get(l.from)!, B = addById.get(l.to)!;
    let on = 0;
    for (let k = 1; k <= 5; k++) if (near(linkPoint(l, A, B, k / 6), 5)) on++;
    if (on >= 4) { skippedRoads++; skipped.push(l); continue; }
    kept.push(l);
  }

  // entry roads of the new area that continue an entry road of the plan (a neighbouring import):
  // the two roads point at each other along the same line, across a gap or an overlap of the frames
  const outward = (n: NodeDef, l: LinkDef, nodeOf: (id: string) => NodeDef | undefined): Vec | null => {
    const inner = l.from === n.id ? (l.c1 ?? nodeOf(l.to)) : (l.c2 ?? nodeOf(l.from));
    if (!inner) return null;
    const dx = n.x - inner.x, dy = n.y - inner.y, m = Math.hypot(dx, dy);
    return m > 1e-6 ? { x: dx / m, y: dy / m } : null;
  };
  const keptDeg = degree(kept);
  const oldEnds = net.nodes.filter(n => oldDeg.get(n.id) === 1).map(n => {
    const l = net.links.find(x => x.from === n.id || x.to === n.id)!;
    return { n, dir: outward(n, l, id => byId.get(id)) };
  }).filter((e): e is { n: NodeDef; dir: Vec } => !!e.dir);
  const pairs: { end: string; to: NodeDef; score: number }[] = [];
  for (const l of kept) for (const end of [l.from, l.to]) {
    const N = addById.get(end);
    // an entry road of the new area, or a road cut short because its continuation was a duplicate
    if (!N || remap.has(end) || keptDeg.get(end) !== 1 || (N.gateway ? addDeg.get(end) !== 1 : (addDeg.get(end) ?? 0) < 2)) continue;
    const dN = outward(N, l, id => addById.get(id));
    if (!dN) continue;
    for (const E of oldEnds) {
      if (dN.x * E.dir.x + dN.y * E.dir.y > -0.8) continue; // not facing each other
      const ex = E.n.x - N.x, ey = E.n.y - N.y;
      const t = ex * dN.x + ey * dN.y, off = Math.abs(ex * dN.y - ey * dN.x);
      if (t < -60 || t > 150 || off > 4 + 0.12 * Math.abs(t)) continue;
      pairs.push({ end, to: E.n, score: off + 0.1 * Math.abs(t) });
    }
  }
  const taken = new Set<string>();
  let joined = [...remap].filter(([nid, oid]) => addDeg.get(nid) === 1 && oldDeg.get(oid) === 1).length;
  // where the ends overlap, the joint moves to a point inside both roads so neither doubles back
  const moved = new Map<string, Vec>();
  const within = (p: Vec, from: Vec, to: Vec) => { const dx = to.x - from.x, dy = to.y - from.y, t = ((p.x - from.x) * dx + (p.y - from.y) * dy) / (dx * dx + dy * dy || 1); return t > 0 && t < 1; };
  for (const p of pairs.sort((a, b) => a.score - b.score)) {
    if (remap.has(p.end) || taken.has(p.to.id)) continue;
    remap.set(p.end, p.to.id); taken.add(p.to.id); joined++;
    const N = addById.get(p.end)!, E = p.to;
    const nl = kept.find(l => l.from === N.id || l.to === N.id)!, ol = net.links.find(l => l.from === E.id || l.to === E.id)!;
    const nIn = addById.get(nl.from === N.id ? nl.to : nl.from)!, oIn = byId.get(ol.from === E.id ? ol.to : ol.from)!;
    // E beyond the new road's inner end or N beyond the old road's: an overlap to trim
    if (within(E, nIn, N)) continue; // E lies on the new road: joining there is clean
    if (within(N, oIn, E)) moved.set(E.id, { x: N.x, y: N.y }); // the old end reaches past N: pull it back to N
  }

  // an entry road of the plan that runs along a skipped (duplicate) road: bridge to that road's far end
  const bridges: LinkDef[] = [];
  const usedByKept = new Set(kept.flatMap(l => [remap.get(l.from) ?? l.from, remap.get(l.to) ?? l.to]));
  for (const E of oldEnds) {
    if (taken.has(E.n.id)) continue;
    for (const l of skipped) {
      const A = addById.get(l.from)!, B = addById.get(l.to)!;
      let on = false;
      for (let k = 0; k <= 12 && !on; k++) { const q = linkPoint(l, A, B, k / 12); on = Math.hypot(q.x - E.n.x, q.y - E.n.y) < 5; }
      if (!on) continue;
      const target = (X: NodeDef) => remap.get(X.id) ?? X.id;
      const ahead = [A, B].filter(X => (X.x - E.n.x) * E.dir.x + (X.y - E.n.y) * E.dir.y > 1 && target(X) !== E.n.id && usedByKept.has(target(X)));
      if (ahead.length !== 1) continue;
      const X = ahead[0], to = target(X);
      if (net.links.some(o => (o.from === E.n.id && o.to === to) || (o.to === E.n.id && o.from === to))) continue;
      // same orientation as the skipped road: its "from" side is where E lies when X is its "to"
      bridges.push({ ...l, id: newId("l"), c1: null, c2: null, turnsF: null, turnsB: null, splitF: null, splitB: null, ...(X.id === l.to ? { from: E.n.id, to } : { from: to, to: E.n.id }) });
      taken.add(E.n.id); joined++;
      break;
    }
  }

  const links = [...kept.map(l => {
    const from = remap.get(l.from) ?? l.from, to = remap.get(l.to) ?? l.to;
    return from === l.from && to === l.to ? l : { ...l, from, to };
  }), ...bridges];
  // entry stubs of the plan that now lie along a new road (the new road continues them) are dropped
  const newGrid = new Map<string, Vec[]>();
  const nodeAt = (id: string) => addById.get(id) ?? byId.get(id);
  for (const l of links) {
    const A = nodeAt(l.from), B = nodeAt(l.to);
    if (!A || !B) continue;
    const n = Math.max(2, Math.ceil(linkLength(l, A, B) / 4));
    for (let k = 0; k <= n; k++) { const p = linkPoint(l, A, B, k / n); const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`; let c = newGrid.get(key); if (!c) newGrid.set(key, (c = [])); c.push(p); }
  }
  const nearNew = (p: Vec) => {
    const gx = Math.floor(p.x / CELL), gy = Math.floor(p.y / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const q of newGrid.get(`${gx + dx},${gy + dy}`) ?? []) if (Math.hypot(q.x - p.x, q.y - p.y) <= 5) return true;
    return false;
  };
  const dropOld = new Set<string>();
  for (const E of oldEnds) {
    if (taken.has(E.n.id) || [...remap.values()].includes(E.n.id)) continue;
    const l = net.links.find(x => x.from === E.n.id || x.to === E.n.id)!;
    const A = byId.get(l.from)!, B = byId.get(l.to)!;
    let on = 0;
    for (let k = 1; k <= 5; k++) if (nearNew(linkPoint(l, A, B, k / 6))) on++;
    if (on >= 4) { dropOld.add(l.id); joined++; }
  }

  const used = new Set(links.flatMap(l => [l.from, l.to]));
  const nodes = add.nodes.filter(n => used.has(n.id) && !remap.has(n.id));
  // existing ends that got joined are no longer entry points
  const oldNodes = net.nodes.map(n => (taken.has(n.id) ? { ...n, ...moved.get(n.id), gateway: false } : n));

  const have = new Set((net.buildings ?? []).map(b => b.id));
  const newBuildings = (add.buildings ?? []).filter(b => !have.has(b.id));
  const merged: Network = pruneRefs({
    ...net,
    nodes: [...oldNodes, ...nodes],
    links: [...net.links.filter(l => !dropOld.has(l.id)), ...links],
    ...(newBuildings.length || net.buildings ? { buildings: [...(net.buildings ?? []), ...newBuildings] } : {}),
    geo: net.geo ? { ...net.geo, areas: [...(net.geo.areas ?? []), ...(add.geo?.areas ?? [])] } : add.geo ?? null,
  });
  return [merged, {
    roads: links.length, buildings: newBuildings.length, joined,
    skippedRoads, skippedBuildings: (add.buildings?.length ?? 0) - newBuildings.length,
  }];
}

// ---------------------------------------------------------------- custom traffic light phases
// A junction with custom lights lists its phases (NodeDef.phases); each road arriving there says,
// per lane, in which of those phases it has green (LinkDef.greenF / greenB).

/** roads arriving at a node: the link, the direction that arrives, and its lanes */
export function approachesTo(net: Network, nodeId: string): { link: LinkDef; dir: 1 | -1; lanes: number }[] {
  const out: { link: LinkDef; dir: 1 | -1; lanes: number }[] = [];
  for (const l of net.links) {
    if (l.to === nodeId && l.lanesF > 0) out.push({ link: l, dir: 1, lanes: l.lanesF });
    if (l.from === nodeId && l.lanesB > 0) out.push({ link: l, dir: -1, lanes: l.lanesB });
  }
  return out;
}

/** a lane-count change keeps each lane's phases; new lanes take those of the nearest existing lane */
export function resizeGreens(g: number[][] | null | undefined, lanes: number): number[][] | null {
  if (!g?.length || lanes <= 0) return null;
  return Array.from({ length: lanes }, (_, i) => [...g[Math.min(i, g.length - 1)]]);
}

/** rewrite the per-lane phase lists of every road arriving at a node */
function mapGreens(net: Network, nodeId: string, f: (phases: number[]) => number[]): LinkDef[] {
  return net.links.map(l => {
    const toHere = l.to === nodeId && l.greenF, fromHere = l.from === nodeId && l.greenB;
    if (!toHere && !fromHere) return l;
    return {
      ...l,
      ...(toHere ? { greenF: l.greenF!.map(ps => f(ps)) } : {}),
      ...(fromHere ? { greenB: l.greenB!.map(ps => f(ps)) } : {}),
    };
  });
}

/** signal-group members of a node: remap the coordinated phase index */
function mapGroupPhase(net: Network, nodeId: string, f: (p: number) => number): Network["signalGroups"] {
  return net.signalGroups?.map(g => ({ ...g, members: g.members.map(m => (m.node === nodeId ? { ...m, phase: Math.max(0, f(m.phase)) } : m)) }));
}

/** Switch a junction to custom phases, starting from the ones it runs automatically. */
export const customizePhases = (net: Network, compiled: Compiled, nodeId: string): Network => withCustomPhases(net, compiled, nodeId);

/** Back to automatic phases (the per-lane settings on the arriving roads are cleared). */
export function resetPhases(net: Network, nodeId: string): Network {
  return {
    ...net,
    nodes: net.nodes.map(n => (n.id === nodeId ? { ...n, phases: null } : n)),
    links: net.links.map(l => (l.to === nodeId && l.greenF) || (l.from === nodeId && l.greenB) ? { ...l, ...(l.to === nodeId ? { greenF: null } : {}), ...(l.from === nodeId ? { greenB: null } : {}) } : l),
    signalGroups: mapGroupPhase(net, nodeId, () => 0),
  };
}

const phasesOf = (net: Network, nodeId: string) => nodeById(net, nodeId)?.phases ?? [];
const withPhases = (net: Network, nodeId: string, phases: SignalPhase[]): Network => ({ ...net, nodes: net.nodes.map(n => (n.id === nodeId ? { ...n, phases } : n)) });

export function addPhase(net: Network, nodeId: string): Network {
  const ps = phasesOf(net, nodeId), n = nodeById(net, nodeId);
  if (!n || ps.length >= MAX_PHASES) return net;
  return withPhases(net, nodeId, [...ps, { green: n.signal.green }]);
}

export function updatePhase(net: Network, nodeId: string, p: number, patch: Partial<SignalPhase>): Network {
  return withPhases(net, nodeId, phasesOf(net, nodeId).map((x, i) => (i === p ? { ...x, ...patch } : x)));
}

/** Remove a phase (at least two stay); lanes and signal groups are renumbered. */
export function deletePhase(net: Network, nodeId: string, p: number): Network {
  const ps = phasesOf(net, nodeId);
  if (ps.length <= 2 || p < 0 || p >= ps.length) return net;
  const re = (i: number) => (i > p ? i - 1 : i);
  return {
    ...withPhases(net, nodeId, ps.filter((_, i) => i !== p)),
    links: mapGreens(net, nodeId, list => list.filter(i => i !== p).map(re)),
    signalGroups: mapGroupPhase(net, nodeId, i => (i === p ? 0 : re(i))),
  };
}

/** Move a phase earlier (-1) or later (+1) in the sequence. */
export function movePhase(net: Network, nodeId: string, p: number, d: -1 | 1): Network {
  const ps = phasesOf(net, nodeId), q = p + d;
  if (q < 0 || q >= ps.length) return net;
  const swap = (i: number) => (i === p ? q : i === q ? p : i);
  const next = ps.slice(); [next[p], next[q]] = [next[q], next[p]];
  return {
    ...withPhases(net, nodeId, next),
    links: mapGreens(net, nodeId, list => list.map(swap).sort((a, b) => a - b)),
    signalGroups: mapGroupPhase(net, nodeId, swap),
  };
}

/** Give (or take away) green for one lane of an arriving road in one phase. */
export function setLaneGreen(net: Network, linkId: string, dir: 1 | -1, lane: number, phase: number, on: boolean): Network {
  return updateLinkWith(net, linkId, l => {
    const lanes = dir === 1 ? l.lanesF : l.lanesB;
    const cur = (dir === 1 ? l.greenF : l.greenB) ?? [];
    const g = Array.from({ length: lanes }, (_, i) => [...(cur[i] ?? [])]);
    if (lane < 0 || lane >= lanes) return l;
    g[lane] = on ? [...new Set([...g[lane], phase])].sort((a, b) => a - b) : g[lane].filter(x => x !== phase);
    return dir === 1 ? { ...l, greenF: g } : { ...l, greenB: g };
  });
}
