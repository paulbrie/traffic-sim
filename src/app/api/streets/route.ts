import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { fetchNominatimStreet, fetchStreetsNear, OsmError } from "@/server/osm";

// The street names near a point, from OpenStreetMap (ticket #48: the V2 map's right-click menu, to name the road under
// the click). `source=nominatim`: the nearest street, fast; `source=overpass`: the named streets within 200 m, slower
// (the menu asks both and shows the first as soon as it comes). A route, not a server action: those run one at a time
// per page, so a slow lookup would hold up the plan's autosave. Signed-in users only; it never changes a plan.

const unauthorized = () => Response.json({ error: "Sign in first" }, { status: 401 });

export async function GET(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return unauthorized();
  const sp = req.nextUrl.searchParams;
  const lat = Number(sp.get("lat")), lon = Number(sp.get("lon")), source = sp.get("source");
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return Response.json({ error: "Not a point on Earth" }, { status: 400 });
  if (source !== "nominatim" && source !== "overpass") return Response.json({ error: "Unknown source" }, { status: 400 });
  try {
    if (source === "nominatim") {
      const s = await fetchNominatimStreet(lat, lon);
      return Response.json({ streets: s ? [s] : [] });
    }
    return Response.json({ streets: await fetchStreetsNear(lat, lon) });
  } catch (e) {
    if (e instanceof OsmError) return Response.json({ error: e.message }, { status: 502 });
    throw e;
  }
}
