"use client";

import { useDeepSubject } from "subjecto/react";
import { Loader2 } from "lucide-react";
import { BUSY_FADE, ui } from "@/state/store";
import { cn } from "@/lib/utils";

/** over the map while a slow edit runs (see busy() in the store): what it is doing, fading in and out */
export function BusyNote() {
  const [on] = useDeepSubject(ui, "busy");
  const [label] = useDeepSubject(ui, "busyLabel");
  return (
    <div role="status" aria-live="polite" aria-hidden={!on} style={{ transitionDuration: `${BUSY_FADE}ms` }}
      className={cn("pointer-events-none absolute inset-0 z-30 flex items-start justify-center bg-background/15 pt-16 transition-opacity ease-out", on ? "opacity-100" : "opacity-0")}>
      <div style={{ transitionDuration: `${BUSY_FADE}ms` }} className={cn("flex items-center gap-2 rounded-full border bg-background/95 px-4 py-2 text-sm font-medium shadow-lg backdrop-blur transition-transform ease-out", on ? "translate-y-0" : "-translate-y-2")}>
        <Loader2 className={cn("size-4 text-primary", on && "animate-spin")} /> {label}
      </div>
    </div>
  );
}
