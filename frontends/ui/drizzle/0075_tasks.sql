-- 0075: tasks — the durable unit of delegated work (ADR-0051).
--
-- ## What was missing
--
-- A job says WHEN Piloti should work (`jobs`); a run says THAT it was submitted
-- (`job_runs`, whose status vocabulary ends at `submitted`); the backend job
-- store says HOW it went and expires the record 24 hours later. Nothing was the
-- thing a person delegated: a row with a requester whose permission it acts
-- under, a lifecycle from queued to reviewed, a result that lands somewhere
-- durable, and a decision that reaches the next attempt. A scheduled run's
-- report was filed by nobody — the interactive report GET is the only filing
-- path, and no one opens a 03:00 run's report from the history — and a
-- reviewer's "no, the atrium is OIB 2.3" went nowhere.
--
-- ## The row
--
-- One task per attempt: `fireJob` inserts it beside the `job_runs` row, the
-- worker's outcome callback closes it and files the report AS THE REQUESTER.
-- `requester_user_id` is the job's creator, pinned at creation — never
-- `'scheduler'`, never a service token (agent-authored-documents design,
-- decision 10). Review is an independent axis on the same row, the
-- `mention_requests` shape: lifecycle `status`, and separately how a person
-- judged it (`review`, with `review_reason`). A rejection's reason is read by
-- the next run of the same job.
--
-- `kind`, `status`, `review` and `filing_status` are plain text with CHECKs
-- naming today's members, so the next kind is a TypeScript change plus one
-- CHECK edit rather than an enum migration.
--
-- ## RLS
--
-- Tenant table, secured the way `jobs` is: the organization AND the project's
-- organization, so a row cannot be planted under another tenant's project.
-- Listed in `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "plan" jsonb NOT NULL,
  "requester_user_id" text NOT NULL,
  "requester_email" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "error" text,
  "budget_usd" numeric(12, 4),
  "deadline_at" timestamp with time zone,
  "job_id" uuid REFERENCES "jobs"("id") ON DELETE SET NULL,
  "job_run_id" uuid REFERENCES "job_runs"("id") ON DELETE SET NULL,
  "backend_job_id" text,
  "conversation_id" text,
  "filed_document_id" uuid,
  "filing_status" text,
  "filing_detail" text,
  "review" text,
  "review_reason" text,
  "reviewed_by" text,
  "reviewed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "started_at" timestamp with time zone,
  "finished_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT tasks_status_known
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
  CONSTRAINT tasks_review_known
    CHECK ("review" IS NULL OR "review" IN ('accepted', 'rejected')),
  CONSTRAINT tasks_filing_status_known
    CHECK ("filing_status" IS NULL OR "filing_status" IN ('filed', 'refused', 'failed')),
  CONSTRAINT tasks_review_complete
    CHECK (("review" IS NULL) = ("reviewed_by" IS NULL) AND ("review" IS NULL) = ("reviewed_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_project_created" ON "tasks" ("project_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_organization_id" ON "tasks" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_tasks_job_id" ON "tasks" ("job_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_tasks_backend_job_id" ON "tasks" ("backend_job_id") WHERE "backend_job_id" IS NOT NULL;
--> statement-breakpoint
SELECT grid_secure_table('tasks',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
