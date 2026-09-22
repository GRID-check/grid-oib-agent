-- 0090: let the scheduler see one-shot tasks, not only recurring ones.
--
-- ## The gap this closes
--
-- `task_definitions` has carried `trigger = 'once'` and a `due_at` column since
-- 0086, with a CHECK saying a due date exists only on a one-shot. Nothing ever
-- wrote one with a date: a delegation is `once` with `due_at` NULL, dispatched
-- at creation, and the task wizard could only offer "on a cron" or "manual
-- only". So "run this the day before the Abgabe, once" — the shape a planning
-- office asks for most — was expressible in the schema and unreachable in the
-- product. People built a weekly schedule and remembered to delete it.
--
-- ## Why this is an index change and not a column
--
-- The storage was already right. What was missing is that the scheduler's
-- due-row claim could never SEE a one-shot: `idx_task_definitions_due` is
-- partial on `trigger = 'schedule' AND enabled`, and the claim's WHERE clause
-- has to keep matching that predicate for the scan to stay an index scan.
--
-- So the predicate moves off the trigger and onto the column that already
-- means "when the scheduler should next look at this row": `next_run_at`. A
-- recurring definition sets it from its cron, a one-shot sets it to its
-- `due_at`, and `manual` leaves it NULL. One index, one scan, both shapes.
--
-- ## How a one-shot stops after firing
--
-- The claim nulls `next_run_at` in the same transaction that claims the row,
-- exactly as a recurring definition advances its. A NULL is outside this
-- partial index and fails `next_run_at <= now()`, so the row is never claimed
-- twice: at-most-once, from the same mechanism that already gives the cron
-- path at-most-once, rather than a second one invented for this.
--
-- Note it does NOT flip `enabled`. `enabled` is the person's pause switch, and
-- a fired one-shot is finished, not paused — spending the one flag on both
-- would make a completed task read as a paused one everywhere it is shown.

DROP INDEX IF EXISTS "idx_task_definitions_due";
--> statement-breakpoint
-- Partial on the column the claim orders by, so the index still holds one entry
-- per row the scheduler could possibly want and none for the manual rows or the
-- one-shots that have already fired.
CREATE INDEX IF NOT EXISTS "idx_task_definitions_due"
  ON "task_definitions" ("next_run_at")
  WHERE "enabled" AND "next_run_at" IS NOT NULL;
