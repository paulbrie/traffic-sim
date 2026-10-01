/** Operations on several selected objects at once (Shift+click, Shift+drag a box). */
import { compile } from "@/engine/compile";
import type { Network } from "@/engine/types";
import { changeConnection } from "./connections";
import * as ops from "./ops";
import type { Selection } from "./store";

/** objects of these kinds can be deleted */
export const DELETABLE = new Set<Selection["kind"]>(["node", "link", "stop", "line", "building", "connector", "marker"]);

/**
 * Delete everything in `list` (what can be deleted): lane connectors first, each against the plan as it is
 * by then, then stops, bus lines, buildings, roads and points (a point takes its roads with it).
 */
export function deleteSelected(net: Network, list: readonly Selection[]): Network {
  let n = net;
  for (const s of list) {
    if (s.kind !== "connector") continue;
    const [, inKey, a, outKey, b] = s.id.split("|");
    n = changeConnection(n, compile(n, { outlines: false }), inKey, Number(a), outKey, Number(b), null);
  }
  for (const s of list) if (s.kind === "marker") n = ops.deleteMarker(n, s.id);
  for (const s of list) if (s.kind === "stop") n = ops.deleteStop(n, s.id);
  for (const s of list) if (s.kind === "line") n = ops.deleteLine(n, s.id);
  for (const s of list) if (s.kind === "building") n = ops.deleteBuilding(n, s.id);
  for (const s of list) if (s.kind === "link") n = ops.deleteLink(n, s.id);
  for (const s of list) if (s.kind === "node" && n.nodes.some(x => x.id === s.id)) n = ops.deleteNode(n, s.id);
  return n;
}

const KIND_NAME: Partial<Record<Selection["kind"], [string, string]>> = {
  node: ["point", "points"], link: ["road", "roads"], stop: ["stop", "stops"], line: ["bus line", "bus lines"],
  building: ["building", "buildings"], connector: ["lane connector", "lane connectors"], lane: ["lane", "lanes"],
  vehicle: ["vehicle", "vehicles"], zone: ["zone", "zones"], marker: ["marker", "markers"],
};
/** "3 roads, 2 points, 1 stop" */
export function describeSelection(list: readonly Selection[]): string {
  const counts = new Map<Selection["kind"], number>();
  for (const s of list) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return [...counts].map(([k, c]) => { const nm = KIND_NAME[k] ?? [k, `${k}s`]; return `${c} ${c === 1 ? nm[0] : nm[1]}`; }).join(", ");
}
