-- 0098: let the run reconciler find a closed run whose block still says „läuft".
--
-- ## The gap this closes
--
-- A run ends twice over: its `task_runs` row closes, and its block's ledger
-- (`messages.metadata.run_ledger`) takes a terminal op. Until this change the
-- two had different writers. The row closed on the outcome report, which the
-- ghost reaper, the cancel route and the worker all send; the ledger took its
-- ending only from the worker's own fold, sent once and never retried. A run
-- whose worker died (a deploy, a reaped ghost) or that was cancelled before a
-- worker claimed it ended with a closed row and a ledger still „läuft". The
-- reconciler claims only active rows, so nothing looked at it again, and the
-- block's „Abbrechen" answered that the run had already ended.
--
-- The outcome recorder settles the ledger now (`recordRunOutcome` →
-- `settleRunLedger`). This index serves the sweep that heals the runs closed
-- before it, and catches any later path that closes a row some other way:
-- every closed run is looked at ONCE after it ended.
--
-- ## Once per ending, on the column 0096 added
--
-- `reconcile_checked_at` before the row's ending (or NULL) means „not looked at
-- since it ended". The heal claim stamps it to now(), which moves the row out of
-- this index for good; it re-enters only if the row changes again. The heal
-- itself writes the ledger only while it still reads as live, under the
-- message's row lock, so a second look changes nothing.
--
-- ## RLS
--
-- Untouched, and not in `BOUNDARY_MIGRATIONS`: no table is created, dropped or
-- renamed. Discovery runs under the platform step-up; each heal runs inside
-- the run's own organization.

CREATE INDEX IF NOT EXISTS "idx_task_runs_ledger_heal_due"
  ON "task_runs" ((COALESCE("finished_at", "updated_at")))
  WHERE "status" NOT IN ('queued', 'running')
    AND "run_message_id" IS NOT NULL
    AND ("reconcile_checked_at" IS NULL OR "reconcile_checked_at" < COALESCE("finished_at", "updated_at"));
