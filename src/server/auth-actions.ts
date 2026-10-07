"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { name } from "@gdp-ts/core";
import { db, schema } from "@/db";
import { assertUser, createSession, destroySession, getCurrentUser, signupOpen } from "./auth";
import { hashPassword, passwordProblem, verifyPassword } from "./password";
import { UserId } from "@/lib/ids";
import { userIsAdmin } from "./proofs/user-is-admin";
import * as users from "./data/users";
import { diagnoseDbError } from "./db-status";

export type FormState = { error?: string; ok?: string; email?: string; name?: string } | undefined;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: FormDataEntryValue | null, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
/** a form field as typed (passwords: not trimmed) */
const raw = (v: FormDataEntryValue | null) => (typeof v === "string" ? v : "");

// --- sign-in throttling: 8 failures per email+IP per 10 minutes (in memory, per server process)
const failures = new Map<string, { n: number; until: number }>();
function throttled(key: string) { const f = failures.get(key); return !!f && f.n >= 8 && f.until > Date.now(); }
function fail(key: string) {
  const f = failures.get(key);
  const fresh = !f || f.until < Date.now();
  failures.set(key, { n: fresh ? 1 : f!.n + 1, until: Date.now() + 10 * 60_000 });
}

// a real hash to compare against when the email is unknown, so timing doesn't reveal which emails exist
let dummyHash: Promise<string> | null = null;

/** only allow same-site relative paths after sign-in */
const safeNext = (v: string) => (v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\") ? v : "/");

export async function login(_: FormState, form: FormData): Promise<FormState> {
  const email = text(form.get("email")).toLowerCase();
  const password = raw(form.get("password"));
  const next = safeNext(text(form.get("next"), 500));
  if (!email || !password) return { error: "Enter your email and password." };
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const key = `${email}|${ip}`;
  if (throttled(key)) return { error: "Too many attempts. Try again in a few minutes.", email };

  let user: schema.User | undefined;
  try {
    [user] = await db.select().from(schema.users).where(eq(schema.users.email, email));
  } catch (e) {
    const p = diagnoseDbError(e);
    console.warn(`[db] ${p.kind}: ${p.detail}`);
    const hint = {
      "not-migrated": "The users table doesn't exist yet. Run: npm run db:migrate && npm run db:admin",
      offline: "Can't reach the database. Check DATABASE_URL in .env.local.",
      auth: "The database rejected the login in DATABASE_URL.",
      "no-database": "The database named in DATABASE_URL doesn't exist.",
      unknown: `Database error: ${p.detail}`,
    }[p.kind];
    return { error: hint, email };
  }
  dummyHash ??= hashPassword("not-a-real-password");
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok) { fail(key); return { error: "Email or password is incorrect.", email }; }

  failures.delete(key);
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  await createSession(user.id);
  redirect(user.mustChangePassword ? "/account/password" : next);
}

// --- sign-up throttling: 5 new accounts per IP per hour (in memory, per server process)
const signups = new Map<string, number[]>();

export async function signup(_: FormState, form: FormData): Promise<FormState> {
  if (!signupOpen()) return { error: "Sign-up is closed. Ask an admin for an account." };
  const name = text(form.get("name"), 120);
  const email = text(form.get("email")).toLowerCase();
  const password = raw(form.get("password"));
  const confirm = raw(form.get("confirm"));
  const keep = { email, name };
  if (!EMAIL.test(email)) return { error: "Enter a valid email address.", ...keep };
  const problem = passwordProblem(password);
  if (problem) return { error: problem, ...keep };
  if (password !== confirm) return { error: "The passwords don't match.", ...keep };
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const recent = (signups.get(ip) ?? []).filter(t => t > Date.now() - 3600_000);
  if (recent.length >= 5) return { error: "Too many new accounts from this network. Try again later.", ...keep };
  let id: string;
  try {
    const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
    if (exists) return { error: "An account with this email already exists. Sign in instead.", ...keep };
    const [row] = await db.insert(schema.users)
      .values({ email, name: name || email.split("@")[0], role: "user", passwordHash: await hashPassword(password), lastLoginAt: new Date() })
      .onConflictDoNothing()
      .returning({ id: schema.users.id });
    if (!row) return { error: "An account with this email already exists. Sign in instead.", ...keep };
    id = row.id;
  } catch (e) {
    const p = diagnoseDbError(e);
    return { error: p.kind === "not-migrated" ? "The database needs migrating: npm run db:migrate" : `Database error: ${p.detail}`, ...keep };
  }
  signups.set(ip, [...recent, Date.now()]);
  await createSession(id);
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}

