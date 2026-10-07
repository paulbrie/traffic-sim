// Branded ids: a plan id can't be passed where a city id is wanted, nor any account's id where the signed-in
// user's is. The one place outside src/server/proofs where `as` makes them (see the gdp-ts lint preset).
// Imports nothing.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** the signed-in user making the request: only src/server/auth.ts makes one, from the session */
export type ViewerId = Brand<string, "ViewerId">;
/** any account (one an admin manages, one a map is shared with) */
export type UserId = Brand<string, "UserId">;
export type CityId = Brand<string, "CityId">;
export type PlanId = Brand<string, "PlanId">;
/** a saved version in a plan's history */
export type VersionId = Brand<string, "VersionId">;

export const UserId = (id: string) => id as UserId;
export const CityId = (id: string) => id as CityId;
export const PlanId = (id: string) => id as PlanId;
export const VersionId = (id: string) => id as VersionId;
