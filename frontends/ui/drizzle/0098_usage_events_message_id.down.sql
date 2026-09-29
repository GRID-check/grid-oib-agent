-- Reverse 0098: drop the answer attribution on the usage ledger.
--
-- ORDER: roll the frontend back first; the newer build selects the column.
DROP INDEX IF EXISTS "idx_llm_usage_events_org_message";
ALTER TABLE "llm_usage_events" DROP COLUMN IF EXISTS "message_id";
