-- Reverse 0117: no permit records and no requirements.
--
-- Lossy, and deliberately so: both tables are derived from the documents at
-- ingest and hold nothing a re-extraction cannot rebuild. An older build has no
-- reader for them, so a stale copy would only mislead.
DROP TABLE IF EXISTS "permit_requirements";
--> statement-breakpoint
DROP TABLE IF EXISTS "permit_records";
