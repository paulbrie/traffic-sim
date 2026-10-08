/** Pure network edit operations. Each returns a new Network (never mutates). */
import { newId, makeNode } from "@/engine/sample";
import { MAX_PHASES, lanesAtLine, type Bays, type BuildingDef, type FlowDef, type ZoneDef, type ZoneFlowDef, type LineDef, type LinkDef, type Network, type ReversibleDef, type NodeDef, type SignalGroup, type SignalGroupMember, type SignalPhase, type StopDef, type Vec, type ConnShape, type LaneTargets, type MarkerDef, type CrossingDef, type ParkingDef, type OutlinePoint } from "@/engine/types";
import { connShapeKey, exitLanesOf, laneAllowed, linkExtent, type Compiled } from "@/engine/compile";
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

/**
 * Set the hand-made lane connections of one turn at a node ("inLink:dir>outLink:dir"): per incoming
 * lane the outgoing lane it feeds, or null for none. `null` for the whole turn goes back to automatic.
 */
export function setLaneMap(net: Network, nodeId: string, key: string, lanes: LaneTargets[] | null): Network {
  const n = nodeById(net, nodeId);
  if (!n) return net;
  const next = { ...(n.laneMap ?? {}) };
  if (lanes) next[key] = lanes; else delete next[key];
  return updateNode(net, nodeId, { laneMap: Object.keys(next).length ? next : undefined });
}

/**
 * At node `nodeId`, rewrite what refers to roads by edge key ("link:dir"): its connectors, closed roads, and
 * lane connections and curves set by hand. `f` gives the new key, or null to drop what refers to it.
 */
export function remapEdgeKeys(net: Network, nodeId: string, f: (key: string) => string | null): Network {
  const n = nodeById(net, nodeId);
  if (!n || !(n.connectors || n.closed || n.laneMap || n.connShape || n.phases?.some(p => p.conns?.length))) return net;
  const g = (k: string) => f(k);
  const patch: Partial<NodeDef> = {};
  if (n.connectors) patch.connectors = n.connectors.flatMap(c => { const i = g(c.in), o = g(c.out); return i && o ? [{ ...c, in: i, out: o }] : []; });
  if (n.closed) { const cl = n.closed.map(g).filter((k): k is string => !!k); patch.closed = cl.length ? cl : undefined; }
  if (n.laneMap) {
    const m: NonNullable<NodeDef["laneMap"]> = {};
    for (const [k, v] of Object.entries(n.laneMap)) { const [a, b] = k.split(">").map(g); if (a && b) m[`${a}>${b}`] = v; }
    patch.laneMap = Object.keys(m).length ? m : undefined;
  }
  if (n.connShape) {
    const m: NonNullable<NodeDef["connShape"]> = {};
    for (const [k, v] of Object.entries(n.connShape)) {
      const [x, y] = k.split(">"), [ka, la] = x.split("|"), [kb, lb] = y.split("|"), a = g(ka), b = g(kb);
      if (a && b) m[`${a}|${la}>${b}|${lb}`] = v;
    }
    patch.connShape = Object.keys(m).length ? m : undefined;
  }
  // (lights per connector: the connectors each phase lists)
  if (n.phases?.some(p => p.conns?.length)) patch.phases = n.phases.map(p => {
    if (!p.conns) return p;
    const conns = p.conns.flatMap(k => {
      const [x, y] = k.split(">"), [ka, la] = x.split("|"), [kb, lb] = y.split("|"), a = g(ka), b = g(kb);
      return a && b ? [`${a}|${la}>${b}|${lb}`] : [];
    });
    return { ...p, conns };
  });
  return updateNode(net, nodeId, patch);
}
/** the same at both ends of link `id`, for keys of that link (`f` gets the node and the direction) */
function remapLink(net: Network, id: string, f: (node: string, dir: 1 | -1) => string | null, ends?: [string, string]): Network {
  const l = linkById(net, id);
  const [A, B] = ends ?? (l ? [l.from, l.to] : ["", ""]);
  for (const end of new Set([A, B])) {
    if (!end) continue;
    // (a junction drawn by hand keeps its connectors and phases on any of its points, the lights on its lead)
    const j = net.junctions?.find(x => x.nodes.includes(end));
    for (const node of j ? j.nodes : [end]) {
      net = remapEdgeKeys(net, node, k => {
        const [lid, d] = k.split(":");
        return lid === id ? f(end, Number(d) as 1 | -1) : k;
      });
    }
  }
  return net;
}

/** Set (or with null, clear) the hand-made shape of one lane connector at a node: its two handle lengths. */
export function setConnShape(net: Network, nodeId: string, key: string, reach: ConnShape | null): Network {
  const n = nodeById(net, nodeId);
  if (!n) return net;
  const next = { ...(n.connShape ?? {}) };
  if (!reach) delete next[key];
  else next[key] = Array.isArray(reach) ? [round(reach[0]), round(reach[1])] : { c1: { x: round(reach.c1.x), y: round(reach.c1.y) }, c2: { x: round(reach.c2.x), y: round(reach.c2.y) } };
  return updateNode(net, nodeId, { connShape: Object.keys(next).length ? next : undefined });
}

/** Set (or with null, clear) a junction's hand-drawn outline: points relative to the node. */
export function setOutline(net: Network, nodeId: string, pts: OutlinePoint[] | null): Network {
  return updateNode(net, nodeId, { outline: pts && pts.length >= 3 ? pts.map(p => ({ x: round(p.x), y: round(p.y), ...(p.round ? { round: true } : {}) })) : undefined });
}
/** Add a painted area (hatched or a kerbed island) to a junction; points relative to the node. */
export function addPaint(net: Network, nodeId: string, kind: "hatch" | "island", pts: Vec[]): Network {
  const n = nodeById(net, nodeId);
  if (!n || pts.length < 3) return net;
  return updateNode(net, nodeId, { paint: [...(n.paint ?? []), { kind, pts: pts.map(p => ({ x: round(p.x), y: round(p.y) })) }] });
}
export function removePaint(net: Network, nodeId: string, index: number): Network {
  const n = nodeById(net, nodeId);
  if (!n?.paint) return net;
  const next = n.paint.filter((_, i) => i !== index);
  return updateNode(net, nodeId, { paint: next.length ? next : undefined });
}

