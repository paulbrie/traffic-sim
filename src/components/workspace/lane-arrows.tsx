"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { LANE_TURNS, type ApproachSign, type LaneTurn, type LaneTurns, type LinkDef } from "@/engine/types";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { Compiled, Movement } from "@/engine/compile";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useSubject } from "subjecto/react";
import { stats$ } from "@/state/store";
import { simController } from "@/state/sim-controller";
import { cn } from "@/lib/utils";

const LABEL: Record<LaneTurn, string> = {
  L: "Left", LS: "Left + ahead", S: "Ahead", SR: "Ahead + right", R: "Right", LR: "Left + right", LSR: "All directions",
};

/** road-marking style arrow: stem from the bottom, branches for L / S / R */
export function LaneArrow({ turns, className }: { turns: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 22 V12" />
      {turns.includes("S") && <path d="M12 12 V3 M8.5 6.5 L12 3 L15.5 6.5" />}
      {turns.includes("L") && <path d="M12 13 C12 9 9 8 5 8 M8 5 L5 8 L8 11" />}
      {turns.includes("R") && <path d="M12 13 C12 9 15 8 19 8 M16 5 L19 8 L16 11" />}
    </svg>
  );
}

/** turns each lane currently allows (from the compiled movements), as one of the presets */
function effective(compiled: Compiled, link: LinkDef, dir: 1 | -1, n: number): LaneTurn[] {
  const e = compiled.edges.find(x => x.link.id === link.id && x.dir === dir);
  const moves = e ? e.to.moves.get(e.idx) ?? [] : [];
  return Array.from({ length: n }, (_, k) => {
    const set = new Set<string>(moves.filter(m => k >= m.lo && k <= m.hi).map(m => (m.turn === "U" ? "L" : m.turn)));
    const key = ["L", "S", "R"].filter(t => set.has(t)).join("");
    return (LANE_TURNS as string[]).includes(key) ? (key as LaneTurn) : "LSR";
  });
}

/**
 * Per-lane arrows for one direction of a road, where it reaches the junction ahead.
 * Lanes are listed left to right as the driver sees them.
 */
