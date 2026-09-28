-- Attribute each generation to the chat answer it belongs to.
--
-- The ledger had no turn dimension, so "what did this answer cost" was not a
-- query. The backend now stamps every call of a chat turn, and of that turn's
-- post-answer stages, with the answer's message id
-- (`turn.response.answer_message_id`); the answer's details sum the frozen
-- `credits` of those rows (ADR-0053), so the number shown is the number billed.
--
-- Nullable and not backfilled: jobs carry no message id, and rows written
-- before this migration cannot be attributed after the fact.
ALTER TABLE "llm_usage_events" ADD COLUMN IF NOT EXISTS "message_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_llm_usage_events_org_message"
  ON "llm_usage_events" ("organization_id", "message_id");
