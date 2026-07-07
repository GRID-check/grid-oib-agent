CREATE TABLE IF NOT EXISTS "budget_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"scope" text NOT NULL,
	"subject_id" text,
	"daily_limit" numeric(12, 4),
	"monthly_limit" numeric(12, 4),
	"currency" text DEFAULT 'EUR' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"supersedes_id" uuid,
	"created_by" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text,
	"project_id" text,
	"conversation_id" text,
	"job_id" text,
	"agent_group" text,
	"requested_model" text,
	"model" text,
	"generation_id" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"cost_source" text DEFAULT 'missing' NOT NULL,
	"is_byok" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_budget_policies_org_scope" ON "budget_policies" USING btree ("organization_id","scope","subject_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_events_org_time" ON "llm_usage_events" USING btree ("organization_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_events_org_user_time" ON "llm_usage_events" USING btree ("organization_id","user_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_events_org_project_time" ON "llm_usage_events" USING btree ("organization_id","project_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_events_org_model_time" ON "llm_usage_events" USING btree ("organization_id","model","created_at");
--> statement-breakpoint
-- Hand-written (drizzle builder can't express COALESCE partial-unique
-- indexes, same pattern as 0010): at most ONE active policy per
-- (organization, scope, subject). Subject NULL (org scope) participates via
-- COALESCE so the constraint also holds for the org-wide row.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_budget_policies_active" ON "budget_policies" ("organization_id","scope",COALESCE("subject_id", '')) WHERE "status" = 'active';
