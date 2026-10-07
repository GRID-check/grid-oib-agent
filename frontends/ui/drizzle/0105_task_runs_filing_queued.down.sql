-- Reverse 0105: task_runs.filing_status loses 'queued'.
--
-- ORDER: roll the frontend back first; the newer build writes the value.
-- Lossy only in detail: a run whose report was still queued when this runs is
-- recorded as failed, with the reason, so nobody reads a filing that will never
-- happen as pending. The report itself is in the run's message, and the job (if
-- any) is in `bff_job_queue`.
DROP INDEX IF EXISTS "ix_task_runs_filing_queued";
--> statement-breakpoint
UPDATE "task_runs"
   SET "filing_status" = 'failed',
       "filing_detail" = 'filing was queued when the filing queue was rolled back'
 WHERE "filing_status" = 'queued';
--> statement-breakpoint
ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS "task_runs_filing_status_known";
--> statement-breakpoint
ALTER TABLE "task_runs"
  ADD CONSTRAINT "task_runs_filing_status_known"
  CHECK ("filing_status" IS NULL OR "filing_status" IN ('filed', 'refused', 'failed'));
