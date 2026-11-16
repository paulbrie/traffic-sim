import type { NextRequest } from "next/server";
import { name } from "@gdp-ts/core";
import { PlanId } from "@/lib/ids";
import { historyCsv } from "@/lib/traffic-history";
import { getCurrentUser } from "@/server/auth";
import { trafficHistoryExport } from "@/server/data/traffic-history";
import { planAccess } from "@/server/proofs/plan-access";

// (ticket #261) TomTom's traffic recorded for a plan, as a file to analyse (src/lib/traffic-history.ts): the last `days`
// days (default 14, at most 92), JSON or (?format=csv) a table. Anyone who can see the plan.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: RouteContext<"/api/plans/[planId]/traffic/history">) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return Response.json({ error: "Sign in first" }, { status: 401 });
  const { planId } = await ctx.params;
  if (!UUID.test(planId)) return Response.json({ error: "Invalid plan" }, { status: 400 });
  const sp = req.nextUrl.searchParams;
  const days = Math.min(92, Math.max(1, Math.round(Number(sp.get("days") ?? 14)) || 14)), csv = sp.get("format") === "csv";
  return name(me.id, PlanId(planId), async (user, plan) => {
    const view = await planAccess(user, plan);
    if (!view) return Response.json({ error: "Plan not found" }, { status: 404 });
    const e = await trafficHistoryExport(plan, new Date(Date.now() - days * 86_400_000), view);
    if (!e) return Response.json({ error: "The plan has no sketch" }, { status: 404 });
    const file = `traffic-${planId.slice(0, 8)}-${(e.range.from ?? "none").slice(0, 10)}-${(e.range.to ?? "none").slice(0, 10)}.${csv ? "csv" : "json"}`;
    return new Response(csv ? historyCsv(e) : JSON.stringify(e), {
      headers: { "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json", "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store" },
    });
  });
}
