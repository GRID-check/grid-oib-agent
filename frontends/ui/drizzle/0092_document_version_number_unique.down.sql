-- Reverse 0092: version numbers stop being unique per document.
--
-- The plain index comes back first, so the `(document_id, version_number)`
-- lookups the version list and the diff base run are never without one.
--
-- The renumbering of pre-existing duplicates is NOT reversed. It moved only rows
-- that shared a number with an earlier row of the same document, and putting
-- them back would recreate an ambiguity nothing could tell apart again. Every
-- moved row keeps its bytes, its state and its storage key either way.

CREATE INDEX IF NOT EXISTS "idx_document_versions_document"
  ON "document_versions" ("document_id", "version_number");

ALTER TABLE "document_versions"
  DROP CONSTRAINT IF EXISTS "document_versions_document_id_version_number_key";
