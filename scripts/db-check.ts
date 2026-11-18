/**
 * The server's data layer on a real Postgres of its own (ticket #269): a throwaway container (postgres:16-alpine, a random local
 * port, removed when done), the app's migrations run on it, then the access rules and the data functions as the pages and actions
 * call them. Never the Railway database nor the local dev one: DATABASE_URL is set here, to the container, before `@/db` is loaded.
 *   npm run db:check                (needs Docker)
 * - cityAccess / planAccess: the owner and an admin own, a share for writing edits, one for reading views, anyone else and an
 *   unknown id get nothing; a share taken away, or a role, counts at once (read from the database, not a session)
 * - versionOfPlan: a version of another plan proves nothing (it could be restored into one the user can edit)
 * - savePlan: saves on the revision it was given, a stale one is a conflict (with the revision now), no save empties a plan that
 *   has something (a restore may); autosaves by one person within minutes are one version, a restore its own
 * - restorePlanVersion: back to that version, itself a new revision in the history
 * - shareCity / unshareCity / leaveCity / transferCity: an unknown address or the owner refused; a transfer leaves the old owner
 *   editing; deleting a city takes its plans and their history with it
 */
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { name } from "@gdp-ts/core";
import { CityId, PlanId, VersionId, type ViewerId, UserId } from "../src/lib/ids";
import { emptyNetwork, DEFAULT_SETTINGS } from "../src/engine/types";
import type { Sketch } from "../src/lib/lane-sketch";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let container = "";
const cleanup = () => { if (container) { try { docker("rm", "-f", container); } catch { /* gone already */ } container = ""; } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { cleanup(); process.exit(1); });

async function startDb(): Promise<string> {
  try { docker("version", "--format", "{{.Server.Version}}"); } catch { throw new Error("db:check needs Docker (a throwaway Postgres): docker isn't answering"); }
  container = docker("run", "-d", "--rm", "-e", "POSTGRES_PASSWORD=test", "-e", "POSTGRES_USER=test", "-e", "POSTGRES_DB=test", "-p", "127.0.0.1::5432", "--label", "trafficsim-db-check", "postgres:16-alpine");
  const port = docker("port", container, "5432/tcp").split("\n")[0].split(":").pop();
  const url = `postgres://test:test@127.0.0.1:${port}/test`;
  for (let i = 0; i < 100; i++) {
    const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 2 });
    try { await sql`select 1`; await sql.end(); return url; } catch { await sql.end({ timeout: 0 }).catch(() => {}); await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error("the throwaway Postgres didn't come up in 20 s");
}

let ok = 0;
const t = async (title: string, f: () => Promise<void>) => { await f(); ok++; console.log(`ok  ${title}`); };

