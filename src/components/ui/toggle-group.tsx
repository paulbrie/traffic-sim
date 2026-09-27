"use client";
import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function ToggleGroup({ className, children, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Root>) {
  return (
    <ToggleGroupPrimitive.Root data-slot="toggle-group" className={cn("inline-flex w-fit items-center rounded-md border bg-background p-0.5 shadow-xs", className)} {...props}>
      {children}
    </ToggleGroupPrimitive.Root>
  );
}
function ToggleGroupItem({ className, children, ...props }: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn("inline-flex h-7 min-w-7 items-center justify-center gap-1.5 rounded-[5px] px-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none data-[state=on]:bg-primary data-[state=on]:text-primary-foreground disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
