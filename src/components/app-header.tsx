import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { UserMenu } from "@/components/auth/user-menu";
import { getCurrentUser } from "@/server/auth";

export function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
      <span className="grid size-7 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">GR</span>
      <span>Gridlock</span>
    </Link>
  );
}

export async function AppHeader({ crumbs = [], children }: { crumbs?: { href?: string; label: string }[]; children?: React.ReactNode }) {
  // the header also renders on the database-error screen, so never let this throw
  const user = await getCurrentUser().catch(() => null);
  return (
    <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
        <Logo />
        {crumbs.map((c, i) => (
          <span key={i} className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground">
            <ChevronRight className="size-4 shrink-0" />
            {c.href ? <Link href={c.href} className="truncate hover:text-foreground">{c.label}</Link> : <span className="truncate text-foreground">{c.label}</span>}
          </span>
        ))}
        <div className="ml-auto flex items-center gap-2">
          {children}
          {user && <UserMenu user={{ email: user.email, name: user.name, role: user.role }} />}
        </div>
      </div>
    </header>
  );
}
