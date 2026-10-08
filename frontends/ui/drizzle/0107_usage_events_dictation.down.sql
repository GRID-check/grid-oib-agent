-- Reverse 0107: forget which ledger rows were voice dictation.
--
-- ORDER: roll the frontend back first; the newer build writes the column and
-- the activity. The dictation rows are reclassified as unclassified spend
-- (activity NULL) so the narrowed CHECK accepts them; their cost stays on the
-- ledger, their audio length is lost. They were never in the rollups, so no
-- budget changes.
ALTER TABLE "llm_usage_events" DROP CONSTRAINT IF EXISTS "llm_usage_events_dictation_unbilled_check";
UPDATE "llm_usage_events" SET "activity" = NULL WHERE "activity" = 'dictation';
ALTER TABLE "llm_usage_events" DROP CONSTRAINT IF EXISTS "llm_usage_events_activity_check";
ALTER TABLE "llm_usage_events"
  ADD CONSTRAINT "llm_usage_events_activity_check" CHECK ("activity" IS NULL OR "activity" IN ('ingest'));
ALTER TABLE "llm_usage_events" DROP COLUMN IF EXISTS "audio_seconds";
