import "server-only";
import { unstable_rethrow } from "next/navigation";

export type DbProblemKind = "offline" | "no-database" | "auth" | "not-migrated" | "unknown";
export interface DbProblem { kind: DbProblemKind; detail: string }

/** Walks `cause` chains (drizzle wraps postgres.js errors) to find a code we recognise. */
export function diagnoseDbError(e: unknown): DbProblem {
  const seen: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 6; depth++) {
    const err = cur as { code?: string; message?: string; errors?: unknown[]; cause?: unknown };
    const code = err.code ?? "";
    const message = err.message || [code, (cur as { address?: string }).address, (cur as { port?: number }).port].filter(Boolean).join(" ") || String(cur);
    seen.push(message);
    if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "CONNECT_TIMEOUT", "EHOSTUNREACH"].includes(code)) return { kind: "offline", detail: message };
    if (code === "3D000") return { kind: "no-database", detail: message };
    if (code === "28P01" || code === "28000") return { kind: "auth", detail: message };
    // 42P01 undefined_table, 42703 undefined_column: migrations missing or behind
    if (code === "42P01" || code === "42703") return { kind: "not-migrated", detail: message };
    // Node's AggregateError (IPv4 + IPv6 attempts both refused)
    if (Array.isArray(err.errors) && err.errors.length) { cur = err.errors[0]; continue; }
    cur = err.cause;
  }
  return { kind: "unknown", detail: seen[seen.length - 1] ?? "Unknown database error" };
}

/** Runs a database read; returns the problem instead of throwing so pages can show setup help. */
export async function tryDb<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; problem: DbProblem }> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    unstable_rethrow(e);
    const problem = diagnoseDbError(e);
    console.warn(`[db] ${problem.kind}: ${problem.detail}`);
    return { ok: false, problem };
  }
}
