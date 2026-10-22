import { GitBranch } from "lucide-react";
import { devBarOn, gitBranch } from "@/server/dev-info";

/** a thin bar at the bottom of every page, the running branch, while this is a dev server (ENV=DEV); nothing in production, where ENV isn't set (ticket #64) */
export function DevBar() {
  if (!devBarOn()) return null;
  const branch = gitBranch();
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex h-6 items-center justify-center gap-1.5 border-t bg-foreground px-2 font-mono text-[11px] text-background select-none">
      <span className="font-semibold tracking-wide">DEV</span>
      {branch && <><span className="opacity-50">·</span><GitBranch className="size-3" /><span>{branch}</span></>}
    </div>
  );
}
