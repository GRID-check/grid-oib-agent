CREATE TABLE IF NOT EXISTS "llm_usage_rollups" (
	"organization_id" text NOT NULL,
	"day" date NOT NULL,
	"user_id" text DEFAULT '' NOT NULL,
	"project_id" text DEFAULT '' NOT NULL,
	"cost_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"events" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_usage_rollups_pk" PRIMARY KEY("organization_id","day","user_id","project_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_rollups_org_user_day" ON "llm_usage_rollups" ("organization_id","user_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_rollups_org_project_day" ON "llm_usage_rollups" ("organization_id","project_id","day");--> statement-breakpoint
INSERT INTO "llm_usage_rollups" ("organization_id","day","user_id","project_id","cost_usd","events")
SELECT
	organization_id,
	(created_at AT TIME ZONE 'UTC')::date AS day,
	coalesce(user_id, '') AS user_id,
	coalesce(project_id, '') AS project_id,
	coalesce(sum(cost_usd), 0) AS cost_usd,
	count(*) AS events
FROM "llm_usage_events"
GROUP BY 1, 2, 3, 4
ON CONFLICT ("organization_id","day","user_id","project_id") DO NOTHING;
