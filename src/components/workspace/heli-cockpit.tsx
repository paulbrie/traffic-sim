"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useDeepSubject, useSubject } from "subjecto/react";
import { simController } from "@/state/sim-controller";
import { stats$, ui } from "@/state/store";
import { junctionRefs } from "@/engine/refs";

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

/*
 * The cockpit is one drawing, 1600 × 900, scaled to cover the view and kept on the bottom edge.
 * The pilot sits on the right (as in most helicopters), so the post between the windscreens is left of the
 * middle and the view straight ahead stays clear. The eye looks at (800, 450).
 */
const W = 1600, H = 900;
// the flight display (PFD): attitude, speed and height tapes, heading
const P = { x: 680, y: 676, w: 240, h: 204, cy: 766 };
// the engine page, and the vehicle screen
const E = { x: 960, y: 676, w: 230, h: 204 };
const M = { x: 360, y: 676, w: 290, h: 204 };
const CLOCK = { x: 1290, y: 744, r: 46 };

/**
 * The helicopter's cockpit drawn over the 3D view. The view drives the instruments every frame
 * through `apiRef` (direct DOM writes, no React renders); the middle screen shows the selected
 * (or tracked) vehicle's live data.
 */
export function Cockpit({ apiRef, tracking }: { apiRef: RefObject<CockpitApi | null>; tracking: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const g = (k: string) => root.querySelector<SVGElement | HTMLElement>(`[data-g="${k}"]`);
    const keys = ["att", "spd", "spdTxt", "alt", "altTxt", "vsTxt", "vsBar", "hdg", "hdgTxt", "whisky", "range", "sights",
      "nrBar", "nrTxt", "trqBar", "trqTxt", "totBar", "totTxt", "fuel", "hh", "mm", "ss"];
    const el = Object.fromEntries(keys.map(k => [k, g(k)]));
    const last: Record<string, string> = {};
    const text = (k: string, t: string) => { const e = el[k]; if (e && last[k] !== t) { last[k] = t; e.textContent = t; } };
    const attr = (k: string, a: string, v: string) => { const e = el[k]; if (e && last[k + a] !== v) { last[k + a] = v; e.setAttribute(a, v); } };
    const t0 = performance.now();
    // the engine eases towards what the flight asks of it
    const eng = { trq: 40, tot: 640 };
    let lastT = t0;
    apiRef.current = {
      update(f) {
        const now = performance.now(), dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
        const kmh = f.speed * 3.6, deg = (r: number) => (r * 180) / Math.PI;
        // flight display
        const pitch = Math.max(-35, Math.min(35, deg(f.pitch))), roll = deg(f.roll);
        attr("att", "transform", `rotate(${(-roll).toFixed(2)} 800 ${P.cy}) translate(0 ${(pitch * 3).toFixed(1)})`);
        attr("spd", "transform", `translate(0 ${(kmh * 2).toFixed(1)})`);
        text("spdTxt", String(Math.round(kmh)));
        attr("alt", "transform", `translate(0 ${f.alt.toFixed(1)})`);
        text("altTxt", String(Math.round(f.alt)));
        const vs = Math.max(-10, Math.min(10, f.vs));
        attr("vsBar", "y", String(vs >= 0 ? P.cy - vs * 7 : P.cy)); attr("vsBar", "height", String(Math.max(0.5, Math.abs(vs) * 7)));
        text("vsTxt", `${f.vs >= 0 ? "+" : "−"}${Math.abs(f.vs).toFixed(1)}`);
        const h = ((f.heading % 360) + 360) % 360;
        attr("hdg", "transform", `translate(${(-h * 2.4).toFixed(1)} 0)`);
        const hs = String(Math.round(h) % 360).padStart(3, "0");
        text("hdgTxt", hs); text("whisky", hs);
        text("range", Number.isFinite(f.range) ? `${Math.round(f.range)} m` : "");
        const on = Number.isFinite(f.range) ? "1" : "0";
        if (el.sights && last.sights !== on) { last.sights = on; el.sights.style.opacity = on; }
        // engine: torque follows speed and climb; turbine temperature follows torque
        const k = 1 - Math.exp(-dt * 1.2), t = (now - t0) / 1000;
        eng.trq += (Math.max(18, Math.min(98, 34 + (f.speed / 55.6) * 42 + f.vs * 3.5)) - eng.trq) * k;
        eng.tot += (520 + eng.trq * 3.1 - eng.tot) * k;
        const nr = 100 + Math.sin(t * 0.7) * 0.4 + (eng.trq - 50) * 0.01;
        bar("nr", (nr - 90) / 20, nr.toFixed(1)); bar("trq", eng.trq / 110, eng.trq.toFixed(0)); bar("tot", (eng.tot - 300) / 600, eng.tot.toFixed(0));
        text("fuel", String(Math.max(0, Math.round(412 - t * 0.04))));
        // clock
        const d = new Date(), s = d.getSeconds() + d.getMilliseconds() / 1000, m = d.getMinutes() + s / 60, hr = (d.getHours() % 12) + m / 60;
        attr("hh", "transform", `rotate(${(hr * 30).toFixed(1)} ${CLOCK.x} ${CLOCK.y})`);
        attr("mm", "transform", `rotate(${(m * 6).toFixed(1)} ${CLOCK.x} ${CLOCK.y})`);
        attr("ss", "transform", `rotate(${(Math.floor(s) * 6).toFixed(0)} ${CLOCK.x} ${CLOCK.y})`);
      },
    };
    /** a bar gauge: share of its height filled, and its readout */
    function bar(k: string, share: number, label: string) {
      const hgt = Math.max(0, Math.min(1, share)) * BAR.h;
      attr(k + "Bar", "y", (BAR.y + BAR.h - hgt).toFixed(1)); attr(k + "Bar", "height", hgt.toFixed(1));
      text(k + "Txt", label);
    }
    return () => { apiRef.current = null; };
  }, [apiRef]);

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-[5] overflow-hidden select-none" aria-hidden>
      {/* the rotor's shadow sweeping over the canopy */}
      <div className="absolute -top-[70vmax] left-1/2 size-[140vmax] -translate-x-1/2 animate-[spin_0.85s_linear_infinite] opacity-[0.06] blur-md"
        style={{ background: "conic-gradient(#000 0deg 6deg, transparent 6deg 180deg, #000 180deg 186deg, transparent 186deg)" }} />
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMax slice" className="absolute inset-0 size-full">
        <Defs />
        <Glass />
        <Airframe />
        <Glareshield />
        <Panel tracking={tracking} />
      </svg>
      {/* the sights: in the middle of the windscreen when a vehicle is tracked */}
      <div data-g="sights" className="absolute top-1/2 left-1/2 size-20 -translate-x-1/2 -translate-y-1/2 opacity-0 transition-opacity" style={{ color: GREEN, filter: `drop-shadow(0 0 3px ${GREEN}80)` }}>
        <svg viewBox="0 0 80 80" className="size-full" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M4 20 V4 H20 M60 4 H76 V20 M76 60 V76 H60 M20 76 H4 V60" />
          <path d="M40 30 V36 M40 44 V50 M30 40 H36 M44 40 H50" strokeWidth="1.2" />
        </svg>
        <span data-g="range" className="absolute top-full left-1/2 mt-1 -translate-x-1/2 font-mono text-[11px] whitespace-nowrap" />
      </div>
    </div>
  );
}

