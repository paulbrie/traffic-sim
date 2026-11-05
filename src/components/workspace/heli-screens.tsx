"use client";

/** V1's cockpit screens (see heli-cockpit.tsx): the selected vehicle's live data, and what the pointer is over */
import { useDeepSubject, useSubject } from "subjecto/react";
import { simController } from "@/state/sim-controller";
import { network$, stats$, ui } from "@/state/store";
import { junctionRefs } from "@/engine/refs";
import { minSec } from "@/lib/time";
import { describe, type Hovered } from "./hover-info";
import { AMBER, Center, GREEN, Screen } from "./heli-cockpit";

const TURN = { L: "LEFT", S: "AHEAD", R: "RIGHT", U: "U-TURN" } as const;

/** the screen on the left of the display: live data of the selected vehicle */
export function VehicleScreen({ tracking }: { tracking: boolean }) {
  useSubject(stats$); // re-render with the stats cadence (~4×/s)
  const [selection] = useDeepSubject(ui, "selection");
  const sim = simController.sim, id = selection?.kind === "vehicle" ? selection.id : null;
  const d = id && sim?.vehicle && String(sim.vehicle.id) === id && sim.vehicles.some(x => x.id === sim.vehicle!.id) ? sim.vehicle : null;
  const body = (() => {
    if (!id) return <Center>NO TARGET<small>click a vehicle, then Track</small></Center>;
    if (!d) return <Center>{sim?.vehicles.some(x => String(x.id) === id) ? "ACQUIRING…" : "TARGET LOST"}<small>#{id}</small></Center>;
    const kmh = d.v * 3.6, want = Math.max(1, d.v0 * 3.6), share = Math.min(1, kmh / want);
    const nt = d.nextTurn, ref = nt ? junctionRefs(simController.compiled).get(nt.node) : undefined;
    const rows: [string, string][] = [
      ["ROAD", d.road],
      ["LANE", d.lane !== null && d.lanes !== null ? `${d.lane + 1} / ${d.lanes}` : "–"],
      ["NEXT", nt ? `${TURN[nt.turn]}${ref ? ` @ ${ref}` : ""}` : "–"],
      ["TO", d.heading],
      ["GAP", Number.isFinite(d.gap) && d.gap < 100 ? `${d.gap.toFixed(1)} m` : "CLEAR"],
      ["TRIP", minSec(d.trip)],
      ["IN TRAFFIC", `${minSec(d.jam)}${d.trip > 0 ? ` · ${Math.round((100 * d.jam) / d.trip)}%` : ""}`],
      ["WAIT", `${d.wait.toFixed(0)} s`],
      ["LN CHG", `${d.laneChanges}  RRT ${d.reroutes}`],
    ];
    if (d.kind === "bus") rows.push(["PAX", `${d.pax} / ${d.cap}`]);
    return (
      <div className="grid h-full grid-cols-[auto_1fr] gap-x-3">
        <div className="flex flex-col justify-between">
          <div className="text-[9px] text-[#6fd8ff]">{tracking ? "TRACKING" : "SELECTED"} · {d.kind.toUpperCase()} #{d.id}</div>
          <div className="leading-none"><span className="text-[30px] font-semibold tabular-nums">{kmh.toFixed(0)}</span><span className="ml-1 text-[9px] opacity-70">KM/H</span></div>
          <div>
            <div className="h-1.5 w-24 overflow-hidden rounded-sm bg-white/10"><div className="h-full" style={{ width: `${share * 100}%`, background: share < 0.3 ? "#ff5a4f" : share < 0.7 ? AMBER : GREEN }} /></div>
            <div className="mt-0.5 text-[8px] opacity-70">OF {want.toFixed(0)} WANTED</div>
          </div>
          <div className="text-[10px]">
            <span className={d.acc < -0.3 ? "text-[#ff5a4f]" : d.acc > 0.3 ? "" : "opacity-70"}>{d.acc >= 0 ? "+" : "−"}{Math.abs(d.acc).toFixed(2)} m/s²</span>
          </div>
          <div className="w-fit max-w-28 truncate rounded-sm border border-current/40 px-1 text-[8px]">{d.state.toUpperCase()}</div>
        </div>
        <dl className="grid min-w-0 auto-rows-min grid-cols-[auto_1fr] content-center gap-x-2 gap-y-[3px] text-[9.5px] leading-tight">
          {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-[#6fd8ff]/80">{k}</dt><dd className="truncate text-right">{v}</dd></div>)}
        </dl>
      </div>
    );
  })();
  return (
    <div className="relative size-full overflow-hidden rounded-[3px] bg-[#03100a] px-2.5 py-2 font-mono" style={{ color: GREEN, textShadow: `0 0 4px ${GREEN}55` }}>
      {body}
      {/* scanlines and a little glare on the glass */}
      <div className="pointer-events-none absolute inset-0 opacity-25" style={{ background: "repeating-linear-gradient(0deg, transparent 0 2px, rgba(0,0,0,0.6) 2px 3px)" }} />
      <div className="pointer-events-none absolute inset-0" style={{ background: "linear-gradient(125deg, rgba(255,255,255,0.06) 0 30%, transparent 30%)" }} />
    </div>
  );
}
/** the screen left of the vehicle's: what the pointer is over (a road, junction, building, marker, vehicle) */
export function InspectScreen({ at }: { at: Hovered | null }) {
  useSubject(stats$); // live figures (~4×/s)
  const [net] = useSubject(network$);
  const info = at ? describe(at, net, simController.compiled) : null;
  return (
    <Screen>
      {!info ? <Center>INSPECT<small>point at a road, a junction, a building…</small></Center> : (
        <div className="flex h-full flex-col">
          <div className="text-[9px] text-[#6fd8ff]">INSPECT · {({ link: "ROAD", node: "JUNCTION", building: "BUILDING", marker: "MARKER", vehicle: "VEHICLE" } as const)[at!.kind]}</div>
          <div className="mt-1 truncate text-[15px] font-semibold leading-tight">{info.title}</div>
          {info.sub && <div className="truncate text-[9.5px] opacity-70">{info.sub}</div>}
          <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-2 gap-y-[3px] text-[9.5px] leading-tight">
            {info.rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-[#6fd8ff]/80 uppercase">{k}</dt><dd className="truncate text-right">{v}</dd></div>)}
          </dl>
        </div>
      )}
    </Screen>
  );
}
