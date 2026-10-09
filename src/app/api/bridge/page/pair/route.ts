import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth";
import { bodyOf, pair, pairTab, str } from "@/server/bridge";

// A page asks to be paired (signed-in admins only): as a hub, the code to give the agent and the page's token; or, opened
// for an agent with a ticket ({ ticket }), as that agent's tab.
export async function POST(req: NextRequest) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (me.role !== "admin") return Response.json({ error: "Admins only" }, { status: 403 });
  const ticket = str((await bodyOf(req)).ticket);
  if (ticket) {
    const t = pairTab(me.id, ticket);
    return t ? Response.json(t, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: "That tab's ticket is used or expired" }, { status: 404 });
  }
  return Response.json(pair(me.id), { headers: { "Cache-Control": "no-store" } });
}
