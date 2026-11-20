"use client";

import { useRef } from "react";
import { Cable, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { NumberField } from "@/components/workspace/fields";
import { cn } from "@/lib/utils";
import { groundUnder, hasHeights, type Sketch } from "@/lib/lane-sketch";
import {
  deleteUtilityNode, lineCount, lineLength, lineSize, linesThrough, MAX_COUNT, moveUtilityNode, NET_INFO, nodeMap, renameUtilityNode, updateUtilityLine,
  UTILITY_NETS, Z_MAX, Z_MIN, type LinePatch, type UtilityLine, type UtilityNet,
} from "@/lib/sketch-utilities";
import { useSketchStore } from "@/state/lane-sketch";
import { InspectorPanel } from "./inspector-panel";

const m = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} km` : `${v.toFixed(1)} m`);
/** the most nodes listed (a longer line: its first ones, and the one picked) */
const MAX_ROWS = 60;

/**
 * Utility lines selected (ticket #280). One: its name, network, buried or not, size, pipes or cables side by side, its
 * lengths (on the plan and in 3D), and its nodes, each x / y / z (z over the ground; with heights, its level above
 * sea level too), the one picked (`node`) with its name and lines. Several: how many and how long, to delete together.
 * Typing shows as it goes and is one undo step when let go; switches, menus and number fields one step each.
 */
export function UtilityPanel({ sketch, lines, node, readOnly, onDelete, onPickNode }: {
  sketch: Sketch; lines: UtilityLine[]; node: string | null; readOnly: boolean; onDelete: () => void; onPickNode: (id: string | null) => void;
}) {
  const { edit, show, record } = useSketchStore();
  const before = useRef<Sketch | null>(null);
  const start = () => { if (!before.current) before.current = sketch; };
  const done = () => { if (before.current) record(before.current); before.current = null; };
  const live = { onFocus: start, onBlur: done };
  const map = nodeMap(sketch), heights = hasHeights(sketch), ground = heights ? (p: { x: number; y: number }) => groundUnder(sketch, p) : undefined;

  if (lines.length !== 1) {
    const total = lines.reduce((a, l) => a + lineLength(sketch, l, ground, map).plan, 0);
    return (
      <InspectorPanel id="utility" title={`${lines.length} utility lines`} icon={<Cable className="size-3.5 shrink-0" />}
        actions={!readOnly && <Button size="icon-sm" variant="ghost" aria-label="Delete the lines" title="Delete them (Del)" onClick={onDelete}><Trash2 /></Button>}>
        <ul className="grid gap-1 text-xs">
          {UTILITY_NETS.map(n => { const ls = lines.filter(l => l.net === n); return ls.length ? <li key={n} className="flex justify-between gap-2"><span><Dot net={n} />{NET_INFO[n].label}</span><span className="font-mono tabular">{ls.length} · {m(ls.reduce((a, l) => a + lineLength(sketch, l, ground, map).plan, 0))}</span></li> : null; })}
        </ul>
        <div className="flex justify-between gap-2 text-xs"><span className="text-muted-foreground">Length, all</span><span className="font-mono tabular">{m(total)}</span></div>
      </InspectorPanel>
    );
  }

  const line = lines[0], info = NET_INFO[line.net], len = lineLength(sketch, line, ground, map);
  const set = (patch: LinePatch) => edit(sk => updateUtilityLine(sk, line.id, patch));
  const picked = node && line.nodes.includes(node) ? map.get(node) ?? null : null;
  const rows = line.nodes.map((id, i) => ({ id, i })).filter(r => r.i < MAX_ROWS || r.id === node);
  const kind = info.sizeUnit === "kV" ? "cables" : "pipes";
  return (
    <InspectorPanel id="utility" title={line.name} icon={<Cable className="size-3.5 shrink-0" style={{ color: info.color }} />}
      actions={!readOnly && <Button size="icon-sm" variant="ghost" aria-label="Delete the line" title="Delete it (Del; a node picked: the node)" onClick={onDelete}><Trash2 /></Button>}>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Name</span>
        <Input aria-label="Line name" value={line.name} className="h-8" disabled={readOnly} {...live} onChange={e => { start(); show(updateUtilityLine(sketch, line.id, { name: e.target.value })); }} />
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Network</span>
        <Select value={line.net} disabled={readOnly} onValueChange={v => set({ net: v as UtilityNet })}>
          <SelectTrigger aria-label="Network" className="h-8"><SelectValue /></SelectTrigger>
          <SelectContent>
            {UTILITY_NETS.map(n => <SelectItem key={n} value={n}><Dot net={n} />{NET_INFO[n].label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground" title="Buried: under the ground, drawn dashed. Turned on or off, its nodes on the wrong side of the ground move to the network's usual depth or height">Buried (below ground)</span>
        <Switch aria-label="Buried" checked={!!line.buried} disabled={readOnly} onCheckedChange={on => set({ buried: on })} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <NumberField id={`util-${line.id}-size`} label={info.sizeUnit === "kV" ? "Voltage" : "Diameter"} unit={info.sizeUnit} digits={info.sizeUnit === "kV" ? 2 : 0} value={lineSize(line)} min={info.sizeUnit === "kV" ? 0.1 : 10} max={info.sizeUnit === "kV" ? 800 : 5000} step={info.sizeUnit === "kV" ? 0.1 : 10}
          onCommit={v => set({ size: v })} />
        <NumberField id={`util-${line.id}-count`} label={`${kind[0].toUpperCase()}${kind.slice(1)} side by side`} digits={0} value={lineCount(line)} min={1} max={MAX_COUNT} step={1}
          onCommit={v => set({ count: v })} />
      </div>
      <div className="grid gap-0.5 text-xs">
        <div className="flex justify-between gap-2"><span className="text-muted-foreground">Length on the plan</span><span className="font-mono tabular">{m(len.plan)}</span></div>
        <div className="flex justify-between gap-2"><span className="text-muted-foreground" title="Along its nodes in 3D: its rises and falls (and the ground's, with heights) counted">Length in 3D</span><span className="font-mono tabular">{m(len.real)}</span></div>
        {lineCount(line) > 1 && <div className="flex justify-between gap-2"><span className="text-muted-foreground">All its {kind}</span><span className="font-mono tabular">{m(len.real * lineCount(line))}</span></div>}
      </div>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Nodes <span className="text-[11px]">(z: metres over the ground, below it negative)</span></span>
        <div className="grid grid-cols-[1.5rem_1fr_1fr_1fr] items-center gap-x-1.5 gap-y-1" role="table" aria-label="Nodes">
          <span role="columnheader" aria-label="Node" className="text-[11px] text-muted-foreground">#</span>
          <span role="columnheader" className="text-[11px] text-muted-foreground">x (m)</span>
          <span role="columnheader" className="text-[11px] text-muted-foreground">y (m)</span>
          <span role="columnheader" className="text-[11px] text-muted-foreground">z (m)</span>
          {rows.map(({ id, i }) => {
            const n = map.get(id);
            if (!n) return null;
            const on = id === node, shared = linesThrough(sketch, id).length > 1;
            return (
              <div key={`${id}:${i}`} role="row" className="contents">
                <button type="button" role="cell" className={cn("rounded text-[11px] font-mono tabular", on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
                  title={`${n.name ?? `Node ${id}`}${shared ? " · lines join here" : ""} · pick it`} onClick={() => onPickNode(on ? null : id)}>{i + 1}{shared ? "•" : ""}</button>
                {(["x", "y", "z"] as const).map(k => (
                  <NumberField key={k} id={`util-${line.id}-${i}-${k}`} label={`Node ${i + 1} ${k}`} hideLabel digits={2} step={k === "z" ? 0.1 : 0.5} value={n[k]}
                    min={k === "z" ? Z_MIN : undefined} max={k === "z" ? Z_MAX : undefined} className="[&_input]:h-7 [&_input]:px-1.5 [&_input]:text-xs"
                    onCommit={v => edit(sk => moveUtilityNode(sk, id, { [k]: v }))} />
                ))}
              </div>
            );
          })}
        </div>
        {line.nodes.length > rows.length && <span className="text-[11px] text-muted-foreground">…and {line.nodes.length - rows.length} more (pick one on the map)</span>}
      </div>
      {picked && (
        <div className="grid gap-1.5 rounded-md border p-2 text-xs">
          <div className="flex items-center gap-1">
            <span className="font-medium">Node {picked.id}</span>
            <span className="text-muted-foreground">· {picked.z < 0 ? `${(-picked.z).toFixed(2)} m deep` : picked.z > 0 ? `${picked.z.toFixed(2)} m up` : "on the ground"}{ground ? ` · ${(ground(picked) + picked.z).toFixed(1)} m above sea level` : ""}</span>
            <Button size="icon-sm" variant="ghost" className="ml-auto size-6" aria-label="Let the node go" onClick={() => onPickNode(null)}><X /></Button>
          </div>
          <Input aria-label="Node name" placeholder="Name (a valve, a manhole, a pole…)" value={picked.name ?? ""} className="h-7" disabled={readOnly} {...live}
            onChange={e => { start(); show(renameUtilityNode(sketch, picked.id, e.target.value)); }} />
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{linesThrough(sketch, picked.id).map(l => l.name).join(", ")}</span>
            {!readOnly && <Button size="sm" variant="outline" className="h-7" onClick={() => { edit(sk => deleteUtilityNode(sk, picked.id)); onPickNode(null); }} title="The node taken out of each line through it (their neighbours joined); a line left with one node goes">Delete node</Button>}
          </div>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Drag it to move it, or a node to move that node (drop it on another of the network&apos;s nodes to join them there). Double-click the line to add a
        node, or a node to take it out. Utility lines are only drawn: the cars don&apos;t see them.
      </p>
    </InspectorPanel>
  );
}

export function Dot({ net }: { net: UtilityNet }) {
  return <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full align-middle" style={{ background: NET_INFO[net].color }} />;
}
