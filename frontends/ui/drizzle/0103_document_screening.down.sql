-- Reverse 0103: forget screening outcomes and releases.
--
-- ORDER: roll the frontend back first; the newer build reads and writes these
-- columns. Lossy: which documents were released from quarantine, by whom, is
-- forgotten (the audit trail keeps it). Quarantined rows keep status
-- `quarantined`, which the older build renders as an unknown status; release or
-- delete them before rolling back.
DROP INDEX IF EXISTS "documents_quarantined_idx";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_screening_release_complete_check";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_screening_outcome_check";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "screening_released_at";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "screening_released_by";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "screening_released_hash";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "screening_outcome";
