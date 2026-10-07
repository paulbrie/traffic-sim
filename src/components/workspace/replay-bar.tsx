"use client";

import { useEffect, useRef, useState } from "react";
import { useSubject } from "subjecto/react";
import { ClipboardCopy, Pause, Play, Radio, StepBack, StepForward } from "lucide-react";
import { toast } from "sonner";
import { replayMomentText } from "@/state/replay-copy";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { stats$, ui } from "@/state/store";
import { simController } from "@/state/sim-controller";

/** holding a step button: the first repeat after this long (ms), then one step every REPEAT ms */
const HOLD = 350, REPEAT = 70;

/** n steps from where the replay is (from the newest step kept when live), within what is kept */
function stepBy(n: number) {
  const rec = simController.rec, at = simController.replay?.tick ?? rec.to;
  simController.replayAt(Math.max(rec.from, Math.min(rec.to, at + n)));
}

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
  // ← / →: a step back or forward (Shift: a second, 10 steps), unless typing or on a slider
  const shown = rec.frames >= 2;
  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if ((e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable],[role=combobox],[role=slider],[role=dialog]")) return;
      e.preventDefault();
      setPlaying(false);
      stepBy((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shown]);
  if (!shown) return null;
  const go = (t: number) => { setPlaying(false); simController.replayAt(Math.max(rec.from, Math.min(rec.to, t))); };
  return (
    <div className="absolute bottom-12 left-1/2 z-10 flex w-[min(760px,calc(100%-2rem))] -translate-x-1/2 items-center gap-2 rounded-lg border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
      <StepButton dir={-1} stop={() => setPlaying(false)} />
      <Button size="icon-sm" variant="ghost" aria-label={playing ? "Pause the replay" : "Play the replay"} title={playing ? "Pause the replay" : "Play the replay"}
        onClick={() => { if (playing) setPlaying(false); else { if (!rp || cur >= rec.to) simController.replayAt(rp && cur < rec.to ? cur : rec.from); setPlaying(true); } }}>
        {playing ? <Pause /> : <Play />}
      </Button>
      <StepButton dir={1} stop={() => setPlaying(false)} />
      <Slider className="flex-1" min={rec.from} max={rec.to} step={1} value={[cur]} onValueChange={([v]) => go(v)} aria-label="Replay position" />
      <span className="w-52 text-right font-mono tabular text-muted-foreground" title={`step ${cur} · ${rec.frames} steps kept (${Math.round(rec.bytes / 1048576)} MB)`}>
        {clock(cur / 10)} / {clock(rec.to / 10)} <span className="text-foreground/70">· tick {cur}</span>
      </span>
      <Button size="icon-sm" variant="ghost" aria-label="Copy this moment's data" title="Copy this moment's data (vehicles, lights, parking and events in view) to paste into a conversation"
        onClick={async () => {
          const text = replayMomentText();
          if (!text) return;
          try { await navigator.clipboard.writeText(text); toast.success("Replay data copied", { description: `${Math.round(text.length / 1024)} kB: paste it into the conversation.` }); }
          catch { toast.error("Couldn't copy: the browser blocked the clipboard."); }
        }}>
        <ClipboardCopy />
      </Button>
      <Button size="sm" variant={rp ? "default" : "secondary"} className="h-7" disabled={!rp} onClick={() => { setPlaying(false); simController.goLive(); }} title="Back to the running simulation">
        <Radio /> Live
      </Button>
    </div>
  );
}

/** a step back or forward (0.1 s); held down, it keeps stepping */
function StepButton({ dir, stop }: { dir: 1 | -1; stop: () => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => release, []);
  const label = dir < 0 ? "Step back" : "Step forward";
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} title={`${label} (${dir < 0 ? "←" : "→"}; hold to keep going, Shift+${dir < 0 ? "←" : "→"} for a second)`}
      onPointerDown={e => {
        if (e.button !== 0) return;
        stop();
        stepBy(dir);
        const again = () => { if (!simController.replayPending) stepBy(dir); timer.current = setTimeout(again, REPEAT); };
        timer.current = setTimeout(again, HOLD);
      }}
      onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stop(); stepBy(dir); } }}>
      {dir < 0 ? <StepBack /> : <StepForward />}
    </Button>
  );
}
