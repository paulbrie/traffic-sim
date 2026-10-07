import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { UsersAdmin } from "@/components/auth/users-admin";
import { AdminNav } from "@/components/admin/admin-nav";
import { requireAdmin } from "@/server/auth";
import { tryDb } from "@/server/db-status";
import { adminUsers } from "@/server/queries";

export const metadata: Metadata = { title: "Users — Gridlock" };

export default async function UsersPage() {
  const res = await tryDb(async () => {
    // (requireAdmin sends anyone else away; adminUsers proves it again from the database)
    const me = await requireAdmin();
    return { me, users: await adminUsers(me) };
  });
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const { me, users } = res.data;
  if (!users) redirect("/");
  return (
    <>
      <AppHeader crumbs={[{ label: "Admin" }]} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Admin</h1>
        <AdminNav current="/admin/users" />
        <p className="mb-4 text-sm text-muted-foreground">Add accounts here, or let people create free ones from the sign-in page. Users own the cities they create and share them with others; admins can open and manage every city.</p>
        <UsersAdmin
          meId={me.id}
          users={users.map(u => ({ ...u, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() }))}
        />
      </main>
    </>
  );
}
