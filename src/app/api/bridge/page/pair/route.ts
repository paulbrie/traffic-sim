import { getCurrentUser } from "@/server/auth";
import { pair } from "@/server/bridge";

// A page asks to be paired with an agent (signed-in admins only): the code to give the agent, the page's token.
export async function POST() {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return Response.json({ error: "Sign in first" }, { status: 401 });
  if (me.role !== "admin") return Response.json({ error: "Admins only" }, { status: 403 });
  return Response.json(pair(me.id), { headers: { "Cache-Control": "no-store" } });
}
