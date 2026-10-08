/**
 * Placing a junction piece (pasted, or from the library): the piece itself is kept here, out of the `ui`
 * store (it is a small plan: no need to watch every part of it); `ui.placing` says one is being placed.
 */
import type { Network } from "@/engine/types";
import { groupById, makeGroup, readPiece, takeOut, type JunctionPiece } from "./groups";
import { ui, type Selection } from "./store";

let piece: JunctionPiece | null = null;
/** what was copied last in this tab (when the clipboard can't be read) */
let copied: JunctionPiece | null = null;

export const placingPiece = () => (ui.getValue().placing ? piece : null);

export function startPlacing(p: JunctionPiece) {
  piece = p;
  const u = ui.getValue();
  u.placing = { name: p.name, turn: 0 };
  u.tool = "select";
}
export function stopPlacing() { piece = null; ui.getValue().placing = null; }

/** copy a piece: to the clipboard (as text, to paste in another tab or plan) and here */
export async function copyPiece(p: JunctionPiece): Promise<boolean> {
  copied = p;
  try { await navigator.clipboard.writeText(JSON.stringify(p)); return true; } catch { return false; }
}
/** what to paste: the clipboard's junction if it holds one, otherwise the one copied here */
export async function pastePiece(): Promise<JunctionPiece | null> {
  try { const p = readPiece(await navigator.clipboard.readText()); if (p) return p; } catch { /* not allowed: the one copied here */ }
  return copied;
}

/**
 * What ⌘C copies: the junction group selected; or the roads selected (with a junction selected, the roads
 * meeting there), as a new junction piece.
 */
export function pieceFromSelection(net: Network, sels: Selection[]): JunctionPiece | null {
  const g = sels.find(s => s.kind === "group");
  if (g) { const def = groupById(net, g.id); return def ? takeOut(net, def) : null; }
  const links = new Set<string>();
  for (const s of sels) {
    if (s.kind === "link") links.add(s.id);
    if (s.kind === "node") for (const l of net.links) if (l.from === s.id || l.to === s.id) links.add(l.id);
  }
  if (!links.size) return null;
  const [tmp, def] = makeGroup(net, [...links], links.size === 1 ? "Road" : "Junction");
  return def ? takeOut(tmp, def) : null;
}
