"use client";

import { Fragment } from "react";
import { useSubject } from "subjecto/react";
import { Button } from "@/components/ui/button";
import { connectorId } from "@/engine/compile";
import { junctionRefs } from "@/engine/refs";
import { connectorsOf } from "@/render/draw2d";
import { select, stats$ } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { IdChip, Section, compass } from "./fields";

const TURN_NAME = { L: "left", S: "ahead", R: "right", U: "U-turn" } as const;
const GLYPH = { L: "←", S: "↑", R: "→", U: "↶" } as const;

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => <Fragment key={k}><dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd></Fragment>)}
    </dl>
  );
}
function Head({ kind, title, id }: { kind: string; title: string; id?: string }) {
  return (
    <div className="border-b px-4 py-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{kind}{id && <IdChip id={id} />}</div>
      <div className="truncate font-medium">{title}</div>
    </div>
  );
}

/** one lane of one direction of a road */
export function LaneInspector({ id }: { id: string }) {
  useSubject(stats$);
  const [linkId, dirS, laneS] = id.split("|"), dir = Number(dirS), lane = Number(laneS);
  const c = simController.compiled, e = c.edgeByKey.get(`${linkId}:${dir}`), lp = e?.lanes[lane];
  if (!e || !lp) return <div><Head kind="Lane" title="This lane no longer exists" /></div>;
  const n = e.to, arm = e.inArm, moves = (n.moves.get(e.idx) ?? []).filter(m => lane >= m.lo && lane <= m.hi);
  const ref = junctionRefs(c).get(n.def.id);
  const head = compass(e.center.at(e.center.len).x - e.center.at(0).x, e.center.at(e.center.len).y - e.center.at(0).y).name;
  const phases = n.controlled && n.def.control === "lights" ? n.lanePhases[arm]?.[lane] ?? [] : null;
  const live = simController.sim?.laneStats(lp.id);
  const rows: [string, React.ReactNode][] = [
    ["Road", <button key="r" type="button" className="underline-offset-2 hover:underline" onClick={() => select({ kind: "link", id: linkId })}>{e.link.name || "Unnamed road"}</button>],
    ["Heading", head],
    ["Lane", `${lane + 1} of ${e.n} (1 = leftmost)`],
    ["Turns at the end", moves.length ? moves.map(m => GLYPH[m.turn]).join(" ") : "none"],
    ["Bus lane", e.bus && lane === e.n - 1 ? "yes" : "no"],
    ["Length", `${lp.len.toFixed(0)} m`],
    ["Speed limit", `${Math.round(e.speed * 3.6)} km/h`],
    ...(ref ? [["Junction ahead", <button key="j" type="button" className="underline-offset-2 hover:underline" onClick={() => select({ kind: "node", id: n.def.id })}>{ref}</button>] as [string, React.ReactNode]] : []),
    ...(phases ? [["Green in phase", phases.length ? phases.map(p => p + 1).join(", ") : "never"] as [string, React.ReactNode]] : []),
    ...(live ? [["Vehicles now", String(live.vehicles)] as [string, React.ReactNode], ["Their speed", live.vehicles ? `${(live.speed * 3.6).toFixed(0)} km/h` : "–"] as [string, React.ReactNode]] : []),
  ];
  return (
    <div>
      <Head kind="Lane" id={id} title={`${e.link.name || "Unnamed road"} · lane ${lane + 1}`} />
      <Section><Rows rows={rows} /></Section>
    </div>
  );
}

/** a lane connector: the path from one lane through a junction into another */
export function ConnectorInspector({ id }: { id: string }) {
  useSubject(stats$);
  const c = simController.compiled;
  const v = connectorsOf(c).find(x => connectorId(x) === id);
  if (!v) return <div><Head kind="Lane connector" title="This connector no longer exists" /></div>;
  const ref = junctionRefs(c).get(v.node.def.id) ?? "junction";
  const inName = v.move.in.link.name || "unnamed road", outName = v.move.out.link.name || "unnamed road";
  const taken = simController.sim?.turnCounts.get(`${v.move.in.idx}>${v.move.out.idx}`);
  const phases = v.node.def.control === "lights" ? v.node.lanePhases[v.move.in.inArm]?.[v.inLane] ?? [] : null;
  const rows: [string, React.ReactNode][] = [
    ["Junction", <button key="j" type="button" className="underline-offset-2 hover:underline" onClick={() => select({ kind: "node", id: v.node.def.id })}>{ref}</button>],
    ["Turn", TURN_NAME[v.move.turn]],
    ["From", `${inName}, lane ${v.inLane + 1}`],
    ["To", `${outName}, lane ${v.outLane + 1}`],
    ["Control", v.node.def.control],
    ...(phases ? [["Green in phase", phases.length ? phases.map(p => p + 1).join(", ") : "never"] as [string, React.ReactNode]] : []),
    ...(taken !== undefined ? [["Vehicles on this turn", String(taken)] as [string, React.ReactNode]] : []),
  ];
  return (
    <div>
      <Head kind="Lane connector" id={id} title={`${ref}: ${TURN_NAME[v.move.turn]} from ${inName}`} />
      <Section>
        <Rows rows={rows} />
        <p className="text-[11px] text-muted-foreground">Vehicles on this turn counts every lane making it. Lane arrows and signal phases are set on the road and the junction.</p>
        <Button variant="outline" size="sm" className="justify-self-start" onClick={() => select({ kind: "link", id: v.move.in.link.id })}>Open the road</Button>
      </Section>
    </div>
  );
}
