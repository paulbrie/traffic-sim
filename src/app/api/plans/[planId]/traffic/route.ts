import type { NextRequest } from "next/server";
import { name } from "@gdp-ts/core";
import { PlanId } from "@/lib/ids";
import { getCurrentUser } from "@/server/auth";
import { planAccess } from "@/server/proofs/plan-access";

// Live traffic (TomTom): proxied server-side so the API key never reaches the browser. Anyone who can
// see the plan can ask for the live conditions over its area (no edit needed: this never changes the plan).

const unauthorized = () => Response.json({ error: "Sign in first" }, { status: 401 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Incident {
  id: string; iconCategory: number; magnitudeOfDelay: number; delay: number | null;
  from: string | null; to: string | null; description: string | null;
  coordinates: { lat: number; lon: number }[];
}

interface TomTomResponse {
  incidents?: {
    properties: { id?: string; iconCategory?: number; magnitudeOfDelay?: number; delay?: number | null; from?: string | null; to?: string | null; events?: { description?: string }[] };
    geometry?: { type?: string; coordinates?: [number, number][] };
  }[];
}

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

    const fields = "{incidents{type,geometry{type,coordinates},properties{id,iconCategory,magnitudeOfDelay,delay,from,to,events{description}}}}";
    const url = `https://api.tomtom.com/traffic/services/5/incidentDetails?key=${encodeURIComponent(key)}&bbox=${west},${south},${east},${north}&fields=${encodeURIComponent(fields)}&language=en-US`;
    let r: Response;
    try { r = await fetch(url); } catch { return Response.json({ error: "Couldn't reach TomTom" }, { status: 502 }); }
    if (!r.ok) return Response.json({ error: `TomTom answered ${r.status}` }, { status: 502 });
    const data: TomTomResponse = await r.json();

    const incidents: Incident[] = (data.incidents ?? []).map((f, i) => {
      const p = f.properties;
      return {
        id: p.id ?? String(i),
        iconCategory: p.iconCategory ?? 0,
        magnitudeOfDelay: p.magnitudeOfDelay ?? 0,
        delay: p.delay ?? null,
        from: p.from ?? null, to: p.to ?? null,
        description: p.events?.[0]?.description ?? null,
        coordinates: (f.geometry?.coordinates ?? []).map(([lon, lat]) => ({ lat, lon })),
      };
    });
    return Response.json({ at: new Date().toISOString(), incidents });
  });
}
