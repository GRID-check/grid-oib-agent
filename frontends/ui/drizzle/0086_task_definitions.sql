-- 0086: task_definitions + task_runs — the collapse of jobs, job_runs and tasks
-- into two tables (follow-up to PR #659).
--
-- ## Why
--
-- The trigger is a property of the work, not a different kind of work. One
-- entity holds the standing intent; another holds each attempt to carry it
-- out. A chat handover is the same entity with a degenerate trigger, which is
-- the whole reason chat cannot currently say „jeden Montag".
--
-- Two rows already described one execution: a scheduled fire wrote a
-- `job_runs` row AND a `tasks` row, both keyed on the same backend job id
-- (`jobs/service.ts`). The seam was historical, not modelled. Migration 0043
-- renamed `skill_schedules`/`skill_runs` for the same reason; this is the
-- second pass, with the task row as the second half.
--
-- ## The two tables
--
--   * `task_definitions` — kind, plan, requester, trigger (manual | once |
--     schedule), and the schedule/due columns that are live only for their
--     trigger's arm.
--   * `task_runs` — one attempt, INCLUDING the attempts that never reached the
--     agent: `skipped`/`error` are first-class statuses, which is how a failed
--     fire stops being invisible in Aufgaben. Runner fields come from
--     `job_runs`, lifecycle/filing/review from `tasks`. The run copies kind,
--     title, plan, requester and its skill snapshot at creation, so history
--     explains itself after a definition is deleted.
--
-- ## Backfill
--
-- Four row shapes, all in this migration:
--
--   1. `jobs` -> definitions (schedule when a cron exists, else manual).
--   2. `job_runs` -> runs, merged with the task that points at them.
--   3. delegated tasks (`job_id IS NULL`) -> a once definition + one run.
--   4. tasks that never got a `job_run_id` -> a run (legacy/pre-0075 rows).
--
-- Ids are deliberately REUSED: a job's definition id is the job's id, and a
-- job-spawned run keeps the `job_runs` id. Conversations, filed documents and
-- inbox anchors keep pointing at the same uuids.
--
-- ## The conversations.job_id FK
--
-- Repointed to `task_definitions` in the same migration, because definition ids
-- for jobs are the job ids the column already holds. During the rollout window
-- an old BFF pod still writing `jobs` cannot break a create: the only path that
-- inserts a conversation with a job id is `createRunConversation`, which
-- records and swallows a failure rather than failing the run. Migration 0087
-- (separate release) drops the old tables; until then nothing reads them but
-- the old release's own code.
--
-- ## RLS
--
-- Both tables are tenant data, secured the way `jobs`/`tasks` were: the
-- organization AND the project's organization. Listed in
-- `rls-coverage.spec.ts` BOUNDARY_MIGRATIONS.

-- ---------------------------------------------------------------------------
-- 1. task_definitions — the standing intent
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "task_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "plan" jsonb NOT NULL,
  "requester_user_id" text NOT NULL,
  "requester_email" text,
  "trigger" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "schedule_cron" text,
  "schedule_timezone" text DEFAULT 'UTC' NOT NULL,
  "next_run_at" timestamp with time zone,
  "due_at" timestamp with time zone,
  "budget_usd" numeric(12, 4),
  "last_run_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- Redundant on its own — `id` is the primary key — and required all the
  -- same: `task_runs`' composite FK references exactly this column set, and a
  -- composite foreign key can only reference a uniquely-constrained one.
  -- Mirrors `conversations_id_organization_id_key` from 0032.
  CONSTRAINT task_definitions_id_organization_id_project_id_key
    UNIQUE ("id", "organization_id", "project_id"),
  -- The trigger vocabulary, and the two columns that are live per arm. A cron
  -- on a manual/once row or a due date on a schedule would each be a fact no
  -- code path reads; the CHECKs keep the two axes from disagreeing.
  CONSTRAINT task_definitions_trigger_known
    CHECK ("trigger" IN ('manual', 'once', 'schedule')),
  CONSTRAINT task_definitions_cron_only_when_scheduled
    CHECK (("trigger" = 'schedule') = ("schedule_cron" IS NOT NULL)),
  CONSTRAINT task_definitions_due_only_when_once
    CHECK ("due_at" IS NULL OR "trigger" = 'once')
  -- No kind CHECK, deliberately, exactly as 0075 left `tasks.kind`: the
  -- vocabulary lives in ONE place (`lib/tasks/task-vocabulary.ts`) rather than
  -- in a column and a tuple that can disagree.
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_definitions_project_created"
  ON "task_definitions" ("project_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_definitions_organization_id"
  ON "task_definitions" ("organization_id");
--> statement-breakpoint
-- The scheduler's due-row claim: partial, so the index holds one entry per
-- every schedule and none for the manual/once rows. The claim's WHERE clause
-- must keep matching this predicate for the scan to stay an index scan.
CREATE INDEX IF NOT EXISTS "idx_task_definitions_due"
  ON "task_definitions" ("next_run_at")
  WHERE "trigger" = 'schedule' AND "enabled";
--> statement-breakpoint
SELECT grid_secure_table('task_definitions',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');

-- ---------------------------------------------------------------------------
-- 2. task_runs — one attempt, including the ones that never reached the agent
-- ---------------------------------------------------------------------------

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "definition_id" uuid,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "plan" jsonb NOT NULL,
  "requester_user_id" text NOT NULL,
  "requester_email" text,
  "trigger" text NOT NULL,
  "triggered_by" text,
  "status" text NOT NULL,
  "error" text,
  "skill_snapshot" jsonb NOT NULL,
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
  -- The merged lifecycle. `skipped` and `error` are attempts that never
  -- reached the agent; they are visible rows in Aufgaben, not hidden
  -- `job_runs` lines.
  CONSTRAINT task_runs_status_known
    CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'skipped', 'error')),
  CONSTRAINT task_runs_trigger_known
    CHECK ("trigger" IN ('manual', 'schedule', 'delegated')),
  CONSTRAINT task_runs_review_known
    CHECK ("review" IS NULL OR "review" IN ('accepted', 'rejected')),
  CONSTRAINT task_runs_filing_status_known
    CHECK ("filing_status" IS NULL OR "filing_status" IN ('filed', 'refused', 'failed')),
  CONSTRAINT task_runs_review_complete
    CHECK (("review" IS NULL) = ("reviewed_by" IS NULL) AND ("review" IS NULL) = ("reviewed_at" IS NULL))
);
--> statement-breakpoint
-- The composite FK (`job_runs`/`tasks` shape, migration 0032): a run cannot
-- name another tenant's conversation even if `conversation_id` is set by a bug.
ALTER TABLE "task_runs"
  ADD CONSTRAINT "task_runs_conversation_id_organization_id_fkey"
  FOREIGN KEY ("conversation_id", "organization_id")
  REFERENCES "conversations" ("id", "organization_id")
  ON DELETE SET NULL ("conversation_id");
