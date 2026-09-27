"use client";

import { useActionState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signup, type FormState } from "@/server/auth-actions";

export function SignupForm({ min }: { min: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(signup, undefined);
  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" autoComplete="name" placeholder="Optional" defaultValue={state?.name} key={`n${state?.name ?? ""}`} autoFocus />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required defaultValue={state?.email} key={`e${state?.email ?? ""}`} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={min} required />
        <p className="text-xs text-muted-foreground">At least {min} characters.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="confirm">Repeat password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={min} required />
      </div>
      {state?.error && <p className="text-sm text-destructive" role="alert">{state.error}</p>}
      <Button type="submit" disabled={pending}>{pending && <Loader2 className="animate-spin" />} Create free account</Button>
    </form>
  );
}
