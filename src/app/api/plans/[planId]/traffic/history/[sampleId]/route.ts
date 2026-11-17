import { gunzipSync, gzipSync } from "node:zlib";
import { name } from "@gdp-ts/core";
import { PlanId } from "@/lib/ids";
import { getCurrentUser } from "@/server/auth";
import { trafficSample } from "@/server/data/traffic-history";
import { planAccess } from "@/server/proofs/plan-access";

// (ticket #261) one sample of TomTom's traffic recorded for a plan, for the Live traffic panel's replay: gzipped JSON
// { at, area, incidents, speeds, ratios } (application/gzip: the page unzips it, so no proxy zips it again). A sample
// never changes, so the browser keeps it. Anyone who can see the plan.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: RouteContext<"/api/plans/[planId]/traffic/history/[sampleId]">) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return Response.json({ error: "Sign in first" }, { status: 401 });
  const { planId, sampleId } = await ctx.params;
  if (!UUID.test(planId) || !UUID.test(sampleId)) return Response.json({ error: "Invalid id" }, { status: 400 });
  return name(me.id, PlanId(planId), async (user, plan) => {
    const view = await planAccess(user, plan);
    if (!view) return Response.json({ error: "Plan not found" }, { status: 404 });
    const s = await trafficSample(plan, sampleId, view);
    if (!s) return Response.json({ error: "No such sample, or it has no data" }, { status: 404 });
    // (the lines as kept, { speeds, ratios }, with the rest put in front: not parsed again)
    const lines = gunzipSync(s.data).toString();
    const body = gzipSync(`{"at":${JSON.stringify(s.at.toISOString())},"area":${JSON.stringify(s.area)},"incidents":${JSON.stringify(s.incidents)},${lines.slice(1)}`, { level: 6 });
    return new Response(new Uint8Array(body), { headers: { "Content-Type": "application/gzip", "Cache-Control": "private, max-age=31536000, immutable" } });
  });
}
