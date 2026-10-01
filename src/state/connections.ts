/**
 * A junction's lane connectors, shared by the inspector and the map. They are automatic until one is
 * edited; then the junction's whole set is written out (NodeDef.connectors) and edited from there on.
 */
import { CROSS_REACH, exitLanesOf, laneAllowed, type Compiled, type Edge, type LanePiece } from "@/engine/compile";
import { dist } from "@/engine/geom";
import type { ConnShape, ConnectorDef, LaneTargets, Network, NodeDef } from "@/engine/types";
import * as ops from "./ops";

const asList = (t: LaneTargets): number[] => (t == null ? [] : Array.isArray(t) ? [...t] : [t]);
const same = (x: ConnectorDef, inKey: string, a: number, outKey: string, b: number) => x.in === inKey && x.a === a && x.out === outKey && x.b === b;

/** the connectors are set by hand (written out, or the older per-turn lane connections) */
export const isManual = (def: NodeDef) => !!def.connectors || !!def.laneMap;

/**
 * The junction's connectors now, as the compiled plan has them: those written out (that still fit the
 * roads there) and the automatic ones of roads with none of their own, or all worked out.
 */
export function nodeConnectors(net: Network, c: Compiled, nodeId: string): ConnectorDef[] {
  const def = ops.nodeById(net, nodeId);
  if (!def) return [];
  const n = c.nodeById.get(nodeId);
  if (!n) return def.connectors?.map(x => ({ ...x })) ?? [];
  if (n.ringR > 0) return [];
  const out: ConnectorDef[] = [];
  for (const ms of n.moves.values()) for (const m of ms) for (let a = 0; a < m.in.n; a++) {
    if (!laneAllowed(m, a)) continue;
    for (const b of exitLanesOf(m, a)) {
      const shape = n.shapes.get(`${m.in.key}|${a}>${m.out.key}|${b}`);
      out.push({ in: m.in.key, a, out: m.out.key, b, ...(shape ? { shape } : {}) });
    }
  }
  return out;
}

/**
 * Write out a junction's connectors; a road left with none is closed (else it would get the automatic ones).
 * Written out the first time, every road at the junction is looked at (one with no turns stays without).
 */
function write(net: Network, c: Compiled, nodeId: string, list: ConnectorDef[], touched: string[]): Network {
  const def = ops.nodeById(net, nodeId)!, n = c.nodeById.get(nodeId);
  if (!def.connectors && n) touched = [...touched, ...n.arms.flatMap(a => [a.inEdge?.key, a.outEdge?.key]).filter((k): k is string => !!k)];
  const closed = new Set(def.closed ?? []);
  for (const k of touched) {
    if (list.some(x => x.in === k || x.out === k)) closed.delete(k); else closed.add(k);
  }
  return ops.updateNode(net, nodeId, { connectors: list, closed: closed.size ? [...closed] : undefined, laneMap: undefined, connShape: undefined });
}

/** a junction's connectors written out as they are now (nothing changes but that they are kept from now on) */
export function writeOut(net: Network, c: Compiled, nodeId: string): Network {
  const def = ops.nodeById(net, nodeId), n = c.nodeById.get(nodeId);
  if (!def || def.connectors || !n || n.ringR > 0 || n.degree < 2) return net;
  return write(net, c, nodeId, nodeConnectors(net, c, nodeId), []);
}

/** a lane of a road at another node can be joined: nearby (within CROSS_REACH), on the same level, not a roundabout's */
const reachable = (ein: Edge, a: number, eout: Edge, b: number) => {
  const p = ein.lanes[a], q = eout.lanes[b];
  if (!p || !q || eout.from.ringR > 0 || ein.to.ringR > 0 || (eout.link.level ?? 0) !== (ein.link.level ?? 0) || eout.link === ein.link) return false;
  // (not back where its own road started, nor behind the end of the lane: ahead or beside it)
  if (eout.from === ein.from) return false;
  const P = p.poly.at(p.len), t = p.poly.tangent(p.len), Q = q.poly.at(0);
  return dist(P, Q) <= CROSS_REACH && (Q.x - P.x) * t.x + (Q.y - P.y) * t.y >= -5;
};

/** the lanes a connector from lane `a` of `ein` may end in: those leaving its junction, or starting at another node nearby */
export function lanesLeavingNear(c: Compiled, ein: Edge, a: number): { e: Edge; lp: LanePiece }[] {
  return c.edges.flatMap(e => (e.from === ein.to ? e.lanes : e.lanes.filter(lp => reachable(ein, a, e, lp.lane))).map(lp => ({ e, lp })));
}
/** the lanes a connector into lane `b` of `eout` may start from: those arriving at its junction, or ending at another node nearby */
export function lanesArrivingNear(c: Compiled, eout: Edge, b: number): { e: Edge; lp: LanePiece }[] {
  return c.edges.flatMap(e => (e.to === eout.from ? e.lanes : e.lanes.filter(lp => reachable(e, lp.lane, eout, b))).map(lp => ({ e, lp })));
}

