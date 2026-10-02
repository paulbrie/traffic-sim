import { Subject } from "subjecto";
import { DEFAULT_HELI_KEYS, type HeliKeys } from "@/lib/heli-keys";

/** the signed-in user's helicopter keys (from their account; see src/lib/heli-keys.ts) */
export const heliKeys$ = new Subject<HeliKeys>(DEFAULT_HELI_KEYS, { name: "heliKeys" });
