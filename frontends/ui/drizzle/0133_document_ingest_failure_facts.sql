-- 0133: why a document's read failed, so a retry can tell a lasting failure
-- from a passing one.
--
-- A failed document carried only `error_message`. Every „Erneut lesen“, every
-- „Alle erneut lesen“ and every org rescan read it again, forever, including
-- the file certain to fail the same way (an empty or encrypted PDF, one the
-- parser cannot open): each attempt a download, a parse, sometimes vision
-- calls, and the same red badge. The backend now states the failure's category
-- and whether the same bytes may read on a retry, per file
-- (`FileProgress.failure_category` / `retryable`,
-- `aiq_agent/knowledge/ingest_failures.py`), and the reader version that read
-- them (`IngestionJobStatus.reader_version`). The reconcile writes the three
-- here (`setDocumentReconciledStatus`), and `lib/documents/retry-policy.ts`
-- decides from them.
--
--   ingest_failure_category  transient | configuration | deterministic |
--                            quarantined | unknown; NULL while the row has not
--                            failed, and on every row from before this column.
--   ingest_retryable         the backend's flag beside it; NULL likewise.
--   ingest_reader_version    the reader that last read the row (`2026.10.1`);
--                            a `deterministic` failure is retried once the
--                            deployed reader is newer.
--   ingest_attempts          dispatches of this row, counted by
--                            `setDocumentIngestJob`; NULL until the first one
--                            after this migration. Read by people, not by the
--                            retry rule (nothing retries a failure on its own).
--
-- Additive only: four nullable columns, no default, no backfill. Every
-- existing row reads as "category unknown", which the retry rule treats
-- exactly as before this migration (retryable), so nothing a person could
-- retry yesterday is refused today. A row's first failure after the deploy
-- records its category.
--
-- The CHECK holds the category to the five values the code knows, so a
-- typo'd writer fails its write instead of storing a category the rule reads
-- as unknown. The BFF parses what the backend sends (`parseIngestFailureCategory`)
-- and writes NULL for a value it does not know, so a newer backend cannot
-- trip it. Adding it scans `documents` once under the lock the ADD COLUMNs
-- already hold, and every row passes: the column is NULL everywhere.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ingest_failure_category" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ingest_retryable" boolean;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ingest_reader_version" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "ingest_attempts" integer;
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_ingest_failure_category_check";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_ingest_failure_category_check" CHECK (
  "ingest_failure_category" IS NULL
  OR "ingest_failure_category" IN ('transient', 'configuration', 'deterministic', 'quarantined', 'unknown')
);
--> statement-breakpoint
COMMENT ON COLUMN "documents"."ingest_failure_category" IS
  'Why the last read failed (migration 0133): transient | configuration | deterministic | quarantined | unknown. NULL: not failed, or recorded before the column. Written by setDocumentReconciledStatus; read by lib/documents/retry-policy.ts.';
--> statement-breakpoint
COMMENT ON COLUMN "documents"."ingest_retryable" IS
  'The backend''s verdict beside ingest_failure_category: whether the same bytes may read on a retry (migration 0133).';
--> statement-breakpoint
COMMENT ON COLUMN "documents"."ingest_reader_version" IS
  'INGEST_READER_VERSION of the backend that last read this row (migration 0133). A deterministic failure is retried once the deployed reader is newer.';
--> statement-breakpoint
COMMENT ON COLUMN "documents"."ingest_attempts" IS
  'How many times this row was dispatched to ingestion since migration 0133 (setDocumentIngestJob). Informational.';