/** Move a node; curve handles of attached links move along so curves keep their shape. */
export function moveNode(net: Network, id: string, p: Vec): Network {
  const n = nodeById(net, id);
  if (!n) return net;
  const dx = round(p.x) - n.x, dy = round(p.y) - n.y;
  if (!dx && !dy) return net;
  // (the leading road end of a junction drawn by hand: its outline, relative to it, stays where it is)
  const leads = !!n.outline && !!net.junctions?.some(j => j.nodes[0] === id);
  return {
    ...net,
    nodes: net.nodes.map(m => (m.id === id ? { ...m, x: m.x + dx, y: m.y + dy, ...(leads ? { outline: m.outline!.map(q => ({ x: round(q.x - dx), y: round(q.y - dy) })) } : {}) } : m)),
    links: net.links.map(l => {
      if (!l.c1 || !l.c2) return l;
      if (l.from === id) return { ...l, c1: { x: l.c1.x + dx, y: l.c1.y + dy } };
      if (l.to === id) return { ...l, c2: { x: l.c2.x + dx, y: l.c2.y + dy } };
      return l;
    }),
  };
}

/** how far back from a deleted junction its roads' loose ends are left (m) */
const DETACH = 4;

/**
 * Delete a point. Its roads stay: at a junction each keeps a loose end of its own (an entry / exit point) a
 * few metres back from where the junction was; at a plain point between two roads they become one road
 * where they can (or are parted like a junction's). A road's own loose end goes with that road.
 */
export function deleteNode(net: Network, id: string): Network {
  const nd = nodeById(net, id), attached = net.links.filter(l => l.from === id || l.to === id);
  // (a loose end, or nothing on it: the point goes with its road; pruneRefs takes it out, and hands on what
  // it held for a junction)
  if (!nd || attached.length <= 1) return pruneRefs({ ...net, links: net.links.filter(l => l.from !== id && l.to !== id) });
  if (attached.length === 2 && !nd.junction && attached[0].id !== attached[1].id) {
    const merged = mergeLinks(net, attached.map(l => l.id));
    if (!("error" in merged) && merged.err < 1) return merged.net;
  }
  for (const { id: lid } of attached) {
    const l = linkById(net, lid);
    if (!l) continue;
    if (l.from === id && l.to === id) { net = deleteLink(net, l.id); continue; }
    const A = nodeById(net, l.from)!, B = nodeById(net, l.to)!, len = linkLength(l, A, B), atStart = l.from === id;
    const back = Math.min(DETACH, len * 0.25), t = tAt(l, A, B, atStart ? back : len - back);
    if (back < 0.5 || t <= 0.001 || t >= 0.999) {
      // (too short to shorten: its own end, where the point was)
      const end = makeNode(nd.x, nd.y);
      net = { ...net, nodes: [...net.nodes, end], links: net.links.map(x => (x.id === l.id ? { ...x, ...(atStart ? { from: end.id } : { to: end.id }) } : x)) };
      continue;
    }
    // cut it a little way back and drop the piece reaching the point
    const [cut, mid] = splitLink(net, l.id, t, linkPoint(l, A, B, t));
    net = cut;
    const stub = net.links.find(x => (x.from === id && x.to === mid.id) || (x.from === mid.id && x.to === id));
    if (stub) net = { ...net, links: net.links.filter(x => x.id !== stub.id) };
  }
  return pruneRefs({ ...net, links: net.links.filter(l => l.from !== id && l.to !== id) });
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
  net = remapLink(net, id, () => null);
  return pruneRefs({ ...net, links: net.links.filter(l => l.id !== id) });
}

/** Swap the drawing direction of a link (keeps traffic as it is on the ground). */
export function reverseLink(net: Network, id: string): Network {
  // (its directions swap names: "id:1" is now the other way)
  net = remapLink(net, id, (_, d) => `${id}:${-d}`);
  // (rows of bays reached from it: still from the same traffic, now the other direction by name)
  if (net.parking?.some(p => p.link === id)) net = { ...net, parking: net.parking.map(p => (p.link === id ? { ...p, dir: (p.dir === 1 ? -1 : 1) as 1 | -1 } : p)) };
  return updateLinkWith(net, id, l => ({ ...l, from: l.to, to: l.from, c1: l.c2, c2: l.c1, lanesF: l.lanesB, lanesB: l.lanesF, busF: l.busB, busB: l.busF, turnsF: l.turnsB ?? null, turnsB: l.turnsF ?? null, signF: l.signB ?? null, signB: l.signF ?? null, splitF: l.splitB ?? null, splitB: l.splitF ?? null, greenF: l.greenB ?? null, greenB: l.greenF ?? null, baysF: l.baysB ?? null, baysB: l.baysF ?? null, dropF: l.dropB ?? null, dropB: l.dropF ?? null }), true);
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
    first = { ...l, id: newId("l"), to: node.id, c1: p01, c2: p012, turnsF: null, signF: null, splitF: null, greenF: null, baysF: null, dropF: null };
    second = { ...l, id: newId("l"), from: node.id, c1: p123, c2: p23, turnsB: null, signB: null, splitB: null, greenB: null, baysB: null, dropB: null };
    const mid = lerp(p012, p123, t);
    node.x = round(mid.x); node.y = round(mid.y);
  } else {
    first = { ...l, id: newId("l"), to: node.id, turnsF: null, signF: null, splitF: null, greenF: null, baysF: null, dropF: null };
    second = { ...l, id: newId("l"), from: node.id, turnsB: null, signB: null, splitB: null, greenB: null, baysB: null, dropB: null };
  }
  const stops = net.stops.map(s => {
    if (s.link !== id) return s;
    return s.pos <= t ? { ...s, link: first.id, pos: s.pos / Math.max(1e-6, t) } : { ...s, link: second.id, pos: (s.pos - t) / Math.max(1e-6, 1 - t) };
  });
  // the junctions at its ends now meet the piece on their side
  net = remapLink(net, id, (end, d) => `${end === l.from ? first.id : second.id}:${d}`, [l.from, l.to]);
  // rows of parking bays reached from it: from the piece nearer them
  const parking = net.parking?.map(p => {
    if (p.link !== id) return p;
    const mid = { x: (p.line.a.x + p.line.b.x) / 2, y: (p.line.a.y + p.line.b.y) / 2 };
    return { ...p, link: nearestT(l, A, B, mid).t < t ? first.id : second.id };
  });
  const groups = net.groups?.map(g => (g.links.includes(id) ? { ...g, links: g.links.flatMap(x => (x === id ? [first.id, second.id] : [x])) } : g));
  return [{ ...net, nodes: [...net.nodes, node], links: [...net.links.filter(x => x.id !== id), first, second], stops, ...(parking ? { parking } : {}), ...(groups ? { groups } : {}) }, node];
}

