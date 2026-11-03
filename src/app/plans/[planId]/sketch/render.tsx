// The Sketch page's server side, for /plans/<plan>/sketch and /plans/<plan>/sketch/<sketch> (ticket #120: a sketch's own address)
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SketchPageClient } from "@/components/v2/sketch-page";
import { getPlan } from "@/server/queries";
import { sanitizeNetwork, sanitizeSettings } from "@/engine/validate";
import { sanitizeUnderlay } from "@/lib/underlay";
import { sanitizeSketch } from "@/lib/lane-sketch";
import { sketchBySlug, sketchList } from "@/lib/sketch-list";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { tryDb } from "@/server/db-status";
import { getCurrentUser, requireUser } from "@/server/auth";

/** the page's title: the sketch's name (the one asked for, else the one open), the plan's, the city's */
export async function sketchPageMetadata(planId: string, want?: string): Promise<Metadata> {
  if (!/^[0-9a-f-]{36}$/i.test(planId)) return {};
  const res = await tryDb(async () => { const u = await getCurrentUser(); return u ? getPlan(planId, u) : null; });
  const row = res.ok ? res.data : null;
  if (!row) return { title: "Sketch — Gridlock" };
  const sk = sanitizeSketch(row.plan.sketch), list = sk ? sketchList(sk) : null;
  const id = list ? (want ? sketchBySlug(list.list, want) : null) ?? list.open : null, name = list?.list.find(x => x.id === id)?.name;
  return { title: `${name ? `${name} · ` : ""}Sketch · ${row.plan.name} · ${row.cityName} — Gridlock` };
}

/** the page: the plan loaded, the sketch `want` names (its address part) opened once it is */
export async function renderSketchPage(planId: string, want?: string) {
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
      want={want}
    />
  );
}