function Defs() {
  return (
    <defs>
      <linearGradient id="ck-frame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2b3036" /><stop offset="1" stopColor="#15181c" /></linearGradient>
      <linearGradient id="ck-post" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#121417" /><stop offset="0.45" stopColor="#30353c" /><stop offset="1" stopColor="#181b1f" /></linearGradient>
      <linearGradient id="ck-roof" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0e1012" /><stop offset="1" stopColor="#262a30" /></linearGradient>
      <linearGradient id="ck-glare" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#30353b" /><stop offset="0.12" stopColor="#1a1d21" /><stop offset="1" stopColor="#0f1113" /></linearGradient>
      <linearGradient id="ck-panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1b1e22" /><stop offset="0.08" stopColor="#2b2f35" /><stop offset="1" stopColor="#202328" /></linearGradient>
      <linearGradient id="ck-shine" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" stopOpacity="0" /><stop offset="0.5" stopColor="#fff" stopOpacity="0.07" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
      <linearGradient id="ck-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#1b5fb5" /><stop offset="1" stopColor="#5aa2e6" /></linearGradient>
      <linearGradient id="ck-earth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8a5a2b" /><stop offset="1" stopColor="#4a2f15" /></linearGradient>
      <radialGradient id="ck-vignette" cx="0.5" cy="0.45" r="0.75"><stop offset="0.6" stopColor="#0a1a22" stopOpacity="0" /><stop offset="1" stopColor="#0a1a22" stopOpacity="0.35" /></radialGradient>
      <filter id="ck-grain" x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="1.4" numOctaves="2" seed="3" />
        <feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.35 0" />
        <feComposite in2="SourceGraphic" operator="in" />
      </filter>
      <filter id="ck-glow"><feGaussianBlur stdDeviation="1.2" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      <clipPath id="ck-pfd"><rect x={P.x} y={P.y} width={P.w} height={P.h} rx="3" /></clipPath>
      <clipPath id="ck-spd"><rect x={P.x} y={P.y + 22} width="46" height={P.h - 50} /></clipPath>
      <clipPath id="ck-alt"><rect x={P.x + P.w - 46} y={P.y + 22} width="46" height={P.h - 50} /></clipPath>
    </defs>
  );
}

