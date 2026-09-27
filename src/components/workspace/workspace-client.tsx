"use client";

import dynamic from "next/dynamic";
import type { WorkspacePlan } from "./workspace";
import type { MenuUser } from "@/components/auth/user-menu";

const Workspace = dynamic(() => import("./workspace").then(m => m.Workspace), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-sm text-muted-foreground">Opening plan…</div>,
});

export function WorkspaceClient({ plan, user }: { plan: WorkspacePlan; user: MenuUser }) {
  return <Workspace key={plan.id} plan={plan} user={user} />;
}
