/**
 * Split a two-way road into two carriageways: a one-way road per direction, side by side with a gap
 * between them. The junctions along it are divided as well, each side road joining the carriageway on
 * its own side, so each of those junctions belongs to one direction only (optionally with a crossing
 * through the gap, so traffic can still turn across). At its two ends the road splits a little way
 * before the junction there, which keeps its shape.
 */
import { newId } from "@/engine/sample";
import { LANE_WIDTH, lanesAtLine, type ConnectorDef, type LinkDef, type Network, type NodeDef, type Vec } from "@/engine/types";
import { linkById, linkLength, linkPoint, linksAt, nodeById, round, splitLink } from "./ops";

/** the roads to split, in order along the road, and the nodes between them (one more than the roads) */
export interface Run { links: { id: string; aligned: boolean }[]; nodes: string[] }

const twoWay = (l: LinkDef) => l.lanesF > 0 && l.lanesB > 0 && !l.rev;
/** where the road may not run on through (it would split a set of traffic lights or a roundabout in two) */
const stopsAt = (n: NodeDef) => n.gateway || n.control === "lights" || n.control === "roundabout" || !!n.align;
/** an interior node it can't pass through, given its degree */
const blocks = (net: Network, n: NodeDef) => {
  const deg = linksAt(net, n.id).length;
  return deg >= 3 ? n.control === "lights" || n.control === "roundabout" : !!n.junction && n.control === "lights";
};

/** unit direction in which link `l` leaves node `id` (along its curve) */
function leaving(net: Network, l: LinkDef, id: string): Vec {
  const A = nodeById(net, l.from)!, B = nodeById(net, l.to)!;
  const p = l.from === id ? A : B, far = l.from === id ? B : A, h = l.from === id ? l.c1 : l.c2;
  const q = h && Math.hypot(h.x - p.x, h.y - p.y) > 0.5 ? h : far;
  const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  return { x: (q.x - p.x) / d, y: (q.y - p.y) / d };
}

