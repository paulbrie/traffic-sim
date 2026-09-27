CREATE TYPE "public"."share_access" AS ENUM('read', 'write');--> statement-breakpoint
CREATE TABLE "city_shares" (
	"city_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"access" "share_access" DEFAULT 'read' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "city_shares_city_id_user_id_pk" PRIMARY KEY("city_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"kind" text DEFAULT 'save' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"network" jsonb NOT NULL,
	"settings" jsonb NOT NULL,
	"underlay" jsonb,
	"user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cities" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "city_shares" ADD CONSTRAINT "city_shares_city_id_cities_id_fk" FOREIGN KEY ("city_id") REFERENCES "public"."cities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "city_shares" ADD CONSTRAINT "city_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "city_shares_user_idx" ON "city_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "plan_versions_plan_idx" ON "plan_versions" USING btree ("plan_id","created_at");--> statement-breakpoint
ALTER TABLE "cities" ADD CONSTRAINT "cities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cities_owner_idx" ON "cities" USING btree ("owner_id");--> statement-breakpoint
-- existing maps belong to the first admin (maps created before accounts existed)
UPDATE "cities" SET "owner_id" = (SELECT "id" FROM "users" WHERE "role" = 'admin' ORDER BY "created_at" LIMIT 1) WHERE "owner_id" IS NULL;--> statement-breakpoint
-- every existing plan starts its history with its current state
INSERT INTO "plan_versions" ("plan_id", "revision", "kind", "note", "network", "settings", "underlay", "created_at", "updated_at")
SELECT "id", "revision", 'baseline', 'State when history tracking started', "network", "settings", "underlay", "updated_at", "updated_at" FROM "plans";
