-- Reverse 0096: the run reconciler loses its bookmark.
--
-- The column only records when a still-active run was last checked against the
-- job store. Dropping it loses no run's history or outcome; the reconciler
-- simply cannot claim rows until it is back, and runs close through the
-- outcome route alone, which is the pre-0096 behaviour.

DROP INDEX IF EXISTS "idx_task_runs_reconcile_due";

ALTER TABLE "task_runs" DROP COLUMN IF EXISTS "reconcile_checked_at";
