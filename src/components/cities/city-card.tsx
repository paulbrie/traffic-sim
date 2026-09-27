"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Eye, LogOut, MoreHorizontal, Pencil, Share2, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardAction } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CityDialog } from "./city-dialog";
import { ShareDialog } from "./share-dialog";
import { deleteCity, duplicateCity, leaveCity } from "@/server/actions";
import { timeAgo } from "@/lib/time";

export type Access = "owner" | "write" | "read";

export function AccessBadge({ access }: { access: Access }) {
  if (access === "owner") return null;
  return access === "write"
    ? <Badge variant="secondary"><Pencil /> Can edit</Badge>
    : <Badge variant="outline"><Eye /> View only</Badge>;
}

export function CityCard({ city }: {
  city: { id: string; name: string; description: string; planCount: number; updatedAt: Date; lastPlanAt: string | Date | null; access: Access; ownerName: string | null; shareCount: number; mine?: boolean };
}) {
  const [edit, setEdit] = useState(false);
  const [share, setShare] = useState(false);
  const [del, setDel] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const last = city.lastPlanAt ? new Date(city.lastPlanAt) : new Date(city.updatedAt);
  const owner = city.access === "owner";
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
              <DropdownMenuItem disabled={pending} onSelect={() => start(async () => {
                try {
                  const id = await duplicateCity(city.id);
                  toast.success(`Copied ${city.name}`, { description: owner ? undefined : "The copy is yours to edit.", action: { label: "Open", onClick: () => router.push(`/cities/${id}`) } });
                  router.refresh();
                } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't copy the city"); }
              })}><Copy /> Duplicate</DropdownMenuItem>
              {owner ? (
                <>
                  <DropdownMenuItem onSelect={() => setShare(true)}><Share2 /> Share</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setEdit(true)}><Pencil /> Rename</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setDel(true)}><Trash2 /> Delete</DropdownMenuItem>
                </>
              ) : (
                <DropdownMenuItem onSelect={() => start(async () => { await leaveCity(city.id); toast.success(`Removed ${city.name} from your maps`); router.refresh(); })}>
                  <LogOut /> Remove from my maps
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 text-sm text-muted-foreground">
        <span className="tabular">{city.planCount} {city.planCount === 1 ? "plan" : "plans"}</span>
        {city.mine === false && city.ownerName && <span className="truncate">by {city.ownerName}</span>}
        {city.mine !== false && city.shareCount > 0 && <span className="flex items-center gap-1"><Users className="size-3.5" /> {city.shareCount}</span>}
        <AccessBadge access={city.access} />
        <span className="ml-auto">Edited {timeAgo(last)}</span>
      </CardContent>
      {owner && <CityDialog city={city} open={edit} onOpenChange={setEdit} />}
      {owner && <ShareDialog city={city} open={share} onOpenChange={setShare} />}
      <AlertDialog open={del} onOpenChange={setDel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {city.name}?</AlertDialogTitle>
            <AlertDialogDescription>This removes the city, its {city.planCount} {city.planCount === 1 ? "plan" : "plans"} and their history, for everyone it is shared with. It can&apos;t be undone.</AlertDialogDescription>
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
