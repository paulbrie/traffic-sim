/** Lane connectors set by hand (a node's laneMap), shared by the inspector and the map. */
import { exitLane, laneAllowed, type Compiled } from "@/engine/compile";
import type { Network } from "@/engine/types";
import * as ops from "./ops";

/**
 * Connect lane `a` of the road arriving at a junction (edge key `inKey`) to lane `b` of a road leaving it
 * (`outKey`): the turn's other lanes stay as they are now; a turn that didn't exist starts with this lane
 * only. Returns the new network and the connector's selection id (null if those roads don't meet there).
 */
export function connectLanes(net: Network, c: Compiled, inKey: string, a: number, outKey: string, b: number): { net: Network; id: string } | null {
  const ein = c.edgeByKey.get(inKey), eout = c.edgeByKey.get(outKey);
  if (!ein || !eout || ein.to !== eout.from) return null;
  const n = ein.to, key = `${inKey}>${outKey}`, def = net.nodes.find(x => x.id === n.def.id);
  if (!def || n.ringR > 0) return null;
  const m = n.moves.get(ein.idx)?.find(x => x.out === eout);
  const lanes = def.laneMap?.[key] ? [...def.laneMap[key]] : m ? Array.from({ length: ein.n }, (_, q) => (laneAllowed(m, q) ? exitLane(m, q, false) : null)) : Array.from({ length: ein.n }, () => null as number | null);
  lanes[a] = b;
  return { net: ops.setLaneMap(net, n.def.id, key, lanes), id: `${n.def.id}|${inKey}|${a}|${outKey}|${b}` };
}
