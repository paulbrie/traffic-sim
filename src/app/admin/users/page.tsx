import type { Metadata } from "next";
import { asc } from "drizzle-orm";
import { AppHeader } from "@/components/app-header";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { UsersAdmin } from "@/components/auth/users-admin";
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
      <AppHeader crumbs={[{ label: "Users" }]} />
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
          <p className="text-sm text-muted-foreground">Admins manage users. Both admins and users can create and edit cities and plans.</p>
        </div>
        <UsersAdmin
          meId={me.id}
          users={users.map(u => ({ ...u, lastLoginAt: u.lastLoginAt?.toISOString() ?? null, createdAt: u.createdAt.toISOString() }))}
        />
      </main>
    </>
  );
}
