-- Say what kind of work a generation served, starting with ingestion.
--
-- Ingesting a document costs real money (vision captions of every drawing,
-- transcription of scanned pages, the summary, the embeddings), and none of it
-- reached the ledger: the backend opened a cost tracker only around chat turns,
-- research jobs and memory reflection. The ingest worker now opens one per job
-- and stamps its rows `activity = 'ingest'`, so the platform view can show what
-- ingestion costs beside what answering costs.
--
-- Nullable and not backfilled: every row written before this migration, and
-- every row from a chat turn, job or stage after it, carries NULL, which reads
-- as "interactive or unclassified". The CHECK lists the values a writer may
-- use; a new activity is added here first, not discovered in the data.
ALTER TABLE "llm_usage_events" ADD COLUMN IF NOT EXISTS "activity" text;
--> statement-breakpoint
ALTER TABLE "llm_usage_events" DROP CONSTRAINT IF EXISTS "llm_usage_events_activity_check";
--> statement-breakpoint
ALTER TABLE "llm_usage_events"
  ADD CONSTRAINT "llm_usage_events_activity_check" CHECK ("activity" IS NULL OR "activity" IN ('ingest'));
