"use client";

/**
 * The V2 cockpit's screens (ticket #129; the cockpit is heli-cockpit.tsx, V1's screens heli-screens.tsx): the car picked
 * (tracked), its speed and what it does, from the editor's live car info; and what the pointer is over, as the map's
 * hover card says it (describeHover).
 */
import type { SketchSim } from "@/lib/lane-sketch-sim";
import { AMBER, Center, CYAN, GREEN, Screen } from "@/components/workspace/heli-cockpit";
import type { HoverInfo } from "./sketch-hover-card";
import { fmtFuel } from "./fuel-panel";

type CarInfo = ReturnType<SketchSim["inspect"]>;

/** the car picked: its speed of the speed it wants, and the rest of what the hover card says of it */
export function VehicleScreenV2({ id, info, about, tracking }: { id: number | null; info: CarInfo; about: HoverInfo | null; tracking: boolean }) {
  if (id === null) return <Screen><Center>NO TARGET<small>click a car, then Track</small></Center></Screen>;
  if (!info) return <Screen><Center>ACQUIRING…<small>car {id}</small></Center></Screen>;
  const share = Math.min(1, info.kmh / Math.max(1, info.desiredKmh));
  return (
    <Screen>
      <div className="grid h-full grid-cols-[auto_1fr] gap-x-3">
        <div className="flex flex-col justify-between">
          <div className="text-[9px]" style={{ color: CYAN }}>{tracking ? "TRACKING" : "SELECTED"} · {info.bus ? "BUS" : info.truck ? "TRUCK" : "CAR"} #{info.id}</div>
          <div className="leading-none"><span className="text-[30px] font-semibold tabular-nums">{info.kmh.toFixed(0)}</span><span className="ml-1 text-[9px] opacity-70">KM/H</span></div>
          <div>
            <div className="h-1.5 w-24 overflow-hidden rounded-sm bg-white/10"><div className="h-full" style={{ width: `${share * 100}%`, background: share < 0.3 ? "#ff5a4f" : share < 0.7 ? AMBER : GREEN }} /></div>
            <div className="mt-0.5 text-[8px] opacity-70">OF {info.desiredKmh.toFixed(0)} WANTED</div>
          </div>
          <div className="w-fit max-w-28 truncate rounded-sm border border-current/40 px-1 text-[8px]">{info.broken !== null ? "BROKEN DOWN" : info.why ? "WAITING" : info.kmh < 1 ? "STOPPED" : "DRIVING"}</div>
        </div>
        <dl className="grid min-w-0 auto-rows-min grid-cols-[auto_1fr] content-center gap-x-2 gap-y-[3px] text-[9.5px] leading-tight">
          {(about?.rows ?? []).filter(([k]) => k !== "Speed").map(([k, v]) => <div key={k} className="contents"><dt className="uppercase" style={{ color: `${CYAN}cc` }}>{k}</dt><dd className="truncate text-right">{v}</dd></div>)}
          {info.why && <div className="contents"><dt style={{ color: `${CYAN}cc` }}>WAITS FOR</dt><dd className="truncate text-right">{info.why}</dd></div>}
          {Number.isFinite(info.fuel) && <div className="contents"><dt style={{ color: `${CYAN}cc` }}>FUEL</dt><dd className="truncate text-right">{fmtFuel(info.fuel / 1000)}</dd></div>}
        </dl>
      </div>
    </Screen>
  );
}

/** what the pointer is over (a lane, a junction, a connector, a car…) */
export function InspectScreenV2({ info }: { info: HoverInfo | null }) {
  return (
    <Screen>
      {!info ? <Center>INSPECT<small>point at a lane, a junction, a car…</small></Center> : (
        <div className="flex h-full flex-col">
          <div className="text-[9px]" style={{ color: CYAN }}>INSPECT</div>
          <div className="mt-1 truncate text-[15px] leading-tight font-semibold">{info.title}</div>
          {info.sub && <div className="truncate text-[9.5px] opacity-70">{info.sub}</div>}
          <dl className="mt-auto grid grid-cols-[auto_1fr] gap-x-2 gap-y-[3px] text-[9.5px] leading-tight">
            {info.rows.map(([k, v]) => <div key={k} className="contents"><dt className="uppercase" style={{ color: `${CYAN}cc` }}>{k}</dt><dd className="truncate text-right">{v}</dd></div>)}
          </dl>
        </div>
      )}
    </Screen>
  );
}
