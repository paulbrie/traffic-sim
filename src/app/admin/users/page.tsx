import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { AppHeader } from "@/components/app-header";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { UsersAdmin } from "@/components/auth/users-admin";
import { AdminNav } from "@/components/admin/admin-nav";
import { db, schema } from "@/db";
import { requireAdmin } from "@/server/auth";
import { tryDb } from "@/server/db-status";

export const metadata: Metadata = { title: "Users — Gridlock" };

export default async function UsersPage() {
  const res = await tryDb(async () => {
    const me = await requireAdmin();
    const users = await db
      .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, mustChangePassword: schema.users.mustChangePassword, lastLoginAt: schema.users.lastLoginAt, createdAt: schema.users.createdAt })
      .from(schema.users)
      .orderBy(asc(schema.users.email));
    return { me, users };
  });
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const { me, users } = res.data;
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
