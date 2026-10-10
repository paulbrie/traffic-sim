// The agents' sign-in (T138): its guards (only the listed agents, each to its own test account, test domains only,
// only the dev database) and the state file agent-browser loads.
import { strict as assert } from "node:assert";
import { AGENT_ACCOUNTS, agentAccount, browserState, databaseProblem, isTestEmail } from "../src/lib/agent-login";
import { newSessionToken, sessionDigest } from "../src/lib/session-token";

let ok = 0;
const t = (name: string, f: () => void) => { f(); ok++; console.log(`ok  ${name}`); };

t("listed agents sign in as their own test account; any case", () => {
  assert.deepEqual(agentAccount("ramona"), { ok: true, email: "ramona@test.com" });
  assert.deepEqual(agentAccount("Tatiana"), { ok: true, email: "tatiana@test.com" });
  for (const n of ["alex", "bob", "tom"]) assert.deepEqual(agentAccount(n), { ok: true, email: `${n}@test.com` });
});
t("names not on the list are refused (the user's, other real accounts, made-up ones)", () => {
  for (const n of ["paul", "admin", "alice", "claude-tests", "", "ramona@test.com", "__proto__", "constructor"]) assert.equal(agentAccount(n).ok, false, n);
});
t("only test email domains", () => {
  for (const e of ["ramona@test.com", "x@gridlock.test", "Y@TEST.COM"]) assert.equal(isTestEmail(e), true, e);
  for (const e of ["paul.brie@teleporthq.io", "claude-screenshots@teleporthq.io", "x@test.com.evil.io", "x@nottest.com", "test.com", "@test.com"]) assert.equal(isTestEmail(e), false, e);
  // and every listed account is one
  for (const e of Object.values(AGENT_ACCOUNTS)) assert.equal(isTestEmail(e), true, e);
});
t("only trafficsim's dev database", () => {
  assert.equal(databaseProblem("railway"), null);
  for (const d of ["admin_dashboard", "traffic", "postgres", ""]) assert.match(databaseProblem(d) ?? "", /not railway/, d);
});
t("a session is stored under its token's digest, as the app's sign-in does", () => {
  const a = newSessionToken(), b = newSessionToken();
  assert.equal(a.id, sessionDigest(a.token));
  assert.notEqual(a.token, b.token);
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.id, a.token);
});
t("the state file: one httpOnly cookie for localhost, any port, ending with the session", () => {
  const at = new Date("2026-10-10T23:00:00Z");
  assert.deepEqual(browserState("gl_session", "tok", at), {
    cookies: [{ name: "gl_session", value: "tok", domain: "localhost", path: "/", expires: Math.floor(at.getTime() / 1000), httpOnly: true, secure: false, sameSite: "Lax" }],
    origins: [],
  });
});
console.log(`agent-login: ${ok} checks passed`);
