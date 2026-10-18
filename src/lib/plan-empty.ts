import type { Network } from "@/engine/types";
import type { Sketch } from "./lane-sketch";
import { nothingIn } from "./sketch-list";

/**
 * A save that would empty a plan (T185 on the page, T186 on the server): the road network or the sketch (its own
 * content, the Sketch window's and the saved sketches) had something in the stored revision, and the save has
 * nothing there. Refused: an empty store on the page (a development hot reload, anything gone wrong) must not
 * overwrite a plan. History restores and file restores take their own paths and aren't checked here.
 */

/** a network with nothing in it */
export const noNetwork = (n: Network | null | undefined) => !n || (!n.nodes.length && !n.links.length && !n.stops.length && !n.lines.length && !n.buildings?.length);

/** what the save would empty ("the road network", "the sketch"), or null when it empties nothing that had something */
export function emptiesPlan(stored: { network: Network | null; sketch: Sketch | null }, incoming: { network: Network | null; sketch: Sketch | null }): string | null {
  if (noNetwork(incoming.network) && !noNetwork(stored.network)) return "the road network";
  if (nothingIn(incoming.sketch ?? undefined) && !nothingIn(stored.sketch ?? undefined)) return "the sketch";
  return null;
}