/** Merge a node into another (used when a drawn road ends on an existing node). */
export function mergeNodes(net: Network, keep: string, drop: string): Network {
  if (keep === drop) return net;
  const links = net.links
    .map(l => ({ ...l, from: l.from === drop ? keep : l.from, to: l.to === drop ? keep : l.to }))
    .filter(l => l.from !== l.to);
  // flows follow the merged node (and are dropped if both ends end up the same)
  const flows = net.flows?.map(f => ({ ...f, from: f.from === drop ? keep : f.from, to: f.to === drop ? keep : f.to })).filter(f => f.from !== f.to);
  return pruneRefs({ ...net, nodes: net.nodes.filter(n => n.id !== drop), links, ...(flows ? { flows } : {}) });
}

// ---------------------------------------------------------------- zebra crossings drawn by hand, rows of parking bays
export function addCrossing(net: Network, a: Vec, b: Vec): [Network, CrossingDef] {
  const x: CrossingDef = { id: newId("x"), a: { x: round(a.x), y: round(a.y) }, b: { x: round(b.x), y: round(b.y) }, width: 4, peds: 300 };
  return [{ ...net, crossings: [...(net.crossings ?? []), x] }, x];
}
export function updateCrossing(net: Network, id: string, patch: Partial<CrossingDef>): Network {
  return { ...net, crossings: (net.crossings ?? []).map(x => (x.id === id ? { ...x, ...patch } : x)) };
}
export function deleteCrossing(net: Network, id: string): Network {
  const rest = (net.crossings ?? []).filter(x => x.id !== id);
  return { ...net, crossings: rest.length ? rest : undefined };
}
/** a row of bays standing on its own: opening along a → b, bays on `side` of it, reached from direction `dir` of road `link` */
export function addFreeParking(net: Network, link: string, dir: 1 | -1, a: Vec, b: Vec, side: 1 | -1, kind: ParkingDef["kind"] = "perpendicular"): [Network, ParkingDef] {
  const p: ParkingDef = { id: newId("pk"), link, dir, kind, line: { a: { x: round(a.x), y: round(a.y) }, b: { x: round(b.x), y: round(b.y) }, side } };
  return [{ ...net, parking: [...(net.parking ?? []), p] }, p];
}
export function updateParking(net: Network, id: string, patch: Partial<ParkingDef>): Network {
  return { ...net, parking: (net.parking ?? []).map(x => (x.id === id ? { ...x, ...patch } : x)) };
}
export function deleteParking(net: Network, id: string): Network {
  const rest = (net.parking ?? []).filter(x => x.id !== id);
  return { ...net, parking: rest.length ? rest : undefined };
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
  let nodes = net.nodes.filter(n => used.has(n.id));
  const nodeIds = new Set(nodes.map(n => n.id));
  const groups = net.signalGroups?.map(g => ({ ...g, members: g.members.filter(m => nodeIds.has(m.node)) })).filter(g => g.members.length);
  const flows = net.flows?.filter(f => nodeIds.has(f.from) && nodeIds.has(f.to));
  const reversibles = net.reversibles?.filter(r => net.links.some(l => l.rev === r.id));
  const parking = net.parking?.filter(p => linkIds.has(p.link));
  const jgroups = net.groups?.map(g => ({ ...g, links: g.links.filter(id => linkIds.has(id)) })).filter(g => g.links.length);
  const ringTags = new Set(net.links.flatMap(l => (l.ring ? [l.ring] : []))), rings = net.rings?.filter(r => ringTags.has(r.id));
  // (junctions drawn by hand keep the road ends still there; the first holds the junction's own settings —
  // control, lights, outline — and hands them on to the next when it goes; one left with a single road end
  // is a junction no more: that end is a loose end again)
  // (one standing on its own, no road joined yet, stays)
  const junctions = net.junctions?.map(j => ({ ...j, nodes: j.nodes.filter(id => nodeIds.has(id)) })).filter(j => j.nodes.length >= 2 || (!j.nodes.length && (j.outline?.length ?? 0) >= 3));
  for (const j of net.junctions ?? []) {
    const left = j.nodes.filter(id => nodeIds.has(id)), was = net.nodes.find(n => n.id === j.nodes[0]);
    if (left.length >= 2 && was && left[0] !== j.nodes[0]) {
      nodes = nodes.map(n => {
        if (n.id !== left[0]) return n;
        const dx = was.x - n.x, dy = was.y - n.y, shift = (p: Vec) => ({ x: round(p.x + dx), y: round(p.y + dy) });
        return { ...n, control: was.control, signal: was.signal, phases: was.phases ?? null,
          outline: was.outline?.map(shift), paint: was.paint?.map(p => ({ ...p, pts: p.pts.map(shift) })) };
      });
    } else if (left.length === 1) {
      nodes = nodes.map(n => (n.id === left[0] ? { ...n, gateway: true, connectors: undefined, closed: undefined, outline: undefined, paint: undefined, phases: null, laneLines: undefined } : n));
    }
  }
  return {
    ...net,
    ...(net.junctions ? { junctions: junctions!.length ? junctions : undefined } : {}),
    ...(net.parking ? { parking: parking!.length ? parking : undefined } : {}),
    ...(net.groups ? { groups: jgroups!.length ? jgroups : undefined } : {}),
    ...(net.rings ? { rings: rings!.length ? rings : undefined } : {}),
    ...(net.reversibles ? { reversibles } : {}),
    nodes,
    stops,
    lines: net.lines.map(l => ({ ...l, stops: l.stops.filter(s => stopIds.has(s)) })),
    ...(net.signalGroups ? { signalGroups: groups } : {}),
    ...(net.flows ? { flows } : {}),
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
  const ls = linksAt(net, nodeId);
  return ls.length === 2 ? smoothPair(net, nodeId, ls[0], ls[1], tension) : net;
}

/**
 * Smooth the join between two roads that meet at a point (a bend point or a junction with other
 * roads too): their curves leave the shared point along one line, so one flows into the other.
 * Returns why not when the roads don't share an end.
 */
export function smoothBetween(net: Network, idA: string, idB: string): Network | { error: string } {
  const a = linkById(net, idA), b = linkById(net, idB);
  if (!a || !b || a.id === b.id) return { error: "Select the two roads to smooth between (Shift+click the second)." };
  const shared = [a.from, a.to].find(n => n === b.from || n === b.to);
  if (!shared) return { error: "The two roads don't meet: pick two roads that share an end." };
  return smoothPair(net, shared, a, b);
}

function smoothPair(net: Network, nodeId: string, la: LinkDef, lb: LinkDef, tension = 1 / 3): Network {
  const N = nodeById(net, nodeId);
  const ls = [la, lb];
  if (!N) return net;
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
  // (traffic runs the other way: its connectors at both ends no longer fit)
  net = remapLink(net, id, () => null);
  const n2 = updateLink(net, id, { lanesF: l.lanesB, lanesB: l.lanesF, busF: l.busB, busB: l.busF, turnsF: null, turnsB: null, signF: l.signB ?? null, signB: l.signF ?? null, splitF: l.splitB ?? null, splitB: l.splitF ?? null, greenF: null, greenB: null, baysF: l.baysB ?? null, baysB: l.baysF ?? null, dropF: l.dropB ?? null, dropB: l.dropF ?? null });
  return fixStops(n2, id, true);
}

/** Set lanes as seen along `aligned` (true = the segment's own arrow direction). */
export function setLanes(net: Network, id: string, along: number, against: number, aligned = true): Network {
  const l = linkById(net, id);
  if (!l || along + against === 0) return net;
  const lanesF = aligned ? along : against, lanesB = aligned ? against : along;
  const next = { ...l, lanesF, lanesB };
  const n2 = updateLink(net, id, {
    lanesF, lanesB, busF: l.busF && lanesF > 0, busB: l.busB && lanesB > 0, turnsF: lanesF === l.lanesF ? l.turnsF : null, turnsB: lanesB === l.lanesB ? l.turnsB : null,
    greenF: resizeGreens(l.greenF, lanesAtLine(next, 1)), greenB: resizeGreens(l.greenB, lanesAtLine(next, -1)),
    ...(lanesF === 0 || lanesB === 0 ? { median: undefined, medianKind: undefined } : {}),
  });
  return fixStops(n2, id, false);
}

/**
 * Set the turn bays of one direction (null = none). Lane numbering at the junction changes, so
 * that direction's lane arrows go back to automatic and its per-lane greens are rebuilt from the
 * nearest lane (a new left bay takes the phases of the old leftmost lane, and so on).
 */
export function setBays(net: Network, id: string, dir: 1 | -1, bays: Bays | null): Network {
  return updateLinkWith(net, id, l => {
    const cur = dir === 1 ? l.baysF : l.baysB;
    const b = bays && bays.left + bays.right > 0 ? bays : null;
    const old = (dir === 1 ? l.greenF : l.greenB) ?? null;
    let greens: number[][] | null = null;
    if (old?.length) {
      const oL = cur?.left ?? 0, thru = dir === 1 ? l.lanesF : l.lanesB, nL = b?.left ?? 0, nR = b?.right ?? 0;
      // map each new lane to the old one in the same place (through lanes keep theirs)
      greens = Array.from({ length: nL + thru + nR }, (_, i) => {
        const j = i < nL ? (oL > 0 ? Math.min(i, oL - 1) : 0) : i < nL + thru ? oL + (i - nL) : oL + thru - 1 + Math.min(i - nL - thru + 1, cur?.right ?? 0);
        return [...(old[Math.min(old.length - 1, Math.max(0, j))] ?? [])];
      });
    }
    return dir === 1 ? { ...l, baysF: b, turnsF: null, greenF: greens } : { ...l, baysB: b, turnsB: null, greenB: greens };
  });
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
    if (l.to === nodeId && l.lanesF > 0) out.push({ link: l, dir: 1, lanes: lanesAtLine(l, 1) });
    if (l.from === nodeId && l.lanesB > 0) out.push({ link: l, dir: -1, lanes: lanesAtLine(l, -1) });
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
  return withPhases(net, nodeId, [...ps, { green: n.signal.green, ...(ps.some(p => p.conns) ? { conns: [] } : {}) }]);
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

/**
 * Lights per connector: the junction's phases as they run now, each listing the connectors green in it (a
 * connector green when its lane is). Connectors of the junction's other nodes without lights of their own are
 * green throughout to start with. The lights of all its nodes then run from `nodeId`.
 */
export function toConnectorPhases(net: Network, compiled: Compiled, nodeId: string): Network {
  const cn = compiled.nodeById.get(nodeId);
  if (!cn || cn.signals.connPhases) return net;
  const k = Math.max(2, cn.phases.length);
  const phases: SignalPhase[] = Array.from({ length: k }, (_, p) => ({
    green: cn.phaseGreen[p] ?? cn.def.signal.green,
    ...(cn.def.phases?.[p]?.minGreen != null ? { minGreen: cn.def.phases[p].minGreen } : {}),
    conns: [],
  }));
  for (const m of cn.cluster) m.arms.forEach((a, arm) => {
    const e = a.inEdge;
    if (!e) return;
    for (const mv of m.moves.get(e.idx) ?? []) for (let lane = 0; lane < e.n; lane++) {
      if (!laneAllowed(mv, lane)) continue;
      const own = m === cn ? m.lanePhases[arm]?.[lane] : null;
      const ps = own && own.length ? own : phases.map((_, p) => p);
      for (const b of exitLanesOf(mv, lane)) for (const p of ps) if (p < k) phases[p].conns!.push(connShapeKey(mv, lane, b));
    }
  });
  const others = new Set(cn.cluster.filter(x => x !== cn).map(x => x.def.id));
  return { ...net, nodes: net.nodes.map(n => (n.id === nodeId ? { ...n, control: "lights" as const, phases } : others.has(n.id) ? { ...n, control: "lights" as const, phases: null } : n)) };
}

/** Lights per connector: give (or take away) green for one connector (key, see connShapeKey) in one phase. */
export function setConnGreen(net: Network, nodeId: string, phase: number, key: string, on: boolean): Network {
  return withPhases(net, nodeId, phasesOf(net, nodeId).map((x, i) => {
    if (i !== phase) return x;
    const cur = x.conns ?? [];
    return { ...x, conns: on ? [...new Set([...cur, key])] : cur.filter(k => k !== key) };
  }));
}

/** Give (or take away) green for one lane of an arriving road in one phase. */
export function setLaneGreen(net: Network, linkId: string, dir: 1 | -1, lane: number, phase: number, on: boolean): Network {
  return updateLinkWith(net, linkId, l => {
    const lanes = lanesAtLine(l, dir);
    const cur = (dir === 1 ? l.greenF : l.greenB) ?? [];
    const g = Array.from({ length: lanes }, (_, i) => [...(cur[i] ?? [])]);
    if (lane < 0 || lane >= lanes) return l;
    g[lane] = on ? [...new Set([...g[lane], phase])].sort((a, b) => a - b) : g[lane].filter(x => x !== phase);
    return dir === 1 ? { ...l, greenF: g } : { ...l, greenB: g };
  });
}

// ---------------------------------------------------------------- transit flows
/** entry points: dead ends where traffic enters and leaves the plan */
export const entryPoints = (net: Network) => {
  const deg = new Map<string, number>();
  for (const l of net.links) for (const k of [l.from, l.to]) deg.set(k, (deg.get(k) ?? 0) + 1);
  return net.nodes.filter(n => n.gateway && deg.get(n.id) === 1);
};

/** A flow from an entry point, to the entry point farthest from it (change it afterwards). */
export function addFlow(net: Network, from: string): [Network, FlowDef | null] {
  const A = nodeById(net, from);
  const others = entryPoints(net).filter(n => n.id !== from);
  if (!A || !others.length) return [net, null];
  const to = others.reduce((a, b) => (Math.hypot(b.x - A.x, b.y - A.y) > Math.hypot(a.x - A.x, a.y - A.y) ? b : a));
  const flow: FlowDef = { id: newId("f"), from, to: to.id, rate: 300 };
  return [{ ...net, flows: [...(net.flows ?? []), flow] }, flow];
}
export function updateFlow(net: Network, id: string, patch: Partial<FlowDef>): Network {
  return { ...net, flows: (net.flows ?? []).map(f => (f.id === id ? { ...f, ...patch } : f)) };
}
export function deleteFlow(net: Network, id: string): Network {
  return { ...net, flows: (net.flows ?? []).filter(f => f.id !== id) };
}

// ---------------------------------------------------------------- zones and zone-to-zone demand
const ZONE_COLORS = ["#2f6fb5", "#b5462f", "#3f8f4e", "#7a4fb0", "#d99800", "#1f8a8a", "#c2417a", "#6b7a1f"];

export function addZone(net: Network, name?: string): [Network, ZoneDef] {
  const zones = net.zones ?? [];
  const zone: ZoneDef = { id: newId("z"), name: name?.trim() || `Zone ${zones.length + 1}`, color: ZONE_COLORS[zones.length % ZONE_COLORS.length], members: [] };
  return [{ ...net, zones: [...zones, zone] }, zone];
}
export function updateZone(net: Network, id: string, patch: Partial<Omit<ZoneDef, "id">>): Network {
  return { ...net, zones: (net.zones ?? []).map(z => (z.id === id ? { ...z, ...patch } : z)) };
}
/** delete a zone and the demand to and from it */
export function deleteZone(net: Network, id: string): Network {
  return { ...net, zones: (net.zones ?? []).filter(z => z.id !== id), zoneFlows: (net.zoneFlows ?? []).filter(f => f.from !== id && f.to !== id) };
}
/** put entry points or buildings in a zone (null = in no zone); each belongs to one zone at most */
export function setZone(net: Network, members: { kind: "entry" | "building"; id: string }[], zoneId: string | null): Network {
  const keys = new Set(members.map(m => `${m.kind}:${m.id}`));
  return {
    ...net,
    zones: (net.zones ?? []).map(z => {
      const rest = z.members.filter(m => !keys.has(`${m.kind}:${m.id}`));
      return z.id === zoneId ? { ...z, members: [...rest, ...members] } : rest.length === z.members.length ? z : { ...z, members: rest };
    }),
  };
}
/** vehicles per hour from one zone to another (0 removes the pair) */
export function setZoneFlow(net: Network, from: string, to: string, rate: number, patch: Partial<ZoneFlowDef> = {}): Network {
  const flows = net.zoneFlows ?? [];
  const cur = flows.find(f => f.from === from && f.to === to);
  if (rate <= 0) return { ...net, zoneFlows: flows.filter(f => f !== cur) };
  if (cur) return { ...net, zoneFlows: flows.map(f => (f === cur ? { ...f, rate, ...patch } : f)) };
  return { ...net, zoneFlows: [...flows, { id: newId("d"), from, to, rate, ...patch }] };
}

// ---------------------------------------------------------------- slip lanes
/** unit direction of travel along the road between nodes a and b, leaving a */
function leaving(net: Network, a: string, b: string): Vec | null {
  const l = net.links.find(x => (x.from === a && x.to === b) || (x.from === b && x.to === a));
  if (!l) return null;
  const A = nodeById(net, l.from)!, B = nodeById(net, l.to)!, fromA = l.from === a;
  const p = linkPoint(l, A, B, fromA ? 0 : 1), q = linkPoint(l, A, B, fromA ? 0.05 : 0.95);
  const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
}

/** parameter along a link at arc length d from its start */
export function tAtLength(l: LinkDef, A: Vec, B: Vec, d: number): number { return tAt(l, A, B, d); }
function tAt(l: LinkDef, A: Vec, B: Vec, d: number): number {
  if (!l.c1 || !l.c2) return Math.max(0, Math.min(1, d / Math.max(1e-6, Math.hypot(B.x - A.x, B.y - A.y))));
  let len = 0, prev = A;
  for (let k = 1; k <= 128; k++) {
    const q = linkPoint(l, A, B, k / 128), step = Math.hypot(q.x - prev.x, q.y - prev.y);
    if (len + step >= d) return (k - 1 + (d - len) / Math.max(1e-6, step)) / 128;
    len += step; prev = q;
  }
  return 1;
}

/**
 * Add a slip lane at a junction: right-turning traffic from road `inLinkId` to road `outLinkId`
 * leaves the approach some way before the junction, curves round the corner on a one-way road of
 * its own and gives way where it joins the exit. Both roads get a new node there (with rounded
 * kerbs); the junction loses that right turn from this approach. Returns the new network, or an
 * explanation when the roads are too short.
 */
export function addSlipLane(net: Network, nodeId: string, inLinkId: string, outLinkId: string): [Network, string | null] {
  const inL = linkById(net, inLinkId), outL = linkById(net, outLinkId), J = nodeById(net, nodeId);
  if (!inL || !outL || !J || inL.id === outL.id) return [net, "Pick two different roads at this junction."];
  const ends = (l: LinkDef) => [nodeById(net, l.from)!, nodeById(net, l.to)!] as const;
  const [iA, iB] = ends(inL), [oA, oB] = ends(outL);
  const lenIn = linkLength(inL, iA, iB), lenOut = linkLength(outL, oA, oB);
  // far enough back for the gore where the slip leaves a wide road
  const half = (l: LinkDef) => Math.max(...linkExtent(l).map(Math.abs));
  const want = Math.min(70, Math.max(32, 24 + 2.2 * Math.max(half(inL), half(outL))));
  const dIn = Math.min(want, lenIn * 0.6), dOut = Math.min(want, lenOut * 0.6);
  if (dIn < 18 || dOut < 18) return [net, "The roads are too short here for a slip lane (it needs about 30 m of each)."];
  const tIn = tAt(inL, iA, iB, inL.to === nodeId ? lenIn - dIn : dIn);
  const [n1, D] = splitLink(net, inL.id, tIn, linkPoint(inL, iA, iB, tIn));
  const tOut = tAt(outL, oA, oB, outL.from === nodeId ? dOut : lenOut - dOut);
  const [n2, M] = splitLink(n1, outL.id, tOut, linkPoint(outL, oA, oB, tOut));
  let n3: Network = { ...n2, nodes: n2.nodes.map(n => (n.id === D.id || n.id === M.id ? { ...n, gateway: false, control: "priority" as const, smooth: true } : n)) };
  // leave and join at 50° to the roads, curving round the corner on their right
  const tIn0 = leaving(n3, D.id, nodeId), tOut1 = leaving(n3, M.id, nodeId);
  if (!tIn0 || !tOut1) return [net, "Could not find the roads after splitting them."];
  const out = { x: -tOut1.x, y: -tOut1.y }; // travel direction on the exit at M
  const a = (50 * Math.PI) / 180, k = 0.42 * Math.hypot(M.x - D.x, M.y - D.y);
  const rIn = { x: -tIn0.y, y: tIn0.x }, rOut = { x: -out.y, y: out.x };
  const c1 = { x: round(D.x + (tIn0.x * Math.cos(a) + rIn.x * Math.sin(a)) * k), y: round(D.y + (tIn0.y * Math.cos(a) + rIn.y * Math.sin(a)) * k) };
  const c2 = { x: round(M.x - (out.x * Math.cos(a) - rOut.x * Math.sin(a)) * k), y: round(M.y - (out.y * Math.cos(a) - rOut.y * Math.sin(a)) * k) };
  const slip: LinkDef = {
    id: newId("l"), name: inL.name ? `${inL.name} slip` : "", from: D.id, to: M.id, c1, c2,
    lanesF: 1, lanesB: 0, busF: false, busB: false, speed: Math.min(40, inL.speed), signF: "yield", slip: nodeId, ...(inL.level ? { level: inL.level } : {}),
  };
  n3 = { ...n3, links: [...n3.links, slip] };
  // right bays on the approach are no use any more
  const toJ = n3.links.find(l => (l.from === D.id && l.to === nodeId) || (l.to === D.id && l.from === nodeId));
  if (toJ) {
    const dir = toJ.to === nodeId ? 1 : -1, b = dir === 1 ? toJ.baysF : toJ.baysB;
    if (b?.right) n3 = setBays(n3, toJ.id, dir, { ...b, right: 0 });
  }
  return [n3, null];
}

// ---------------------------------------------------------------- merging roads
/** a link seen the other way round: from ↔ to, and every per-direction setting swapped */
function reversedView(l: LinkDef): LinkDef {
  return {
    ...l, from: l.to, to: l.from, c1: l.c2, c2: l.c1, lanesF: l.lanesB, lanesB: l.lanesF, busF: l.busB, busB: l.busF,
    turnsF: l.turnsB ?? null, turnsB: l.turnsF ?? null, signF: l.signB ?? null, signB: l.signF ?? null, splitF: l.splitB ?? null, splitB: l.splitF ?? null,
    greenF: l.greenB ?? null, greenB: l.greenF ?? null, baysF: l.baysB ?? null, baysB: l.baysF ?? null, dropF: l.dropB ?? null, dropB: l.dropF ?? null,
  };
}

/** one cubic Bézier through a polyline (chord-length least squares), and how far the polyline strays from it (m) */
function fitOneCurve(pts: Vec[]): { c1: Vec | null; c2: Vec | null; err: number } {
  const n = pts.length, A = pts[0], B = pts[n - 1];
  const dist = (p: Vec, q: Vec) => Math.hypot(p.x - q.x, p.y - q.y);
  const chord = dist(A, B);
  // straight enough: a straight road
  let wd = 0;
  for (const p of pts) {
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2));
    wd = Math.max(wd, Math.hypot(p.x - A.x - dx * t, p.y - A.y - dy * t));
  }
  if (wd < 0.5) return { c1: null, c2: null, err: wd };
  const unit = (p: Vec, q: Vec) => { const d = dist(p, q) || 1; return { x: (q.x - p.x) / d, y: (q.y - p.y) / d }; };
  const t0 = unit(A, pts[1]), t1 = unit(pts[n - 2], B);
  const u = [0];
  for (let k = 1; k < n; k++) u.push(u[k - 1] + dist(pts[k], pts[k - 1]));
  const L = u[n - 1] || 1;
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let k = 0; k < n; k++) {
    const t = u[k] / L, s = 1 - t, b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const a1 = { x: t0.x * b1, y: t0.y * b1 }, a2 = { x: -t1.x * b2, y: -t1.y * b2 };
    const tx = pts[k].x - (A.x * (b0 + b1) + B.x * (b2 + b3)), ty = pts[k].y - (A.y * (b0 + b1) + B.y * (b2 + b3));
    c00 += a1.x * a1.x + a1.y * a1.y; c01 += a1.x * a2.x + a1.y * a2.y; c11 += a2.x * a2.x + a2.y * a2.y;
    x0 += a1.x * tx + a1.y * ty; x1 += a2.x * tx + a2.y * ty;
  }
  const det = c00 * c11 - c01 * c01;
  let al1 = det > 1e-9 ? (x0 * c11 - x1 * c01) / det : chord / 3, al2 = det > 1e-9 ? (c00 * x1 - c01 * x0) / det : chord / 3;
  if (!(al1 > chord * 0.02 && al1 < chord * 2 && al2 > chord * 0.02 && al2 < chord * 2)) al1 = al2 = chord / 3;
  const c1 = { x: round(A.x + t0.x * al1), y: round(A.y + t0.y * al1) }, c2 = { x: round(B.x - t1.x * al2), y: round(B.y - t1.y * al2) };
  const curve: Vec[] = [];
  for (let k = 0; k <= 48; k++) {
    const t = k / 48, s = 1 - t;
    curve.push({ x: s * s * s * A.x + 3 * s * s * t * c1.x + 3 * s * t * t * c2.x + t * t * t * B.x, y: s * s * s * A.y + 3 * s * s * t * c1.y + 3 * s * t * t * c2.y + t * t * t * B.y });
  }
  let err = 0;
  for (const p of pts) err = Math.max(err, Math.min(...curve.map(q => dist(p, q))));
  return { c1, c2, err };
}

