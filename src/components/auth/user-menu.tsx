"use client";

import Link from "next/link";
import { Bot, KeyRound, LogOut, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/server/auth-actions";
import { bridgeStore } from "@/state/bridge-client";

export interface MenuUser { email: string; name: string; role: "admin" | "user" }

export function UserMenu({ user }: { user: MenuUser }) {
  const label = user.name || user.email;
  const initials = label.split(/[\s.@_-]+/).filter(Boolean).slice(0, 2).map(s => s[0]!.toUpperCase()).join("");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label={`Account: ${user.email}`}>
          <span className="grid size-7 place-items-center rounded-full bg-muted text-[11px] font-semibold">{initials}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate">{label}</span>
          <span className="truncate text-xs font-normal text-muted-foreground">{user.email} · {user.role === "admin" ? "Admin" : "User"}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {user.role === "admin" && (
          <DropdownMenuItem asChild><Link href="/admin/users"><Users /> Admin</Link></DropdownMenuItem>
        )}
        {user.role === "admin" && (
          <DropdownMenuItem onSelect={() => bridgeStore.show(true)}><Bot /> Connect Claude</DropdownMenuItem>
        )}
        <DropdownMenuItem asChild><Link href="/account/password"><KeyRound /> Change password</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => { void logout(); }}><LogOut /> Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
