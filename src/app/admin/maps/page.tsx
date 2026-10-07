import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AdminNav } from "@/components/admin/admin-nav";
import { MapsAdmin } from "@/components/admin/maps-admin";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { requireAdmin } from "@/server/auth";
import { tryDb } from "@/server/db-status";
import { adminMaps } from "@/server/queries";

export const metadata: Metadata = { title: "Maps — Admin — Gridlock" };

export default async function AdminMapsPage() {
  const res = await tryDb(async () => {
    // (requireAdmin sends anyone else away; adminMaps proves it again from the database)
    return adminMaps(await requireAdmin());
  });
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  if (!res.data) redirect("/");
  const { maps, users } = res.data;
  return (
    <>
      <AppHeader crumbs={[{ label: "Admin" }]} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        <h1 className="mb-4 text-2xl font-semibold tracking-tight">Admin</h1>
        <AdminNav current="/admin/maps" />
        <p className="mb-4 text-sm text-muted-foreground">Every city on this server. Change the owner to hand a city to someone else; the previous owner keeps edit access.</p>
        <MapsAdmin
          users={users}
          maps={maps.map(m => ({ ...m, updatedAt: (m.lastPlanAt ? new Date(m.lastPlanAt) : m.updatedAt).toISOString() }))}
        />
      </main>
    </>
  );
}
