import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Logo } from "@/components/app-header";
import { SignupForm } from "@/components/auth/signup-form";
import { DbSetupNotice } from "@/components/db-setup-notice";
import { getCurrentUser, signupOpen } from "@/server/auth";
import { tryDb } from "@/server/db-status";
import { MIN_PASSWORD } from "@/server/password";

export const metadata: Metadata = { title: "Create an account — Gridlock" };

export default async function SignupPage() {
  const res = await tryDb(getCurrentUser);
  if (!res.ok) return <DbSetupNotice problem={res.problem} />;
  if (res.data) redirect("/");
  const open = signupOpen();
  return (
    <main className="grid flex-1 place-items-center px-4 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex justify-center"><Logo /></div>
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="mb-1 text-lg font-semibold tracking-tight">Create a free account</h1>
          {open ? (
            <>
              <p className="mb-5 text-sm text-muted-foreground">Build your own maps, and open the ones other people share with you.</p>
              <SignupForm min={MIN_PASSWORD} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Sign-up is closed on this server. Ask an admin to create an account for you.</p>
          )}
        </div>
        <p className="mt-4 text-center text-sm text-muted-foreground">Already have an account? <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">Sign in</Link></p>
      </div>
    </main>
  );
}
