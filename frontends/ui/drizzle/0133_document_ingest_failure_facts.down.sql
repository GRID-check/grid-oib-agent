-- Reverse 0133. ORDER: roll the frontend back first; the newer build selects
-- these columns on every listing and writes them on every reconcile and dispatch.
--
-- Loses only what 0133 added: the category, the flag, the reader version and the
-- attempt count. The older build retries every failed document again, which is
-- the behaviour before 0133.
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_ingest_failure_category_check";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "ingest_attempts";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "ingest_reader_version";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "ingest_retryable";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "ingest_failure_category";
