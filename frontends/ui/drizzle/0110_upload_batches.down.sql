-- Reverse 0109. ORDER: roll the frontend back first; the newer build writes
-- both. Lossy: the upload history and the batch pointer on documents go.
DROP INDEX IF EXISTS "documents_upload_batch_idx";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "upload_batch_id";
DROP TABLE IF EXISTS "upload_batches";
