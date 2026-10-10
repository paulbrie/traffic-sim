/**
 * Agents sign in to the dev app without a password (T138): a session for the agent's own test account, its cookie
 * in an agent-browser state file only the agent's user can read.
 *   npm run agent:login -- --as <name>        sign in for 8 h; writes /home/genie/<name>-scratch/agent-browser-state.json
 *   npm run agent:login -- --list <name>      the account's sessions (an id prefix and when each ends; never a token)
 *   npm run agent:login -- --revoke <name>    ends all the account's sessions (these accounts are the agents' own)
 *   npm run agent:login -- --scramble <name>  gives the account a long random password nobody keeps (prints none);
 *                                             only once --as works for it (a live session), with the user's approval
 * Only the names in src/lib/agent-login.ts, each to its own test account (test domains only), and only on
 * trafficsim's dev database: DATABASE_URL from trafficsim's .env.local (nothing else read), which must be `railway`.
 * The token is never printed. The cookie is for localhost, so it works on :7000 and on the private servers.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";
import { dirname } from "path";
import postgres from "postgres";
import { AGENT_SESSION_HOURS, agentAccount, browserState, databaseProblem } from "../src/lib/agent-login";
import { newSessionToken, SESSION_COOKIE } from "../src/lib/session-token";
import { hashPassword } from "../src/server/password";

const ENV_FILE = "/opt/project/projects/trafficsim/.env.local";
const statePath = (name: string) => `/home/genie/${name}-scratch/agent-browser-state.json`;
const hhmm = (d: Date) => d.toTimeString().slice(0, 5);

async function main() {
  const [flag, name, ...extra] = process.argv.slice(2);
  const actions = ["--as", "--list", "--revoke", "--scramble"];
  if (!actions.includes(flag ?? "") || !name || extra.length) throw new Error(`usage: npm run agent:login -- ${actions.join("|")} <name>`);
  const who = name.trim().toLowerCase();
  const acct = agentAccount(who);
  if (!acct.ok) throw new Error(acct.error);

  const url = /^DATABASE_URL=(.*)$/m.exec(readFileSync(ENV_FILE, "utf8"))?.[1].trim().replace(/^"|"$/g, "");
  if (!url) throw new Error("no DATABASE_URL in trafficsim's .env.local");
  const sql = postgres(url, { max: 1 });
  try {
    const [{ d }] = await sql`select current_database() as d`;
    const bad = databaseProblem(d);
    if (bad) throw new Error(bad);
    const [user] = await sql`select id, must_change_password from users where email = ${acct.email}`;
    if (!user) throw new Error(`no account ${acct.email} on this database`);

    if (flag === "--as") {
      const { token, id } = newSessionToken();
      const expires = new Date(Date.now() + AGENT_SESSION_HOURS * 3600_000);
      await sql`insert into sessions (id, user_id, expires_at) values (${id}, ${user.id}, ${expires})`;
      const path = statePath(who);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, JSON.stringify(browserState(SESSION_COOKIE, token, expires)), { mode: 0o600 });
      chmodSync(path, 0o600); // (already there: its mode as well)
      const Name = who[0].toUpperCase() + who.slice(1);
      console.log(`signed in as ${who} until ${hhmm(expires)}; state file: ${path}`);
      console.log(`  agent-browser --session ${Name} --state ${path} --args "--no-sandbox,--remote-debugging-port=0" open http://localhost:7000/projects/trafficsim`);
      if (user.must_change_password) console.log("  (this account still has to change its password: the app will ask for it first)");
    } else if (flag === "--list") {
      const rows = await sql`select id, created_at, expires_at from sessions where user_id = ${user.id} order by created_at`;
      const now = Date.now();
      console.log(`${who}: ${rows.length} session${rows.length === 1 ? "" : "s"}`);
      for (const r of rows) console.log(`  ${String(r.id).slice(0, 8)}…  from ${r.created_at.toISOString().slice(0, 16)}  until ${r.expires_at.toISOString().slice(0, 16)}${r.expires_at.getTime() < now ? "  (ended)" : ""}`);
    } else if (flag === "--revoke") {
      const gone = await sql`delete from sessions where user_id = ${user.id} returning id`;
      console.log(`${who}: ${gone.length} session${gone.length === 1 ? "" : "s"} ended`);
    } else {
      // (only once signing in this way works for the account: a live session from --as)
      const [live] = await sql`select count(*)::int as n from sessions where user_id = ${user.id} and expires_at > now()`;
      if (!live.n) throw new Error(`${who} has no live session: run --as ${who} and check it works before scrambling`);
      const hash = await hashPassword(randomBytes(48).toString("base64url"));
      await sql`update users set password_hash = ${hash}, must_change_password = false, updated_at = now() where id = ${user.id}`;
      console.log(`${who}: password replaced by a random one nobody has; sign in with --as`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
