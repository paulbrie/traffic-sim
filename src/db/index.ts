import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL ?? "postgres://traffic:traffic@localhost:5544/traffic";

// Reuse one connection pool across hot reloads in development, but open a new one
// when DATABASE_URL changes (Next reloads .env without restarting the dev server).
const g = globalThis as unknown as { __trafficSql?: ReturnType<typeof postgres>; __trafficSqlUrl?: string };
if (g.__trafficSql && g.__trafficSqlUrl !== url) { g.__trafficSql.end({ timeout: 1 }).catch(() => {}); g.__trafficSql = undefined; }
const sql = g.__trafficSql ?? postgres(url, { max: 5 });
if (process.env.NODE_ENV !== "production") { g.__trafficSql = sql; g.__trafficSqlUrl = url; }

export const db = drizzle(sql, { schema });
export { schema };
