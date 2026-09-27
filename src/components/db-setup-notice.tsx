import { DatabaseZap } from "lucide-react";
import { AppHeader } from "@/components/app-header";
import type { DbProblem } from "@/server/db-status";

const HELP: Record<DbProblem["kind"], { title: string; body: string; steps: string[] }> = {
  offline: {
    title: "Can't reach the database",
    body: "Nothing is answering at DATABASE_URL (default: Postgres in Docker on localhost:5544). Start Docker Desktop, then:",
    steps: ["npm run db:up", "npm run db:migrate", "npm run db:seed   # optional demo city"],
  },
  "no-database": {
    title: "The database doesn't exist",
    body: "Postgres is running but the database named in DATABASE_URL is missing. With the bundled Docker setup it is created for you:",
    steps: ["docker compose down -v && npm run db:up", "npm run db:migrate"],
  },
  auth: {
    title: "The database refused the login",
    body: "Postgres answered but rejected the user or password. Something else may already be listening on the port; check DATABASE_URL in .env, or recreate the Docker database:",
    steps: ["cp .env.example .env", "docker compose down -v && npm run db:up", "npm run db:migrate"],
  },
  "not-migrated": {
    title: "The database needs migrating",
    body: "Connected, but the tables are missing or out of date. Apply the migrations:",
    steps: ["npm run db:migrate", "npm run db:seed   # optional demo city"],
  },
  unknown: {
    title: "Database error",
    body: "The query failed. The details below come from Postgres. Checking the setup steps usually fixes it:",
    steps: ["npm run db:up", "npm run db:migrate"],
  },
};

export function DbSetupNotice({ problem }: { problem: DbProblem }) {
  const h = HELP[problem.kind];
  return (
    <>
      <AppHeader />
      <main className="mx-auto grid w-full max-w-2xl flex-1 content-start px-4 py-16">
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="mb-3 flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-destructive/10 text-destructive"><DatabaseZap className="size-5" /></span>
            <h1 className="text-lg font-semibold tracking-tight">{h.title}</h1>
          </div>
          <p className="mb-4 text-sm text-muted-foreground">{h.body}</p>
          <pre className="mb-4 overflow-x-auto rounded-lg bg-muted px-4 py-3 font-mono text-[13px] leading-6">{h.steps.join("\n")}</pre>
          <p className="text-sm text-muted-foreground">Then reload this page.</p>
          <details className="mt-4 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">Error details</summary>
            <p className="mt-2 break-words font-mono">{problem.detail}</p>
          </details>
        </div>
      </main>
    </>
  );
}
