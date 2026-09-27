"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { duplicateCity } from "@/server/actions";

/** Copies the whole city (all plans) into a new one owned by the current user, then opens it. */
export function DuplicateCityButton({ city, label = "Duplicate" }: { city: { id: string; name: string }; label?: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => start(async () => {
      try {
        const id = await duplicateCity(city.id);
        toast.success(`Copied ${city.name}`);
        router.push(`/cities/${id}`);
      } catch (e) { toast.error(e instanceof Error ? e.message : "Couldn't copy the city"); }
    })}>
      {pending ? <Loader2 className="animate-spin" /> : <Copy />} {label}
    </Button>
  );
}