/** the road straight on from `l` at node `at`: another two-way road within 35° of carrying straight on */
function straightOn(net: Network, l: LinkDef, at: string, seen: Set<string>): LinkDef | null {
  const n = nodeById(net, at);
  if (!n || stopsAt(n) || blocks(net, n)) return null;
  const v = leaving(net, l, at);
  let best: LinkDef | null = null, bd = -Math.cos((35 * Math.PI) / 180);
  for (const o of linksAt(net, at)) {
    if (o.id === l.id || seen.has(o.id) || !twoWay(o) || (o.level ?? 0) !== (l.level ?? 0)) continue;
    const w = leaving(net, o, at), d = v.x * w.x + v.y * w.y;
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

/**
 * What splitting `linkId` would split: the selected roads (when several are selected: they must make one
 * road end to end), or else the road and its continuation straight on through junctions and bends, up
 * to traffic lights, roundabouts, entry points or where it stops being two-way.
 */
export function carriagewayRun(net: Network, linkId: string, also: string[] = []): Run | { error: string } {
  const start = linkById(net, linkId);
  if (!start || !twoWay(start)) return { error: "Only a two-way road (without a reversible lane) can be split into carriageways." };
  if (also.length) return selectedRun(net, [linkId, ...also]);
  const seen = new Set([start.id]);
  const walk = (from: string) => {
    const out: LinkDef[] = [];
    let cur = start, at = from;
    while (out.length < 80) {
      const next = straightOn(net, cur, at, seen);
      if (!next) break;
      seen.add(next.id); out.push(next);
      at = next.from === at ? next.to : next.from; cur = next;
    }
    return out;
  };
  const back = walk(start.from).reverse(), ahead = walk(start.to);
  return orderRun(net, [...back, start, ...ahead]);
}

/** the links as a run, given they follow each other in this order */
function orderRun(net: Network, ls: LinkDef[]): Run {
  // the node before the first link: its end not shared with the second
  const first = ls[0], second = ls[1];
  let at = !second ? first.from : first.from === second.from || first.from === second.to ? first.to : first.from;
  const nodes = [at], links: Run["links"] = [];
  for (const l of ls) { links.push({ id: l.id, aligned: l.from === at }); at = l.from === at ? l.to : l.from; nodes.push(at); }
  return { links, nodes };
}

function selectedRun(net: Network, ids: string[]): Run | { error: string } {
  const ls = ids.map(id => linkById(net, id)).filter((l): l is LinkDef => !!l);
  if (ls.some(l => !twoWay(l))) return { error: "Every selected road must be two-way (without a reversible lane)." };
  const by = new Map<string, LinkDef[]>();
  for (const l of ls) for (const n of [l.from, l.to]) by.set(n, [...(by.get(n) ?? []), l]);
  const ends = [...by].filter(([, x]) => x.length === 1).map(([n]) => n);
  if (ends.length !== 2 || [...by.values()].some(x => x.length > 2)) return { error: "The selected roads must make one road, end to end." };
  const order: LinkDef[] = [], seen = new Set<string>();
  let at = ends[0];
  for (;;) {
    const l = by.get(at)!.find(x => !seen.has(x.id));
    if (!l) break;
    seen.add(l.id); order.push(l); at = l.from === at ? l.to : l.from;
  }
  if (order.length !== ls.length) return { error: "The selected roads must make one road, end to end." };
  const run = orderRun(net, order);
  const bad = run.nodes.slice(1, -1).map(id => nodeById(net, id)!).find(n => blocks(net, n));
  if (bad) return { error: "The road would split a set of traffic lights or a roundabout in two: split it on either side of it instead." };
  return run;
}

/** parameter (0..1) of the point `d` m along link `l` from its `from` end */
function tAt(l: LinkDef, A: Vec, B: Vec, d: number): number {
  if (!l.c1 || !l.c2) return Math.max(0, Math.min(1, d / Math.max(1e-6, Math.hypot(B.x - A.x, B.y - A.y))));
  let len = 0, prev = A;
  for (let k = 1; k <= 64; k++) {
    const q = linkPoint(l, A, B, k / 64), s = Math.hypot(q.x - prev.x, q.y - prev.y);
    if (len + s >= d) return (k - 1 + (d - len) / Math.max(1e-6, s)) / 64;
    len += s; prev = q;
  }
  return 1;
}

export interface SplitOptions {
  /** width of the gap between the carriageways (m) */
  gap: number;
  /**
   * Openings at the junctions: lane connectors from each side road across the gap into the other direction's
   * inner lane, and from that lane into the side road (left turns), so both carriageways make one junction there
   */
  openings: boolean;
}

export interface SplitResult { net: Network; forward: string[]; backward: string[]; junctions: number }

export function splitCarriageways(net0: Network, run0: Run, opts: SplitOptions): SplitResult | { error: string } {
  let net = net0;
  const links = run0.links.map(x => ({ ...x })), nodes = [...run0.nodes];
  if (links.some(x => !twoWay(linkById(net, x.id)!))) return { error: "Only two-way roads can be split into carriageways." };

  // 1. the ends: the road splits a little way before the node at each end; the piece next to that node
  // keeps its id (and so what refers to it there: lane connections, light phases, signs)
  const splitPoints: string[] = [];
  for (const end of ["start", "end"] as const) {
    const i = end === "start" ? 0 : links.length - 1, node = end === "start" ? nodes[0] : nodes[nodes.length - 1];
    const L = linkById(net, links[i].id)!, A = nodeById(net, L.from)!, B = nodeById(net, L.to)!;
    const len = linkLength(L, A, B), d = Math.min(25, len * (links.length === 1 ? 0.3 : 0.35));
    const t = tAt(L, A, B, L.from === node ? d : len - d);
    const [next, S] = splitLink(net, L.id, t, linkPoint(L, A, B, t));
    const parts = next.links.filter(l => l.from === S.id || l.to === S.id);
    const stub = parts.find(l => l.from === node || l.to === node)!, rest = parts.find(l => l !== stub)!;
    // (the stub takes the old id back)
    net = {
      ...next,
      links: next.links.map(l => (l === stub ? { ...l, id: L.id } : l)),
      nodes: next.nodes.map(n => (n.id === S.id ? { ...n, align: true } : n)),
      stops: next.stops.map(s => (s.link === stub.id ? { ...s, link: L.id } : s)),
    };
    // (a road in the run starts at the node before it)
    links[i] = { id: rest.id, aligned: end === "start" ? rest.from === S.id : rest.to === S.id };
    nodes[end === "start" ? 0 : nodes.length - 1] = S.id;
    splitPoints.push(S.id);
  }

  // 2. along the road: its direction and the carriageways' offsets at each node (0 at the split points)
  const k = links.length, defs = links.map(x => linkById(net, x.id)!);
  const lanesAlong = (j: number, along: boolean) => (defs[j][links[j].aligned === along ? "lanesF" : "lanesB"]) * (defs[j].laneWidth ?? LANE_WIDTH.default);
  const frame = nodes.map((id, i) => {
    const p = nodeById(net, id)!;
    const out = i < k ? leaving(net, defs[i], id) : null, inn = i > 0 ? leaving(net, defs[i - 1], id) : null;
    let t = out && inn ? { x: out.x - inn.x, y: out.y - inn.y } : out ?? { x: -inn!.x, y: -inn!.y };
    const d = Math.hypot(t.x, t.y) || 1; t = { x: t.x / d, y: t.y / d };
    const r = { x: -t.y, y: t.x };
    const end = i === 0 || i === k;
    const wF = Math.max(...[i - 1, i].filter(j => j >= 0 && j < k).map(j => lanesAlong(j, true))) / 2;
    const wB = Math.max(...[i - 1, i].filter(j => j >= 0 && j < k).map(j => lanesAlong(j, false))) / 2;
    const offF = end ? 0 : opts.gap / 2 + wF, offB = end ? 0 : opts.gap / 2 + wB;
    return { p, t, r, f: { x: r.x * offF, y: r.y * offF }, b: { x: -r.x * offB, y: -r.y * offB } };
  });

  // 3. each node along the way becomes two, one on each carriageway; side roads join the one on their side
  const fwdNode: string[] = [], bwdNode: string[] = [], added: NodeDef[] = [], dropped = new Set<string>();
  const runIds = new Set(links.map(x => x.id));
  const moved = new Map<string, Partial<LinkDef>>();
  let junctions = 0;
  /** per divided node: its two halves and the side roads on each */
  const halves: { i: number; F: NodeDef; B: NodeDef; onF: LinkDef[]; onB: LinkDef[] }[] = [];
  nodes.forEach((id, i) => {
    if (i === 0 || i === k) { fwdNode.push(id); bwdNode.push(id); return; }
    const def = nodeById(net, id)!, fr = frame[i];
    const copy = (o: Vec): NodeDef => ({ ...def, id: newId("n"), x: round(def.x + o.x), y: round(def.y + o.y), laneMap: undefined, connShape: undefined, connectors: undefined, closed: undefined, outline: undefined, paint: undefined, align: undefined });
    const F = copy(fr.f), B = copy(fr.b);
    fwdNode.push(F.id); bwdNode.push(B.id); added.push(F, B); dropped.add(id);
    const side = linksAt(net, id).filter(l => !runIds.has(l.id));
    if (side.length) junctions++;
    for (const l of side) {
      const v = leaving(net, l, id), right = v.x * fr.r.x + v.y * fr.r.y >= 0, to = right ? F : B, o = right ? fr.f : fr.b;
      const shift = (h: Vec | null) => (h ? { x: round(h.x + o.x), y: round(h.y + o.y) } : null);
      const patch: Partial<LinkDef> = { ...(moved.get(l.id) ?? {}) };
      if (l.from === id) { patch.from = to.id; patch.c1 = shift(l.c1); }
      if (l.to === id) { patch.to = to.id; patch.c2 = shift(l.c2); }
      if (l.slip === id) patch.slip = null;
      moved.set(l.id, patch);
    }
    halves.push({ i, F, B, onF: side.filter(l => moved.get(l.id)?.from === F.id || moved.get(l.id)?.to === F.id), onB: side.filter(l => moved.get(l.id)?.from === B.id || moved.get(l.id)?.to === B.id) });
  });

  // 4. the carriageways: per road, one one-way road each way (the backward one drawn in its own direction)
  const fwd: LinkDef[] = [], bwd: LinkDef[] = [];
  /** the new road carrying old road `id` in direction `dir` */
  const dmap = new Map<string, string>();
  const stopsOut = net.stops.filter(s => !runIds.has(s.link));
  defs.forEach((L, j) => {
    const al = links[j].aligned, h1 = al ? L.c1 : L.c2, h2 = al ? L.c2 : L.c1;
    const add = (h: Vec | null, o: Vec) => (h ? { x: round(h.x + o.x), y: round(h.y + o.y) } : null);
    const side = (along: boolean) => {
      const F = al === along;
      return {
        lanesF: F ? L.lanesF : L.lanesB, busF: F ? L.busF : L.busB, signF: (F ? L.signF : L.signB) ?? null, splitF: (F ? L.splitF : L.splitB) ?? null,
        baysF: (F ? L.baysF : L.baysB) ?? null, dropF: (F ? L.dropF : L.dropB) ?? null,
      };
    };
    const common = {
      name: L.name, speed: L.speed, laneWidth: L.laneWidth, level: L.level, counter: L.counter,
      lanesB: 0, busB: false, turnsF: null, turnsB: null, signB: null, splitB: null, greenF: null, greenB: null, baysB: null, dropB: null,
    };
    const a = frame[j], b = frame[j + 1];
    const f: LinkDef = { ...common, ...side(true), id: newId("l"), from: fwdNode[j], to: fwdNode[j + 1], c1: add(h1, a.f), c2: add(h2, b.f) };
    const r: LinkDef = { ...common, ...side(false), id: newId("l"), from: bwdNode[j + 1], to: bwdNode[j], c1: add(h2, b.b), c2: add(h1, a.b) };
    fwd.push(f); bwd.push(r);
    dmap.set(`${L.id}:${al ? 1 : -1}`, f.id); dmap.set(`${L.id}:${al ? -1 : 1}`, r.id);
    for (const s of net.stops) {
      if (s.link !== L.id) continue;
      const along = (s.dir === 1) === al, pos = al ? s.pos : 1 - s.pos;
      stopsOut.push({ ...s, link: along ? f.id : r.id, dir: 1, pos: along ? pos : 1 - pos });
    }
  });

  let links2 = [
    ...net.links.filter(l => !runIds.has(l.id)).map(l => (moved.has(l.id) ? { ...l, ...moved.get(l.id) } : l)),
    ...fwd, ...bwd,
  ];
  // turning shares name the road taken at the junction ahead: an old road becomes the carriageway
  // leaving that junction (or the share goes, when that direction isn't reachable from there any more)
  const ends = new Map(links2.map(l => [l.id, l]));
  const leavesFrom = (node: string, id: string): string | null => {
    for (const d of [1, -1]) { const nid = dmap.get(`${id}:${d}`); if (nid && ends.get(nid)?.from === node) return nid; }
    const l = ends.get(id);
    return l && (l.from === node || l.to === node) ? id : null;
  };
  const remap = (split: Record<string, number> | null | undefined, node: string) => {
    if (!split) return split;
    const out: Record<string, number> = {};
    for (const [id, w] of Object.entries(split)) { const nid = leavesFrom(node, id); if (nid) out[nid] = w; }
    return Object.keys(out).length ? out : null;
  };
  links2 = links2.map(l => (l.splitF || l.splitB ? { ...l, splitF: remap(l.splitF, l.to), splitB: remap(l.splitB, l.from) } : l));

  // no turning round from one carriageway onto the other where the road splits (switched off by hand,
  // so it can be put back in the junction's lane connections)
  const noU = new Map<string, NodeDef["laneMap"]>();
  for (const [S, into, out] of [[nodes[0], bwd[0], fwd[0]], [nodes[k], fwd[k - 1], bwd[k - 1]]] as const)
    noU.set(S, { ...(noU.get(S) ?? {}), [`${into.id}:1>${out.id}:1`]: Array(lanesAtLine(into, 1)).fill(null) });
  // openings: left turns across the gap as lane connectors (side road ↔ the other carriageway's inner lane)
  if (opts.openings) for (const { i, F, B, onF, onB } of halves) {
    const at = new Map<NodeDef, ConnectorDef[]>([[F, []], [B, []]]);
    /** the side road's edge arriving at / leaving node `x` (null where it carries no traffic that way) */
    const arrive = (l: LinkDef, x: NodeDef) => { const toX = (moved.get(l.id)?.to ?? l.to) === x.id; return (toX ? l.lanesF : l.lanesB) > 0 ? `${l.id}:${toX ? 1 : -1}` : null; };
    const leave = (l: LinkDef, x: NodeDef) => { const fromX = (moved.get(l.id)?.from ?? l.from) === x.id; return (fromX ? l.lanesF : l.lanesB) > 0 ? `${l.id}:${fromX ? 1 : -1}` : null; };
    // side roads on the forward carriageway reach the backward one (leaving B_i toward B_{i-1}), and are reached from it
    for (const [x, other, sides, into, from] of [[F, B, onF, bwd[i - 1], bwd[i]], [B, F, onB, fwd[i], fwd[i - 1]]] as const) {
      for (const l of sides) {
        const a = arrive(l, x), d = leave(l, x);
        if (a) at.get(x)!.push({ in: a, a: 0, out: `${into.id}:1`, b: 0 });
        if (d) at.get(other)!.push({ in: `${from.id}:1`, a: 0, out: d, b: 0 });
      }
    }
    for (const [x, list] of at) if (list.length) x.connectors = list;
  }
  return {
    net: { ...net, nodes: [...net.nodes.filter(n => !dropped.has(n.id)).map(n => (noU.has(n.id) ? { ...n, laneMap: noU.get(n.id) } : n)), ...added], links: links2, stops: stopsOut },
    forward: fwd.map(l => l.id), backward: bwd.map(l => l.id), junctions,
  };
}
