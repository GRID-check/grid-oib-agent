-- Reverse 0101: drop the activity dimension on the usage ledger.
--
-- ORDER: roll the frontend back first; the newer build writes and selects the
-- column. Lossy only in classification: the rows stay, and their spend still
-- counts everywhere, but which of them were ingestion is forgotten.
ALTER TABLE "llm_usage_events" DROP CONSTRAINT IF EXISTS "llm_usage_events_activity_check";
ALTER TABLE "llm_usage_events" DROP COLUMN IF EXISTS "activity";
