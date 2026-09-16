-- Reverse 0090: narrow the due scan back to recurring definitions only.
--
-- Data needs no reversing — no column changes shape here. What matters is the
-- ORDER against a deployed scheduler: this index must go back to the 0086
-- predicate BEFORE a worker running the old claim query sweeps again, or that
-- claim degrades to a sequential scan over every definition.
--
-- A one-shot created while 0090 was live keeps its `due_at` and its
-- `next_run_at`; after this migration the scheduler simply stops seeing it, so
-- it never fires. That is the honest reversal — the feature is gone — and the
-- row stays legible rather than being quietly rewritten into something else.

DROP INDEX IF EXISTS "idx_task_definitions_due";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_task_definitions_due"
  ON "task_definitions" ("next_run_at")
  WHERE "trigger" = 'schedule' AND "enabled";
