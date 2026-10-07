// What each kind of work on a city or plan needs, as unions of the proofs in city-access.ts and
// plan-access.ts (a stronger proof will do where a weaker one is asked for). Mints nothing, so nothing here
// is trusted: it only picks, from the strongest proof a user has, the one a function asks for.
import type { CityAccess, UserCanEditCity, UserOwnsCity } from "./city-access";
import type { PlanAccess, UserCanEditPlan, UserOwnsPlan } from "./plan-access";

export type CanViewCity<U, C> = CityAccess<U, C>;
export type CanEditCity<U, C> = UserOwnsCity<U, C> | UserCanEditCity<U, C>;
export type CanOwnCity<U, C> = UserOwnsCity<U, C>;

export type CanViewPlan<U, P> = PlanAccess<U, P>;
export type CanEditPlan<U, P> = UserOwnsPlan<U, P> | UserCanEditPlan<U, P>;
export type CanOwnPlan<U, P> = UserOwnsPlan<U, P>;

export const canEditCity = <U, C>(a: CityAccess<U, C> | null): CanEditCity<U, C> | null => (a && a.kind !== "UserCanViewCity" ? a : null);
export const canOwnCity = <U, C>(a: CityAccess<U, C> | null): CanOwnCity<U, C> | null => (a?.kind === "UserOwnsCity" ? a : null);
export const canEditPlan = <U, P>(a: PlanAccess<U, P> | null): CanEditPlan<U, P> | null => (a && a.kind !== "UserCanViewPlan" ? a : null);
export const canOwnPlan = <U, P>(a: PlanAccess<U, P> | null): CanOwnPlan<U, P> | null => (a?.kind === "UserOwnsPlan" ? a : null);

/**
 * Why the user may not: an unknown city or plan and one they can't see read the same ("not found"); one they
 * can see but not change says so.
 */
export function refusal(had: { kind: string } | null, need: "edit" | "own", what: "map" | "plan"): Error {
  if (!had) return new Error(what === "map" ? "Map not found" : "Plan not found");
  return new Error(need === "own" ? "Only the owner of this map can do that." : "You can view this map but not change it. Ask its owner for edit access.");
}

/** the access a proof stands for, as the pages show it (owner, write, read) */
export type Access = "owner" | "write" | "read";
export function accessOf(p: { kind: CityAccess<unknown, unknown>["kind"] | PlanAccess<unknown, unknown>["kind"] }): Access {
  return p.kind === "UserOwnsCity" || p.kind === "UserOwnsPlan" ? "owner" : p.kind === "UserCanEditCity" || p.kind === "UserCanEditPlan" ? "write" : "read";
}
