"use client";

import { useDeepSubject } from "subjecto/react";
import { Check, PenLine, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { alignableNodes, simplifyRing } from "@/engine/compile";
import type { Network, NodeDef } from "@/engine/types";
import { commit, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { Section } from "./fields";

/**
 * Junction editor: the outline (automatic from the lanes, or drawn by hand), lane lines through the
 * junction, and painted areas (hatched, or kerbed islands), to match the real junction.
 */
export function JunctionShapeSection({ net, node }: { net: Network; node: NodeDef }) {
  const [shape] = useDeepSubject(ui, "shape");
  const cn = simController.compiled.nodeById.get(node.id);
  if (!cn || cn.ringR > 0) return null;
  const canAlign = alignableNodes(net).includes(node.id);
  const editing = shape.edit === node.id, drawing = shape.paint?.node === node.id ? shape.paint : null;
  const startEdit = () => {
    // start from the current outline, thinned out to points worth dragging
    if (!node.outline) commit(ops.setOutline(net, node.id, simplifyRing(cn.polygon, 0.15).map(p => ({ x: p.x - node.x, y: p.y - node.y }))));
    const s = ui.getValue().shape; s.paint = null; s.edit = node.id;
  };
  const draw = (kind: "hatch" | "island") => { const s = ui.getValue().shape; s.edit = null; s.paint = { node: node.id, kind, pts: [] }; };
  return (
    <Section title="Shape">
      <div className="flex flex-wrap gap-2">
        {editing
          ? <Button size="sm" onClick={() => { ui.getValue().shape.edit = null; }}><Check /> Done</Button>
          : <Button size="sm" variant="outline" onClick={startEdit}><PenLine /> Edit outline</Button>}
        {node.outline && <Button size="sm" variant="ghost" onClick={() => { commit(ops.setOutline(net, node.id, null)); ui.getValue().shape.edit = null; }}><RotateCcw /> Automatic outline</Button>}
      </div>
      <p className="text-xs text-muted-foreground">
        {editing
          ? "Drag the square points to follow the kerb on the aerial (hold Shift to leave the grid). Double-click an edge to add a point, Alt+click a point to remove it."
          : node.outline ? "Outline drawn by hand." : "Automatic outline: the road ends plus every lane path through the junction."}
      </p>
      {(canAlign || node.align) && (
        <>
          <label className="flex items-center justify-between gap-2 text-sm">
            <span>Line up lanes</span>
            <Switch checked={!!node.align} onCheckedChange={v => commit(ops.updateNode(net, node.id, v ? { align: true, connShape: undefined, ...(node.connectors ? { connectors: node.connectors.map(x => ({ in: x.in, a: x.a, out: x.out, b: x.b })) } : {}) } : { align: undefined }))} aria-label="Line up lanes" />
          </label>
          <p className="text-xs text-muted-foreground">
            A one-way road carrying on one direction of a two-way road here (a road splitting into two carriageways) gets its
            lanes shifted to continue exactly where that direction&apos;s lanes are, so the paths run straight. Turning it on
            clears connector shapes set by hand here.
          </p>
        </>
      )}
      <label className="flex items-center justify-between gap-2 text-sm">
        <span>Lane lines through the junction</span>
        <Switch checked={!!node.laneLines} onCheckedChange={v => commit(ops.updateNode(net, node.id, { laneLines: v || undefined }))} aria-label="Lane lines through the junction" />
      </label>
      <div className="grid gap-1.5">
        <div className="text-xs font-medium">Painted areas</div>
        {(node.paint ?? []).map((a, i) => (
          <div key={i} className="flex items-center justify-between gap-2 text-xs">
            <span>{a.kind === "hatch" ? "Hatched area" : "Island"} · {a.pts.length} points</span>
            <Button variant="ghost" size="icon" className="size-6" aria-label="Remove" onClick={() => commit(ops.removePaint(net, node.id, i))}><Trash2 className="size-3" /></Button>
          </div>
        ))}
        {drawing ? (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={drawing.pts.length < 3} onClick={() => {
              const s = ui.getValue().shape, p = s.paint!;
              if (p.kind === "hatch" || p.kind === "island") commit(ops.addPaint(net, node.id, p.kind, p.pts.map(q => ({ x: q.x - node.x, y: q.y - node.y }))));
              s.paint = null;
            }}><Check /> Finish</Button>
            <Button size="sm" variant="ghost" onClick={() => { ui.getValue().shape.paint = null; }}>Cancel</Button>
            <span className="text-xs text-muted-foreground">{drawing.pts.length} points</span>
          </div>
        ) : (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => draw("hatch")}>Add hatched area</Button>
            <Button size="sm" variant="outline" onClick={() => draw("island")}>Add island</Button>
          </div>
        )}
        {drawing && <p className="text-xs text-muted-foreground">Click the corners on the map; double-click or Enter to finish, Esc to cancel.</p>}
      </div>
      <p className="text-[11px] text-muted-foreground">
        To change how a lane runs through the junction, show the Connectors layer, click a lane path and drag its handles
        (Shift to move a handle freely).
      </p>
    </Section>
  );
}
