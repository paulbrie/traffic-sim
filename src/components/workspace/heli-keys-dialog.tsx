"use client";

import { useEffect, useState } from "react";
import { useSubject } from "subjecto/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { DEFAULT_HELI_KEYS, HELI_ACTIONS, keyAllowed, keyLabel, type HeliAction, type HeliKeys } from "@/lib/heli-keys";
import { heliKeys$ } from "@/state/heli-keys";
import { saveHeliKeys } from "@/server/actions";
import { cn } from "@/lib/utils";

/**
 * Settings: the keys that fly the helicopter, two per action. Click a key, then press the new one
 * (Esc: leave it as it was, Backspace: no key there). A key used elsewhere moves here. Saved with the
 * user's account.
 */
export function HeliKeysDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Helicopter keys</DialogTitle>
          <DialogDescription>Click a key, then press the one you want (Esc to keep it, Backspace for none). Saved with your account.</DialogDescription>
        </DialogHeader>
        {/* (mounted afresh each time the dialog opens: it starts from the saved keys) */}
        <KeysEditor onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function KeysEditor({ onDone }: { onDone: () => void }) {
  const [keys] = useSubject(heliKeys$);
  const [draft, setDraft] = useState<HeliKeys>(() => heliKeys$.getValue());
  const [listen, setListen] = useState<{ a: HeliAction; slot: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!listen) return;
    const onKey = (e: KeyboardEvent) => {
      // (first, before the dialog and the page: Escape mustn't close the dialog while choosing)
      e.preventDefault(); e.stopPropagation();
      const k = e.key.toLowerCase();
      if (k === "escape") { setListen(null); return; }
      if (k === "backspace" || k === "delete") { setDraft(d => withKey(d, listen.a, listen.slot, null)); setListen(null); return; }
      if (!keyAllowed(k)) return;
      setDraft(d => withKey(d, listen.a, listen.slot, k));
      setListen(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listen]);

  async function save() {
    setSaving(true);
    const res = await saveHeliKeys(draft).catch(() => ({ ok: false as const, error: "Couldn't save the keys." }));
    setSaving(false);
    if (!res.ok) { toast.error(res.error); return; }
    heliKeys$.next(res.keys);
    toast.success("Helicopter keys saved");
    onDone();
  }

  const same = JSON.stringify(draft) === JSON.stringify(keys);
  return (
    <>
      <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-2 gap-y-1.5 text-sm">
        {HELI_ACTIONS.map(({ id, label }) => (
          <div key={id} className="contents">
            <span>{label}</span>
            {[0, 1].map(slot => {
              const k = draft[id][slot], on = listen?.a === id && listen.slot === slot;
              // (the second slot only once there is a first)
              if (slot === 1 && !draft[id][0]) return <span key={slot} />;
              return (
                <button key={slot} type="button" onClick={() => setListen(on ? null : { a: id, slot })} aria-label={`${label}: ${slot ? "second" : "first"} key${k ? `, ${keyLabel(k)}` : ""}`}
                  className={cn("flex h-8 min-w-24 items-center justify-center rounded-md border px-2 text-xs transition-colors",
                    on ? "border-primary bg-primary/10 text-primary" : "hover:bg-accent", !k && !on && "text-muted-foreground")}>
                  {on ? "Press a key…" : k ? <Kbd>{keyLabel(k)}</Kbd> : "add"}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">The mouse still turns the helicopter and looks up or down; the wheel still climbs and descends.</p>
      <DialogFooter className="sm:justify-between">
        <Button variant="ghost" size="sm" onClick={() => setDraft(DEFAULT_HELI_KEYS)} disabled={JSON.stringify(draft) === JSON.stringify(DEFAULT_HELI_KEYS)}>Back to the defaults</Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onDone}>Cancel</Button>
          <Button size="sm" onClick={save} disabled={saving || same}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** the keys with key k (or none) in an action's slot, taken from wherever else it was */
function withKey(d: HeliKeys, a: HeliAction, slot: number, k: string | null): HeliKeys {
  const next = Object.fromEntries(HELI_ACTIONS.map(x => [x.id, d[x.id].filter(y => y !== k)])) as HeliKeys;
  const mine = [...next[a]];
  if (k) mine[Math.min(slot, mine.length)] = k; else mine.splice(slot, 1);
  next[a] = mine.filter(Boolean).slice(0, 2);
  return next;
}
