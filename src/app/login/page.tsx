import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/app-header";
import { LoginForm } from "@/components/auth/login-form";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { getCurrentUser, signupOpen } from "@/server/auth";
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
          <p className="mb-5 text-sm text-muted-foreground">Welcome back.</p>
          <LoginForm next={next} />
        </div>
        {signupOpen() && (
          <p className="mt-4 text-center text-sm text-muted-foreground">New here? <Link href="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">Create a free account</Link></p>
        )}
      </div>
    </main>
  );
}