/** the junction (node) a connector from lane `a` of one road into lane `b` of another is kept at: where the first ends */
function junction(c: Compiled, inKey: string, outKey: string, a = 0, b = 0): string | null {
  const ein = c.edgeByKey.get(inKey), eout = c.edgeByKey.get(outKey);
  if (!ein || !eout || ein.to.ringR > 0 || eout.from.ringR > 0) return null;
  // (into a road starting at another node: one nearby, see CROSS_REACH)
  if (ein.to !== eout.from && !reachable(ein, a, eout, b)) return null;
  return ein.to.def.id;
}

/**
 * Add a connector from lane `a` of the road arriving at a junction (edge key `inKey`) to lane `b` of a
 * road leaving it (`outKey`); the lane keeps the connectors it has (one lane can feed several). Returns the
 * new network and the connector's selection id.
 */
export function connectLanes(net: Network, c: Compiled, inKey: string, a: number, outKey: string, b: number): { net: Network; id: string } | null {
  const nodeId = junction(c, inKey, outKey, a, b);
  if (!nodeId) return null;
  const list = nodeConnectors(net, c, nodeId);
  if (!list.some(x => same(x, inKey, a, outKey, b))) list.push({ in: inKey, a, out: outKey, b });
  return { net: write(net, c, nodeId, list, [inKey, outKey]), id: `${nodeId}|${inKey}|${a}|${outKey}|${b}` };
}

/** change one connector (lane a → lane b) to end in lane `to`, or remove it (`to` null); the lane's others stay */
export function changeConnection(net: Network, c: Compiled, inKey: string, a: number, outKey: string, b: number, to: number | null): Network {
  const nodeId = junction(c, inKey, outKey, a, b);
  if (!nodeId) return net;
  let list = nodeConnectors(net, c, nodeId);
  const i = list.findIndex(x => same(x, inKey, a, outKey, b));
  if (i < 0) return net;
  if (to === null || list.some(x => same(x, inKey, a, outKey, to))) list = list.filter((_, k) => k !== i);
  // (a new end: the old curve no longer fits)
  else list[i] = { in: inKey, a, out: outKey, b: to };
  return write(net, c, nodeId, list, [inKey, outKey]);
}

/** set where each lane of one turn ("inKey>outKey") goes: per incoming lane its outgoing lane(s), or null for none */
export function setTurnTargets(net: Network, c: Compiled, key: string, lanes: LaneTargets[]): Network {
  const [inKey, outKey] = key.split(">"), nodeId = junction(c, inKey, outKey);
  if (!nodeId) return net;
  const old = nodeConnectors(net, c, nodeId);
  const list = old.filter(x => !(x.in === inKey && x.out === outKey));
  lanes.forEach((t, a) => {
    for (const b of asList(t)) {
      const was = old.find(x => same(x, inKey, a, outKey, b));
      list.push(was ?? { in: inKey, a, out: outKey, b });
    }
  });
  return write(net, c, nodeId, list, [inKey, outKey]);
}

/** all of a junction's connectors back to automatic */
export function resetConnectors(net: Network, nodeId: string): Network {
  return ops.updateNode(net, nodeId, { connectors: undefined, closed: undefined, laneMap: undefined, connShape: undefined });
}

/** one approach's connectors back to automatic (e.g. after its lane arrows change) */
export function resetApproach(net: Network, nodeId: string, inKey: string): Network {
  const def = ops.nodeById(net, nodeId);
  if (!def) return net;
  if (def.connectors) {
    const closed = (def.closed ?? []).filter(k => k !== inKey);
    return ops.updateNode(net, nodeId, { connectors: def.connectors.filter(x => x.in !== inKey), closed: closed.length ? closed : undefined });
  }
  if (!def.laneMap) return net;
  const laneMap = Object.fromEntries(Object.entries(def.laneMap).filter(([k]) => !k.startsWith(`${inKey}>`)));
  return ops.updateNode(net, nodeId, { laneMap: Object.keys(laneMap).length ? laneMap : undefined });
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** set (or with null, clear) the curve of one connector (key "in|a>out|b", see connShapeKey) */
export function setConnectorShape(net: Network, nodeId: string, key: string, shape: ConnShape | null): Network {
  const def = ops.nodeById(net, nodeId);
  if (!def) return net;
  if (!def.connectors) return ops.setConnShape(net, nodeId, key, shape);
  const sh = shape && (Array.isArray(shape) ? [r2(shape[0]), r2(shape[1])] as [number, number] : { c1: { x: r2(shape.c1.x), y: r2(shape.c1.y) }, c2: { x: r2(shape.c2.x), y: r2(shape.c2.y) } });
  const connectors = def.connectors.map(x => {
    if (`${x.in}|${x.a}>${x.out}|${x.b}` !== key) return x;
    const rest: ConnectorDef = { in: x.in, a: x.a, out: x.out, b: x.b };
    return sh ? { ...rest, shape: sh } : rest;
  });
  return ops.updateNode(net, nodeId, { connectors });
}