/**
 * Merge roads that follow on from each other through plain road points (bend points) into one
 * road: the points between them go, the shape is fitted with one curve, and the settings are the
 * first road's, with the lane arrows, signs, bays and lights of each end kept from the road at that
 * end. Bus stops move onto the merged road. Returns the new network and the merged road's id, or
 * why the roads can't be merged; `err` is how far (m) the new curve strays from the old shape.
 */
export function mergeLinks(net: Network, ids: string[]): { net: Network; id: string; err: number } | { error: string } {
  const set = new Set(ids), links = ids.map(id => linkById(net, id)).filter((l): l is LinkDef => !!l);
  if (links.length < 2) return { error: "Select at least two roads (Shift+click) to merge." };
  // how many selected roads meet at each node
  const deg = new Map<string, number>();
  for (const l of links) for (const n of [l.from, l.to]) deg.set(n, (deg.get(n) ?? 0) + 1);
  const ends = [...deg].filter(([, d]) => d === 1).map(([n]) => n);
  if (ends.length !== 2 || [...deg.values()].some(d => d > 2)) return { error: "The selected roads must follow on from each other in a single line." };
  for (const [n, d] of deg) {
    if (d !== 2) continue;
    const node = nodeById(net, n);
    if (linksAt(net, n).length !== 2 || node?.junction) return { error: "Another road joins in between (a junction there): only plain bend points can be merged away." };
  }
  // walk from one end, turning each road to face the way of travel along the chain
  let at = ends[0];
  const first = links.find(l => l.from === at || l.to === at)!;
  if (first.to === at) at = ends[1];
  const chain: { l: LinkDef; rev: boolean }[] = [];
  const used = new Set<string>();
  for (let guard = 0; guard < links.length; guard++) {
    const l = links.find(x => !used.has(x.id) && (x.from === at || x.to === at));
    if (!l) break;
    used.add(l.id);
    const rev = l.to === at;
    chain.push({ l, rev });
    at = rev ? l.from : l.to;
  }
  if (chain.length !== links.length) return { error: "The selected roads must follow on from each other in a single line." };
  const views = chain.map(x => (x.rev ? reversedView(x.l) : x.l));
  const bad = views.find(v => v.lanesF !== views[0].lanesF || v.lanesB !== views[0].lanesB);
  if (bad) return { error: `The roads have different lanes (${views[0].lanesF}+${views[0].lanesB} and ${bad.lanesF}+${bad.lanesB} on ${bad.id}); make them the same first.` };
  // the shape: points along every road in order, fitted with one curve
  const pts: Vec[] = [], lens: number[] = [];
  for (const v of views) {
    const A = nodeById(net, v.from)!, B = nodeById(net, v.to)!, n = v.c1 ? 24 : 4;
    lens.push(linkLength(v, A, B));
    for (let k = pts.length ? 1 : 0; k <= n; k++) pts.push(linkPoint(v, A, B, k / n));
  }
  const fit = fitOneCurve(pts);
  const head = views[0], tail = views[views.length - 1];
  const merged: LinkDef = {
    ...head, id: newId("l"), name: views.find(v => v.name)?.name ?? "", from: head.from, to: tail.to, c1: fit.c1, c2: fit.c2,
    // each end keeps what was set where it meets its junction
    turnsF: tail.turnsF ?? null, signF: tail.signF ?? null, splitF: tail.splitF ?? null, greenF: tail.greenF ?? null, baysF: tail.baysF ?? null,
    turnsB: head.turnsB ?? null, signB: head.signB ?? null, splitB: head.splitB ?? null, greenB: head.greenB ?? null, baysB: head.baysB ?? null,
    ...(views.some(v => v.counter) ? { counter: true } : {}),
  };
  // bus stops: to the same place along the merged road
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let offset = 0;
  const where = new Map<string, { off: number; len: number; rev: boolean }>();
  chain.forEach((x, i) => { where.set(x.l.id, { off: offset, len: lens[i], rev: x.rev }); offset += lens[i]; });
  const stops = net.stops.map(s => {
    const w = where.get(s.link);
    if (!w) return s;
    const pos = (w.off + (w.rev ? 1 - s.pos : s.pos) * w.len) / total;
    return { ...s, link: merged.id, pos: round(pos * 1000) / 1000, dir: (w.rev ? -s.dir : s.dir) as 1 | -1 };
  });
  // the junctions at its two ends now meet the merged road (a piece drawn the other way had its directions swapped)
  const tips = [{ x: chain[0], node: head.from }, { x: chain[chain.length - 1], node: tail.to }];
  for (const { x, node } of tips) net = remapEdgeKeys(net, node, k => { const [lid, d] = k.split(":"); return lid === x.l.id ? `${merged.id}:${x.rev ? -Number(d) : Number(d)}` : k; });
  const groups = net.groups?.map(g => (g.links.some(x => set.has(x)) ? { ...g, links: [...g.links.filter(x => !set.has(x)), merged.id] } : g));
  return { net: pruneRefs({ ...net, links: [...net.links.filter(l => !set.has(l.id)), merged], stops, ...(groups ? { groups } : {}) }), id: merged.id, err: fit.err };
}

