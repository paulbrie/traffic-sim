// The junction library: junctions each user saved to reuse in any of their plans. A user's own things: the
// functions take the signed-in user's ViewerId, which only the session makes.
import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ViewerId } from "@/lib/ids";

export interface TemplateItem { id: string; name: string; piece: unknown; createdAt: Date }

/** most saved: a library is for a handful of junction designs, not a plan's worth */
export const MAX_TEMPLATES = 200;

export async function listTemplates(viewer: ViewerId): Promise<TemplateItem[]> {
  return db.select({ id: schema.junctionTemplates.id, name: schema.junctionTemplates.name, piece: schema.junctionTemplates.piece, createdAt: schema.junctionTemplates.createdAt })
    .from(schema.junctionTemplates).where(eq(schema.junctionTemplates.userId, viewer)).orderBy(desc(schema.junctionTemplates.createdAt));
}

export async function countTemplates(viewer: ViewerId): Promise<number> {
  return (await db.$count(schema.junctionTemplates, eq(schema.junctionTemplates.userId, viewer)));
}

export async function addTemplate(viewer: ViewerId, name: string, piece: unknown): Promise<string> {
  const [row] = await db.insert(schema.junctionTemplates).values({ userId: viewer, name, piece }).returning({ id: schema.junctionTemplates.id });
  return row.id;
}

/** (only the user's own: someone else's id deletes nothing) */
export async function deleteTemplate(viewer: ViewerId, id: string) {
  await db.delete(schema.junctionTemplates).where(and(eq(schema.junctionTemplates.id, id), eq(schema.junctionTemplates.userId, viewer)));
}
