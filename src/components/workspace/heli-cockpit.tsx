"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { simController } from "@/state/sim-controller";
import { stats$, ui } from "@/state/store";
import { junctionRefs } from "@/engine/refs";
import { minSec } from "@/lib/time";

/** what the 3D view tells the cockpit every frame */
export interface Flight {
  /** height above the ground, m */
  alt: number;
  /** ground speed and climb rate, m/s */
  speed: number; vs: number;
  /** compass heading of the nose, degrees (0 = north) */
  heading: number;
  /** nose up, right wing down, radians */
  pitch: number; roll: number;
  /** distance to the vehicle in the sights, m (NaN: none) */
  range: number;
}
export interface CockpitApi { update(f: Flight): void }

const GREEN = "#62f5a0", AMBER = "#ffb83d", CYAN = "#6fd8ff", MAG = "#ff6bd6";
const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

// the display's drawing (units): the vehicle screen and, right of it, the flight display (PFD)
const M = { x: 360, y: 676, w: 290, h: 204 };
const P = { x: 680, y: 676, w: 240, h: 204, cy: 766 };
const VIEW = { x: M.x - 14, y: M.y - 14, w: P.x + P.w + 14 - (M.x - 14), h: M.h + 28 };

/**
 * What the pilot sees besides the helicopter's own cabin (the 3D model): sights on the tracked vehicle and
 * a display at the bottom with the selected (or tracked) vehicle's live data and the flight instruments.
 * The view drives the instruments every frame through `apiRef` (direct DOM writes, no React renders).
 */
