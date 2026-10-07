// A plan's saved versions. Only called from the data layer's own transactions, on plans whose access the
// caller has already proved (or that it has just created).
import "server-only";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Network, PlanSettings } from "@/engine/types";
import type { Underlay } from "@/lib/underlay";

/** autosaves by the same person within this window update the newest version instead of adding one */
const SESSION_MS = 3 * 60_000;
/** versions kept per plan (the oldest are dropped) */
export const KEEP_VERSIONS = 300;

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface Snapshot { revision: number; network: Network; settings: PlanSettings; underlay: Underlay | null }

export async function recordVersion(tx: Tx, planId: string, userId: string, snap: Snapshot, kind: "create" | "save" | "restore", note = "") {
  const now = new Date();
  if (kind === "save") {
    const [last] = await tx
      .select({ id: schema.planVersions.id, userId: schema.planVersions.userId, kind: schema.planVersions.kind, createdAt: schema.planVersions.createdAt })
      .from(schema.planVersions).where(eq(schema.planVersions.planId, planId)).orderBy(desc(schema.planVersions.createdAt)).limit(1);
    if (last && last.kind === "save" && last.userId === userId && now.getTime() - last.createdAt.getTime() < SESSION_MS) {
      await tx.update(schema.planVersions).set({ ...snap, updatedAt: now }).where(eq(schema.planVersions.id, last.id));
      return;
    }
  }
  await tx.insert(schema.planVersions).values({ planId, userId, kind, note, ...snap, createdAt: now, updatedAt: now });
  // keep the newest KEEP_VERSIONS
  const [cut] = await tx
    .select({ createdAt: schema.planVersions.createdAt })
    .from(schema.planVersions).where(eq(schema.planVersions.planId, planId)).orderBy(desc(schema.planVersions.createdAt)).offset(KEEP_VERSIONS).limit(1);
  if (cut) await tx.delete(schema.planVersions).where(and(eq(schema.planVersions.planId, planId), lt(schema.planVersions.createdAt, sql`${cut.createdAt}::timestamptz + interval '1 millisecond'`)));
}
