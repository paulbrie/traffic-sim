import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { and, eq, gt } from "drizzle-orm";
import { db, schema } from "@/db";
import type { ViewerId } from "@/lib/ids";
import { newSessionToken, SESSION_COOKIE, sessionDigest as digest } from "@/lib/session-token";

export { SESSION_COOKIE };

/** anyone can create a free account unless ALLOW_SIGNUP=false */
export const signupOpen = () => process.env.ALLOW_SIGNUP !== "false";
const SESSION_DAYS = 30;

/** the signed-in user; `id` is a ViewerId, made here and nowhere else (see src/lib/ids.ts) */
export type CurrentUser = Pick<schema.User, "email" | "name" | "role" | "mustChangePassword"> & { id: ViewerId };

export async function createSession(userId: string) {
  const { token, id } = newSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await db.insert(schema.sessions).values({ id, userId, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: expiresAt,
  });
}

export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(schema.sessions).where(eq(schema.sessions.id, digest(token)));
  store.delete(SESSION_COOKIE);
}

/** The signed-in user for this request, or null. Memoised per render. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, mustChangePassword: schema.users.mustChangePassword })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(and(eq(schema.sessions.id, digest(token)), gt(schema.sessions.expiresAt, new Date())));
  // (the one place a ViewerId is made: from the session just checked)
  return row ? { ...row, id: row.id as ViewerId } : null;
});

/** For pages: redirects to sign-in (or to the password change the account still owes). */
export async function requireUser(opts: { allowPasswordChange?: boolean } = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword && !opts.allowPasswordChange) redirect("/account/password");
  return user;
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user;
}

/** For server actions and route handlers: throws instead of redirecting. */
export async function assertUser(role?: "admin"): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword) throw new Error("Not signed in");
  if (role === "admin" && user.role !== "admin") throw new Error("Admins only");
  return user;
}