/** the canopy: a tint at the edges, a reflection streak, eyebrow windows in the roof */
function Glass() {
  return (
    <g>
      <rect width={W} height={H} fill="url(#ck-vignette)" />
      <path d="M260 80 L520 70 L250 600 L120 600 Z" fill="url(#ck-shine)" />
      <path d="M1150 70 L1260 76 L1080 590 L1010 590 Z" fill="url(#ck-shine)" opacity="0.7" />
    </g>
  );
}

/** roof with its console, the posts, door frames and the sills of the chin windows */
function Airframe() {
  const switches = Array.from({ length: 7 }, (_, i) => i);
  return (
    <g>
      {/* roof, its tinted eyebrow windows, and the overhead console between the seats */}
      <path d="M0 0 H1600 V128 C1300 74 1000 56 800 54 C600 56 300 74 0 128 Z" fill="url(#ck-roof)" />
      <path d="M660 12 C900 6 1180 16 1400 46 L1392 74 C1180 54 940 44 660 48 Z" fill="#2c7a5c" opacity="0.38" />
      <path d="M100 52 C240 26 380 14 420 12 L420 48 C330 54 220 70 112 88 Z" fill="#2c7a5c" opacity="0.32" />
      <path d="M660 12 C900 6 1180 16 1400 46 L1392 74 C1180 54 940 44 660 48 Z" fill="none" stroke="#14171a" strokeWidth="6" />
      <path d="M430 0 H612 L600 66 L442 70 Z" fill="#1d2024" stroke="#0c0d0f" strokeWidth="2" />
      {switches.map(i => (
        <g key={i}>
          <rect x={452 + i * 20} y={20} width="10" height="16" rx="2" fill="#0d0e10" />
          <rect x={455 + i * 20} y={i % 3 === 0 ? 21 : 27} width="4" height="8" rx="1" fill="#b9bec4" />
          <rect x={452 + i * 20} y={44} width="12" height="8" rx="1" fill={i === 2 ? "#3a1a10" : "#101214"} stroke="#000" strokeWidth="0.5" />
        </g>
      ))}
      <path d="M0 128 C300 74 600 56 800 54 C1000 56 1300 74 1600 128" fill="none" stroke="#3a4048" strokeWidth="2" />
      {/* the post between the windscreens, with the standby compass on top */}
      <path d="M506 60 L536 60 L494 616 L456 616 Z" fill="url(#ck-post)" />
      <rect x="492" y="66" width="56" height="30" rx="6" fill="#111316" stroke="#000" strokeWidth="1.5" />
      <rect x="500" y="72" width="40" height="18" rx="3" fill="#e9e3d0" />
      <line x1="520" y1="70" x2="520" y2="92" stroke="#c22" strokeWidth="1.2" />
      <text data-g="whisky" x="520" y="81" fill="#111" fontSize="11" fontFamily={MONO} fontWeight="700" textAnchor="middle" dominantBaseline="central" />
      {/* door posts, the pilot's (right) and the co-pilot's (left) */}
      <path d="M1428 104 L1482 96 L1600 470 L1600 568 Z" fill="url(#ck-post)" />
      <path d="M1600 470 L1600 568 L1588 552 Z" fill="#0d0f11" />
      <path d="M118 106 L170 112 L22 560 L0 560 L0 470 Z" fill="url(#ck-post)" />
      {/* door frames down the sides, with the handle on the pilot's door */}
      <path d="M1540 560 L1600 568 L1600 900 L1560 900 Z" fill="url(#ck-frame)" />
      <rect x="1560" y="620" width="18" height="70" rx="6" fill="#0c0d0f" stroke="#3a3f46" strokeWidth="1.5" />
      <path d="M0 560 L22 560 L44 900 L0 900 Z" fill="url(#ck-frame)" />
      {/* sills between the windscreen and the chin windows, and the floor */}
      <path d="M22 560 L312 632 L318 652 L28 590 Z" fill="#1a1d21" />
      <path d="M1540 560 L1468 632 L1462 652 L1546 590 Z" fill="#1a1d21" />
      <path d="M44 866 C300 856 1300 856 1560 866 L1560 900 L44 900 Z" fill="#141619" />
      {/* the yaw pedals through the chin windows */}
      <path d="M1410 846 l34 -14 l10 24 l-34 12 Z M1490 840 l32 -10 l8 22 l-32 10 Z" fill="#222529" stroke="#0b0c0d" strokeWidth="1.5" />
    </g>
  );
}

