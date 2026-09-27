-- Reverse 0094: a version is bound to its document by the composite key alone.
--
-- The orphan rows 0094 deleted are NOT restored. They were version rows of
-- documents that no longer existed, naming objects their delete had already
-- erased; nothing could have read them.

ALTER TABLE "document_versions"
  DROP CONSTRAINT IF EXISTS "document_versions_document_id_fkey";
