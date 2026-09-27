import { boolean, customType, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { Network, PlanSettings } from "@/engine/types";
import type { Underlay } from "@/lib/underlay";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const cities = pgTable("cities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

/** Reference image bytes, one per plan (kept apart so plan saves stay small). */
export const planImages = pgTable("plan_images", {
  planId: uuid("plan_id").primaryKey().references(() => plans.id, { onDelete: "cascade" }),
  mime: text("mime").notNull(),
  data: bytea("data").notNull(),
  bytes: integer("bytes").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userRole = pgEnum("user_role", ["admin", "user"]);

/** People who can sign in. Admins also manage users; both roles can edit cities and plans. */
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
export type Plan = typeof plans.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = (typeof userRole.enumValues)[number];