/** the hood over the instruments, with its warning lights */
function Glareshield() {
  const lights: [string, string][] = [["ROTOR", "#1f3"], ["GEN", "#1f3"], ["XMSN", "#1f3"], ["FUEL", "#1f3"], ["LDG LT", "#555"], ["AP TRK", CYAN], ["CHIP", "#555"], ["MASTER", "#555"]];
  return (
    <g>
      <path d="M300 654 C312 610 350 594 420 590 L1384 590 C1440 594 1466 612 1474 654 Z" fill="url(#ck-glare)" />
      <path d="M300 654 C312 610 350 594 420 590 L1384 590 C1440 594 1466 612 1474 654" fill="none" stroke="#454b53" strokeWidth="1.5" />
      <rect x="306" y="650" width="1162" height="10" fill="#0b0c0e" />
      {lights.map(([t, c], i) => (
        <g key={t}>
          <rect x={548 + i * 76} y={612} width="66" height="20" rx="2" fill="#0a0b0c" stroke="#30353b" />
          <text x={581 + i * 76} y={622} fill={c} opacity={c === "#555" ? 0.6 : 1} fontSize="9.5" fontFamily={MONO} fontWeight="700" textAnchor="middle" dominantBaseline="central" filter={c === "#555" ? undefined : "url(#ck-glow)"}>{t}</text>
        </g>
      ))}
    </g>
  );
}

const BAR = { y: E.y + 38, h: 118, w: 24 };

