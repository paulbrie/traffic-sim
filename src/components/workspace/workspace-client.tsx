"use client";

import dynamic from "next/dynamic";
import type { WorkspacePlan } from "./workspace";
import type { MenuUser } from "@/components/auth/user-menu";
import type { UserPrefs } from "@/server/queries";

const WorkspaceV2 = dynamic(() => import("@/components/v2/workspace-v2").then(m => m.WorkspaceV2), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-sm text-muted-foreground">Opening plan…</div>,
});
const Workspace = dynamic(() => import("./workspace").then(m => m.Workspace), {
  ssr: false,
  loading: () => <div className="grid h-dvh place-items-center text-sm text-muted-foreground">Opening plan…</div>,
});

/** `engine`: the plan's engine, V2 (the lane sketch as the plan) or V1 */
export function WorkspaceClient({ plan, user, prefs, assistant = false, engine = "v1" }: { plan: WorkspacePlan; user: MenuUser; prefs: UserPrefs; assistant?: boolean; engine?: "v1" | "v2" }) {
  if (engine === "v2") return <WorkspaceV2 key={plan.id} plan={plan} user={user} />;
  return <Workspace key={plan.id} plan={plan} user={user} prefs={prefs} assistant={assistant} />;
}
