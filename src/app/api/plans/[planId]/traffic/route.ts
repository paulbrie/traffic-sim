import type { NextRequest } from "next/server";
import { name } from "@gdp-ts/core";
import { PlanId } from "@/lib/ids";
import { fetchIncidents, TomTomError, type Incident } from "@/lib/tomtom-api";
import { getCurrentUser } from "@/server/auth";
import { planAccess } from "@/server/proofs/plan-access";

// Live traffic (TomTom): proxied server-side so the API key never reaches the browser. Anyone who can
// see the plan can ask for the live conditions over its area (no edit needed: this never changes the plan).

const unauthorized = () => Response.json({ error: "Sign in first" }, { status: 401 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest, ctx: RouteContext<"/api/plans/[planId]/traffic">) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return unauthorized();
  const { planId } = await ctx.params;
  if (!UUID.test(planId)) return Response.json({ error: "Invalid plan" }, { status: 400 });

  const key = process.env.TOMTOM_API;
  if (!key) return Response.json({ error: "TomTom isn't set up on this server" }, { status: 501 });

  const sp = req.nextUrl.searchParams;
  const south = Number(sp.get("south")), west = Number(sp.get("west")), north = Number(sp.get("north")), east = Number(sp.get("east"));
  if (![south, west, north, east].every(Number.isFinite)) return Response.json({ error: "Missing or invalid bbox" }, { status: 400 });
  // (TomTom answers slowly, and this is just a live overlay: a sane area only)
  if (Math.abs(north - south) > 0.2 || Math.abs(east - west) > 0.2) return Response.json({ error: "Area too large" }, { status: 400 });

  return name(me.id, PlanId(planId), async (user, plan) => {
    const access = await planAccess(user, plan);
    if (!access) return Response.json({ error: "Plan not found" }, { status: 404 });

    let incidents: Incident[];
    try { incidents = await fetchIncidents({ south, west, north, east }, key); }
    catch (e) { return Response.json({ error: e instanceof TomTomError ? e.message : "Couldn't reach TomTom" }, { status: 502 }); }
    return Response.json({ at: new Date().toISOString(), incidents });
  });
}
