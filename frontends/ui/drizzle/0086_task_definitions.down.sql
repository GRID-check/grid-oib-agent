-- Reverse 0086: drop the collapsed tables and point conversations.job_id back
-- at jobs.
--
-- Data loss is the point: every attempt recorded only in task_runs disappears
-- with the table, exactly as reversing 0075 dropped every task. The old
-- jobs/job_runs/tasks tables are untouched by 0086, so the pre-0086 record is
-- still there for every row that existed before it ran.
--
-- The one thing with no old-model counterpart is a conversation whose
-- definition was created AFTER the cutover: it names a `task_definitions` row
-- that has no `jobs` row, so re-adding the old FK would fail. Its provenance is
-- nulled and the conversation survives as an ordinary thread, which is the
-- documented `ON DELETE SET NULL` fallback.

ALTER TABLE "conversations" DROP CONSTRAINT IF EXISTS "conversations_job_id_fkey";
--> statement-breakpoint
DROP TABLE IF EXISTS "task_runs";
--> statement-breakpoint
DROP TABLE IF EXISTS "task_definitions";
--> statement-breakpoint
UPDATE "conversations"
  SET "job_id" = NULL
  WHERE "job_id" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "jobs" j WHERE j."id" = "conversations"."job_id");
--> statement-breakpoint
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_job_id_fkey"
  FOREIGN KEY ("job_id") REFERENCES "jobs" ("id") ON DELETE SET NULL;
--> statement-breakpoint
COMMENT ON COLUMN "conversations"."job_id" IS
  'The job that produced this conversation (output=chat), or NULL when a person started it. created_by is still the job OWNER, a real user id - the roster, the last-owner invariant and audit all read it as a person. Job conversations are created visibility=project and are kept out of the personal sessions list by this column.';
