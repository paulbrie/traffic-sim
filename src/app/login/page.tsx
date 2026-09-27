import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Logo } from "@/components/app-header";
import { LoginForm } from "@/components/auth/login-form";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { getCurrentUser } from "@/server/auth";
import { tryDb } from "@/server/db-status";

export const metadata: Metadata = { title: "Sign in — Gridlock" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/";
  const res = await tryDb(getCurrentUser);
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  if (res.data) redirect(res.data.mustChangePassword ? "/account/password" : next);
  return (
    <main className="grid flex-1 place-items-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><Logo /></div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="mb-1 text-lg font-semibold tracking-tight">Sign in</h1>
          <p className="mb-5 text-sm text-muted-foreground">Use the account an admin created for you.</p>
          <LoginForm next={next} />
        </div>
      </div>
    </main>
  );
}
