/** Short references for junctions ("J1", "J2", …) used in labels and debugging views. */
import type { Compiled, CNode } from "./compile";

/** (a road's loose end counts too once connectors make it part of a junction over several nodes) */
export const isJunction = (n: CNode) => n.controlled && (n.degree >= 2 || n.cluster.length > 1);

/** numbered in the order the nodes were created, so references stay put while you draw */
export function junctionRefs(c: Compiled): Map<string, string> {
  const out = new Map<string, string>();
  let k = 0;
  // (a junction drawn by hand has one, on its leading node)
  for (const n of c.nodes) if (isJunction(n) && (!n.lead || n.lead === n)) out.set(n.def.id, `J${++k}`);
  return out;
}