// ---------------------------------------------------------------- reversible middle lanes
/** the outward direction of a road where it leaves node `at` (toward its first control point or far end) */
function leavingDir(net: Network, l: LinkDef, at: string): Vec | null {
  const n = nodeById(net, at), far = nodeById(net, l.from === at ? l.to : l.from);
  if (!n || !far) return null;
  const q = l.c1 && l.c2 ? (l.from === at ? l.c1 : l.c2) : far;
  const dx = q.x - n.x, dy = q.y - n.y, d = Math.hypot(dx, dy);
  return d > 1e-6 ? { x: dx / d, y: dy / d } : null;
}
const twoWay = (l: LinkDef) => l.lanesF > 0 && l.lanesB > 0;
/**
 * The road straight on from `linkId` both ways, through junctions and road joints: two-way roads
 * within 30° of straight on, up to a roundabout, an entry / exit point, or where nothing carries on.
 * In order from one end to the other.
 */
export function straightChain(net: Network, linkId: string): string[] {
  const first = linkById(net, linkId);
  if (!first || !twoWay(first)) return [];
  const seen = new Set([first.id]);
  const walk = (from: LinkDef, node: string): string[] => {
    const out: string[] = [];
    let cur = from, at = node;
    for (let hop = 0; hop < 200; hop++) {
      const nd = nodeById(net, at);
      if (!nd || nd.control === "roundabout") break;
      const back = leavingDir(net, cur, at);
      if (!back) break;
      let best: LinkDef | null = null, bd = -0.866; // straight on = opposite of where we came from
      for (const l of linksAt(net, at)) {
        if (seen.has(l.id) || !twoWay(l) || (l.rev && l.rev !== first.rev)) continue;
        const u = leavingDir(net, l, at);
        if (!u) continue;
        const d = u.x * back.x + u.y * back.y;
        if (d < bd) { bd = d; best = l; }
      }
      if (!best) break;
      seen.add(best.id); out.push(best.id);
      at = best.from === at ? best.to : best.from; cur = best;
    }
    return out;
  };
  const ahead = walk(first, first.to), behind = walk(first, first.from);
  return [...behind.reverse(), first.id, ...ahead];
}
/** a road's settings for (or without) a reversible middle lane: lane numbering at its ends changes */
function withRev(l: LinkDef, rev: string | null): LinkDef {
  const next: LinkDef = { ...l, rev, ...(rev ? { median: undefined, medianKind: undefined, baysF: l.baysF?.right ? { ...l.baysF, left: 0 } : null, baysB: l.baysB?.right ? { ...l.baysB, left: 0 } : null, dropF: l.dropF?.side === "left" ? null : l.dropF ?? null, dropB: l.dropB?.side === "left" ? null : l.dropB ?? null } : {}) };
  return { ...next, turnsF: null, turnsB: null, greenF: resizeGreens(l.greenF, lanesAtLine(next, 1)), greenB: resizeGreens(l.greenB, lanesAtLine(next, -1)) };
}
/**
 * Give a two-way road a reversible middle lane: just this road, or (`whole`) the whole road straight
 * on through its junctions (see straightChain). Direction 1 runs from the chain's first end.
 */