export async function changePassword(_: FormState, form: FormData): Promise<FormState> {
  const me = await getCurrentUser();
  if (!me) redirect("/login");
  const current = raw(form.get("current"));
  const next = raw(form.get("password"));
  const confirm = raw(form.get("confirm"));
  const [row] = await db.select({ hash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, me.id));
  if (!row || !(await verifyPassword(current, row.hash))) return { error: "Your current password is incorrect." };
  const problem = passwordProblem(next);
  if (problem) return { error: problem };
  if (next !== confirm) return { error: "The new passwords don't match." };
  if (next === current) return { error: "Choose a password different from the current one." };
  await db.update(schema.users).set({ passwordHash: await hashPassword(next), mustChangePassword: false, updatedAt: new Date() }).where(eq(schema.users.id, me.id));
  // sign out other devices, keep this one
  await destroySession();
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, me.id));
  await createSession(me.id);
  redirect("/");
}

// ---------------------------------------------------------------- user management (admins)
// Each names the signed-in user and proves they are an admin (src/server/proofs/user-is-admin): the account
// functions (src/server/data/users) take nothing else.

type AdminResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Creates a user with a generated temporary password (shown once to the admin). */
export async function createUser(input: { email: string; name: string; role: "admin" | "user" }): Promise<AdminResult<{ password: string }>> {
  const me = await assertUser();
  const email = input.email.trim().toLowerCase().slice(0, 200);
  const res = await name(me.id, async user => {
    const admin = await userIsAdmin(user);
    if (!admin) throw new Error("Admins only");
    if (!EMAIL.test(email)) return { ok: false as const, error: "Enter a valid email address." };
    return users.createUser({ email, name: input.name.trim().slice(0, 120), role: input.role === "admin" ? "admin" : "user" }, admin);
  });
  if (res.ok) revalidatePath("/admin/users");
  return res;
}

export async function updateUser(id: string, input: { name?: string; role?: "admin" | "user" }): Promise<AdminResult> {
  const me = await assertUser();
  const res = await name(me.id, async user => {
    const admin = await userIsAdmin(user);
    if (!admin) throw new Error("Admins only");
    if (!UUID.test(id)) return { ok: false as const, error: "Invalid user." };
    const patch: { name?: string; role?: "admin" | "user" } = {};
    if (typeof input.name === "string") patch.name = input.name.trim().slice(0, 120);
    if (input.role === "admin" || input.role === "user") patch.role = input.role;
    return users.updateUser(UserId(id), user, patch, admin);
  });
  if (res.ok) revalidatePath("/admin/users");
  return res;
}

/** Sets a new temporary password (shown once) and signs the user out everywhere. */
export async function resetUserPassword(id: string): Promise<AdminResult<{ password: string }>> {
  const me = await assertUser();
  const res = await name(me.id, async user => {
    const admin = await userIsAdmin(user);
    if (!admin) throw new Error("Admins only");
    if (!UUID.test(id)) return { ok: false as const, error: "Invalid user." };
    return users.resetUserPassword(UserId(id), admin);
  });
  if (res.ok) revalidatePath("/admin/users");
  return res;
}

export async function deleteUser(id: string): Promise<AdminResult> {
  const me = await assertUser();
  const res = await name(me.id, async user => {
    const admin = await userIsAdmin(user);
    if (!admin) throw new Error("Admins only");
    if (!UUID.test(id)) return { ok: false as const, error: "Invalid user." };
    return users.deleteUser(UserId(id), user, admin);
  });
  if (res.ok) { revalidatePath("/admin/users"); revalidatePath("/admin/maps"); }
  return res;
}
