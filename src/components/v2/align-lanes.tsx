"use client";

import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { alignUnits, type Align } from "@/lib/lane-align";
import type { Sketch } from "@/lib/lane-sketch";

/** the six alignments, as a design tool has them: their icon, name and key (Alt+, as Figma) */
export const ALIGN_BUTTONS: { how: Align; label: string; key: string; code: string; icon: React.ReactNode }[] = [
  { how: "left", label: "Align left edges", key: "A", code: "KeyA", icon: <AlignStartVertical /> },
  { how: "center", label: "Align centres (across)", key: "H", code: "KeyH", icon: <AlignCenterVertical /> },
  { how: "right", label: "Align right edges", key: "D", code: "KeyD", icon: <AlignEndVertical /> },
  { how: "top", label: "Align top edges (north)", key: "W", code: "KeyW", icon: <AlignStartHorizontal /> },
  { how: "middle", label: "Align middles (up and down)", key: "V", code: "KeyV", icon: <AlignCenterHorizontal /> },
  { how: "bottom", label: "Align bottom edges (south)", key: "S", code: "KeyS", icon: <AlignEndHorizontal /> },
];
const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌥" : "Alt+";

/**
 * Align (T149), for two or more selected lanes: their bounding boxes lined up on one axis against the first
 * selected (the anchor, which stays put), whole lanes moving, a side-by-side road with its lane.
 */
export function AlignLanes({ sketch, lanes, readOnly, onAlign }: { sketch: Sketch; lanes: string[]; readOnly: boolean; onAlign: (how: Align) => void }) {
  const units = alignUnits(sketch, lanes), can = units.length >= 2 && !readOnly;
  const anchor = units[0]?.lanes;
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Align</span>
        <div className="flex gap-0.5" role="group" aria-label="Align the lanes">
          {ALIGN_BUTTONS.map(b => (
            <Button key={b.how} size="icon-sm" variant="ghost" disabled={!can} aria-label={b.label} title={`${b.label} on the anchor (${MOD}${b.key})`} onClick={() => onAlign(b.how)}>
              {b.icon}
            </Button>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {can && anchor
          ? <>Lined up on {anchor.length > 1 ? `the road of lane ${lanes[0]}` : `lane ${anchor[0]}`}, the first selected, which stays put (⇧-click in the order you want). Whole lanes move; a road laid out side by side moves with its lane.</>
          : "Select two lanes or more (⇧-click): the first one is the anchor the others line up on."}
      </p>
    </div>
  );
}
