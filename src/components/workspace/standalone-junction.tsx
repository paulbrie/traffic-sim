"use client";

import { Link2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { JunctionDef, Network } from "@/engine/types";
import { busy, commit, network$, select } from "@/state/store";
import { deleteStandalone, joinStandalone } from "@/state/junctions";
import { Section } from "./fields";

/** a junction standing on its own: no road joined to it yet */
export function StandaloneJunctionInspector({ net, j }: { net: Network; j: JunctionDef }) {
  const join = () => void busy("Joining the roads…", () => {
    const r = joinStandalone(network$.getValue(), j.id);
    if (!r) { toast.info("Not yet", { description: "Fewer than two roads reach it: draw roads to it, across it or ending up to 6 m outside it." }); return; }
    commit(r.net); select({ kind: "node", id: r.junction.nodes[0] });
  });
  return (
    <div>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Junction on its own</div>
          <div className="font-medium">No roads yet</div>
        </div>
        <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="Delete the junction" title="Delete it (Del)" onClick={() => { commit(deleteStandalone(net, j.id)); select(null); }}><Trash2 /></Button>
      </div>
      <Section>
        <p className="text-sm">Its area is drawn; it becomes a junction with lane connectors, control and signs once two roads reach it.</p>
        <p className="text-xs text-muted-foreground">Draw roads ending inside it: they join it as soon as there are two. Roads already there (across its outline, or ending up to 6 m outside it) join with the button.</p>
        <Button size="sm" variant="outline" onClick={join}><Link2 /> Join the roads that reach it</Button>
      </Section>
    </div>
  );
}
