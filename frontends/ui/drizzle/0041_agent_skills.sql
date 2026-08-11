-- Agent Skills — org-authored and org-cloned skills plus their schedules and
-- run history (Phase A of the Agent Skills feature replacing Workflows; skills
-- follow the agentskills.io format, see docs/architecture/agent-skills.md).
--
-- Three tables:
--
--   skills            The org toolbox: skills authored in the organization
--                     (origin 'org') or cloned from a platform skill
--                     (origin 'platform-clone', cloned_from = platform name).
--                     Platform-authored skills are NOT rows — they ship as
--                     files under src/aiq_agent/skills/builtin/<collection>/.
--
--   skill_schedules   A project-scoped schedule that fires one named skill,
--                     manually or on a 5-field cron. The skill is snapshotted
--                     (name/description/body/metadata/origin) at save time so a
--                     run is a deterministic WYSIWYG copy that cannot drift
--                     when the skill is later edited (the workflow compiled
--                     prompt contract, mirrored here as JSONB).
--
--   skill_runs        Submission history per schedule. job_id is the backend
--                     async-job id; status submitted|skipped|error; the run
--                     carries its own skill_snapshot copy (the schedule ETL
--                     contract: runs stay self-describing even after a
--                     schedule row is edited or purged).
--
-- The tenant boundary joins in the SAME migration (ADR-0041): each table is
-- secured by grid_secure_table() exactly once.

-- ---------------------------------------------------------------------------
-- skills
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "metadata" jsonb DEFAULT '{}' NOT NULL,
  "origin" text DEFAULT 'org' NOT NULL,
  "cloned_from" text,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_by" text NOT NULL,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- One skill per name per organization; a name lookup for the fire/resolve
-- paths is the point query this serves.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_skills_org_name" ON "skills"("organization_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skills_organization_id" ON "skills"("organization_id");

-- ---------------------------------------------------------------------------
-- skill_schedules
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "skill_name" text NOT NULL,
  "skill_snapshot" jsonb NOT NULL,
  "execution" text NOT NULL,
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
CREATE INDEX IF NOT EXISTS "idx_skill_schedules_project_id" ON "skill_schedules"("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_schedules_organization_id" ON "skill_schedules"("organization_id");
--> statement-breakpoint
-- Partial due-scan index backing the scheduler's claim: only rows that can
-- ever fire (a cron set AND enabled) are indexed, so the per-tick
-- "next_run_at <= now()" probe stays a tiny, cheap scan. PARTIAL, so the
-- drizzle builder can't express it — see schema/skills.ts NOTE.
CREATE INDEX IF NOT EXISTS "idx_skill_schedules_due" ON "skill_schedules"("next_run_at")
  WHERE "schedule_cron" IS NOT NULL AND "enabled";

-- ---------------------------------------------------------------------------
-- skill_runs
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "schedule_id" uuid NOT NULL REFERENCES "skill_schedules"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL,
  "organization_id" text NOT NULL,
  "job_id" text,
  "trigger" text NOT NULL,
  "status" text NOT NULL,
  "detail" text,
  "skill_snapshot" jsonb NOT NULL,
  "triggered_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_runs_schedule_created" ON "skill_runs"("schedule_id","created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_runs_project_id" ON "skill_runs"("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_runs_organization_id" ON "skill_runs"("organization_id");
--> statement-breakpoint
-- Standalone created_at index: the scheduler's retention prune filters and
-- orders by created_at alone, which the composite (schedule_id, created_at)
-- index cannot serve without a schedule_id predicate.
CREATE INDEX IF NOT EXISTS "idx_skill_runs_created_at" ON "skill_runs"("created_at");

-- ---------------------------------------------------------------------------
-- The tenant boundary (ADR-0041) — grid_secure_table() was defined by 0031
-- and stays installed; each new table joins the boundary in the migration
-- that creates it, or it is unreadable for the runtime role.
-- ---------------------------------------------------------------------------
--> statement-breakpoint
SELECT grid_secure_table('skills', 'organization_id = grid_current_org()');
--> statement-breakpoint
SELECT grid_secure_table('skill_schedules',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
--> statement-breakpoint
SELECT grid_secure_table('skill_runs',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM skill_schedules s WHERE s.id = schedule_id AND s.organization_id = grid_current_org())');
