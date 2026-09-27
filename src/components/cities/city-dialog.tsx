"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createCity, updateCity } from "@/server/actions";

export function CityDialog({ city, trigger, open: openProp, onOpenChange }: {
  city?: { id: string; name: string; description: string };
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [pending, start] = useTransition();
  const router = useRouter();
  const editing = !!city;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            const input = { name: String(fd.get("name") ?? ""), description: String(fd.get("description") ?? "") };
            start(async () => {
              try {
                if (editing) { await updateCity(city!.id, input); toast.success("City updated"); setOpen(false); router.refresh(); }
                else { const id = await createCity(input); setOpen(false); router.push(`/cities/${id}`); }
              } catch (err) { toast.error(err instanceof Error ? err.message : "Could not save the city"); }
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>{editing ? "Edit city" : "New city"}</DialogTitle>
            <DialogDescription>A city groups the road plans you design for the same place.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="city-name">Name</Label>
            <Input id="city-name" name="name" defaultValue={city?.name} placeholder="Cluj-Napoca" required autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="city-desc">Notes</Label>
            <Textarea id="city-desc" name="description" defaultValue={city?.description} placeholder="Area, goals, constraints…" />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={pending}>{pending ? "Saving…" : editing ? "Save" : "Create city"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
