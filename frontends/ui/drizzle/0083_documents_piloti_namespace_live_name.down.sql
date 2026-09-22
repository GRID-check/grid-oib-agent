-- Reverse 0083: the live-name rule covers human uploads only again.
--
-- Narrowing a unique index deletes no data and changes no row, so there is no
-- guard. What it means is that two live documents may once more share a name
-- inside the `piloti/` namespace — which the application cannot produce, since
-- the namespace carries the document's own id — so the reversal is a schema
-- statement rather than a behaviour change. The BFF code of the same change
-- keeps filing under the namespace either way, so re-applying 0083 needs no
-- code change.
--
-- Restores 0077's index verbatim, comment included: that is the version this
-- migration widened, and a rollback that left a reworded comment behind would
-- make the catalogue disagree with the migration a reader is following.

DROP INDEX IF EXISTS "uniq_documents_live_name_per_collection";

CREATE UNIQUE INDEX "uniq_documents_live_name_per_collection"
  ON "documents" ("organization_id", "collection_name", "filename")
  WHERE "authored_by" = 'user';

COMMENT ON INDEX "uniq_documents_live_name_per_collection" IS
  'One live human-uploaded document per (organization, collection, filename): the ingest pipeline replaces passages by filename, so a second row under one name is a ghost that is listed and downloadable but findable by nothing. The columns and predicate are exactly the WHERE clause of findLiveDocumentByFilename, which is what makes the application replace instead of insert; this index closes the concurrent-first-upload race that probe cannot. Partial on authored_by = ''user'' because a machine-authored row carries a model-chosen name, owns no chunks, and must coexist with a person''s file of the same name.';
