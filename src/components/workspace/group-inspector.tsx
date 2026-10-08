"use client";

import { useState } from "react";
import { BookmarkPlus, Copy, LogIn, LogOut, RotateCcw, RotateCw, Trash2, Ungroup } from "lucide-react";
import { toast } from "sonner";
import { useDeepSubject } from "subjecto/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import type { GroupDef, Network } from "@/engine/types";
import { commit, select, ui } from "@/state/store";
import { sendView } from "@/state/commands";
import { deleteGroup, groupNodes, groupPorts, renameGroup, rotateGroup, takeOut, ungroup } from "@/state/groups";
import { copyPiece } from "@/state/placing";
import { saveToJunctionLibrary } from "@/server/actions";
import { Section } from "./fields";

/** a junction group: its name, its entry and exit points, and what can be done with it as one */
export function GroupInspector({ net, g }: { net: Network; g: GroupDef }) {
  const [inside] = useDeepSubject(ui, "groupEdit");
  const [readOnly] = useDeepSubject(ui, "readOnly");
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const ports = groupPorts(net, g), points = groupNodes(net, g);
  const junctions = [...points].filter(id => net.links.filter(l => l.from === id || l.to === id).length >= 3).length;
  const roadName = (id: string) => { const l = net.links.find(x => x.id === id); return l?.name || id; };
  const joinedTo = (node: string) => net.links.find(l => (l.from === node || l.to === node) && !g.links.includes(l.id));
  const turn = (deg: number) => commit(rotateGroup(net, g, (deg * Math.PI) / 180), `turn:${g.id}`);
  const save = async () => {
    setSaving(true);
    const r = await saveToJunctionLibrary(g.name, takeOut(net, g)).catch(() => ({ ok: false as const, error: "Couldn't save it." }));
    setSaving(false);
    if (r.ok) toast.success(`Saved “${g.name}” to your junction library`, { description: "Place it in any of your plans from Junctions in the top bar." });
    else toast.error(r.error);
  };
  return (
    <div>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Junction group</div>
          <div className="truncate font-medium">{g.name}</div>
        </div>
        {!readOnly && <Button size="icon-sm" variant="ghost" className="text-destructive" aria-label="Delete the junction" title="Delete the junction: its roads and points (Del)" onClick={() => { commit(deleteGroup(net, g.id)); select(null); }}><Trash2 /></Button>}
      </div>
      <Section>
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">Name</span>
          <Input value={name ?? g.name} disabled={readOnly} onChange={e => setName(e.target.value)}
            onBlur={() => { if (name !== null && name.trim() && name.trim() !== g.name) commit(renameGroup(net, g.id, name.trim())); setName(null); }}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        </label>
        <p className="text-xs text-muted-foreground">{g.links.length} roads · {junctions} junction{junctions === 1 ? "" : "s"} · {ports.length} entry / exit point{ports.length === 1 ? "" : "s"}</p>
        <div className="flex flex-wrap gap-2">
          {inside === g.id
            ? <Button size="sm" variant="outline" onClick={() => { ui.getValue().groupEdit = null; select({ kind: "group", id: g.id }); }}><LogOut /> Come out <Kbd className="ml-1">Esc</Kbd></Button>
            : <Button size="sm" variant="outline" title="Edit its roads and junctions one by one (or double-click it on the map)" onClick={() => { ui.getValue().groupEdit = g.id; }}><LogIn /> Go inside</Button>}
          <Button size="sm" variant="outline" title="Copy it, to place again here or in another plan (⌘C, then ⌘V)" onClick={() => void copyPiece(takeOut(net, g)).then(() => toast.success(`Copied ${g.name}`, { description: "⌘V / Ctrl+V to place it." }))}><Copy /> Copy</Button>
          <Button size="sm" variant="outline" disabled={saving} title="Save it to your junction library, to place in any of your plans" onClick={save}><BookmarkPlus /> Save to library</Button>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Turn</span>
            <Button size="sm" variant="ghost" onClick={() => turn(-15)} title="Turn it 15° anticlockwise"><RotateCcw /> 15°</Button>
            <Button size="sm" variant="ghost" onClick={() => turn(15)} title="Turn it 15° clockwise"><RotateCw /> 15°</Button>
            <Button size="sm" variant="ghost" className="ml-auto" title="Keep its roads and junctions, as they are, but not as one" onClick={() => { commit(ungroup(net, g.id)); select(null); }}><Ungroup /> Ungroup</Button>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">Drag it to move it. Double-click it to go inside and edit its roads, junctions, lanes and connectors; Esc comes back out.</p>
      </Section>
      <Section title="Entry and exit points">
        {!ports.length && <p className="text-xs text-muted-foreground">None: no road leaves it. A road drawn on from one of its loose ends makes one.</p>}
        <ul className="grid gap-1.5">
          {ports.map(p => {
            const other = joinedTo(p.node);
            return (
              <li key={p.node} className="flex items-center gap-2 text-xs">
                <button type="button" className="font-mono underline decoration-dotted underline-offset-2 hover:decoration-solid" title="Select this point and go to it"
                  onClick={() => { ui.getValue().groupEdit = g.id; select({ kind: "node", id: p.node }); sendView("focus", p.at.x, p.at.y); }}>{p.node}</button>
                <span className="text-muted-foreground">{p.lanesIn ? `${p.lanesIn} in` : ""}{p.lanesIn && p.lanesOut ? " · " : ""}{p.lanesOut ? `${p.lanesOut} out` : ""}</span>
                <span className="min-w-0 flex-1 truncate text-right">{other ? `joins ${roadName(other.id)}` : <span className="text-amber-700 dark:text-amber-400">loose end</span>}</span>
              </li>
            );
          })}
        </ul>
        <p className="text-[11px] text-muted-foreground">Where a road of the plan joins it, or could: drag a loose end onto a road end to join them.</p>
      </Section>
    </div>
  );
}
