"use client";

import type { Sketch } from "@/lib/lane-sketch";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, MoreHorizontal, Pencil, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { convertPlanToV2, deletePlan, duplicatePlan, updatePlanInfo } from "@/server/actions";
import { timeAgo } from "@/lib/time";

export function PlanCardActions({ plan, canDelete = true }: { plan: { id: string; name: string; description: string; engine?: "v1" | "v2" }; canDelete?: boolean }) {
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${plan.name}`}><MoreHorizontal /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEdit(true)}><Pencil /> Rename</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => start(async () => { const id = await duplicatePlan(plan.id); toast.success("Plan duplicated", { action: { label: "Open", onClick: () => router.push(`/plans/${id}`) } }); router.refresh(); })}>
            <Copy /> Duplicate
          </DropdownMenuItem>
          {plan.engine !== "v2" && (
            <DropdownMenuItem disabled={pending} title="A new V2 plan next to this one, its roads, junctions, signs, lights and roundabouts as lanes and connectors (this plan stays as it is)"
              onSelect={() => start(async () => {
                const t = toast.loading("Converting to V2…");
                try {
                  const { id, report: r } = await convertPlanToV2(plan.id);
                  toast.success("V2 plan made", {
                    id: t, duration: 12000,
                    description: `${r.lanes} lanes, ${r.connectors} connectors, ${r.junctions} junctions (${r.lights} with lights, ${r.roundabouts} roundabouts), ${r.signs} signs.${r.skipped.length ? ` Not converted: ${r.skipped.join("; ")}.` : ""}`,
                    action: { label: "Open", onClick: () => router.push(`/plans/${id}`) },
                  });
                  router.refresh();
                } catch (err) { toast.error(err instanceof Error ? err.message : "Could not convert", { id: t }); }
              })}>
              <Sparkles /> Convert to V2
            </DropdownMenuItem>
          )}
          {canDelete && <DropdownMenuSeparator />}
          {canDelete && <DropdownMenuItem variant="destructive" onSelect={() => setDel(true)}><Trash2 /> Delete</DropdownMenuItem>}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={edit} onOpenChange={setEdit}>
        <DialogContent>
          <form className="grid gap-4" onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.currentTarget);
            start(async () => {
              try { await updatePlanInfo(plan.id, { name: String(fd.get("name")), description: String(fd.get("description") ?? "") }); setEdit(false); router.refresh(); }
              catch (err) { toast.error(err instanceof Error ? err.message : "Could not rename"); }
            });
          }}>
            <DialogHeader><DialogTitle>Rename plan</DialogTitle></DialogHeader>
            <div className="grid gap-2"><Label htmlFor={`pn-${plan.id}`}>Name</Label><Input id={`pn-${plan.id}`} name="name" defaultValue={plan.name} required /></div>
            <div className="grid gap-2"><Label htmlFor={`pd-${plan.id}`}>Notes</Label><Textarea id={`pd-${plan.id}`} name="description" defaultValue={plan.description} /></div>
            <DialogFooter><Button type="submit" disabled={pending}>Save</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={del} onOpenChange={setDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{plan.name}”?</AlertDialogTitle>
            <AlertDialogDescription>The plan, its street network and its history will be removed. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep plan</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" disabled={pending}
              onClick={e => { e.preventDefault(); start(async () => { await deletePlan(plan.id); setDel(false); toast.success("Plan deleted"); router.refresh(); }); }}>
              Delete plan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** `sketch`: a V2 plan's lane sketch (its counts shown instead of the V1 network's) */
/** which engine a plan is built on: V2 (the lane sketch) stands out, V1 is quieter */
export function EngineBadge({ engine }: { engine: "v1" | "v2" }) {
  return engine === "v2"
    ? <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary" title="V2 engine: lanes, connectors and junctions drawn freely">V2</span>
    : <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground" title="V1 engine (classic)">V1</span>;
}

export function PlanMeta({ nodes, links, stops, updatedAt, sketch }: { nodes: number; links: number; stops: number; updatedAt: Date; sketch?: Sketch | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular">
      {sketch !== undefined
        ? <><span>{sketch?.roads.length ?? 0} roads</span><span>{sketch?.lanes.length ?? 0} lanes</span><span>{sketch?.junctions.length ?? 0} junctions</span></>
        : <><span>{links} roads</span><span>{nodes} nodes</span><span>{stops} stops</span></>}
      <span className="ml-auto">Edited {timeAgo(new Date(updatedAt))}</span>
    </div>
  );
}

export function PlanLink({ id, children }: { id: string; children: React.ReactNode }) {
  return <Link href={`/plans/${id}`} className="after:absolute after:inset-0 hover:underline">{children}</Link>;
}
