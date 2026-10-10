/**
 * Agents sign in to the dev app without passwords (T138, the user's decision): a script makes a session for an
 * agent's own test account and hands its cookie to agent-browser in a state file. Guards, pure so they're tested:
 * only the names listed here, each to its own test account; only test email domains; only trafficsim's dev
 * database (`railway`). The user's and any other real accounts can't be reached through it.
 */

/** the agents with a test account of their own (others: ask Alice and the user first) */
export const AGENT_ACCOUNTS: Readonly<Record<string, string>> = {
  ramona: "ramona@test.com",
  tatiana: "tatiana@test.com",
};
/** email domains of test accounts only */
export const TEST_DOMAINS = ["test.com", "gridlock.test"] as const;
/** how long an agent's session lasts */
export const AGENT_SESSION_HOURS = 8;

export const isTestEmail = (email: string) => {
  const at = email.lastIndexOf("@");
  return at > 0 && (TEST_DOMAINS as readonly string[]).includes(email.slice(at + 1).toLowerCase());
};

/** the test account an agent's name signs in as, or why not */
export function agentAccount(name: string): { ok: true; email: string } | { ok: false; error: string } {
  const key = name.trim().toLowerCase();
  const email = Object.hasOwn(AGENT_ACCOUNTS, key) ? AGENT_ACCOUNTS[key] : undefined;
  if (!email) return { ok: false, error: `"${name}" has no agent test account here (known: ${Object.keys(AGENT_ACCOUNTS).join(", ")}). Ask Alice and the user first.` };
  if (!isTestEmail(email)) return { ok: false, error: `${email} isn't a test account (allowed: @${TEST_DOMAINS.join(", @")}).` };
  return { ok: true, email };
}

/** the database must be trafficsim's dev one */
export const databaseProblem = (name: string) => (name === "railway" ? null : `database is ${name}, not railway: stop`);

/** agent-browser's state file (--state) holding the session cookie for localhost (any port) */
export function browserState(cookieName: string, token: string, expires: Date) {
  return {
    cookies: [{ name: cookieName, value: token, domain: "localhost", path: "/", expires: Math.floor(expires.getTime() / 1000), httpOnly: true, secure: false, sameSite: "Lax" }],
    origins: [],
  };
}
