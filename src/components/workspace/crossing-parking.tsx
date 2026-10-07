"use client";

import { useDeepSubject, useSubject } from "subjecto/react";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BAY_SIZE, PARKING, type CrossingDef, type Network, type ParkingDef, type ParkingKind } from "@/engine/types";
import { commit, select, stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";
import * as ops from "@/state/ops";
import { IdChip, NumberField, Section } from "./fields";

function Header({ kind, id, title, onDelete }: { kind: string; id: string; title: string; onDelete: () => void }) {
  const [readOnly] = useDeepSubject(ui, "readOnly");
  return (
    <div className="flex items-center gap-2 border-b px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{kind}<IdChip id={id} /></div>
        <div className="truncate font-medium">{title}</div>
      </div>
      {!readOnly && <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`Delete ${kind.toLowerCase()}`}><Trash2 /></Button>}
    </div>
  );
}

function Readings({ rows }: { rows: [string, string][] }) {
  return (
    <div className="grid grid-cols-3 gap-2 text-center">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-md border px-2 py-1.5"><div className="font-mono text-sm font-semibold tabular">{v}</div><div className="text-[10px] text-muted-foreground">{k}</div></div>
      ))}
    </div>
  );
}

/** a zebra crossing drawn by hand: where it is, how wide, how busy, and its pedestrians while traffic runs */
export function CrossingInspector({ net, x }: { net: Network; x: CrossingDef }) {
  useSubject(stats$);
  const set = (patch: Partial<CrossingDef>, key?: string) => commit(ops.updateCrossing(net, x.id, patch), key);
  const len = Math.hypot(x.b.x - x.a.x, x.b.y - x.a.y);
  const k = simController.compiled.crossings.findIndex(c => c.def.id === x.id), live = k >= 0 ? simController.sim?.crossingStats(k) : null;
  return (
    <div>
      <Header kind="Zebra crossing" id={x.id} title={`${len.toFixed(1)} m from kerb to kerb`} onDelete={() => { commit(ops.deleteCrossing(net, x.id)); select(null); }} />
      <Section>
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="xw" label="Width (along the traffic)" unit="m" value={x.width} min={1.5} max={12} step={0.1} digits={1} onCommit={v => set({ width: v }, `xw:${x.id}`)} />
          <NumberField id="xp" label="Pedestrians per hour" unit="/h" value={x.peds} min={0} max={5000} step={50} digits={0} onCommit={v => set({ peds: Math.round(v) }, `xp:${x.id}`)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="xax" label="One kerb: X (east)" unit="m" value={x.a.x} onCommit={v => set({ a: { ...x.a, x: v } }, `xa:${x.id}`)} />
          <NumberField id="xay" label="Y (south)" unit="m" value={x.a.y} onCommit={v => set({ a: { ...x.a, y: v } }, `xa:${x.id}`)} />
          <NumberField id="xbx" label="Other kerb: X (east)" unit="m" value={x.b.x} onCommit={v => set({ b: { ...x.b, x: v } }, `xb:${x.id}`)} />
          <NumberField id="xby" label="Y (south)" unit="m" value={x.b.y} onCommit={v => set({ b: { ...x.b, y: v } }, `xb:${x.id}`)} />
        </div>
        <p className="text-xs text-muted-foreground">
          Pedestrians have priority: vehicles stop before it while they wait or cross (one too close to stop goes first). Where the paths over it have
          traffic lights, they walk early in the red of the straight-on traffic over it, and turning vehicles give way to them. A crossing with a refuge in
          the middle is two crossings. Drag it on the map to move it, or drag a square end to move that kerb end (Shift: off the grid).
        </p>
      </Section>
      <Section title="Live">
        {live ? <Readings rows={[["Crossed", String(live.crossed)], ["Avg wait", `${live.avgWait.toFixed(0)} s`], ["Waiting", String(live.waiting)]]} />
          : <p className="text-xs text-muted-foreground">Run traffic to see its pedestrians.</p>}
      </Section>
    </div>
  );
}

const KIND_LABEL: Record<ParkingKind, string> = { parallel: "Parallel to the kerb", perpendicular: "Perpendicular (90°)", angled: "Angled" };

/** a row of parking bays: the bays, how they are used, and how full they are while traffic runs */
export function ParkingInspector({ net, p }: { net: Network; p: ParkingDef }) {
  useSubject(stats$);
  const set = (patch: Partial<ParkingDef>, key?: string) => commit(ops.updateParking(net, p.id, patch), key);
  const c = simController.compiled.parking.find(x => x.def.id === p.id), size = BAY_SIZE[p.kind];
  const link = ops.linkById(net, p.link), other = p.dir === 1 ? -1 : 1, otherLanes = link ? (other === 1 ? link.lanesF : link.lanesB) : 0;
  const live = c ? simController.sim?.parkingStats(c.idx) : null, line = p.line;
  return (
    <div>
      <Header kind="Parking bays" id={p.id} title={c ? `${c.bays.length} bay${c.bays.length === 1 ? "" : "s"} on ${link?.name || "a road"}` : "No room for a bay here"} onDelete={() => { commit(ops.deleteParking(net, p.id)); select(null); }} />
      <Section title="Bays">
        <Select value={p.kind} onValueChange={v => set({ kind: v as ParkingKind, bayW: undefined, bayL: undefined, ...(v === "angled" ? { angle: p.angle ?? PARKING.angle } : { angle: undefined }) })}>
          <SelectTrigger className="w-full" aria-label="Kind of bays"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(KIND_LABEL) as ParkingKind[]).map(k => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
        </Select>
        <div className="grid grid-cols-2 gap-2">
          {p.kind === "angled" && <NumberField id="pa" label="Angle to the kerb" unit="°" value={p.angle ?? PARKING.angle} min={20} max={80} step={5} digits={0} onCommit={v => set({ angle: Math.round(v) }, `pa:${p.id}`)} />}
          <NumberField id="pw" label={p.kind === "parallel" ? "Bay width (across)" : "Bay width"} unit="m" value={p.bayW ?? size.w} min={1.8} max={4} step={0.1} digits={1} onCommit={v => set({ bayW: v }, `pw:${p.id}`)} />
          <NumberField id="pl" label={p.kind === "parallel" ? "Bay length" : "Bay depth"} unit="m" value={p.bayL ?? size.l} min={3.5} max={9} step={0.1} digits={1} onCommit={v => set({ bayL: v }, `pl:${p.id}`)} />
          <NumberField id="pax" label="One end: X (east)" unit="m" value={line.a.x} onCommit={v => set({ line: { ...line, a: { ...line.a, x: v } } }, `pla:${p.id}`)} />
          <NumberField id="pay" label="Y (south)" unit="m" value={line.a.y} onCommit={v => set({ line: { ...line, a: { ...line.a, y: v } } }, `pla:${p.id}`)} />
          <NumberField id="pbx" label="Other end: X (east)" unit="m" value={line.b.x} onCommit={v => set({ line: { ...line, b: { ...line.b, x: v } } }, `plb:${p.id}`)} />
          <NumberField id="pby" label="Y (south)" unit="m" value={line.b.y} onCommit={v => set({ line: { ...line, b: { ...line.b, y: v } } }, `plb:${p.id}`)} />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => set({ line: { ...line, side: line.side === 1 ? -1 : 1 } })}><ArrowLeftRight /> Bays on the other side</Button>
          {otherLanes > 0 && <Button size="sm" variant="outline" onClick={() => set({ dir: other as 1 | -1 })}><ArrowLeftRight /> Reached from the other lanes</Button>}
        </div>
        <p className="text-xs text-muted-foreground">
          {`Standing on its own: drag it anywhere, or drag an end to stretch it. Cars reach it from ${link?.name || "the nearest road"}: they stop in its kerb lane to turn in (a few seconds), and wait for a gap to pull out. Draw more rows for a car park; a short row holds a single bay.`}
        </p>
      </Section>
      <Section title="Use">
        <div className="grid grid-cols-2 gap-2">
          <NumberField id="po" label="Usually taken" unit="%" value={Math.round((p.occupancy ?? PARKING.occupancy) * 100)} min={0} max={100} step={5} digits={0} onCommit={v => set({ occupancy: v / 100 }, `po:${p.id}`)} />
          <NumberField id="ps" label="Average stay" unit="min" value={p.stay ?? PARKING.stay} min={1} max={1440} step={5} digits={0} onCommit={v => set({ stay: v }, `ps:${p.id}`)} />
        </div>
        <label className="flex items-center justify-between gap-2 text-sm">
          <span>Cars pulling out have priority</span>
          <Switch checked={!p.giveWay} onCheckedChange={v => set({ giveWay: v ? undefined : true })} aria-label="Cars pulling out have priority" />
        </label>
        <p className="text-xs text-muted-foreground">{p.giveWay ? "Cars pulling out wait for a gap in the lane's traffic (in a queue that can take long)." : "The lane's traffic lets cars out: whoever can still stop comfortably stops short of a car waiting to pull out, queues included."}</p>
        <p className="text-xs text-muted-foreground">Cars come at the rate that keeps it about this full (a car finding it full goes elsewhere), and stay this long on average (some much longer).</p>
      </Section>
      <Section title="Live">
        {live ? (
          <>
            <Readings rows={[["Taken", `${live.taken} / ${live.bays}`], ["On the way", String(live.coming)], ["Found it full", String(live.full)]]} />
            <p className="text-xs text-muted-foreground tabular">{live.parked} parked and {live.left} pulled out so far.</p>
          </>
        ) : <p className="text-xs text-muted-foreground">Run traffic to see how full it is.</p>}
      </Section>
    </div>
  );
}
