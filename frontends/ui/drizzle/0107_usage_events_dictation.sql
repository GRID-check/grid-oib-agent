-- Book voice dictation on the ledger without billing anyone for it.
--
-- Dictating into the chat composer calls a transcription model, and that call
-- costs the platform (or an organization's own key) real money. The product
-- decision is that a member is never billed for it and never blocked by a
-- budget because of it, while the platform still sees what it spends. So a
-- dictation row is a normal ledger row with `activity = 'dictation'`, its real
-- `cost_usd`, the seconds of audio it transcribed, and no price.
--
-- The CHECK below is what keeps the "never billed" half true: a writer that
-- forgets to zero the price is refused by the database rather than invoicing a
-- member. The other half, never counting against a budget, is the BFF keeping
-- these rows out of `llm_usage_rollups` (`UNBILLED_USAGE_ACTIVITIES`), which is
-- the only thing the budgets read.
ALTER TABLE "llm_usage_events" ADD COLUMN IF NOT EXISTS "audio_seconds" numeric(10, 2);
--> statement-breakpoint
ALTER TABLE "llm_usage_events" DROP CONSTRAINT IF EXISTS "llm_usage_events_activity_check";
--> statement-breakpoint
ALTER TABLE "llm_usage_events"
  ADD CONSTRAINT "llm_usage_events_activity_check" CHECK ("activity" IS NULL OR "activity" IN ('ingest', 'dictation'));
--> statement-breakpoint
ALTER TABLE "llm_usage_events" DROP CONSTRAINT IF EXISTS "llm_usage_events_dictation_unbilled_check";
--> statement-breakpoint
ALTER TABLE "llm_usage_events"
  ADD CONSTRAINT "llm_usage_events_dictation_unbilled_check"
  CHECK ("activity" IS DISTINCT FROM 'dictation' OR ("price_usd" = 0 AND "credits" = 0));
