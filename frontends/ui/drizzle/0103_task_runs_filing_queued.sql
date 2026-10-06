-- 0103: task_runs.filing_status may be 'queued' (ADR-0078).
--
-- ## Why
--
-- A finished deep-research run's report was rendered to a PDF and filed inside
-- the worker's outcome callback: on the pod that proxies chat, with no retry
-- once it failed. It is now a `file_research_report` job on the `bff-jobs`
-- pool, retried there. Between the run ending and the job finishing the row has
-- a state of its own: the report is held, the document is not there yet.
--
-- `queued` says that, and it is a state the row can be left in only briefly:
-- the job ends it as `filed`, `refused` or `failed`, on its last attempt at the
-- latest. The sweep (`lib/tasks/filing-sweep.ts`) ends one whose job is gone.
--
-- Additive: no row changes, no column changes, and a build that predates this
-- never reads the value.

ALTER TABLE "task_runs" DROP CONSTRAINT IF EXISTS "task_runs_filing_status_known";
--> statement-breakpoint
ALTER TABLE "task_runs"
  ADD CONSTRAINT "task_runs_filing_status_known"
  CHECK ("filing_status" IS NULL OR "filing_status" IN ('queued', 'filed', 'refused', 'failed'));
--> statement-breakpoint
-- The filing sweep's read: the few rows whose report is still queued. Partial,
-- so it stays as small as the backlog and costs nothing once the queue is empty.
CREATE INDEX IF NOT EXISTS "ix_task_runs_filing_queued"
  ON "task_runs" ((COALESCE("finished_at", "updated_at")))
  WHERE "filing_status" = 'queued';
