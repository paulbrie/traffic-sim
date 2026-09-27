"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { listShares, shareCity, unshareCity } from "@/server/actions";

type Level = "read" | "write";
interface Share { userId: string; email: string; name: string; access: Level }

const LEVELS: { value: Level; label: string }[] = [
  { value: "read", label: "Can view" },
  { value: "write", label: "Can edit" },
];

function LevelSelect({ value, onChange, id, disabled, label }: { value: Level; onChange: (v: Level) => void; id?: string; disabled?: boolean; label: string }) {
  return (
    <Select value={value} onValueChange={v => onChange(v as Level)} disabled={disabled}>
      <SelectTrigger id={id} size="sm" className="w-28" aria-label={label}><SelectValue /></SelectTrigger>
      <SelectContent>{LEVELS.map(l => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
    </Select>
  );
}

/** Owner view of who can open a map, with add / change / remove. */
export function ShareDialog({ city, open, onOpenChange }: { city: { id: string; name: string }; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [shares, setShares] = useState<Share[] | null>(null);
  const [level, setLevel] = useState<Level>("read");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();

  const reload = () => listShares(city.id).then(setShares).catch(e => setError(e instanceof Error ? e.message : "Couldn't load"));
  useEffect(() => { if (open) void reload(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) => start(async () => {
    try {
      const r = await fn();
      if (!r.ok) { setError(r.error ?? "Something went wrong"); return; }
      setError(""); done?.(); await reload(); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Something went wrong"); }
  });

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) setError(""); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share {city.name}</DialogTitle>
          <DialogDescription>People you add see this map and all its plans. Viewers can open and simulate; editors can also change, add and restore plans.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          onSubmit={e => {
            e.preventDefault();
            const form = e.currentTarget;
            const email = String(new FormData(form).get("email") ?? "");
            run(() => shareCity(city.id, { email, access: level }), () => { form.reset(); toast.success(`Shared with ${email.trim()}`); });
          }}
        >
          <Label htmlFor="share-email">Add people by email</Label>
          <div className="flex gap-2">
            <Input id="share-email" name="email" type="email" placeholder="name@example.com" required autoFocus className="h-8" />
            <LevelSelect value={level} onChange={setLevel} label="Access for the new person" />
            <Button type="submit" size="sm" disabled={pending}>{pending && <Loader2 className="animate-spin" />} Share</Button>
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </form>
        <div className="grid gap-1">
          <p className="text-xs font-medium text-muted-foreground">People with access</p>
          {shares === null ? (
            <p className="py-3 text-sm text-muted-foreground">Loading…</p>
          ) : shares.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">Only you so far.</p>
          ) : (
            <ul className="divide-y rounded-lg border">
              {shares.map(s => (
                <li key={s.userId} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{s.name || s.email.split("@")[0]}</div>
                    <div className="truncate text-xs text-muted-foreground">{s.email}</div>
                  </div>
                  <LevelSelect value={s.access} disabled={pending} label={`Access for ${s.email}`} onChange={v => run(() => shareCity(city.id, { email: s.email, access: v }))} />
                  <Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`Remove ${s.email}`} onClick={() => run(() => unshareCity(city.id, s.userId))}><UserMinus /></Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
