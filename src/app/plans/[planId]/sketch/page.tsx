import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SketchPageClient } from "@/components/v2/sketch-page";
import { getPlan } from "@/server/queries";
import { sanitizeNetwork, sanitizeSettings } from "@/engine/validate";
import { sanitizeUnderlay } from "@/lib/underlay";
import { sanitizeSketch } from "@/lib/lane-sketch";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { tryDb } from "@/server/db-status";
import { getCurrentUser, requireUser } from "@/server/auth";

export async function generateMetadata({ params }: PageProps<"/plans/[planId]/sketch">): Promise<Metadata> {
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) return {};
  const res = await tryDb(async () => { const u = await getCurrentUser(); return u ? getPlan(planId, u) : null; });
  const row = res.ok ? res.data : null;
  return { title: row ? `Sketch · ${row.plan.name} · ${row.cityName} — Gridlock` : "Sketch — Gridlock" };
}

export default async function PlanSketchPage({ params }: PageProps<"/plans/[planId]/sketch">) {
  const { planId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(planId)) notFound();
  const res = await tryDb(async () => { const user = await requireUser(); return { user, row: await getPlan(planId, user) }; });
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const { row, user } = res.data;
  // (the Sketch window's own page is a V2 thing: a V1 plan's sketch window stays over it)
  if (!row || row.plan.engine !== "v2") notFound();
  const { plan, cityName, access } = row;
  return (
    <SketchPageClient
      plan={{
        id: plan.id, name: plan.name, cityId: plan.cityId, cityName,
        network: sanitizeNetwork(plan.network), settings: sanitizeSettings(plan.settings), underlay: sanitizeUnderlay(plan.underlay), sketch: sanitizeSketch(plan.sketch),
        revision: plan.revision, updatedAt: plan.updatedAt.toISOString(), access,
      }}
      user={{ email: user.email, name: user.name, role: user.role }}
    />
  );
}
