CREATE TABLE "traffic_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"revision" integer NOT NULL,
	"area" jsonb NOT NULL,
	"tiles" integer DEFAULT 0 NOT NULL,
	"lanes" jsonb NOT NULL,
	"incidents" jsonb NOT NULL,
	"data" "bytea",
	"bytes" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "traffic_samples" ADD CONSTRAINT "traffic_samples_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "traffic_samples_plan_idx" ON "traffic_samples" USING btree ("plan_id","at");