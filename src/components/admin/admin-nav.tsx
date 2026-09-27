import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/maps", label: "Maps" },
] as const;

export function AdminNav({ current }: { current: (typeof TABS)[number]["href"] }) {
  return (
    <nav className="mb-6 flex gap-1 border-b" aria-label="Admin sections">
      {TABS.map(t => (
        <Link key={t.href} href={t.href} aria-current={t.href === current ? "page" : undefined}
          className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t.href === current ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
