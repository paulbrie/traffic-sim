"use client";

import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RING_MAX, RING_MIN, type Network, type RingDef } from "@/engine/types";
import { commit, select } from "@/state/store";
import { deleteRing, removeRingPoint, ringPoints, setRing } from "@/state/rings";
import { NumberField, Section } from "./fields";

/** a ring placed by hand (or one of its points, `point`): its size and lanes, its points, and how to join it */
export function RingInspector({ net, r, point }: { net: Network; r: RingDef; point?: string }) {
  const pts = ringPoints(net, r);
  // how many lanes join it, and lead off it, at each point (connectors into its roads, out of them)
  const ringRoads = new Set(net.links.filter(l => l.ring === r.id).map(l => l.id));
  let ins = 0, outs = 0;
  for (const n of net.nodes) for (const c of n.connectors ?? []) {
    const fromRing = ringRoads.has(c.in.split(":")[0]), toRing = ringRoads.has(c.out.split(":")[0]);
    if (toRing && !fromRing) ins++;
    if (fromRing && !toRing) outs++;
  }
  const takeOff = () => {
    const out = removeRingPoint(net, r.id, point!);
    if ("error" in out) { toast.error(out.error); return; }
    commit(out); select({ kind: "ring", id: r.id });
  };
  return (
    <div>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{point ? "Point of a ring" : "Ring"}</div>
          <div className="font-medium">{Math.round(r.kerb)} m · {r.lanes} lane{r.lanes === 1 ? "" : "s"}</div>
        </div>
        <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="Delete the ring" title="Delete the ring (its roads, and connectors to and from it)" onClick={() => { commit(deleteRing(net, r.id)); select(null); }}><Trash2 /></Button>
      </div>
      {point && (
        <Section title="This point">
          <p className="text-xs text-muted-foreground">Drag it round the ring to move where lanes join or leave. Drag from the ring lane&apos;s end here to a lane leaving (within 60 m) to lead traffic off the ring.</p>
          <Button size="sm" variant="outline" onClick={takeOff}><Trash2 /> Take this point off <span className="ml-1 text-muted-foreground">(Del)</span></Button>
        </Section>
      )}
      <Section title="Ring">
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="ring-kerb" label="Radius (outer kerb)" unit="m" value={r.kerb} min={RING_MIN} max={RING_MAX} step={0.5} digits={1} onCommit={v => commit(setRing(net, r.id, { kerb: v }), `ringk:${r.id}`)} />
          <label className="flex items-end justify-between gap-2 pb-2 text-sm">
            <span>Two lanes</span>
            <Switch checked={r.lanes === 2} onCheckedChange={v => commit(setRing(net, r.id, { lanes: v ? 2 : 1 }))} aria-label="Two circulating lanes" />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">{pts.length} points · {ins} lane{ins === 1 ? "" : "s"} joining it · {outs} leading off it. Traffic on the ring drives on; traffic joining it gives way, and waits while it is nearly full.</p>
        <p className="text-[11px] text-muted-foreground">
          Drag the ring to move it, a point to slide it round. Double-click the ring to add a point. To join it, draw a connector from a lane&apos;s end and drop it anywhere on the ring; to leave it, pick a point and drag from the ring lane&apos;s end there to a lane leaving.
        </p>
      </Section>
    </div>
  );
}
