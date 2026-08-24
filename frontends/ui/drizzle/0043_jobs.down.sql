-- Reverse 0043: jobs / job_runs go back to being skill_schedules / skill_runs.
--
-- A real inverse, unlike 0042's deliberately empty one: 0043 renamed and
-- widened existing tables rather than removing a feature, so every step of it
-- has an opposite that leaves the database exactly as 0041 and 0042 left it.
--
-- ## What is lost, and why that is unavoidable
--
-- `jobs.prompt` and `job_runs.conversation_id` are dropped. Both are columns
-- 0041's shape has nowhere to put: a prompt was derived from the skill, and a
-- run had no conversation. Rolling back means going back to a world where a job
-- IS its skill, so a prompt that no longer matches the pinned snapshot cannot
-- be preserved.
--
-- ## What this rollback REFUSES to guess
--
-- Restoring NOT NULL on `skill_name`/`skill_snapshot` fails if any skill-less
-- job exists — a job that is only a prompt is precisely what 0041's schema
-- cannot represent, and there is no correct skill to invent for it. The failure
-- is the point: the transaction aborts, nothing is half-rolled-back, and the
-- operator decides whether those jobs are deleted or the rollback is abandoned.
-- Silently deleting a user's scheduled work to make a DDL statement succeed
-- would be the worse outcome by far.
--
--   SELECT id, name FROM jobs WHERE skill_name IS NULL;   -- the blocking rows

-- ---------------------------------------------------------------------------
-- Undo 7/6/4: the columns and the constraint 0041 knew nothing about
-- ---------------------------------------------------------------------------
-- The FK goes with the column it is on; naming it explicitly first keeps the
-- drop honest about what it removes.
ALTER TABLE "job_runs" DROP CONSTRAINT IF EXISTS "job_runs_conversation_id_organization_id_fkey";
--> statement-breakpoint
ALTER TABLE "job_runs" DROP COLUMN IF EXISTS "conversation_id";
--> statement-breakpoint
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_skill_pair_check";
--> statement-breakpoint
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "prompt";

-- ---------------------------------------------------------------------------
-- Undo 5: the skill becomes mandatory again (see the refusal note above)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "skill_name" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "skill_snapshot" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- Undo 3: output -> execution
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "jobs" RENAME COLUMN "output" TO "execution";

-- ---------------------------------------------------------------------------
-- Undo 8: the catalog comments 0043 added
-- ---------------------------------------------------------------------------
-- They describe the jobs-era naming collision, which stops being a thing that
-- needs explaining the moment the tables are called schedules again.
--> statement-breakpoint
COMMENT ON COLUMN "job_runs"."schedule_id" IS NULL;
--> statement-breakpoint
COMMENT ON COLUMN "job_runs"."job_id" IS NULL;

-- ---------------------------------------------------------------------------
-- Undo 2 + 1: the dependent objects, then the tables
-- ---------------------------------------------------------------------------
-- Constraints and indexes are renamed BEFORE the tables, so every statement
-- below reads in the names the database currently has rather than in a mix of
-- old and new.
--> statement-breakpoint
ALTER TABLE "job_runs" RENAME CONSTRAINT "job_runs_schedule_id_fkey" TO "skill_runs_schedule_id_fkey";
--> statement-breakpoint
ALTER TABLE "job_runs" RENAME CONSTRAINT "job_runs_pkey" TO "skill_runs_pkey";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_project_id_fkey" TO "skill_schedules_project_id_fkey";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME CONSTRAINT "jobs_pkey" TO "skill_schedules_pkey";
--> statement-breakpoint
ALTER INDEX "idx_job_runs_created_at" RENAME TO "idx_skill_runs_created_at";
--> statement-breakpoint
ALTER INDEX "idx_job_runs_organization_id" RENAME TO "idx_skill_runs_organization_id";
--> statement-breakpoint
ALTER INDEX "idx_job_runs_project_id" RENAME TO "idx_skill_runs_project_id";
--> statement-breakpoint
ALTER INDEX "idx_job_runs_job_created" RENAME TO "idx_skill_runs_schedule_created";
--> statement-breakpoint
ALTER INDEX "idx_jobs_due" RENAME TO "idx_skill_schedules_due";
--> statement-breakpoint
ALTER INDEX "idx_jobs_organization_id" RENAME TO "idx_skill_schedules_organization_id";
--> statement-breakpoint
ALTER INDEX "idx_jobs_project_id" RENAME TO "idx_skill_schedules_project_id";
--> statement-breakpoint
ALTER TABLE "job_runs" RENAME TO "skill_runs";
--> statement-breakpoint
ALTER TABLE "jobs" RENAME TO "skill_schedules";

-- ---------------------------------------------------------------------------
-- Undo 9: the tenant boundary, restated under the 0041 names
-- ---------------------------------------------------------------------------
-- Same reasoning as the forward migration in reverse: the policies survive the
-- rename, but the boundary must be declared in the names the database now uses,
-- so a reader of migration history and `pg_policies` see the same rule. These
-- are byte-for-byte 0041's predicates.
--> statement-breakpoint
SELECT grid_secure_table('skill_schedules',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');
--> statement-breakpoint
SELECT grid_secure_table('skill_runs',
  'organization_id = grid_current_org() AND EXISTS (SELECT 1 FROM skill_schedules s WHERE s.id = schedule_id AND s.organization_id = grid_current_org())');
