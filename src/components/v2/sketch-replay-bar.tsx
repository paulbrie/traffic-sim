"use client";

import { useEffect, useRef } from "react";
import { ClipboardCopy, Pause, Play, Radio, StepBack, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";

/** holding a step button: the first repeat after this long (ms), then one step every REPEAT ms */
const HOLD = 350, REPEAT = 70;
/** a step: the replay keeps the cars every tenth of a second */
export const REPLAY_STEP = 0.1;

const clock = (s: number) => {
  const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
};

/** `capped`: less than the 10 minutes kept, the memory it may take being full (a big town) */
export interface ReplayKept { from: number; to: number; frames: number; bytes: number; capped?: boolean }

/**
 * The lane sketch's replay, as V1's (replay-bar.tsx): what the cars did is kept (the last 10 minutes, every
 * 0.1 s, or less in a big town: then the time kept is shown); drag to any moment, step back and forward (held, it keeps stepping; ← → too, Shift for a second),
 * play it back at the simulation speed, copy the moment to paste into a conversation. Live goes back to the
 * cars as they are (replaying doesn't change them; going into the replay pauses them).
 */
export function SketchReplayBar({ kept, t, playing, onPlaying, onShow, onLive, onCopy, above = 0, sides = { left: 0, right: 0 } }: {
  kept: ReplayKept | null;
  /** the moment shown (null: live) */
  t: number | null;
  playing: boolean;
  onPlaying: (on: boolean) => void;
  /** show the moment `t` (going into the replay when live) */
  onShow: (t: number) => void;
  onLive: () => void;
  onCopy: () => void;
  /** how high (px) what is open under it is (the console): the bar sits above it, its scrubber in reach */
  above?: number;
  /** room (px) kept clear at its sides, for what sits there at the map's foot (the Console button; the zoom buttons) */
  sides?: { left: number; right: number };
}) {
  const shown = !!kept && kept.frames >= 2;
  const ref = useRef({ kept, t });
  ref.current = { kept, t };
  // ← / →, when the editor doesn't have the keys (it steps the replay itself then; see stepReplayBy)
  useEffect(() => {
    if (!shown) return;
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
      if ((e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable],[role=combobox],[role=slider],[role=dialog]")) return;
      e.preventDefault();
      onPlaying(false);
      stepBy((e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);
  /** n steps from the moment shown (from the newest kept when live) */
  function stepBy(n: number) {
    const { kept: k, t: at } = ref.current;
    if (!k) return;
    onShow(Math.max(k.from, Math.min(k.to, (at ?? k.to) + n * REPLAY_STEP)));
  }
  if (!shown || !kept) return null;
  const cur = t ?? kept.to;
  const go = (x: number) => { onPlaying(false); onShow(Math.max(kept.from, Math.min(kept.to, x))); };
  return (
    <div role="group" aria-label="Replay"
      style={{ ...(above ? { bottom: above + 8 } : {}), left: `calc(50% + ${(sides.left - sides.right) / 2}px)`, width: `min(760px, calc(100% - 2rem - ${sides.left + sides.right}px))` }}
      className="absolute bottom-6 z-30 flex -translate-x-1/2 items-center gap-2 rounded-lg border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
      <StepButton dir={-1} stop={() => onPlaying(false)} step={stepBy} />
      <Button size="icon-sm" variant="ghost" aria-label={playing ? "Pause the replay" : "Play the replay"} title={playing ? "Pause the replay" : "Play the replay (at the simulation speed)"}
        onClick={() => {
          if (playing) { onPlaying(false); return; }
          // (live, or at the end: from the start of what is kept)
          if (t === null || t >= kept.to - REPLAY_STEP / 2) onShow(kept.from);
          onPlaying(true);
        }}>
        {playing ? <Pause /> : <Play />}
      </Button>
      <StepButton dir={1} stop={() => onPlaying(false)} step={stepBy} />
      <Slider className="flex-1" min={kept.from} max={kept.to} step={REPLAY_STEP} value={[cur]} onValueChange={([v]) => go(v)} aria-label="Replay position" />
      <span className="w-52 text-right font-mono tabular text-muted-foreground"
        title={`step ${Math.round(cur / REPLAY_STEP)} · ${kept.frames} steps kept (${(kept.bytes / 1048576).toFixed(1)} MB), from ${clock(kept.from)}${kept.capped ? " (the last " + clock(kept.to - kept.from) + " only: the memory kept for the replay is full)" : ""}`}>
        {clock(cur)} / {clock(kept.to)} <span className="text-foreground/70">· {kept.capped ? `last ${clock(kept.to - kept.from)}` : `step ${Math.round(cur / REPLAY_STEP)}`}</span>
      </span>
      <Button size="icon-sm" variant="ghost" aria-label="Copy this moment's data"
        title="Copy this moment's data (the cars in view, the lights, and what happened a minute either side) to paste into a conversation"
        onClick={onCopy}>
        <ClipboardCopy />
      </Button>
      <Button size="sm" variant={t !== null ? "default" : "secondary"} className="h-7" disabled={t === null}
        onClick={() => { onPlaying(false); onLive(); }} title="Back to the cars as they are (Run carries on from there)">
        <Radio /> Live
      </Button>
    </div>
  );
}

/** a step back or forward (0.1 s); held down, it keeps stepping */
function StepButton({ dir, stop, step }: { dir: 1 | -1; stop: () => void; step: (n: number) => void }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => release, []);
  const label = dir < 0 ? "Step back" : "Step forward";
  return (
    <Button size="icon-sm" variant="ghost" aria-label={label} title={`${label} 0.1 s (${dir < 0 ? "←" : "→"}; hold to keep going, Shift+${dir < 0 ? "←" : "→"} for a second)`}
      onPointerDown={e => {
        if (e.button !== 0) return;
        stop();
        step(dir);
        const again = () => { step(dir); timer.current = setTimeout(again, REPEAT); };
        timer.current = setTimeout(again, HOLD);
      }}
      onPointerUp={release} onPointerLeave={release} onPointerCancel={release}
      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); stop(); step(dir); } }}>
      {dir < 0 ? <StepBack /> : <StepForward />}
    </Button>
  );
}
