"use client";

import { useState } from "react";
import { Trash2, Triangle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { LinkDef, Network } from "@/engine/types";
import { busy, commit, network$, select } from "@/state/store";
import { ISLAND_LEN, ISLAND_WIDTH, islandAt, removeIsland, reshapeIsland, splitterIsland } from "@/state/islands";
import { junctionOf } from "@/state/junctions";
import { NumberField, Section } from "./fields";

/** a two-way road's end on its own (at a junction drawn by hand, or an entry point): part it round a triangular island */
export function SplitterIslandSection({ net, link }: { net: Network; link: LinkDef }) {
  const [len, setLen] = useState(ISLAND_LEN), [width, setWidth] = useState(ISLAND_WIDTH);
  if (!link.lanesF || !link.lanesB) return null;
  const ends = [link.from, link.to].filter(id => net.links.filter(l => l.from === id || l.to === id).length === 1);
  if (!ends.length) return null;
  const label = (id: string) => (junctionOf(net, id) ? "at the junction" : "at the loose end") + (ends.length > 1 ? (id === link.from ? " (start)" : " (end)") : "");
  const make = (id: string) => void busy("Adding the island…", () => {
    const r = splitterIsland(network$.getValue(), link.id, id, len, width);
    if ("error" in r) { toast.error(r.error); return; }
    commit(r.net); select({ kind: "node", id: r.island });
  });
  return (
    <Section title="Splitter island">
      <p className="text-xs text-muted-foreground">
        The road&apos;s last stretch parts into its two directions round a kerbed triangle that widens towards the junction (as at a roundabout&apos;s entries). The junction&apos;s connectors carry over.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <NumberField id="isl-len" label="Length" unit="m" value={len} min={8} max={80} step={1} digits={0} onCommit={setLen} />
        <NumberField id="isl-w" label="Width at the junction" unit="m" value={width} min={1.5} max={15} step={0.5} digits={1} onCommit={setWidth} />
      </div>
      <div className="flex flex-wrap gap-2">
        {ends.map(id => <Button key={id} size="sm" variant="outline" onClick={() => make(id)}><Triangle /> Island {label(id)}</Button>)}
      </div>
    </Section>
  );
}

/** a splitter island (selected by clicking it): its size, or taken away (the road one again) */
export function IslandInspector({ net, id }: { net: Network; id: string }) {
  const it = islandAt(net, id);
  if (!it) return null;
  const reshape = (len: number, width: number) => void busy("Reshaping the island…", () => {
    const r = reshapeIsland(network$.getValue(), id, len, width);
    if ("error" in r) { toast.error(r.error); return; }
    commit(r.net); select({ kind: "node", id: r.island });
  });
  const remove = () => void busy("Taking the island away…", () => {
    const r = removeIsland(network$.getValue(), id);
    if (!r) { toast.error("Couldn't take the island away."); return; }
    commit(r.net); select({ kind: "link", id: r.link });
  });
  const name = it.road.name || "the road";
  return (
    <div>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Splitter island</div>
          <div className="truncate font-medium">On {name}</div>
        </div>
        <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="Take the island away" title="Take the island away: the road one again" onClick={remove}><Trash2 /></Button>
      </div>
      <Section>
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="isl-len" label="Length" unit="m" value={Math.round(it.len)} min={8} max={80} step={1} digits={0} onCommit={v => reshape(v, it.width)} />
          <NumberField id="isl-w" label="Width at the junction" unit="m" value={Math.round(it.width * 10) / 10} min={1.5} max={15} step={0.5} digits={1} onCommit={v => reshape(it.len, v)} />
        </div>
        <p className="text-xs text-muted-foreground">The two ways part here round the island and reach the junction side by side. Change its size, or take it away to make the road one again.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => select({ kind: "link", id: it.roadIn.id })}>The way in</Button>
          <Button size="sm" variant="outline" onClick={() => select({ kind: "link", id: it.roadOut.id })}>The way out</Button>
          <Button size="sm" variant="outline" onClick={remove}><Trash2 /> Take it away</Button>
        </div>
      </Section>
    </div>
  );
}
