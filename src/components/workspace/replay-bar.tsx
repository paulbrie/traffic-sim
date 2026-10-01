"use client";

import { useEffect, useRef, useState } from "react";
import { useSubject } from "subjecto/react";
import { Pause, Play, Radio, SkipBack, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";

const clock = (s: number) => {
  const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/**
 * Replay what the simulation did, like a video player: every step is kept in memory (as much as fits);
 * drag to any step, step back and forward, play it back at the chosen speed. Live goes back to the running
 * simulation (replaying doesn't change it).
 */
export function ReplayBar() {
  useSubject(stats$); // (refreshes with the live numbers and with each replayed step)
  const [playing, setPlaying] = useState(false);
  const rec = simController.rec, rp = simController.replay;
  const cur = rp ? rp.tick : rec.to;
  const playRef = useRef({ last: 0, at: 0 });
  // playing back: advance at the chosen simulation speed (10 steps a second at 1×), one step request at a time
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    playRef.current = { last: performance.now(), at: simController.replay?.tick ?? simController.rec.from };
    const tick = (now: number) => {
      const p = playRef.current, dt = (now - p.last) / 1000;
      p.last = now;
      p.at += dt * 10 * ui.getValue().sim.speed;
      const target = Math.min(simController.rec.to, Math.round(p.at));
      if (!simController.replayPending && target !== simController.replay?.tick) simController.replayAt(target);
      if (target >= simController.rec.to) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  if (rec.frames < 2) return null;
  const go = (t: number) => { setPlaying(false); simController.replayAt(Math.max(rec.from, Math.min(rec.to, t))); };
  return (
    <div className="absolute bottom-12 left-1/2 z-10 flex w-[min(760px,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-lg border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
      <Button size="icon-sm" variant="ghost" aria-label="One step back" title="One step back" onClick={() => go(cur - 1)}><SkipBack /></Button>
      <Button size="icon-sm" variant="ghost" aria-label={playing ? "Pause the replay" : "Play the replay"} title={playing ? "Pause the replay" : "Play the replay"}
        onClick={() => { if (playing) setPlaying(false); else { if (!rp || cur >= rec.to) simController.replayAt(rp && cur < rec.to ? cur : rec.from); setPlaying(true); } }}>
        {playing ? <Pause /> : <Play />}
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="One step forward" title="One step forward" onClick={() => go(cur + 1)}><SkipForward /></Button>
      <Slider className="flex-1" min={rec.from} max={rec.to} step={1} value={[cur]} onValueChange={([v]) => go(v)} aria-label="Replay position" />
      <span className="w-32 text-right font-mono tabular text-muted-foreground" title={`step ${cur} · ${rec.frames} steps kept (${Math.round(rec.bytes / 1048576)} MB)`}>
        {clock(cur / 10)} / {clock(rec.to / 10)}
      </span>
      <Button size="sm" variant={rp ? "default" : "secondary"} className="h-7" disabled={!rp} onClick={() => { setPlaying(false); simController.goLive(); }} title="Back to the running simulation">
        <Radio /> Live
      </Button>
    </div>
  );
}