export function Cockpit({ apiRef, tracking }: { apiRef: RefObject<CockpitApi | null>; tracking: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const g = (k: string) => root.querySelector<SVGElement | HTMLElement>(`[data-g="${k}"]`);
    const keys = ["att", "spd", "spdTxt", "alt", "altTxt", "vsTxt", "vsBar", "hdg", "hdgTxt", "range", "sights"];
    const el = Object.fromEntries(keys.map(k => [k, g(k)]));
    const last: Record<string, string> = {};
    const text = (k: string, t: string) => { const e = el[k]; if (e && last[k] !== t) { last[k] = t; e.textContent = t; } };
    const attr = (k: string, a: string, v: string) => { const e = el[k]; if (e && last[k + a] !== v) { last[k + a] = v; e.setAttribute(a, v); } };
    apiRef.current = {
      update(f) {
        const kmh = f.speed * 3.6, deg = (r: number) => (r * 180) / Math.PI;
        const pitch = Math.max(-35, Math.min(35, deg(f.pitch))), roll = deg(f.roll);
        attr("att", "transform", `rotate(${(-roll).toFixed(2)} ${P.x + P.w / 2} ${P.cy}) translate(0 ${(pitch * 3).toFixed(1)})`);
        attr("spd", "transform", `translate(0 ${(kmh * 2).toFixed(1)})`);
        text("spdTxt", String(Math.round(kmh)));
        attr("alt", "transform", `translate(0 ${f.alt.toFixed(1)})`);
        text("altTxt", String(Math.round(f.alt)));
        const vs = Math.max(-10, Math.min(10, f.vs));
        attr("vsBar", "y", String(vs >= 0 ? P.cy - vs * 7 : P.cy)); attr("vsBar", "height", String(Math.max(0.5, Math.abs(vs) * 7)));
        text("vsTxt", `${f.vs >= 0 ? "+" : "−"}${Math.abs(f.vs).toFixed(1)}`);
        const h = ((f.heading % 360) + 360) % 360;
        attr("hdg", "transform", `translate(${(-h * 2.4).toFixed(1)} 0)`);
        text("hdgTxt", String(Math.round(h) % 360).padStart(3, "0"));
        text("range", Number.isFinite(f.range) ? `${Math.round(f.range)} m` : "");
        const on = Number.isFinite(f.range) ? "1" : "0";
        if (el.sights && last.sights !== on) { last.sights = on; el.sights.style.opacity = on; }
      },
    };
    return () => { apiRef.current = null; };
  }, [apiRef]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[5] overflow-hidden select-none" aria-hidden>
      {/* the sights: in the middle of the view when a vehicle is tracked */}
      <div data-g="sights" className="absolute top-1/2 left-1/2 size-20 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity" style={{ color: GREEN, filter: `drop-shadow(0 0 3px ${GREEN}80)` }}>
        <svg viewBox="0 0 80 80" className="size-full" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 20 V4 H20 M60 4 H76 V20 M76 60 V76 H60 M20 76 H4 V60" />
          <path d="M40 30 V36 M40 44 V50 M30 40 H36 M44 40 H50" strokeWidth="1.2" />
        </svg>
        <span data-g="range" className="absolute top-full left-1/2 mt-1 -translate-x-1/2 font-mono text-[11px] whitespace-nowrap" />
      </div>
      <div className="absolute bottom-3 left-1/2 w-[min(600px,62%)] -translate-x-1/2 rounded-xl bg-[#111316]/90 shadow-lg ring-1 ring-black/60 backdrop-blur-sm">
        <svg viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`} className="block w-full">
          <Defs />
          <Bezel x={M.x} y={M.y} w={M.w} h={M.h} />
          <foreignObject x={M.x} y={M.y} width={M.w} height={M.h}><VehicleScreen tracking={tracking} /></foreignObject>
          <Bezel x={P.x} y={P.y} w={P.w} h={P.h} />
          <Pfd tracking={tracking} />
        </svg>
      </div>
    </div>
  );
}

function Defs() {
  return (
    <defs>
      <linearGradient id="ck-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1b5fb5" /><stop offset="1" stopColor="#5aa2e6" /></linearGradient>
      <linearGradient id="ck-earth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8a5a2b" /><stop offset="1" stopColor="#4a2f15" /></linearGradient>
      <clipPath id="ck-pfd"><rect x={P.x} y={P.y} width={P.w} height={P.h} rx="3" /></clipPath>
      <clipPath id="ck-spd"><rect x={P.x} y={P.y + 22} width="46" height={P.h - 50} /></clipPath>
      <clipPath id="ck-alt"><rect x={P.x + P.w - 46} y={P.y + 22} width="46" height={P.h - 50} /></clipPath>
    </defs>
  );
}

function Bezel({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <g>
      <rect x={x - 8} y={y - 8} width={w + 16} height={h + 16} rx="7" fill="#111316" stroke="#050506" strokeWidth="1.5" />
      <rect x={x - 8} y={y - 8} width={w + 16} height={h + 16} rx="7" fill="none" stroke="#3b4048" strokeWidth="1" strokeDasharray={`${w + h} ${w + h}`} />
      <rect x={x} y={y} width={w} height={h} rx="3" fill="#020304" />
    </g>
  );
}

/** the flight display: attitude, speed tape (left), height tape (right), climb rate, heading */
function Pfd({ tracking }: { tracking: boolean }) {
  const cx = P.x + P.w / 2, L = P.x, R = P.x + P.w, top = P.y + 22, bot = P.y + P.h - 26;
  const ladder = [-30, -20, -15, -10, -5, 5, 10, 15, 20, 30];
  const spd = [];
  for (let s = 0; s <= 300; s += 10) {
    const y = P.cy - s * 2;
    spd.push(<line key={s} x1={L + 38} x2={L + 46} y1={y} y2={y} stroke="#fff" strokeWidth="1.2" />);
    if (s % 20 === 0) spd.push(<text key={`t${s}`} x={L + 34} y={y} fill="#fff" fontSize="11" fontFamily={MONO} textAnchor="end" dominantBaseline="central">{s}</text>);
  }
  const alt = [];
  for (let a = 0; a <= 1500; a += 10) {
    const y = P.cy - a;
    alt.push(<line key={a} x1={R - 46} x2={R - (a % 50 === 0 ? 36 : 40)} y1={y} y2={y} stroke="#fff" strokeWidth="1.2" />);
    if (a % 50 === 0) alt.push(<text key={`t${a}`} x={R - 4} y={y} fill="#fff" fontSize="10.5" fontFamily={MONO} textAnchor="end" dominantBaseline="central">{a}</text>);
  }
  const hdg = [];
  for (let d = -180; d <= 540; d += 5) {
    const x = cx + d * 2.4, n = ((d % 360) + 360) % 360;
    hdg.push(<line key={d} x1={x} x2={x} y1={bot} y2={bot + (n % 10 === 0 ? 7 : 4)} stroke="#fff" strokeWidth="1" />);
    if (n % 30 === 0) hdg.push(<text key={`t${d}`} x={x} y={bot + 16} fill={n % 90 === 0 ? CYAN : "#fff"} fontSize="10" fontFamily={MONO} textAnchor="middle" dominantBaseline="central">{({ 0: "N", 90: "E", 180: "S", 270: "W" } as Record<number, string>)[n] ?? n / 10}</text>);
  }
  return (
    <g clipPath="url(#ck-pfd)">
      <g data-g="att">
        <rect x={cx - 400} y={P.cy - 600} width="800" height="600" fill="url(#ck-sky)" />
        <rect x={cx - 400} y={P.cy} width="800" height="600" fill="url(#ck-earth)" />
        <line x1={cx - 400} x2={cx + 400} y1={P.cy} y2={P.cy} stroke="#fff" strokeWidth="1.5" />
        {ladder.map(p => (
          <g key={p}>
            <line x1={cx - (p % 10 === 0 ? 26 : 13)} x2={cx + (p % 10 === 0 ? 26 : 13)} y1={P.cy - p * 3} y2={P.cy - p * 3} stroke="#fff" strokeWidth="1.2" />
            {p % 10 === 0 && <text x={cx + 32} y={P.cy - p * 3} fill="#fff" fontSize="9" fontFamily={MONO} dominantBaseline="central">{Math.abs(p)}</text>}
          </g>
        ))}
      </g>
      {/* bank scale and the aircraft symbol */}
      <path d={`M${cx - 52} ${P.cy - 50} A72 72 0 0 1 ${cx + 52} ${P.cy - 50}`} fill="none" stroke="#fff" strokeWidth="1.2" transform={`translate(0 -2)`} />
      <path d={`M${cx} ${P.cy - 70} l-5 -9 h10 Z`} fill="#fff" />
      <path d={`M${cx - 40} ${P.cy} h22 l6 7 M${cx + 40} ${P.cy} h-22 l-6 7`} stroke="#000" strokeWidth="6" fill="none" strokeLinejoin="round" />
      <path d={`M${cx - 40} ${P.cy} h22 l6 7 M${cx + 40} ${P.cy} h-22 l-6 7`} stroke="#ffd23d" strokeWidth="3.5" fill="none" strokeLinejoin="round" />
      <rect x={cx - 2.5} y={P.cy - 2.5} width="5" height="5" fill="#ffd23d" stroke="#000" />
      {/* speed tape */}
      <rect x={L} y={top} width="46" height={bot - top} fill="#000" opacity="0.45" />
      <g clipPath="url(#ck-spd)"><g data-g="spd">{spd}</g></g>
      <path d={`M${L} ${P.cy - 11} h40 l7 11 l-7 11 h-40 Z`} fill="#000" stroke="#fff" strokeWidth="1.2" />
      <text data-g="spdTxt" x={L + 36} y={P.cy} fill="#fff" fontSize="14" fontFamily={MONO} fontWeight="700" textAnchor="end" dominantBaseline="central" />
      {/* height tape and climb bar */}
      <rect x={R - 46} y={top} width="46" height={bot - top} fill="#000" opacity="0.45" />
      <g clipPath="url(#ck-alt)"><g data-g="alt">{alt}</g></g>
      <rect data-g="vsBar" x={R - 52} y={P.cy} width="4" height="0" fill={MAG} />
      <path d={`M${R} ${P.cy - 11} h-40 l-7 11 l7 11 h40 Z`} fill="#000" stroke="#fff" strokeWidth="1.2" />
      <text data-g="altTxt" x={R - 4} y={P.cy} fill="#fff" fontSize="14" fontFamily={MONO} fontWeight="700" textAnchor="end" dominantBaseline="central" />
      {/* top line: units, mode, climb rate */}
      <rect x={L} y={P.y} width={P.w} height="20" fill="#000" />
      <text x={L + 4} y={P.y + 10} fill={CYAN} fontSize="10" fontFamily={MONO} dominantBaseline="central">KM/H</text>
      <text x={cx} y={P.y + 10} fill={tracking ? GREEN : "#8a9099"} fontSize="10" fontFamily={MONO} fontWeight="700" textAnchor="middle" dominantBaseline="central">{tracking ? "TRK  ALT HLD" : "MAN"}</text>
      <text x={R - 4} y={P.y + 10} fill={MAG} fontSize="10" fontFamily={MONO} textAnchor="end" dominantBaseline="central"><tspan fill={CYAN}>VS </tspan><tspan data-g="vsTxt" /></text>
      {/* heading strip */}
      <rect x={L} y={bot} width={P.w} height="26" fill="#000" />
      <g data-g="hdg">{hdg}</g>
      <rect x={cx - 18} y={bot - 15} width="36" height="15" fill="#000" stroke="#fff" strokeWidth="1" />
      <text data-g="hdgTxt" x={cx} y={bot - 7.5} fill="#fff" fontSize="11" fontFamily={MONO} fontWeight="700" textAnchor="middle" dominantBaseline="central" />
    </g>
  );
}

const TURN = { L: "LEFT", S: "AHEAD", R: "RIGHT", U: "U-TURN" } as const;

/** the screen on the left of the display: live data of the selected vehicle */
function VehicleScreen({ tracking }: { tracking: boolean }) {
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
function Center({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-1 text-sm tracking-widest [&_small]:text-[9px] [&_small]:tracking-normal [&_small]:opacity-60">{children}</div>;
}
