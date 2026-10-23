// What the dev bar shows (src/components/dev-bar.tsx): on only with ENV=DEV (as npm run dev sets it), never built into
// the client bundle (server-only), so there's nothing to leak into a production build that doesn't set it.
import "server-only";
import { execFileSync } from "node:child_process";

export const devBarOn = () => process.env.ENV === "DEV";

/** the branch checked out where the dev server runs, or null (not a git checkout, or git isn't on the PATH) */
export function gitBranch(): string | null {
  try {
    const name = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    return name && name !== "HEAD" ? name : null;
  } catch {
    return null;
  }
}

/** the commit checked out where the dev server runs (short hash, and its subject for a tooltip), or null (ticket #82) */
export function gitCommit(): { hash: string; subject: string } | null {
  try {
    const [hash, subject] = execFileSync("git", ["log", "-1", "--format=%h%n%s"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n");
    return hash ? { hash, subject: subject ?? "" } : null;
  } catch {
    return null;
  }
}