function Panel({ tracking }: { tracking: boolean }) {
  return (
    <g>
      <path d="M310 658 H1464 L1446 866 C1100 860 700 860 328 866 Z" fill="url(#ck-panel)" />
      <path d="M310 658 H1464 L1446 866 C1100 860 700 860 328 866 Z" fill="#000" filter="url(#ck-grain)" opacity="0.6" />
      {/* screw heads in the corners */}
      {[[320, 668], [1454, 668], [334, 852], [1440, 852]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="3" fill="#3a3f46" stroke="#111" />)}
      <Bezel x={M.x} y={M.y} w={M.w} h={M.h} />
      <foreignObject x={M.x} y={M.y} width={M.w} height={M.h}><VehicleScreen tracking={tracking} /></foreignObject>
      <Bezel x={P.x} y={P.y} w={P.w} h={P.h} />
      <Pfd tracking={tracking} />
      <Bezel x={E.x} y={E.y} w={E.w} h={E.h} />
      <Engine />
      <Clock />
      {/* a row of rotary knobs and switches on the right of the panel */}
      {[0, 1, 2].map(i => (
        <g key={i}>
          <circle cx={1252 + i * 40} cy={824} r="11" fill="#141619" stroke="#3a3f46" strokeWidth="1.5" />
          <line x1={1252 + i * 40} y1={824} x2={1252 + i * 40 + 6} y2={816} stroke="#d0d4d8" strokeWidth="2" />
          <text x={1252 + i * 40} y={848} fill="#c9cdd2" fontSize="8" fontFamily={MONO} textAnchor="middle">{["DIM", "BARO", "HDG"][i]}</text>
        </g>
      ))}
    </g>
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

/** the engine page: rotor speed, torque, turbine temperature, fuel */
function Engine() {
  const gauges: [string, string, string, number, number][] = [
    // key, label, unit, top of the green band and of the amber band (shares of the bar)
    ["nr", "NR", "%", 0.65, 0.8], ["trq", "TRQ", "%", 0.77, 0.91], ["tot", "TOT", "°C", 0.75, 0.88],
  ];
  return (
    <g>
      <text x={E.x + 8} y={E.y + 14} fill={CYAN} fontSize="10" fontFamily={MONO} fontWeight="700" dominantBaseline="central">ENGINE · ROTOR</text>
      {gauges.map(([k, label, unit, g, a], i) => {
        const x = E.x + 14 + i * 50, gy = BAR.y + BAR.h * (1 - g), ay = BAR.y + BAR.h * (1 - a);
        return (
          <g key={k}>
            <text x={x + BAR.w / 2} y={BAR.y - 10} fill="#fff" fontSize="10" fontFamily={MONO} textAnchor="middle" dominantBaseline="central">{label}</text>
            <rect x={x} y={BAR.y} width={BAR.w} height={BAR.h} fill="#0c0f12" stroke="#4a5059" />
            <rect data-g={`${k}Bar`} x={x + 3} y={BAR.y + BAR.h} width={BAR.w - 6} height="0" fill="#e8ecef" />
            <line x1={x + BAR.w + 3} x2={x + BAR.w + 3} y1={gy} y2={BAR.y + BAR.h} stroke="#1fd36b" strokeWidth="3" />
            <line x1={x + BAR.w + 3} x2={x + BAR.w + 3} y1={ay} y2={gy} stroke={AMBER} strokeWidth="3" />
            <line x1={x - 2} x2={x + BAR.w + 6} y1={ay} y2={ay} stroke="#ff4a3d" strokeWidth="2" />
            <text data-g={`${k}Txt`} x={x + BAR.w / 2} y={BAR.y + BAR.h + 14} fill={GREEN} fontSize="11" fontFamily={MONO} fontWeight="700" textAnchor="middle" dominantBaseline="central" />
            <text x={x + BAR.w / 2} y={BAR.y + BAR.h + 26} fill="#8a9099" fontSize="8" fontFamily={MONO} textAnchor="middle" dominantBaseline="central">{unit}</text>
          </g>
        );
      })}
      <g fontFamily={MONO} fontSize="10" dominantBaseline="central">
        <text x={E.x + 170} y={E.y + 48} fill="#8a9099">FUEL</text>
        <text x={E.x + 170} y={E.y + 64} fill={GREEN} fontSize="13" fontWeight="700"><tspan data-g="fuel" /><tspan fontSize="9" fill="#8a9099"> kg</tspan></text>
        <text x={E.x + 170} y={E.y + 94} fill="#8a9099">OAT</text>
        <text x={E.x + 170} y={E.y + 110} fill={GREEN} fontSize="13" fontWeight="700">18<tspan fontSize="9" fill="#8a9099"> °C</tspan></text>
        <text x={E.x + 170} y={E.y + 140} fill="#8a9099">GEN</text>
        <text x={E.x + 170} y={E.y + 156} fill={GREEN} fontSize="13" fontWeight="700">28.2<tspan fontSize="9" fill="#8a9099"> V</tspan></text>
      </g>
    </g>
  );
}

function Clock() {
  const { x, y, r } = CLOCK;
  return (
    <g>
      <circle cx={x} cy={y} r={r + 7} fill="#111316" stroke="#3b4048" strokeWidth="1.5" />
      <circle cx={x} cy={y} r={r} fill="#08090a" />
      {Array.from({ length: 60 }, (_, i) => {
        const a = (i * Math.PI) / 30, big = i % 5 === 0, r0 = big ? r - 8 : r - 4;
        return <line key={i} x1={x + Math.sin(a) * r0} y1={y - Math.cos(a) * r0} x2={x + Math.sin(a) * (r - 1)} y2={y - Math.cos(a) * (r - 1)} stroke="#e8ecef" strokeWidth={big ? 1.8 : 0.7} />;
      })}
      {[12, 3, 6, 9].map((n, i) => <text key={n} x={x + Math.sin((i * Math.PI) / 2) * (r - 17)} y={y - Math.cos((i * Math.PI) / 2) * (r - 17)} fill="#e8ecef" fontSize="10" fontFamily={MONO} textAnchor="middle" dominantBaseline="central">{n}</text>)}
      <line data-g="hh" x1={x} y1={y + 4} x2={x} y2={y - r * 0.5} stroke="#f2f4f5" strokeWidth="3.2" strokeLinecap="round" />
      <line data-g="mm" x1={x} y1={y + 5} x2={x} y2={y - r * 0.78} stroke="#f2f4f5" strokeWidth="2.2" strokeLinecap="round" />
      <line data-g="ss" x1={x} y1={y + 8} x2={x} y2={y - r * 0.86} stroke={AMBER} strokeWidth="1" />
      <circle cx={x} cy={y} r="2.5" fill={AMBER} />
    </g>
  );
}

const TURN = { L: "LEFT", S: "AHEAD", R: "RIGHT", U: "U-TURN" } as const;

/** the screen on the left of the panel: live data of the selected vehicle */
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
