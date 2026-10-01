"use client";

import { useState } from "react";
import { useDeepSubject } from "subjecto/react";
import { Columns2, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { MAX_MEDIAN, type LinkDef, type Network } from "@/engine/types";
import { carriagewayRun, splitCarriageways } from "@/state/carriageways";
import { commit, select, ui } from "@/state/store";
import * as ops from "@/state/ops";
import { NumberField, Section } from "./fields";

/** openings need room for a car to wait in the gap */
const OPENING_MIN_GAP = 15;

/**
 * Split a two-way road into two one-way carriageways, so the junctions along it each belong to one
 * direction: the selected roads, or the road and its continuation straight on.
 */
export function CarriagewaysSection({ net, link }: { net: Network; link: LinkDef }) {
  const [multi] = useDeepSubject(ui, "multi");
  const [gap, setGap] = useState(() => Math.max(1, link.median ?? 0));
  const [openings, setOpenings] = useState(false);
  if (!(link.lanesF > 0 && link.lanesB > 0) || link.rev) return null;
  const run = carriagewayRun(net, link.id, multi);
  if ("error" in run) return <Section title="Carriageways"><p className="text-xs text-muted-foreground">{run.error}</p></Section>;
  const node = (id: string) => ops.nodeById(net, id)!;
  const length = run.links.reduce((s, x) => { const l = ops.linkById(net, x.id)!; return s + ops.linkLength(l, node(l.from), node(l.to)); }, 0);
  const junctions = run.nodes.slice(1, -1).filter(id => ops.linksAt(net, id).length > 2).length;
  const canOpen = gap >= OPENING_MIN_GAP;
  const show = () => { select({ kind: "link", id: run.links[0].id }); ui.getValue().multi = run.links.slice(1).map(x => x.id); };
  const split = () => {
    const r = splitCarriageways(net, run, { gap, openings: openings && canOpen });
    if ("error" in r) return;
    commit(r.net);
    select({ kind: "link", id: r.forward[0] });
  };
  return (
    <Section title="Carriageways">
      <p className="text-xs text-muted-foreground">
        Make this a divided road: one one-way road per direction, side by side. Each junction along it is split
        too, every side road joining the carriageway on its side, so it only meets that direction.
      </p>
      <p className="text-xs">
        {multi.length ? "The selected roads" : run.links.length > 1 ? "This road and its continuation straight on" : "This road"}:{" "}
        {run.links.length} piece{run.links.length === 1 ? "" : "s"}, {Math.round(length)} m, {junctions} junction{junctions === 1 ? "" : "s"} on the way.
      </p>
      <div className="grid grid-cols-[1fr_5.5rem] items-center gap-2">
        <span className="text-sm">Gap between them</span>
        <NumberField id="cwgap" label="Gap between the carriageways" hideLabel unit="m" value={gap} min={0.5} max={MAX_MEDIAN} step={0.5} digits={1} onCommit={v => setGap(Math.max(0.5, Math.min(MAX_MEDIAN, v)))} />
      </div>
      <label className="flex items-center justify-between gap-2 text-sm">
        <span className={canOpen ? "" : "text-muted-foreground"}>Openings at the junctions</span>
        <Switch checked={openings && canOpen} disabled={!canOpen} onCheckedChange={setOpenings} aria-label="Openings at the junctions" />
      </label>
      <p className="text-[11px] text-muted-foreground">
        {canOpen
          ? "A short crossing through the gap at each junction, so traffic from a side road can still turn across to the other direction (and back)."
          : `Without openings side roads only turn right in and out. Openings need a gap of ${OPENING_MIN_GAP} m or more, so a car can wait in them.`}
      </p>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={split}><Columns2 /> Split into two carriageways</Button>
        <Button size="sm" variant="outline" onClick={show} title="Select the roads it would split"><Eye /> Show</Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Shift+click roads to choose exactly which ones to split. The road splits a little before the junction at each end, which keeps its shape.
      </p>
    </Section>
  );
}
