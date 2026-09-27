/**
 * Creates (or resets) an admin account.
 *   npm run db:admin                      -> ADMIN_EMAIL / ADMIN_PASSWORD from .env.local / .env
 *   npm run db:admin -- someone@x.com     -> that email, generated password
 * The account must choose a new password at first sign-in.
 */
import "./env";
import { eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { cities, users } from "../src/db/schema";
import { generatePassword, hashPassword, passwordProblem } from "../src/server/password";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://traffic:traffic@localhost:5544/traffic", { max: 1 });
const db = drizzle(sql);

async function main() {
  const email = (process.argv[2] ?? process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  if (!email) throw new Error("Pass an email or set ADMIN_EMAIL");
  const fromEnv = !process.argv[2] && process.env.ADMIN_PASSWORD;
  const password = fromEnv ? process.env.ADMIN_PASSWORD! : generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(`ADMIN_PASSWORD: ${problem}`);
  const passwordHash = await hashPassword(password);
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    await db.update(users).set({ role: "admin", passwordHash, mustChangePassword: true, updatedAt: new Date() }).where(eq(users.id, existing.id));
    console.log(`Reset ${email} (admin).`);
  } else {
    await db.insert(users).values({ email, name: email.split("@")[0], role: "admin", passwordHash, mustChangePassword: true });
    console.log(`Created admin ${email}.`);
  }
  // maps without an owner (created before accounts existed) go to this admin
  const [me] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  const claimed = await db.update(cities).set({ ownerId: me.id }).where(isNull(cities.ownerId)).returning({ id: cities.id });
  if (claimed.length) console.log(`${claimed.length} map(s) without an owner now belong to ${email}.`);
  console.log(fromEnv ? "Password: the ADMIN_PASSWORD value in your env file." : `Temporary password: ${password}`);
  console.log("You'll be asked to choose a new password after signing in.");
  await sql.end();
}
main().catch(async (e) => { console.error(e instanceof Error ? e.message : e); await sql.end(); process.exit(1); });
