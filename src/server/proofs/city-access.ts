// Trusted: the only place that can prove what the signed-in user may do with a city (a map). One query
// decides it — admins and the owner own it, anyone it is shared with has the access it was shared with —
// and the strongest proof that holds comes back (null: none, or no such city: the two look the same).
import "server-only";
import { and, eq } from "drizzle-orm";
import { defineProof, type Named, type Proof } from "@gdp-ts/core";
import { db, schema } from "@/db";
import type { CityId, ViewerId } from "@/lib/ids";

const UserOwnsCity = defineProof("UserOwnsCity");
const UserCanEditCity = defineProof("UserCanEditCity");
const UserCanViewCity = defineProof("UserCanViewCity");

/** U owns city C, or is an admin: everything, sharing, renaming and deleting included */
export interface UserOwnsCity<U, C> extends Proof<"UserOwnsCity", [U, C]> {}
/** C is shared with U for editing: open, simulate, edit and add plans */
export interface UserCanEditCity<U, C> extends Proof<"UserCanEditCity", [U, C]> {}
/** C is shared with U to look at: open and simulate its plans, nothing saved */
export interface UserCanViewCity<U, C> extends Proof<"UserCanViewCity", [U, C]> {}

export type CityAccess<U, C> = UserOwnsCity<U, C> | UserCanEditCity<U, C> | UserCanViewCity<U, C>;

export async function cityAccess<U, C>(user: Named<U, ViewerId>, city: Named<C, CityId>): Promise<CityAccess<U, C> | null> {
  const [row] = await db
    .select({ ownerId: schema.cities.ownerId, share: schema.cityShares.access, role: schema.users.role })
    .from(schema.cities)
    .leftJoin(schema.cityShares, and(eq(schema.cityShares.cityId, schema.cities.id), eq(schema.cityShares.userId, user.value)))
    .leftJoin(schema.users, eq(schema.users.id, user.value))
    .where(eq(schema.cities.id, city.value));
  if (!row) return null;
  if (row.role === "admin" || row.ownerId === user.value) return UserOwnsCity.prove(user, city);
  if (row.share === "write") return UserCanEditCity.prove(user, city);
  if (row.share === "read") return UserCanViewCity.prove(user, city);
  return null;
}
