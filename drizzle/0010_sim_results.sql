CREATE TABLE "sim_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"sketch_id" text DEFAULT '' NOT NULL,
	"sketch_name" text DEFAULT '' NOT NULL,
	"seconds" integer NOT NULL,
	"series" boolean DEFAULT false NOT NULL,
	"bytes" integer NOT NULL,
	"meta" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sim_results" ADD CONSTRAINT "sim_results_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sim_results" ADD CONSTRAINT "sim_results_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sim_results_plan_idx" ON "sim_results" USING btree ("plan_id","created_at");