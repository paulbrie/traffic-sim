import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { PasswordForm } from "@/components/auth/password-form";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { requireUser } from "@/server/auth";
import { tryDb } from "@/server/db-status";
import { MIN_PASSWORD } from "@/server/password";

export const metadata: Metadata = { title: "Change password — Gridlock" };

export default async function PasswordPage() {
  const res = await tryDb(() => requireUser({ allowPasswordChange: true }));
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  const me = res.data;
  return (
    <>
      <AppHeader crumbs={[{ label: "Change password" }]} />
      <main className="mx-auto grid w-full max-w-sm flex-1 content-start px-4 py-12">
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="mb-1 text-lg font-semibold tracking-tight">{me.mustChangePassword ? "Choose your own password" : "Change password"}</h1>
          <p className="mb-5 text-sm text-muted-foreground">
            {me.mustChangePassword ? "You signed in with a temporary password. Pick a new one to continue." : `Signed in as ${me.email}.`}
          </p>
          <PasswordForm min={MIN_PASSWORD} />
        </div>
      </main>
    </>
  );
}
