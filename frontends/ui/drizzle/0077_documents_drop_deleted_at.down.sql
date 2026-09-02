-- Reverse 0077: `documents.deleted_at` returns, NULL on every row, and the
-- unique index carries its original `deleted_at IS NULL` clause again.
--
-- No data is restored because none was lost: the forward migration refused to
-- run over any row with the column set. The application code of the same
-- change no longer reads the column, so re-applying it is a schema-only step.

DROP INDEX IF EXISTS "uniq_documents_live_name_per_collection";

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;

CREATE UNIQUE INDEX "uniq_documents_live_name_per_collection"
  ON "documents" ("organization_id", "collection_name", "filename")
  WHERE "authored_by" = 'user' AND "deleted_at" IS NULL;

COMMENT ON INDEX "uniq_documents_live_name_per_collection" IS
  'One live human-uploaded document per (organization, collection, filename): the ingest pipeline replaces passages by filename, so a second row under one name is a ghost that is listed and downloadable but findable by nothing. The columns and predicate are exactly the WHERE clause of findLiveDocumentByFilename, which is what makes the application replace instead of insert; this index closes the concurrent-first-upload race that probe cannot. Partial on authored_by = ''user'' because a machine-authored row carries a model-chosen name, owns no chunks, and must coexist with a person''s file of the same name.';