export function LaneArrowsEditor({ compiled, link, dir, heading, onChange, onSign, onSplit, roadName }: {
  compiled: Compiled; link: LinkDef; dir: 1 | -1; heading: string; onChange: (turns: LaneTurns | null) => void; onSign: (sign: ApproachSign | null) => void;
  onSplit: (split: Record<string, number> | null) => void; roadName: (linkId: string) => string;
}) {
  const n = dir === 1 ? link.lanesF : link.lanesB;
  const custom = dir === 1 ? link.turnsF : link.turnsB;
  const e = compiled.edges.find(x => x.link.id === link.id && x.dir === dir);
  if (!n || !e || !e.to.controlled || e.to.degree < 3) return null;
  const moves = e.to.moves.get(e.idx) ?? [];
  // turns this junction physically offers from this road (before any lane arrows)
  const offered = new Set<string>(e.to.arms.filter(a => a.outEdge && a.link.id !== link.id).length ? moves.map(m => (m.turn === "U" ? "L" : m.turn)) : []);
  const current = custom && custom.length === n ? custom : effective(compiled, link, dir, n);
  const setLane = (k: number, t: LaneTurn) => onChange(current.map((x, i) => (i === k ? t : x)));
  return (
    <div className="grid gap-2 rounded-md border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">Heading {heading}</span>
        {custom ? (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange(null)} title="Let the app choose lane arrows again"><RotateCcw /> Reset</Button>
        ) : <span className="text-xs text-muted-foreground">Automatic</span>}
      </div>
      <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {current.map((t, k) => (
          <Select key={k} value={t} onValueChange={v => setLane(k, v as LaneTurn)}>
            <SelectTrigger
              className={cn("h-12 w-full justify-center px-1 [&>svg:last-child]:hidden", custom ? "border-primary/50" : "text-muted-foreground")}
              aria-label={`Lane ${k + 1} from the left: ${LABEL[t]}`}
            >
              <LaneArrow turns={t} className="size-6" />
            </SelectTrigger>
            <SelectContent>
              {LANE_TURNS.map(opt => {
                const missing = [...opt].filter(c => !offered.has(c));
                return (
                  <SelectItem key={opt} value={opt}>
                    <span className="flex items-center gap-2">
                      <LaneArrow turns={opt} />{LABEL[opt]}
                      {missing.length > 0 && missing.length < opt.length && <span className="text-xs text-muted-foreground">(no {missing.map(c => ({ L: "left", S: "ahead", R: "right" })[c]).join("/")} here)</span>}
                    </span>
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground"><span>left lane</span>{n > 1 && <span>kerb lane</span>}</div>
      <SignPicker control={e.to.def.control} sign={(dir === 1 ? link.signF : link.signB) ?? null} onSign={onSign} />
      <SplitEditor moves={moves} split={(dir === 1 ? link.splitF : link.splitB) ?? null} onSplit={onSplit} roadName={roadName} />
    </div>
  );
}

/**
 * Turning shares: what fraction of vehicles on this approach takes each exit. Vehicles draw
 * their exit from these shares instead of following their own routes through this junction.
 */
function SplitEditor({ moves, split, onSplit, roadName }: {
  moves: Movement[]; split: Record<string, number> | null; onSplit: (s: Record<string, number> | null) => void; roadName: (linkId: string) => string;
}) {
  useSubject(stats$); // refresh the measured shares while traffic runs
  const exits = moves.filter(m => !m.out.busOnly);
  if (exits.length < 2) return null;
  const on = !!split;
  const w = (m: Movement) => split?.[m.out.link.id] ?? 0;
  const total = exits.reduce((a, m) => a + w(m), 0);
  const start = () => {
    const even = Math.round(100 / exits.length);
    onSplit(Object.fromEntries(exits.map(m => [m.out.link.id, even])));
  };
  const turnName = (t: string) => ({ L: "Left", S: "Ahead", R: "Right", U: "U-turn" })[t] ?? t;
  // what the running simulation actually does, to compare with the shares
  const sim = simController.sim;
  const counted = exits.map(m => (sim ? sim.turnCounts.get(`${m.in.idx}>${m.out.idx}`) ?? 0 : 0));
  const countedTotal = counted.reduce((a, b) => a + b, 0);
  return (
    <div className="grid gap-2 border-t pt-2">
      <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Turning shares</span>
        <Switch checked={on} onCheckedChange={v => (v ? start() : onSplit(null))} aria-label="Set turning shares" />
      </label>
      {on ? (
        <>
          {exits.map((m, i) => (
            <div key={m.out.key} className="grid grid-cols-[auto_1fr_3rem_5.5rem] items-center gap-2">
              <LaneArrow turns={m.turn === "U" ? "L" : m.turn} className="size-5 text-muted-foreground" />
              <span className="truncate text-xs" title={roadName(m.out.link.id)}>{turnName(m.turn)} · {roadName(m.out.link.id)}</span>
              <span className="text-right font-mono text-[10px] text-muted-foreground tabular" title="Share measured in the running simulation">
                {countedTotal >= 5 ? `${Math.round((100 * counted[i]) / countedTotal)}%` : ""}
              </span>
              <div className="relative">
                <Input
                  key={`${m.out.link.id}:${w(m)}`} defaultValue={String(w(m))} inputMode="decimal" aria-label={`Share turning ${turnName(m.turn)}`}
                  className="h-7 pr-6 text-right font-mono text-xs tabular"
                  onBlur={ev => {
                    const n = Math.max(0, Math.min(1000, Number(ev.target.value.replace(",", ".")) || 0));
                    if (n !== w(m)) onSplit({ ...(split ?? {}), [m.out.link.id]: n });
                  }}
                  onKeyDown={ev => ev.key === "Enter" && (ev.target as HTMLInputElement).blur()}
                />
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
              </div>
            </div>
          ))}
          <p className={cn("text-[11px]", total === 100 ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")}>
            {total === 100 ? "Vehicles here pick their exit from these shares." : `Shares add up to ${total}%; they are used relative to each other.`}
            {countedTotal >= 5 && ` Grey numbers: measured so far (${countedTotal} vehicles).`}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-muted-foreground">Off: vehicles take whichever exit their route needs.</p>
      )}
    </div>
  );
}

/** small road-sign glyphs */
export function SignGlyph({ kind, className }: { kind: ApproachSign; className?: string }) {
  return kind === "stop" ? (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} aria-hidden>
      <path d="M8.3 2h7.4L22 8.3v7.4L15.7 22H8.3L2 15.7V8.3z" fill="#c8312f" stroke="#fff" strokeWidth="1.2" />
      <text x="12" y="12.5" textAnchor="middle" dominantBaseline="central" fontSize="6.2" fontWeight="700" fill="#fff">STOP</text>
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" className={cn("size-5", className)} aria-hidden>
      <path d="M2.5 3.5h19L12 21z" fill="#fff" stroke="#c8312f" strokeWidth="2.4" strokeLinejoin="round" />
    </svg>
  );
}

function SignPicker({ control, sign, onSign }: { control: string; sign: ApproachSign | null; onSign: (s: ApproachSign | null) => void }) {
  if (control !== "priority") {
    return <p className="text-[11px] text-muted-foreground">Signs apply at priority junctions; this one uses {control === "lights" ? "traffic lights" : control === "stop" ? "an all-way stop" : control === "free" ? "free flow (no rules)" : "a roundabout"}.</p>;
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">Sign</span>
      <ToggleGroup type="single" value={sign ?? "none"} onValueChange={v => v && onSign(v === "none" ? null : (v as ApproachSign))} aria-label="Sign at the junction">
        <ToggleGroupItem value="none" className="h-7 px-2 text-xs" aria-label="No sign (right of way)">None</ToggleGroupItem>
        <ToggleGroupItem value="yield" className="h-7 gap-1 px-2 text-xs" aria-label="Give way (cédez le passage)"><SignGlyph kind="yield" className="size-4" /> Give way</ToggleGroupItem>
        <ToggleGroupItem value="stop" className="h-7 gap-1 px-2 text-xs" aria-label="Stop"><SignGlyph kind="stop" className="size-4" /> Stop</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
