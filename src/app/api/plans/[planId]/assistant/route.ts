import type { NextRequest } from "next/server";
import { name } from "@gdp-ts/core";
import { PlanId } from "@/lib/ids";
import { getCurrentUser } from "@/server/auth";
import { planAccess } from "@/server/proofs/plan-access";
import { userIsAdmin } from "@/server/proofs/user-is-admin";
import { assistantEnabled, runAssistant, type AssistantTurn } from "@/server/assistant";

// The chat bubble's assistant (src/server/assistant.ts): one message in, its answer streamed back as JSON lines.
// Admins only, on a development server where it was switched on; the plan must be one the admin can open.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 40 * 1024 * 1024;

export async function POST(req: NextRequest, ctx: RouteContext<"/api/plans/[planId]/assistant">) {
  if (!assistantEnabled()) return new Response("Not found", { status: 404 });
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return Response.json({ error: "Sign in first" }, { status: 401 });
  // (a page on another site can't post here with the session cookie and have it run)
  const origin = req.headers.get("origin");
  if (!origin || new URL(origin).host !== (req.headers.get("x-forwarded-host") ?? req.headers.get("host"))) return Response.json({ error: "Wrong origin" }, { status: 403 });
  const { planId } = await ctx.params;
  if (!UUID.test(planId)) return new Response("Not found", { status: 404 });
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return Response.json({ error: "Too big" }, { status: 413 });

  let body: Partial<AssistantTurn>;
  try { body = await req.json(); } catch { return Response.json({ error: "Bad request" }, { status: 400 }); }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return Response.json({ error: "Say something" }, { status: 400 });
  const session = typeof body.session === "string" && UUID.test(body.session) ? body.session : null;

  return name(me.id, PlanId(planId), async (user, plan) => {
    const admin = await userIsAdmin(user);
    if (!admin) return Response.json({ error: "Admins only" }, { status: 403 });
    if (!(await planAccess(user, plan))) return new Response("Not found", { status: 404 });
    const turn: AssistantTurn = {
      message, session,
      plan: { id: planId, name: String(body.plan?.name ?? "").slice(0, 200), revision: Number(body.plan?.revision) || 0 },
      network: body.network ?? null, settings: body.settings ?? null,
      context: typeof body.context === "string" ? body.context : "",
    };
    return new Response(runAssistant(turn, me, req.signal, admin), {
      headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" },
    });
  });
}