async function main() {
  const t0 = Date.now();
  const url = await startDb();
  // (the app's own migrations, as `npm run db:migrate` runs them)
  const mig = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(mig), { migrationsFolder: join(__dirname, "../drizzle") });
  await mig.end();
  process.env.DATABASE_URL = url;
  console.log(`(a throwaway Postgres, migrated, in ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  const { db, schema } = await import("../src/db");
  assert.match(url, /^postgres:\/\/test:test@127\.0\.0\.1:\d+\/test$/);
  const { sql } = await import("drizzle-orm");
  const [{ current_database: dbName }] = await db.execute<{ current_database: string }>(sql`select current_database()`);
  assert.equal(dbName, "test", "connected to the throwaway database");
  const { cityAccess } = await import("../src/server/proofs/city-access");
  const { planAccess } = await import("../src/server/proofs/plan-access");
  const { userIsAdmin } = await import("../src/server/proofs/user-is-admin");
  const { versionOfPlan } = await import("../src/server/proofs/version-of-plan");
  const { canEditPlan, canOwnPlan, canEditCity, canOwnCity, accessOf } = await import("../src/server/proofs/policy");
  const cities = await import("../src/server/data/cities");
  const plans = await import("../src/server/data/plans");
  const { eq } = await import("drizzle-orm");

  // people: an owner, an admin, an editor and a viewer it's shared with, a stranger
  const mk = async (email: string, role: "admin" | "user" = "user") => (await db.insert(schema.users).values({ email, name: email.split("@")[0], role, passwordHash: "x" }).returning({ id: schema.users.id }))[0].id as ViewerId;
  const owner = await mk("owner@test.dev"), admin = await mk("admin@test.dev", "admin"), editor = await mk("editor@test.dev"), viewer = await mk("viewer@test.dev"), stranger = await mk("stranger@test.dev");
  const cityId = CityId(await cities.createCity(owner, { name: "Bistrița", description: "" }));
  const sketch: Sketch = { lanes: [{ id: "a", width: 3.5, shape: { kind: "line", pts: [{ x: 0, y: 0 }, { x: 100, y: 0 }] } }], connectors: [], roads: [], junctions: [] };

  const kindOf = async (who: ViewerId, plan: PlanId) => name(who, plan, async (u, p) => (await planAccess(u, p))?.kind ?? null);
  const cityKind = async (who: ViewerId, city: CityId) => name(who, city, async (u, c) => (await cityAccess(u, c))?.kind ?? null);
  // (as the actions do: proved, then the data layer with the proof)
  const asOwner = <R>(who: ViewerId, city: CityId, f: <U, C>(u: import("@gdp-ts/core").Named<U, ViewerId>, c: import("@gdp-ts/core").Named<C, CityId>, proof: NonNullable<ReturnType<typeof canOwnCity<U, C>>>) => Promise<R>) =>
    name(who, city, async (u, c) => { const p = canOwnCity(await cityAccess(u, c)); assert.ok(p, "owner's proof"); return f(u, c, p); });

  let planId = PlanId("");
  await t("a plan made in a city by its owner, its first version recorded", async () => {
    planId = PlanId(await name(owner, cityId, async (u, c) => {
      const p = canEditCity(await cityAccess(u, c));
      assert.ok(p);
      return plans.createPlan(c, u, { name: "Centre", description: "", network: emptyNetwork(), settings: DEFAULT_SETTINGS, note: "made", engine: "v2" }, p);
    }));
    const vs = await db.select().from(schema.planVersions).where(eq(schema.planVersions.planId, planId));
    assert.deepEqual(vs.map(v => [v.kind, v.note, v.userId]), [["create", "made", owner]]);
  });

  await t("shared: unknown addresses and the owner refused, the others in with the access given", async () => {
    await asOwner(owner, cityId, async (_u, c, p) => {
      assert.equal((await cities.shareCity(c, "nobody@test.dev", "read", p)).ok, false);
      assert.deepEqual(await cities.shareCity(c, "owner@test.dev", "write", p), { ok: false, error: "That's the owner of this map." });
      assert.deepEqual(await cities.shareCity(c, "editor@test.dev", "write", p), { ok: true });
      assert.deepEqual(await cities.shareCity(c, "viewer@test.dev", "read", p), { ok: true });
    });
  });

  await t("planAccess: owner and admin own it, write edits, read views, a stranger and an unknown plan get nothing", async () => {
    assert.equal(await kindOf(owner, planId), "UserOwnsPlan");
    assert.equal(await kindOf(admin, planId), "UserOwnsPlan");
    assert.equal(await kindOf(editor, planId), "UserCanEditPlan");
    assert.equal(await kindOf(viewer, planId), "UserCanViewPlan");
    assert.equal(await kindOf(stranger, planId), null);
    assert.equal(await kindOf(owner, PlanId("00000000-0000-0000-0000-000000000000")), null);
    assert.equal(await cityKind(viewer, cityId), "UserCanViewCity");
    assert.equal(await cityKind(stranger, cityId), null);
  });

  await t("policy: what each proof is good for (a viewer can't edit, an editor can't own)", async () => {
    await name(viewer, planId, async (u, p) => { const a = await planAccess(u, p); assert.ok(a); assert.equal(canEditPlan(a), null); assert.equal(accessOf(a), "read"); });
    await name(editor, planId, async (u, p) => { const a = await planAccess(u, p); assert.ok(a && canEditPlan(a)); assert.equal(canOwnPlan(a), null); assert.equal(accessOf(a), "write"); });
    await name(admin, planId, async (u, p) => { const a = await planAccess(u, p); assert.ok(a && canOwnPlan(a)); assert.equal(accessOf(a), "owner"); });
  });

  let rev = 0;
  await t("savePlan: saves on its revision; a stale revision is a conflict, with the revision now", async () => {
    await name(editor, planId, async (u, p) => {
      const proof = canEditPlan(await planAccess(u, p))!;
      const cur = (await db.select({ r: schema.plans.revision }).from(schema.plans).where(eq(schema.plans.id, planId)))[0].r;
      const a = await plans.savePlan(p, u, { network: emptyNetwork(), settings: DEFAULT_SETTINGS, sketch, revision: cur }, proof);
      assert.ok(a.ok && a.revision === cur + 1, JSON.stringify(a));
      const b = await plans.savePlan(p, u, { network: emptyNetwork(), settings: DEFAULT_SETTINGS, sketch, revision: cur }, proof);
      assert.deepEqual(b, { ok: false, reason: "conflict", revision: cur + 1 });
      rev = cur + 1;
    });
  });

  await t("savePlan: no ordinary save empties a plan that has something; a restore may", async () => {
    await name(editor, planId, async (u, p) => {
      const proof = canEditPlan(await planAccess(u, p))!;
      const empty = await plans.savePlan(p, u, { network: emptyNetwork(), settings: DEFAULT_SETTINGS, sketch: { ...sketch, lanes: [] }, revision: rev }, proof);
      assert.equal(empty.ok, false);
      assert.equal(!empty.ok && empty.reason, "empty");
      const restore = await plans.savePlan(p, u, { network: emptyNetwork(), settings: DEFAULT_SETTINGS, sketch: { ...sketch, lanes: [] }, revision: rev, restore: { note: "from a file", kind: "apply" } }, proof);
      assert.ok(restore.ok);
      rev = restore.revision;
    });
  });

  await t("history: the editor's autosaves within minutes one version, a restore its own", async () => {
    await name(editor, planId, async (u, p) => {
      const proof = canEditPlan(await planAccess(u, p))!;
      for (let i = 0; i < 3; i++) { const r = await plans.savePlan(p, u, { network: emptyNetwork(), settings: DEFAULT_SETTINGS, sketch, revision: rev }, proof); assert.ok(r.ok); rev = r.revision; }
      const vs = await plans.listPlanVersions(p, proof);
      assert.deepEqual(vs.map(v => v.kind), ["save", "apply", "save", "create"]);
      assert.equal(vs[0].revision, rev);
      assert.equal(vs[1].note, "from a file");
    });
  });

  await t("versionOfPlan: another plan's version proves nothing; restoring this plan's own goes back to it, as a new revision", async () => {
    const otherPlan = PlanId(await name(owner, cityId, async (u, c) => plans.createPlan(c, u, { name: "Other", description: "", network: emptyNetwork(), note: "", engine: "v2" }, canEditCity(await cityAccess(u, c))!)));
    const [foreign] = await db.select({ id: schema.planVersions.id }).from(schema.planVersions).where(eq(schema.planVersions.planId, otherPlan));
    const [first] = await db.select({ id: schema.planVersions.id }).from(schema.planVersions).where(eq(schema.planVersions.planId, planId)).orderBy(schema.planVersions.createdAt).limit(1);
    assert.equal(await name(VersionId(foreign.id), planId, async (v, p) => !!(await versionOfPlan(v, p))), false);
    const back = await name(editor, planId, VersionId(first.id), async (u, p, v) => {
      const edit = canEditPlan(await planAccess(u, p))!, version = await versionOfPlan(v, p);
      assert.ok(version);
      return plans.restorePlanVersion(p, v, u, { edit, version });
    });
    assert.equal(back, rev + 1);
    const [now] = await db.select({ sketch: schema.plans.sketch, revision: schema.plans.revision }).from(schema.plans).where(eq(schema.plans.id, planId));
    assert.equal(now.sketch, null, "the first version had no sketch");
    const [last] = await db.select().from(schema.planVersions).where(eq(schema.planVersions.planId, planId)).orderBy(schema.planVersions.createdAt).limit(1).offset(4);
    assert.equal(last.kind, "restore");
  });

  await t("a share taken away, or a role, counts at once", async () => {
    await asOwner(owner, cityId, async (_u, c, p) => cities.unshareCity(c, UserId(editor), p));
    assert.equal(await kindOf(editor, planId), null);
    await cities.leaveCity(cityId, viewer);
    assert.equal(await kindOf(viewer, planId), null);
    await db.update(schema.users).set({ role: "user" }).where(eq(schema.users.id, admin));
    assert.equal(await kindOf(admin, planId), null);
    assert.equal(await name(admin, async u => !!(await userIsAdmin(u))), false);
  });

  await t("transferCity: the new owner owns it, the old one keeps editing", async () => {
    await db.update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin));
    const r = await name(admin, async u => { const proof = await userIsAdmin(u); assert.ok(proof); return cities.transferCity(cityId, UserId(stranger), proof); });
    assert.deepEqual(r, { ok: true });
    assert.equal(await kindOf(stranger, planId), "UserOwnsPlan");
    assert.equal(await kindOf(owner, planId), "UserCanEditPlan");
  });

  await t("deleting a city takes its plans and their history with it", async () => {
    await asOwner(stranger, cityId, async (_u, c, p) => cities.deleteCity(c, p));
    assert.equal((await db.select().from(schema.plans).where(eq(schema.plans.cityId, cityId))).length, 0);
    assert.equal((await db.select().from(schema.planVersions).where(eq(schema.planVersions.planId, planId))).length, 0);
    assert.equal(await kindOf(stranger, planId), null);
  });

  console.log(`db check: ${ok} checks passed (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(0);
}

main().catch(e => { console.error(e); cleanup(); process.exit(1); });
