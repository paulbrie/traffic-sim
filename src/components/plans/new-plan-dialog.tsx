"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { createPlan } from "@/server/actions";

export function NewPlanDialog({ cityId, trigger }: { cityId: string; trigger: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<"blank" | "sample">("blank");
  // (new plans on the V2 engine unless V1 is asked for)
  const [engine, setEngine] = useState<"v1" | "v2">("v2");
  const [pending, start] = useTransition();
  const router = useRouter();
  function choice<T extends string>(current: T, set: (v: T) => void, value: T, title: string, body: string) {
    return (
    <button
      type="button"
      onClick={() => set(value)}
      aria-pressed={current === value}
      className={cn("rounded-lg border p-3 text-left transition-colors hover:bg-accent", current === value && "border-primary ring-2 ring-primary/20")}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted-foreground">{body}</div>
    </button>
    );
  }
  const opt = (value: "blank" | "sample", title: string, body: string) => choice(template, setTemplate, value, title, body);
  const eng = (value: "v1" | "v2", title: string, body: string) => choice(engine, setEngine, value, title, body);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            start(async () => {
              try {
                const id = await createPlan({ cityId, name: String(fd.get("name") ?? ""), description: String(fd.get("description") ?? ""), template, engine });
                setOpen(false);
                router.push(`/plans/${id}`);
              } catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the plan"); }
            });
          }}
        >
          <DialogHeader>
            <DialogTitle>New plan</DialogTitle>
            <DialogDescription>A plan is one version of the street network. Duplicate plans to compare alternatives.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="plan-name">Name</Label>
            <Input id="plan-name" name="name" placeholder="Centre — option A" required autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="plan-desc">Notes</Label>
            <Textarea id="plan-desc" name="description" placeholder="What this option changes…" />
          </div>
          <div className="grid gap-2">
            <Label>Engine</Label>
            <div className="grid grid-cols-2 gap-2">
              {eng("v2", "V2 (lanes)", "Lanes, connectors and junctions drawn freely; the newer, more accurate simulation.")}
              {eng("v1", "V1 (classic)", "Roads and junctions as before, with every V1 feature.")}
            </div>
          </div>
          {engine === "v1" && (
            <div className="grid gap-2">
              <Label>Start from</Label>
              <div className="grid grid-cols-2 gap-2">
                {opt("blank", "Blank", "Draw every street yourself.")}
                {opt("sample", "Sample district", "Boulevard, roundabout, bus loop.")}
              </div>
            </div>
          )}
          <DialogFooter><Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create and open"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
