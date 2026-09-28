-- Reverse 0098: the ledger heal loses its index.
--
-- Drops nothing but the index. The heal claim still works without it, as a
-- scan of `task_runs`, which retention keeps to 90 days.

DROP INDEX IF EXISTS "idx_task_runs_ledger_heal_due";
