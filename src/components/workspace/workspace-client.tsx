"use client";

import dynamic from "next/dynamic";
import type { WorkspacePlan } from "./workspace";
import type { MenuUser } from "@/components/auth/user-menu";
import type { UserPrefs } from "@/server/queries";

const Workspace = dynamic(() => import("./workspace").then(m => m.Workspace), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-sm text-muted-foreground">Opening plan…</div>,
});

export function WorkspaceClient({ plan, user, prefs }: { plan: WorkspacePlan; user: MenuUser; prefs: UserPrefs }) {
  return <Workspace key={plan.id} plan={plan} user={user} prefs={prefs} />;
}