--> statement-breakpoint
-- The same shape for the definition link: a run cannot name another tenant's
-- OR another project's definition, and its denormalised tenant/project columns
-- cannot disagree with the definition they point at. SET NULL is scoped to
-- `definition_id` alone (Postgres 15+ syntax); an unscoped SET NULL would try
-- to null the NOT NULL tenant columns and fail.
ALTER TABLE "task_runs"
  ADD CONSTRAINT "task_runs_definition_id_organization_id_project_id_fkey"
  FOREIGN KEY ("definition_id", "organization_id", "project_id")
  REFERENCES "task_definitions" ("id", "organization_id", "project_id")
  ON DELETE SET NULL ("definition_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_runs_definition_created"
  ON "task_runs" ("definition_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_runs_project_created"
  ON "task_runs" ("project_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_runs_organization_id"
  ON "task_runs" ("organization_id");
--> statement-breakpoint
-- The worker reports by backend job id; one run per backend job. Partial:
-- a skipped/error fire never got one.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_task_runs_backend_job_id"
  ON "task_runs" ("backend_job_id") WHERE "backend_job_id" IS NOT NULL;
--> statement-breakpoint
SELECT grid_secure_table('task_runs',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');

-- ---------------------------------------------------------------------------
-- 3. Backfill definitions from jobs
-- ---------------------------------------------------------------------------

--> statement-breakpoint
INSERT INTO "task_definitions" (
  "id", "organization_id", "project_id", "kind", "title", "plan",
  "requester_user_id", "requester_email", "trigger", "enabled",
  "schedule_cron", "schedule_timezone", "next_run_at", "due_at",
  "budget_usd", "last_run_at", "created_at", "updated_at"
)
SELECT
  j."id",
  j."organization_id",
  j."project_id",
  j."output",
  j."name",
  jsonb_build_object(
    'prompt', j."prompt",
    -- `{}` for a skill-less job, the same value job_runs recorded.
    'skill', COALESCE(j."skill_snapshot", '{}'::jsonb),
    'dataSources', j."data_sources"
  ),
  j."created_by",
  j."created_by_email",
  CASE WHEN j."schedule_cron" IS NULL THEN 'manual' ELSE 'schedule' END,
  j."enabled",
  j."schedule_cron",
  j."schedule_timezone",
  j."next_run_at",
  NULL,
  NULL,
  j."last_run_at",
  j."created_at",
  j."updated_at"
FROM "jobs" j
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. Backfill definitions from delegated tasks (the once arm)
-- ---------------------------------------------------------------------------

--> statement-breakpoint
INSERT INTO "task_definitions" (
  "id", "organization_id", "project_id", "kind", "title", "plan",
  "requester_user_id", "requester_email", "trigger", "enabled",
  "schedule_cron", "schedule_timezone", "next_run_at", "due_at",
  "budget_usd", "last_run_at", "created_at", "updated_at"
)
SELECT
  t."id",
  t."organization_id",
  t."project_id",
  t."kind",
  t."title",
  t."plan",
  t."requester_user_id",
  t."requester_email",
  'once',
  true,
  NULL,
  'UTC',
  NULL,
  t."deadline_at",
  t."budget_usd",
  COALESCE(t."started_at", t."created_at"),
  t."created_at",
  t."updated_at"
FROM "tasks" t
WHERE t."job_id" IS NULL
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Repoint conversations.job_id -> task_definitions
-- ---------------------------------------------------------------------------
-- After the two definition inserts, so every id an existing conversation could
-- name already exists. The index `conversations_job_id_idx` is kept: it backs
-- the FK, exactly as 0044 wrote it.

--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_job_id_fkey";
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "task_definitions" ("id") ON DELETE SET NULL;
--> statement-breakpoint
COMMENT ON COLUMN "conversations"."job_id" IS
  'The task DEFINITION that produced this conversation (output=chat), or NULL when a person started it. created_by is still the definition''s requester, a real user id. Was a jobs.id before migration 0086 repointed it; definition ids for job-backed rows are the same uuids.';

-- ---------------------------------------------------------------------------
-- 6. Backfill runs from job_runs, merged with the task that links to each
-- ---------------------------------------------------------------------------
-- Where a task exists, the task's lifecycle wins (it is the later record);
-- where it does not, the submission status maps across: submitted -> running
-- (the worker may still report), skipped -> skipped, error -> error.

--> statement-breakpoint
INSERT INTO "task_runs" (
  "id", "organization_id", "project_id", "definition_id", "kind", "title", "plan",
  "requester_user_id", "requester_email", "trigger", "triggered_by", "status",
  "error", "skill_snapshot", "backend_job_id", "conversation_id",
  "filed_document_id", "filing_status", "filing_detail",
  "review", "review_reason", "reviewed_by", "reviewed_at",
  "created_at", "started_at", "finished_at", "updated_at"
)
SELECT
  jr."id",
  jr."organization_id",
  jr."project_id",
  jr."schedule_id",
  COALESCE(t."kind", j."output"),
  COALESCE(t."title", j."name"),
  COALESCE(
    t."plan",
    jsonb_build_object(
      'prompt', j."prompt",
      'skill', COALESCE(j."skill_snapshot", '{}'::jsonb),
      'dataSources', j."data_sources"
    )
  ),
  COALESCE(t."requester_user_id", j."created_by"),
  COALESCE(t."requester_email", j."created_by_email"),
  jr."trigger",
  jr."triggered_by",
  COALESCE(
    t."status",
    CASE jr."status"
      WHEN 'submitted' THEN 'running'
      WHEN 'skipped' THEN 'skipped'
      ELSE 'error'
    END
  ),
  -- A skipped/error fire wrote no task; the job_runs detail IS the reason a
  -- person now sees on the row.
  COALESCE(t."error", jr."detail"),
  jr."skill_snapshot",
  jr."job_id",
  -- The new composite FK is STRICTER than the old `tasks` table, which had no
  -- conversation constraint at all: a task can point at a thread that was
  -- deleted (or whose row never reached this tenant). Carrying that value in
  -- would abort the whole migration, so provenance the FK cannot validate is
  -- dropped here — the conversation link is lost, the run is not.
  CASE
    WHEN COALESCE(t."conversation_id", jr."conversation_id") IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM "conversations" c
      WHERE c."id" = COALESCE(t."conversation_id", jr."conversation_id")
        AND c."organization_id" = jr."organization_id"
    ) THEN COALESCE(t."conversation_id", jr."conversation_id")
    ELSE NULL
  END,
  t."filed_document_id",
  t."filing_status",
  t."filing_detail",
  t."review",
  t."review_reason",
  t."reviewed_by",
  t."reviewed_at",
  jr."created_at",
  t."started_at",
  t."finished_at",
  COALESCE(t."updated_at", jr."created_at")
FROM "job_runs" jr
JOIN "jobs" j ON j."id" = jr."schedule_id"
LEFT JOIN "tasks" t ON t."job_run_id" = jr."id"
ON CONFLICT ("id") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 7. Backfill runs from tasks that never got a job_run link
-- ---------------------------------------------------------------------------
-- The delegated tasks (job_id IS NULL; definition id is the task's own id and
-- was just inserted), plus the job-spawned tasks from before `job_run_id`
-- existed. The linked run, when one can be found by backend id, supplies the
-- trigger it actually fired under.

--> statement-breakpoint
INSERT INTO "task_runs" (
  "id", "organization_id", "project_id", "definition_id", "kind", "title", "plan",
  "requester_user_id", "requester_email", "trigger", "triggered_by", "status",
  "error", "skill_snapshot", "backend_job_id", "conversation_id",
  "filed_document_id", "filing_status", "filing_detail",
  "review", "review_reason", "reviewed_by", "reviewed_at",
  "created_at", "started_at", "finished_at", "updated_at"
)
SELECT
  t."id",
  t."organization_id",
  t."project_id",
  COALESCE(t."job_id", t."id"),
  t."kind",
  t."title",
  t."plan",
  t."requester_user_id",
  t."requester_email",
  CASE WHEN t."job_id" IS NULL THEN 'delegated' ELSE COALESCE(lr."trigger", 'manual') END,
  COALESCE(lr."triggered_by", t."requester_user_id"),
  t."status",
  t."error",
  COALESCE(t."plan" -> 'skill', '{}'::jsonb),
  t."backend_job_id",
  -- Same guard as step 6: `tasks.conversation_id` was unconstrained until now.
  CASE
    WHEN t."conversation_id" IS NULL THEN NULL
    WHEN EXISTS (
      SELECT 1 FROM "conversations" c
      WHERE c."id" = t."conversation_id"
        AND c."organization_id" = t."organization_id"
    ) THEN t."conversation_id"
    ELSE NULL
  END,
  t."filed_document_id",
  t."filing_status",
  t."filing_detail",
  t."review",
  t."review_reason",
  t."reviewed_by",
  t."reviewed_at",
  t."created_at",
  t."started_at",
  t."finished_at",
  t."updated_at"
FROM "tasks" t
LEFT JOIN "job_runs" lr ON lr."job_id" = t."backend_job_id"
WHERE t."job_run_id" IS NULL
ON CONFLICT ("id") DO NOTHING;
