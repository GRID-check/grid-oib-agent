-- 0096: let a sweep find the runs whose ending never arrived.
--
-- ## The gap this closes
--
-- A run's `task_runs` row leaves `queued`/`running` only when the worker tells
-- the BFF how it ended (`/api/internal/jobs/{id}/outcome`). That was one POST
-- with no retry: a BFF restart or a blip at that moment left the row `running`
-- for good, and so did a job that finished before the BFF had written its
-- backend job id onto the row (the report met a 404). The job store kept the
-- real verdict the whole time; nothing ever asked it.
--
-- The run reconciler (`lib/runs/reconcile.ts`) asks. This column is what makes
-- that a bounded, replica-safe sweep rather than a scan of every active row on
-- every tick.
--
-- ## `reconcile_checked_at`
--
-- When the reconciler last asked the job store about this run. The claim sets it
-- to now() in the same statement that selects the row (`FOR UPDATE SKIP LOCKED`
-- in the subquery), so two BFF replicas sweeping at once never pick the same
-- run, and a run still genuinely working is asked again only after the stale
-- window has passed once more. NULL until the first check: the claim falls back
-- to `started_at`, then `created_at`, so a fresh run is left alone for the whole
-- window. Nothing else writes it and no reader shows it.
--
-- ## The index
--
-- Partial on the two active statuses, because they are a small, short-lived
-- minority of all runs and the sweep reads only them. Ordered by the same
-- expression the claim orders by, so the oldest check is found first. Drizzle's
-- index builder cannot express a partial index on an expression, so it lives
-- only here, like `idx_task_definitions_due`.
--
-- ## RLS
--
-- Untouched, and not in `BOUNDARY_MIGRATIONS`: no table is created, dropped or
-- renamed. The sweep's discovery runs under the platform step-up and each
-- run's close is done inside that run's own organization.

ALTER TABLE "task_runs"
  ADD COLUMN IF NOT EXISTS "reconcile_checked_at" timestamp with time zone;

--> statement-breakpoint
COMMENT ON COLUMN "task_runs"."reconcile_checked_at" IS
  'When the run reconciler last asked the job store about this still-active run (lib/runs/reconcile.ts, migration 0096). Set by the claim itself, so replicas never check one run twice at once. NULL until the first check. Bookkeeping only; nothing renders it.';

--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_runs_reconcile_due"
  ON "task_runs" ((COALESCE("reconcile_checked_at", "started_at", "created_at")))
  WHERE "status" IN ('queued', 'running');
