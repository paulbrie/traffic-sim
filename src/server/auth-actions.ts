"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { and, count, eq, isNull, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { assertUser, createSession, destroySession, getCurrentUser, signupOpen } from "./auth";
import { generatePassword, hashPassword, passwordProblem, verifyPassword } from "./password";
import { diagnoseDbError } from "./db-status";

export type FormState = { error?: string; ok?: string; email?: string; name?: string } | undefined;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: FormDataEntryValue | null, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

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
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
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
  const password = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
  const confirm = typeof form.get("confirm") === "string" ? (form.get("confirm") as string) : "";
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
  const current = (form.get("current") as string) ?? "";
  const next = (form.get("password") as string) ?? "";
  const confirm = (form.get("confirm") as string) ?? "";
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

async function adminCount() {
  const [r] = await db.select({ n: count() }).from(schema.users).where(eq(schema.users.role, "admin"));
  return r.n;
}

/** Creates a user with a generated temporary password (shown once to the admin). */
export async function createUser(input: { email: string; name: string; role: "admin" | "user" }): Promise<{ ok: true; password: string } | { ok: false; error: string }> {
  await assertUser("admin");
  const email = input.email.trim().toLowerCase().slice(0, 200);
  if (!EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  const role = input.role === "admin" ? "admin" : "user";
  const [exists] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email));
  if (exists) return { ok: false, error: "A user with this email already exists." };
  const password = generatePassword();
  await db.insert(schema.users).values({ email, name: input.name.trim().slice(0, 120), role, passwordHash: await hashPassword(password), mustChangePassword: true });
  revalidatePath("/admin/users");
  return { ok: true, password };
}

export async function updateUser(id: string, input: { name?: string; role?: "admin" | "user" }): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await assertUser("admin");
  if (!UUID.test(id)) return { ok: false, error: "Invalid user." };
  const patch: Partial<schema.User> = { updatedAt: new Date() };
  if (typeof input.name === "string") patch.name = input.name.trim().slice(0, 120);
  if (input.role === "admin" || input.role === "user") {
    if (id === me.id && input.role !== "admin") return { ok: false, error: "You can't remove your own admin role." };
    patch.role = input.role;
  }
  await db.update(schema.users).set(patch).where(eq(schema.users.id, id));
  revalidatePath("/admin/users");
  return { ok: true };
}

/** Sets a new temporary password (shown once) and signs the user out everywhere. */
export async function resetUserPassword(id: string): Promise<{ ok: true; password: string } | { ok: false; error: string }> {
  await assertUser("admin");
  if (!UUID.test(id)) return { ok: false, error: "Invalid user." };
  const password = generatePassword();
  await db.update(schema.users).set({ passwordHash: await hashPassword(password), mustChangePassword: true, updatedAt: new Date() }).where(eq(schema.users.id, id));
  await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
  revalidatePath("/admin/users");
  return { ok: true, password };
}

export async function deleteUser(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await assertUser("admin");
  if (!UUID.test(id)) return { ok: false, error: "Invalid user." };
  if (id === me.id) return { ok: false, error: "You can't delete your own account." };
  const [target] = await db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, id));
  if (target?.role === "admin" && (await adminCount()) <= 1) return { ok: false, error: "Keep at least one admin." };
  await db.transaction(async tx => {
    // their maps go to the admin who removes them (nothing is lost; hand them on from Admin → Maps)
    await tx.execute(sql`delete from city_shares where user_id = ${me.id} and city_id in (select id from cities where owner_id = ${id})`);
    await tx.update(schema.cities).set({ ownerId: me.id }).where(or(eq(schema.cities.ownerId, id), isNull(schema.cities.ownerId)));
    await tx.delete(schema.users).where(and(eq(schema.users.id, id), ne(schema.users.id, me.id)));
  });
  revalidatePath("/admin/users");
  revalidatePath("/admin/maps");
  return { ok: true };
}
