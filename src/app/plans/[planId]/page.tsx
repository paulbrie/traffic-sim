import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WorkspaceClient } from "@/components/workspace/workspace-client";
import { getPlan, getUserPrefs } from "@/server/queries";
import { sanitizeNetwork, sanitizeSettings } from "@/engine/validate";
import { sanitizeUnderlay } from "@/lib/underlay";
import { sanitizeSketch } from "@/lib/lane-sketch";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { tryDb } from "@/server/db-status";
import { getCurrentUser, requireUser } from "@/server/auth";
import { assistantEnabled } from "@/server/assistant";

export async function generateMetadata({ params }: PageProps<"/plans/[planId]">): Promise<Metadata> {
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) return {};
  const res = await tryDb(async () => { const u = await getCurrentUser(); return u ? getPlan(planId, u) : null; });
  const row = res.ok ? res.data : null;
  return { title: row ? `${row.plan.name} · ${row.cityName} — Gridlock` : "Plan — Gridlock" };
}

export default async function PlanPage({ params }: PageProps<"/plans/[planId]">) {
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) notFound();
  const res = await tryDb(async () => { const user = await requireUser(); return { user, row: await getPlan(planId, user), prefs: await getUserPrefs(user) }; });
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const { row, user, prefs } = res.data;
  if (!row) notFound();
  const { plan, cityName, access } = row;
  return (
    <WorkspaceClient
      plan={{
        id: plan.id, name: plan.name, cityId: plan.cityId, cityName,
        network: sanitizeNetwork(plan.network), settings: sanitizeSettings(plan.settings), underlay: sanitizeUnderlay(plan.underlay), sketch: sanitizeSketch(plan.sketch),
        revision: plan.revision, updatedAt: plan.updatedAt.toISOString(), access,
      }}
      user={{ email: user.email, name: user.name, role: user.role }}
      prefs={prefs}
      assistant={user.role === "admin" && assistantEnabled()}
      engine={plan.engine}
    />
  );
}
