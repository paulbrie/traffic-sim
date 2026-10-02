import { boolean, customType, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import type { Network, PlanSettings } from "@/engine/types";
import type { Underlay } from "@/lib/underlay";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/** A city (map) belongs to the user who created it; others see it through city_shares. */
export const cities = pgTable(
  "cities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** null only for maps whose owner was removed without a hand-over: admins still manage them */
    ownerId: uuid("owner_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cities_owner_idx").on(t.ownerId)],
);

export const shareAccess = pgEnum("share_access", ["read", "write"]);

/** read = open and simulate; write = also edit, add and rename plans */
export const cityShares = pgTable(
  "city_shares",
  {
    cityId: uuid("city_id").notNull().references(() => cities.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references((): AnyPgColumn => users.id, { onDelete: "cascade" }),
    access: shareAccess("access").notNull().default("read"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.cityId, t.userId] }), index("city_shares_user_idx").on(t.userId)],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    cityId: uuid("city_id").notNull().references(() => cities.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    network: jsonb("network").$type<Network>().notNull(),
    settings: jsonb("settings").$type<PlanSettings>().notNull(),
    /** reference image placement; the image itself is in plan_images */
    underlay: jsonb("underlay").$type<Underlay>(),
    /** incremented on every save, used to detect concurrent edits */
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("plans_city_idx").on(t.cityId)],
);

/**
 * Saved states of a plan, for rolling back. Autosaves by the same person within a few minutes
 * update the newest row instead of adding one, so each row is a short editing session.
 */
export const planVersions = pgTable(
  "plan_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id").notNull().references(() => plans.id, { onDelete: "cascade" }),
    /** plans.revision this row holds */
    revision: integer("revision").notNull(),
    /** create | baseline (state before the first tracked save) | save | restore */
    kind: text("kind").notNull().default("save"),
    note: text("note").notNull().default(""),
    network: jsonb("network").$type<Network>().notNull(),
    settings: jsonb("settings").$type<PlanSettings>().notNull(),
    underlay: jsonb("underlay").$type<Underlay>(),
    userId: uuid("user_id").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("plan_versions_plan_idx").on(t.planId, t.createdAt)],
);

/** Reference image bytes, one per plan (kept apart so plan saves stay small). */
export const planImages = pgTable("plan_images", {
  planId: uuid("plan_id").primaryKey().references(() => plans.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  data: bytea("data").notNull(),
  bytes: integer("bytes").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRole = pgEnum("user_role", ["admin", "user"]);

/** People who can sign in. Admins also manage users and every map; users manage their own maps and those shared with them. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** stored lower-case */
    email: text("email").notNull(),
    name: text("name").notNull().default(""),
    role: userRole("role").notNull().default("user"),
    /** scrypt hash, see src/server/password.ts */
    passwordHash: text("password_hash").notNull(),
    /** set for default / reset passwords: the user must pick a new one after signing in */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/** Each user's own preferences, kept with their account (one row per user; missing = the defaults). */
export const userPrefs = pgTable("user_prefs", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  /** the keys that fly the helicopter (see src/lib/heli-keys.ts) */
  heliKeys: jsonb("heli_keys"),
  /** war mode turned on in the settings (the helicopter's gun and rockets) */
  warMode: boolean("war_mode").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Server-side sessions; the cookie holds a random token, the table holds its SHA-256. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export type City = typeof cities.$inferSelect;
export type PlanVersion = typeof planVersions.$inferSelect;
export type ShareAccess = (typeof shareAccess.enumValues)[number];
export type Plan = typeof plans.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = (typeof userRole.enumValues)[number];
