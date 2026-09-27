"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, Loader2, MoreHorizontal, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createUser, deleteUser, resetUserPassword, updateUser } from "@/server/auth-actions";

type Role = "admin" | "user";
export interface AdminUserRow {
  id: string; email: string; name: string; role: Role; mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string;
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never");

export function UsersAdmin({ users, meId }: { users: AdminUserRow[]; meId: string }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<AdminUserRow | null>(null);
  const [pending, start] = useTransition();

  const run = <T extends { ok: boolean; error?: string }>(fn: () => Promise<T>, onOk?: (r: T) => void) =>
    start(async () => {
      try {
        const r = await fn();
        if (!r.ok) toast.error(r.error ?? "Something went wrong");
        else { onOk?.(r); router.refresh(); }
      } catch (e) { toast.error(e instanceof Error ? e.message : "Something went wrong"); }
    });

  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={() => setCreating(true)}><UserPlus /> Add user</Button>
      </div>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">User</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Last sign-in</th>
              <th className="w-10 px-2 py-2.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className="border-t">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{u.name || u.email.split("@")[0]}{u.id === meId && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(you)</span>}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                  {u.mustChangePassword && <Badge variant="outline" className="mt-1">Temporary password</Badge>}
                </td>
                <td className="px-4 py-2.5">
                  <Select value={u.role} disabled={u.id === meId || pending} onValueChange={v => run(() => updateUser(u.id, { role: v as Role }))}>
                    <SelectTrigger size="sm" className="w-28" aria-label={`Role for ${u.email}`}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Admin</SelectItem>
                      <SelectItem value="user">User</SelectItem>
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground tabular">{fmt(u.lastLoginAt)}</td>
                <td className="px-2 py-2.5">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${u.email}`}><MoreHorizontal /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem disabled={u.id === meId} onSelect={() => run(() => resetUserPassword(u.id), r => setSecret({ email: u.email, password: (r as { password: string }).password }))}>
                        <KeyRound /> Reset password
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" disabled={u.id === meId} onSelect={() => setConfirmDelete(u)}><Trash2 /> Delete user</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CreateUserDialog
        open={creating} onOpenChange={setCreating} pending={pending}
        onCreate={input => run(() => createUser(input), r => { setCreating(false); setSecret({ email: input.email.trim().toLowerCase(), password: (r as { password: string }).password }); })}
      />

      <Dialog open={!!secret} onOpenChange={o => { if (!o) setSecret(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Temporary password</DialogTitle>
            <DialogDescription>Send this to {secret?.email}. It is shown only once; they&apos;ll choose their own password after signing in.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly value={secret?.password ?? ""} className="font-mono" aria-label="Temporary password" onFocus={e => e.currentTarget.select()} />
            <Button variant="outline" size="icon" aria-label="Copy password" onClick={() => { navigator.clipboard.writeText(secret?.password ?? "").then(() => toast.success("Copied")); }}><Copy /></Button>
          </div>
          <DialogFooter><Button onClick={() => setSecret(null)}>Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!confirmDelete} onOpenChange={o => { if (!o) setConfirmDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {confirmDelete?.email}?</AlertDialogTitle>
            <AlertDialogDescription>They lose access immediately. Maps they own are handed to you (reassign them under Admin → Maps); their edits stay in plan history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => { const u = confirmDelete; if (u) run(() => deleteUser(u.id), () => toast.success("User deleted")); }}>Delete user</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function CreateUserDialog({ open, onOpenChange, onCreate, pending }: {
  open: boolean; onOpenChange: (o: boolean) => void; pending: boolean; onCreate: (input: { email: string; name: string; role: Role }) => void;
}) {
  const [role, setRole] = useState<Role>("user");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>They get a temporary password to sign in with, then choose their own.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={e => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            onCreate({ email: String(f.get("email") ?? ""), name: String(f.get("name") ?? ""), role });
          }}
        >
          <div className="grid gap-1.5"><Label htmlFor="nu-email">Email</Label><Input id="nu-email" name="email" type="email" required autoFocus /></div>
          <div className="grid gap-1.5"><Label htmlFor="nu-name">Name</Label><Input id="nu-name" name="name" placeholder="Optional" /></div>
          <div className="grid gap-1.5">
            <Label htmlFor="nu-role">Role</Label>
            <Select value={role} onValueChange={v => setRole(v as Role)}>
              <SelectTrigger id="nu-role" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="user">User: edits cities and plans</SelectItem>
                <SelectItem value="admin">Admin: also manages users</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending && <Loader2 className="animate-spin" />} Create user</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
