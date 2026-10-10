// Agent patches (T132): changes agents propose to a plan, decided by its editors on its page. Listing takes a
// proof that the user may see the plan; deciding one, that they may edit it (and who they are, named).
import "server-only";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Named } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { AgentPatchRow, AgentPatchStatus } from "@/lib/agent-patch";
import type { PlanId, ViewerId } from "@/lib/ids";
import type { CanEditPlan, CanViewPlan } from "../proofs/policy";

/** a patch as listed, with who decided it */
export type AgentPatchView = AgentPatchRow & { decidedByName: string | null };

const p = schema.agentPatches;
const STATUSES: readonly AgentPatchStatus[] = ["pending", "applied", "rejected", "superseded"];
const statusOf = (s: string): AgentPatchStatus => STATUSES.find((x) => x === s) ?? "pending";
const row = (r: typeof p.$inferSelect & { byName: string | null; byEmail: string | null }): AgentPatchView => ({
  id: r.id, planId: r.planId, author: r.author, task: r.task, title: r.title, description: r.description, patch: r.patch,
  baseRevision: r.baseRevision, status: statusOf(r.status), createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null, decidedBy: r.decidedBy, appliedRevision: r.appliedRevision,
  rejectNote: r.rejectNote, decidedByName: r.byName || r.byEmail || null,
});

/** the plan's patches, the pending ones first, then the rest, newest first within each */
export async function listAgentPatches<U, P>(plan: Named<P, PlanId>, _proof: CanViewPlan<U, P>): Promise<AgentPatchView[]> {
  const rows = await db
    .select({ r: p, byName: schema.users.name, byEmail: schema.users.email })
    .from(p).leftJoin(schema.users, eq(schema.users.id, p.decidedBy))
    .where(eq(p.planId, plan.value))
    .orderBy(sql`case when ${p.status} = 'pending' then 0 else 1 end`, sql`${p.createdAt} desc`, asc(p.id));
  return rows.map((x) => row({ ...x.r, byName: x.byName, byEmail: x.byEmail }));
}

/** one pending patch of the plan, or null (decided, or not this plan's) */
export async function pendingPatch<U, P>(plan: Named<P, PlanId>, id: number, _proof: CanEditPlan<U, P>): Promise<AgentPatchRow | null> {
  const [r] = await db.select().from(p).where(and(eq(p.id, id), eq(p.planId, plan.value), eq(p.status, "pending")));
  return r ? row({ ...r, byName: null, byEmail: null }) : null;
}

/** marks a pending patch decided by `user`: applied (with the revision it saved) or rejected (with a note); false if it wasn't pending */
export async function decideAgentPatch<U, P>(
  plan: Named<P, PlanId>, user: Named<U, ViewerId>, id: number,
  d: { status: "applied"; revision: number } | { status: "rejected"; note: string },
  _proof: CanEditPlan<U, P>,
): Promise<boolean> {
  const set = d.status === "applied"
    ? { status: "applied", appliedRevision: d.revision, decidedAt: new Date(), decidedBy: user.value }
    : { status: "rejected", rejectNote: d.note || null, decidedAt: new Date(), decidedBy: user.value };
  const done = await db.update(p).set(set).where(and(eq(p.id, id), eq(p.planId, plan.value), eq(p.status, "pending"))).returning({ id: p.id });
  return done.length > 0;
}
