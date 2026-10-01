/** Lane connectors set by hand (a node's laneMap), shared by the inspector and the map. */
import { currentTargets, type Compiled } from "@/engine/compile";
import type { LaneTargets, Network } from "@/engine/types";
import * as ops from "./ops";

const asList = (t: LaneTargets): number[] => (t == null ? [] : Array.isArray(t) ? [...t] : [t]);
const fromList = (l: number[]): LaneTargets => (l.length > 1 ? l : l.length ? l[0] : null);

/** a turn's lane connections now (set by hand, or as worked out), or none at all when there is no such turn */
function targetsOf(net: Network, c: Compiled, inKey: string, outKey: string): { nodeId: string; key: string; lanes: LaneTargets[] } | null {
  const ein = c.edgeByKey.get(inKey), eout = c.edgeByKey.get(outKey);
  if (!ein || !eout || ein.to !== eout.from || ein.to.ringR > 0) return null;
  const n = ein.to, key = `${inKey}>${outKey}`, def = net.nodes.find(x => x.id === n.def.id);
  if (!def) return null;
  const m = n.moves.get(ein.idx)?.find(x => x.out === eout);
  const lanes = def.laneMap?.[key] ? [...def.laneMap[key]] : m ? currentTargets(m) : Array.from({ length: ein.n }, () => null as LaneTargets);
  return { nodeId: n.def.id, key, lanes };
}

/**
 * Add a connector from lane `a` of the road arriving at a junction (edge key `inKey`) to lane `b` of a
 * road leaving it (`outKey`): the lane keeps the connectors it has (one lane can feed several); a turn that
 * didn't exist starts with this one. Returns the new network and the connector's selection id.
 */
export function connectLanes(net: Network, c: Compiled, inKey: string, a: number, outKey: string, b: number): { net: Network; id: string } | null {
  const t = targetsOf(net, c, inKey, outKey);
  if (!t) return null;
  const l = asList(t.lanes[a]);
  if (!l.includes(b)) l.push(b);
  t.lanes[a] = fromList(l);
  return { net: ops.setLaneMap(net, t.nodeId, t.key, t.lanes), id: `${t.nodeId}|${inKey}|${a}|${outKey}|${b}` };
}

/** change one connector (lane a → lane b) to end in lane `to`, or remove it (`to` null); the lane's others stay */
export function changeConnection(net: Network, c: Compiled, inKey: string, a: number, outKey: string, b: number, to: number | null): Network {
  const t = targetsOf(net, c, inKey, outKey);
  if (!t) return net;
  let l = asList(t.lanes[a]);
  l = to === null ? l.filter(x => x !== b) : l.includes(to) ? l.filter(x => x !== b) : l.map(x => (x === b ? to : x));
  t.lanes[a] = fromList(l);
  return ops.setLaneMap(net, t.nodeId, t.key, t.lanes);
}
