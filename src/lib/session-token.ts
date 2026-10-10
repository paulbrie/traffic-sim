/**
 * A sign-in session's token and the id it is stored under (its SHA-256: the token itself is only ever in the
 * cookie). Shared by the app's sign-in (src/server/auth.ts) and the agents' sign-in script (scripts/agent-login.ts),
 * so both make sessions the same way.
 */
import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "gl_session";

export const sessionDigest = (token: string) => createHash("sha256").update(token).digest("hex");

export function newSessionToken(): { token: string; id: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, id: sessionDigest(token) };
}
