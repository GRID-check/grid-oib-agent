-- Reverse 0091: a run forgets its message, and a message forgets its run.
--
-- Dropping these columns drops the POINTERS, not the work. The run ledger itself
-- lives in `messages.metadata.run_ledger` and stays exactly where it is: a jsonb
-- key no reader is obliged to understand, ignored by every mapper that predates
-- it. The report a run wrote stays on its message, readable as an ordinary
-- assistant turn.
--
-- What stops working is the joining: `GET /api/projects/[id]/runs/[runId]` can no
-- longer resolve a run to its message, and the internal ledger route can no
-- longer find one to patch. Both are additive surfaces — a run still runs, still
-- files its report and still closes through the outcome route — so the honest
-- reversal is that the thread stops narrating itself, which is the pre-0091
-- behaviour rather than a broken one.
--
-- The index goes with the column it serves. Order matters only in that the index
-- must be dropped first: Postgres would drop it with the column anyway, and
-- naming it here keeps the reversal readable.

DROP INDEX IF EXISTS "idx_messages_run_id";

ALTER TABLE "messages" DROP COLUMN IF EXISTS "run_id";

ALTER TABLE "task_runs" DROP COLUMN IF EXISTS "run_message_id";
