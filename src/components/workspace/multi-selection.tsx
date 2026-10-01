"use client";

import { useDeepSubject, useSubject } from "subjecto/react";
import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { DELETABLE, deleteSelected, describeSelection } from "@/state/bulk";
import { commit, network$, select, selectedAll, selectMany, ui, type Selection } from "@/state/store";
import { Section } from "./fields";

const KIND: Partial<Record<Selection["kind"], string>> = { node: "Point", link: "Road", stop: "Stop", line: "Bus line", building: "Building", connector: "Connector", lane: "Lane", vehicle: "Vehicle", zone: "Zone" };

/** several objects selected together (Shift+click, Shift+drag a box): what they are, and delete them all */
export function MultiSelection() {
  // (re-rendered when any part of the selection changes)
  useDeepSubject(ui, "selection"); useDeepSubject(ui, "multi"); useDeepSubject(ui, "extra");
  const [readOnly] = useDeepSubject(ui, "readOnly");
  const [net] = useSubject(network$);
  const all = selectedAll(), deletable = all.filter(x => DELETABLE.has(x.kind));
  const name = (s: Selection) => {
    if (s.kind === "link") return net.links.find(l => l.id === s.id)?.name || s.id;
    if (s.kind === "building") return net.buildings?.find(b => b.id === s.id)?.name || s.id;
    if (s.kind === "stop") return net.stops.find(x => x.id === s.id)?.name || s.id;
    return s.id;
  };
  const remove = () => { commit(deleteSelected(net, deletable)); select(null); };
  return (
    <div>
      <div className="border-b px-4 py-3">
        <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Selection</div>
        <div className="font-medium">{all.length} selected</div>
        <div className="text-xs text-muted-foreground">{describeSelection(all)}</div>
      </div>
      <Section>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="destructive" disabled={readOnly || !deletable.length} onClick={remove}>
            <Trash2 /> Delete {deletable.length === all.length ? "all" : `${deletable.length}`} <Kbd className="ml-1">Del</Kbd>
          </Button>
          <Button size="sm" variant="ghost" onClick={() => select(null)}><X /> Clear</Button>
        </div>
        {deletable.length < all.length && <p className="text-xs text-muted-foreground">Lanes and vehicles can&apos;t be deleted; they stay.</p>}
        <p className="text-[11px] text-muted-foreground">
          Shift+click adds or removes one, Shift+drag on the map adds everything in a box. Deleting a point takes its roads
          with it. Undo (⌘Z) brings it all back.
        </p>
      </Section>
      <Section title="Selected">
        <ul className="grid gap-1">
          {all.map(s => (
            <li key={`${s.kind}:${s.id}`} className="flex items-center gap-2 text-xs">
              <span className="w-16 shrink-0 text-muted-foreground">{KIND[s.kind] ?? s.kind}</span>
              <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" title="Select just this one" onClick={() => select(s)}>{name(s)}</button>
              <Button variant="ghost" size="icon" className="size-6" aria-label="Take out of the selection" title="Take out of the selection"
                onClick={() => selectMany(all.filter(x => !(x.kind === s.kind && x.id === s.id)))}><X className="size-3" /></Button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
