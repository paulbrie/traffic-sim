CREATE TABLE "agent_patches" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" uuid NOT NULL,
	"author" text NOT NULL,
	"task" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"patch" jsonb NOT NULL,
	"base_revision" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"applied_revision" integer,
	"reject_note" text
);
--> statement-breakpoint
ALTER TABLE "agent_patches" ADD CONSTRAINT "agent_patches_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_patches" ADD CONSTRAINT "agent_patches_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_patches_plan_idx" ON "agent_patches" USING btree ("plan_id","status");