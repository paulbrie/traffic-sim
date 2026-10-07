// Accounts: managing them takes a proof that the signed-in user is an admin (src/server/proofs/user-is-admin),
// and where that admin acts for themselves too (keeping their own role, taking over a deleted account's
// maps) they come named, so the proof must be about them. A user's own preferences take a ViewerId.
import "server-only";
import { and, asc, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { Named } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { UserId, ViewerId } from "@/lib/ids";
import { sanitizeHeliKeys, type HeliKeys } from "@/lib/heli-keys";
import { generatePassword, hashPassword } from "../password";
import type { UserIsAdmin } from "../proofs/user-is-admin";

export async function listUsers<U>(_proof: UserIsAdmin<U>) {
  return db
    .select({ id: schema.users.id, email: schema.users.email, name: schema.users.name, role: schema.users.role, mustChangePassword: schema.users.mustChangePassword, lastLoginAt: schema.users.lastLoginAt, createdAt: schema.users.createdAt })
    .from(schema.users)
    .orderBy(asc(schema.users.email));
}

/** every account's id and email (to hand a map to) */
export async function listUserEmails<U>(_proof: UserIsAdmin<U>) {
  return db.select({ id: schema.users.id, email: schema.users.email }).from(schema.users).orderBy(asc(schema.users.email));
}

/** the account and the signed-in user are the same one */
const same = (a: string, b: string) => a === b;

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** A new account with a generated temporary password (shown once to the admin). */
export async function createUser<U>(input: { email: string; name: string; role: "admin" | "user" }, _proof: UserIsAdmin<U>): Promise<Result<{ password: string }>> {
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, input.email));
  if (exists) return { ok: false, error: "A user with this email already exists." };
  const password = generatePassword();
  await db.insert(schema.users).values({ email: input.email, name: input.name, role: input.role, passwordHash: await hashPassword(password), mustChangePassword: true });
  return { ok: true, password };
}

export async function updateUser<U>(target: UserId, admin: Named<U, ViewerId>, patch: { name?: string; role?: "admin" | "user" }, _proof: UserIsAdmin<U>): Promise<Result> {
  if (same(target, admin.value) && patch.role === "user") return { ok: false, error: "You can't remove your own admin role." };
  await db.update(schema.users).set({ ...patch, updatedAt: new Date() }).where(eq(schema.users.id, target));
  return { ok: true };
}

/** Sets a new temporary password (shown once) and signs the account out everywhere. */
export async function resetUserPassword<U>(target: UserId, _proof: UserIsAdmin<U>): Promise<Result<{ password: string }>> {
  const password = generatePassword();
  await db.update(schema.users).set({ passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: new Date() }).where(eq(schema.users.id, target));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, target));
  return { ok: true, password };
}

/** Deletes an account; its maps go to the admin who deletes it (nothing is lost). */
export async function deleteUser<U>(target: UserId, admin: Named<U, ViewerId>, _proof: UserIsAdmin<U>): Promise<Result> {
  const me = admin.value;
  if (same(target, me)) return { ok: false, error: "You can't delete your own account." };
  const [row] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, target));
  if (row?.role === "admin") {
    const [r] = await db.select({ n: count() }).from(schema.users).where(eq(schema.users.role, "admin"));
    if (r.n <= 1) return { ok: false, error: "Keep at least one admin." };
  }
  await db.transaction(async tx => {
    await tx.execute(sql`delete from city_shares where user_id = ${me} and city_id in (select id from cities where owner_id = ${target})`);
    await tx.update(schema.cities).set({ ownerId: me }).where(or(eq(schema.cities.ownerId, target), isNull(schema.cities.ownerId)));
    await tx.delete(schema.users).where(and(eq(schema.users.id, target), ne(schema.users.id, me)));
  });
  return { ok: true };
}

// ---------------------------------------------------------------- the signed-in user's own preferences

export interface UserPrefs { heliKeys: HeliKeys; warMode: boolean }
/** the defaults if none saved, or when the preferences table isn't there yet */
export async function getUserPrefs(viewer: ViewerId): Promise<UserPrefs> {
  try {
    const [row] = await db.select({ keys: schema.userPrefs.heliKeys, warMode: schema.userPrefs.warMode }).from(schema.userPrefs).where(eq(schema.userPrefs.userId, viewer)).limit(1);
    return { heliKeys: sanitizeHeliKeys(row?.keys), warMode: row?.warMode ?? false };
  } catch {
    return { heliKeys: sanitizeHeliKeys(null), warMode: false };
  }
}

export async function saveHeliKeys(viewer: ViewerId, keys: HeliKeys) {
  await db.insert(schema.userPrefs).values({ userId: viewer, heliKeys: keys, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.userPrefs.userId, set: { heliKeys: keys, updatedAt: new Date() } });
}

export async function saveWarMode(viewer: ViewerId, warMode: boolean) {
  await db.insert(schema.userPrefs).values({ userId: viewer, warMode, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.userPrefs.userId, set: { warMode, updatedAt: new Date() } });
}
