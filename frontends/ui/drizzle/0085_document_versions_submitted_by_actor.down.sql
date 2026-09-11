-- Reverse 0085: a submission forgets whose hand made it.
--
-- Dropping the column re-collapses the two facts, so the not-the-submitter
-- guard reads `submitted_by` alone again and a commissioning human is once more
-- refused the release of the report they ordered. That is the pre-0085
-- behaviour rather than a broken one; nothing else reads the column.

ALTER TABLE "document_versions"
  DROP CONSTRAINT IF EXISTS "document_versions_submitted_by_actor_known";

ALTER TABLE "document_versions" DROP COLUMN IF EXISTS "submitted_by_actor";
