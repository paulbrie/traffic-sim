"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { transferCity } from "@/server/actions";
import { timeAgo } from "@/lib/time";

interface MapRow { id: string; name: string; ownerId: string | null; ownerEmail: string | null; planCount: number; shareCount: number; updatedAt: string }

export function MapsAdmin({ maps, users }: { maps: MapRow[]; users: { id: string; email: string }[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!maps.length) return <p className="rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">No cities yet.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2.5 font-medium">City</th>
            <th className="px-4 py-2.5 font-medium">Owner</th>
            <th className="px-4 py-2.5 text-right font-medium">Plans</th>
            <th className="px-4 py-2.5 text-right font-medium">Shared with</th>
            <th className="px-4 py-2.5 font-medium">Edited</th>
          </tr>
        </thead>
        <tbody>
          {maps.map(m => (
            <tr key={m.id} className="border-t">
              <td className="px-4 py-2.5 font-medium"><Link href={`/cities/${m.id}`} className="hover:underline">{m.name}</Link></td>
              <td className="px-4 py-2.5">
                <Select
                  value={m.ownerId ?? ""} disabled={pending}
                  onValueChange={v => start(async () => {
                    const r = await transferCity(m.id, v);
                    if (!r.ok) toast.error(r.error); else { toast.success(`${m.name} now belongs to ${users.find(u => u.id === v)?.email}`); router.refresh(); }
                  })}
                >
                  <SelectTrigger size="sm" className="w-64" aria-label={`Owner of ${m.name}`}><SelectValue placeholder="No owner" /></SelectTrigger>
                  <SelectContent>{users.map(u => <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>)}</SelectContent>
                </Select>
              </td>
              <td className="px-4 py-2.5 text-right tabular">{m.planCount}</td>
              <td className="px-4 py-2.5 text-right tabular">{m.shareCount}</td>
              <td className="px-4 py-2.5 text-muted-foreground">{timeAgo(new Date(m.updatedAt))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
