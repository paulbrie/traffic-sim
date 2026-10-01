"use client";
// TEMPORARY: visual check of the helicopter cockpit (delete after)
import { useEffect, useRef } from "react";
import { Cockpit, type CockpitApi } from "@/components/workspace/heli-cockpit";

export default function Page() {
  const api = useRef<CockpitApi>(null);
  useEffect(() => {
    let raf = 0;
    const f = (t: number) => { api.current?.update({ alt: 87, speed: 41, vs: 1.6, heading: 62, pitch: -0.32, roll: 0.08, range: 52 }); raf = requestAnimationFrame(f); };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="relative h-dvh w-full overflow-hidden" style={{ background: "linear-gradient(#bcd3e6 0 30%, #7f9a6a 30%, #6d8a5c 100%)" }}>
      <div className="absolute top-[30%] left-0 right-0 bottom-0" style={{ background: "repeating-linear-gradient(90deg, transparent 0 140px, #555 140px 152px), repeating-linear-gradient(0deg, transparent 0 120px, #555 120px 130px)" }} />
      <Cockpit apiRef={api} tracking />
    </div>
  );
}
