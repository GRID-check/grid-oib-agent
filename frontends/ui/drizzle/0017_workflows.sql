-- Workflows — saved research briefs per project, run manually or on a cron
-- schedule through the existing async deep-research pipeline (ADR-0023,
-- docs/architecture/workflows.md). Mirrors the project_memory shape:
-- denormalized organization_id beside a cascading project_id FK.
CREATE TABLE IF NOT EXISTS "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "definition" jsonb NOT NULL,
  "compiled_prompt" text NOT NULL,
  "agent_type" text DEFAULT 'deep_researcher' NOT NULL,
  "data_sources" jsonb,
  "enabled" boolean DEFAULT true NOT NULL,
  "schedule_cron" text,
  "schedule_timezone" text DEFAULT 'UTC' NOT NULL,
  "next_run_at" timestamp with time zone,
  "last_run_at" timestamp with time zone,
  "created_by" text NOT NULL,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL,
  "organization_id" text NOT NULL,
  "job_id" text,
  "trigger" text NOT NULL,
  "status" text NOT NULL,
  "detail" text,
  "prompt_snapshot" text NOT NULL,
  "triggered_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_project_id" ON "workflows"("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflows_organization_id" ON "workflows"("organization_id");
--> statement-breakpoint
-- Partial due-scan index backing the scheduler's FOR UPDATE SKIP LOCKED claim:
-- only rows that can ever fire (a cron set AND enabled) are indexed, so the
-- per-tick "next_run_at <= now()" probe stays a tiny, cheap scan. PARTIAL, so
-- the drizzle builder can't express it — see schema/workflows.ts NOTE.
CREATE INDEX IF NOT EXISTS "idx_workflows_due" ON "workflows"("next_run_at")
  WHERE "schedule_cron" IS NOT NULL AND "enabled";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_workflow_created" ON "workflow_runs"("workflow_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_project_id" ON "workflow_runs"("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_organization_id" ON "workflow_runs"("organization_id");
--> statement-breakpoint
-- Standalone created_at index: the scheduler's retention prune filters/orders
-- by created_at alone, which the composite (workflow_id, created_at) index
-- cannot serve without a workflow_id predicate.
CREATE INDEX IF NOT EXISTS "idx_workflow_runs_created_at" ON "workflow_runs"("created_at");
