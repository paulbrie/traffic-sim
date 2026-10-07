// What the pages read, for the signed-in user: each names the ids it reads, proves the user's access to them
// (src/server/proofs) and asks the data layer (src/server/data), which won't answer without the proofs.
// Plain data comes back (names and proofs stay inside); pages call connection() through these, so they render
// per request.
import "server-only";
import { connection } from "next/server";
import { name } from "@gdp-ts/core";
import { CityId, PlanId } from "@/lib/ids";
import type { CurrentUser } from "./auth";
import { cityAccess } from "./proofs/city-access";
import { planAccess } from "./proofs/plan-access";
import { userIsAdmin } from "./proofs/user-is-admin";
import { accessOf } from "./proofs/policy";
import * as cities from "./data/cities";
import * as plans from "./data/plans";
import * as users from "./data/users";

export type { CityListItem } from "./data/cities";
export type { UserPrefs } from "./data/users";

/** Maps the user owns plus maps shared with them (admins see every map in the admin section). */
export async function listCities(user: CurrentUser) {
  await connection();
  return cities.listCities(user.id, user.role === "admin" ? "admin" : "user");
}

export async function getCity(id: string, user: CurrentUser) {
  await connection();
  return name(user.id, CityId(id), async (viewer, city) => {
    const view = await cityAccess(viewer, city);
    if (!view) return null;
    const data = await cities.getCity(city, viewer, view);
    return data && { ...data, access: accessOf(view) };
  });
}

export async function getPlan(id: string, user: CurrentUser) {
  await connection();
  return name(user.id, PlanId(id), async (viewer, plan) => {
    const view = await planAccess(viewer, plan);
    if (!view) return null;
    const row = await plans.getPlan(plan, view);
    return row && { ...row, access: accessOf(view) };
  });
}

export async function getUserPrefs(user: CurrentUser) {
  return users.getUserPrefs(user.id);
}

/** Admins: every map, and every account's email (to hand a map to). Null for anyone else. */
export async function adminMaps(user: CurrentUser) {
  await connection();
  return name(user.id, async viewer => {
    const admin = await userIsAdmin(viewer);
    if (!admin) return null;
    const [maps, emails] = await Promise.all([cities.listAllCities(admin), users.listUserEmails(admin)]);
    return { maps, users: emails };
  });
}

/** Admins: every account. Null for anyone else. */
export async function adminUsers(user: CurrentUser) {
  await connection();
  return name(user.id, async viewer => {
    const admin = await userIsAdmin(viewer);
    return admin ? users.listUsers(admin) : null;
  });
}
