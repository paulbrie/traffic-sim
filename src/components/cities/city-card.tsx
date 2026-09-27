"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CityDialog } from "./city-dialog";
import { deleteCity } from "@/server/actions";
import { timeAgo } from "@/lib/time";

export function CityCard({ city }: { city: { id: string; name: string; description: string; planCount: number; updatedAt: Date; lastPlanAt: string | Date | null } }) {
  const [edit, setEdit] = useState(false);
  const [del, setDel] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const last = city.lastPlanAt ? new Date(city.lastPlanAt) : new Date(city.updatedAt);
  return (
    <Card className="group relative gap-3 py-5 transition-shadow hover:shadow-md">
      <CardHeader className="px-5">
        <CardTitle className="text-base">
          <Link href={`/cities/${city.id}`} className="after:absolute after:inset-0">{city.name}</Link>
        </CardTitle>
        <CardDescription className="line-clamp-2 min-h-10">{city.description || "No notes yet."}</CardDescription>
        <CardAction className="relative z-10">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${city.name}`}><MoreHorizontal /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEdit(true)}><Pencil /> Rename</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onSelect={() => setDel(true)}><Trash2 /> Delete</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="flex items-center justify-between px-5 text-sm text-muted-foreground">
        <span className="tabular">{city.planCount} {city.planCount === 1 ? "plan" : "plans"}</span>
        <span>Edited {timeAgo(last)}</span>
      </CardContent>
      <CityDialog city={city} open={edit} onOpenChange={setEdit} />
      <AlertDialog open={del} onOpenChange={setDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {city.name}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the city and its {city.planCount} {city.planCount === 1 ? "plan" : "plans"}. It can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep city</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={pending}
              onClick={e => { e.preventDefault(); start(async () => { await deleteCity(city.id); setDel(false); toast.success(`Deleted ${city.name}`); router.refresh(); }); }}
            >Delete city</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
