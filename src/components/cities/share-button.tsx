"use client";

import { useState } from "react";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ShareDialog } from "./share-dialog";

export function ShareButton({ city }: { city: { id: string; name: string } }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Share2 /> Share</Button>
      <ShareDialog city={city} open={open} onOpenChange={setOpen} />
    </>
  );
}
