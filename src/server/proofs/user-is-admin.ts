// Trusted: the only place that can prove the signed-in user is an admin (read from the database, not the
// session, so a role taken away counts at once).
import "server-only";
import { eq } from "drizzle-orm";
import { defineProof, type Named, type Proof } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { ViewerId } from "@/lib/ids";

const UserIsAdmin = defineProof("UserIsAdmin");
/** U is an admin: manages every account and every map */
export interface UserIsAdmin<U> extends Proof<"UserIsAdmin", [U]> {}

export async function userIsAdmin<U>(user: Named<U, ViewerId>): Promise<UserIsAdmin<U> | null> {
  const [row] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, user.value));
  return row?.role === "admin" ? UserIsAdmin.prove(user) : null;
}