export function addReversible(net: Network, linkId: string, whole: boolean): [Network, ReversibleDef | null] {
  const ids = whole ? straightChain(net, linkId) : linkById(net, linkId) && twoWay(linkById(net, linkId)!) ? [linkId] : [];
  const ls = ids.map(id => linkById(net, id)!).filter(l => !l.rev);
  if (!ls.length) return [net, null];
  // the end the chain starts from: the node of the first road not shared with the second
  const a = ls[0], b = ls[1];
  const start = !b ? a.from : a.from === b.from || a.from === b.to ? a.to : a.from;
  const n = (net.reversibles?.length ?? 0) + 1;
  const def: ReversibleDef = { id: newId("rv"), name: `Reversible lane ${n}`, start, mode: "timer", open1: 900, open2: 900, gap: 10, minDensity: 15, ratio: 1.5, minOpen: 300, initial: "closed" };
  const set = new Set(ls.map(l => l.id));
  return [{ ...net, links: net.links.map(l => (set.has(l.id) ? withRev(l, def.id) : l)), reversibles: [...(net.reversibles ?? []), def] }, def];
}
export function updateReversible(net: Network, id: string, patch: Partial<Omit<ReversibleDef, "id">>): Network {
  return { ...net, reversibles: (net.reversibles ?? []).map(r => (r.id === id ? { ...r, ...patch } : r)) };
}
/** remove a corridor: its roads go back to fixed lanes */
export function deleteReversible(net: Network, id: string): Network {
  return { ...net, links: net.links.map(l => (l.rev === id ? withRev(l, null) : l)), reversibles: (net.reversibles ?? []).filter(r => r.id !== id) };
}
/** take one road out of its corridor (only a road at either end, so the rest stays one road) */
export function leaveReversible(net: Network, linkId: string): Network {
  const l = linkById(net, linkId);
  if (!l?.rev) return net;
  const others = net.links.filter(x => x.rev === l.rev && x.id !== l.id);
  if (!others.length) return deleteReversible(net, l.rev);
  const sharedEnds = [l.from, l.to].filter(nd => others.some(x => x.from === nd || x.to === nd)).length;
  if (sharedEnds > 1) return net;
  const n2 = { ...net, links: net.links.map(x => (x.id === linkId ? withRev(x, null) : x)) };
  // direction 1 starts at the far end of the road taken out, if it started there
  const def = net.reversibles?.find(r => r.id === l.rev);
  if (def && (def.start === l.from || def.start === l.to)) return updateReversible(n2, def.id, { start: def.start === l.from ? l.to : l.from });
  return n2;
}
/** extend a corridor by the road straight on from either of its ends */
export function extendReversible(net: Network, id: string): Network {
  const ls = net.links.filter(l => l.rev === id);
  if (!ls.length) return net;
  const chain = straightChain(net, ls[0].id).map(x => linkById(net, x)!);
  // the corridor's roads must be a run within the chain; take the neighbours at both ends of that run
  const idx = chain.map((l, i) => (l.rev === id ? i : -1)).filter(i => i >= 0);
  const lo = Math.min(...idx), hi = Math.max(...idx), add = [chain[lo - 1], chain[hi + 1]].filter((l): l is LinkDef => !!l && !l.rev);
  if (!add.length) return net;
  const set = new Set(add.map(l => l.id));
  return { ...net, links: net.links.map(l => (set.has(l.id) ? withRev(l, id) : l)) };
}

// ---------------------------------------------------------------- markers
/** Place a marker on the map at `p` (labelled "Marker n"). */
export function addMarker(net: Network, p: Vec): [Network, MarkerDef] {
  const m: MarkerDef = { id: newId("m"), x: round(p.x), y: round(p.y), label: `Marker ${(net.markers?.length ?? 0) + 1}` };
  return [{ ...net, markers: [...(net.markers ?? []), m] }, m];
}
export function updateMarker(net: Network, id: string, patch: Partial<Omit<MarkerDef, "id">>): Network {
  const markers = (net.markers ?? []).map(m => (m.id === id ? { ...m, ...patch, ...(patch.x !== undefined ? { x: round(patch.x) } : {}), ...(patch.y !== undefined ? { y: round(patch.y) } : {}) } : m));
  return { ...net, markers };
}
export function deleteMarker(net: Network, id: string): Network {
  const markers = (net.markers ?? []).filter(m => m.id !== id);
  return { ...net, markers: markers.length ? markers : undefined };
}
