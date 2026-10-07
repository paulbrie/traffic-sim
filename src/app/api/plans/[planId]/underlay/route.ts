import type { NextRequest } from "next/server";
import { name } from "@gdp-ts/core";
import { UNDERLAY_MAX_BYTES } from "@/lib/underlay";
import { PlanId } from "@/lib/ids";
import { getCurrentUser } from "@/server/auth";
import { planAccess } from "@/server/proofs/plan-access";
import { canEditPlan } from "@/server/proofs/policy";
import { deletePlanImage, getPlanImage, putPlanImage } from "@/server/data/plans";

const unauthorized = () => Response.json({ error: "Sign in first" }, { status: 401 });

// Reference image for a plan: seen by anyone who can see the plan, changed by those who can edit it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** identify the format from the file's first bytes rather than trusting the client */
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export async function GET(_req: NextRequest, ctx: RouteContext<"/api/plans/[planId]/underlay">) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return unauthorized();
  const { planId } = await ctx.params;
  if (!UUID.test(planId)) return new Response("Not found", { status: 404 });
  return name(me.id, PlanId(planId), async (user, plan) => {
    const view = await planAccess(user, plan);
    const row = view && (await getPlanImage(plan, view));
    if (!row) return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(row.data), {
      headers: {
        "Content-Type": row.mime,
        // URLs carry ?v=<version>, so a given URL never changes
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

export async function PUT(req: NextRequest, ctx: RouteContext<"/api/plans/[planId]/underlay">) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return unauthorized();
  const { planId } = await ctx.params;
  if (!UUID.test(planId)) return Response.json({ error: "Invalid plan" }, { status: 400 });
  return name(me.id, PlanId(planId), async (user, plan) => {
    const a = await planAccess(user, plan);
    if (!a) return Response.json({ error: "Plan not found" }, { status: 404 });
    const edit = canEditPlan(a);
    if (!edit) return Response.json({ error: "You can view this plan but not change it" }, { status: 403 });
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > UNDERLAY_MAX_BYTES) return Response.json({ error: "Image is larger than 25 MB" }, { status: 413 });
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength === 0) return Response.json({ error: "Empty upload" }, { status: 400 });
    if (buf.byteLength > UNDERLAY_MAX_BYTES) return Response.json({ error: "Image is larger than 25 MB" }, { status: 413 });
    const mime = sniff(buf);
    if (!mime) return Response.json({ error: "Use a PNG, JPEG or WebP image" }, { status: 415 });
    const now = new Date();
    const stored = await putPlanImage(plan, { mime, data: Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength), bytes: buf.byteLength, at: now }, edit);
    if (!stored) return Response.json({ error: "Plan not found" }, { status: 404 });
    return Response.json({ v: now.getTime(), bytes: buf.byteLength, mime });
  });
}

export async function DELETE(_req: NextRequest, ctx: RouteContext<"/api/plans/[planId]/underlay">) {
  const me = await getCurrentUser();
  if (!me || me.mustChangePassword) return unauthorized();
  const { planId } = await ctx.params;
  if (!UUID.test(planId)) return Response.json({ error: "Invalid plan" }, { status: 400 });
  return name(me.id, PlanId(planId), async (user, plan) => {
    const edit = canEditPlan(await planAccess(user, plan));
    if (!edit) return Response.json({ error: "You can view this plan but not change it" }, { status: 403 });
    await deletePlanImage(plan, edit);
    return new Response(null, { status: 204 });
  });
}
