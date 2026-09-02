-- 0077: drop `documents.deleted_at`, the soft-delete column nothing ever wrote.
--
-- ## What was wrong
--
-- 0009 gave `projects`, `documents` and `conversations` a `deleted_at` for the
-- deletion pipeline's grace period. Projects and conversations soft-delete;
-- documents never did — every document delete is a hard DELETE (0064 says so
-- at length). The column stayed, and it was READ: five aggregate and probe
-- queries, the document-role join and the 0074 unique index all carried
-- `deleted_at IS NULL`. A predicate over a column nothing writes is inert
-- today and a trap tomorrow: the first writer, whether a hand-run UPDATE or a
-- soft delete added for one path, would silently hide rows from the quota
-- sum, the filename probe and the role checklist, and re-admit a duplicate
-- under the unique index, with nothing failing. This migration removes the
-- column so a future soft delete has to be designed, not stumbled into.
--
-- ## The index
--
-- `uniq_documents_live_name_per_collection` was partial on
-- `authored_by = 'user' AND deleted_at IS NULL`. Since `deleted_at` is NULL
-- on every row, the rule it has been enforcing is exactly `authored_by = 'user'`,
-- and that is what it is recreated with. The columns and the remaining
-- predicate stay the WHERE clause of `findLiveDocumentByFilename` (0074's
-- reason: narrower rejects rows the probe accepts, wider admits the duplicate
-- it prevents). "Live" now means "exists", because that is what it always
-- meant for a document.
--
-- ## Existing data
--
-- A row with `deleted_at` set would become visible the moment the column
-- goes, and could collide under the recreated index. Nothing in the
-- application writes the column, so such a row can only be the result of a
-- hand-run statement; the guard below refuses rather than deciding for the
-- operator whether it was meant as a delete.
--
-- ## Locks
--
-- `DROP COLUMN` takes an ACCESS EXCLUSIVE lock for the catalogue update only;
-- Postgres does not rewrite the table. The unique index rebuild takes a SHARE
-- lock, as 0074 did — CONCURRENTLY cannot run inside the runner's transaction.

-- ---------------------------------------------------------------------------
-- 1. Refuse to drop a column that holds a value somebody put there
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  marked bigint;
BEGIN
  SELECT count(*) INTO marked FROM "documents" WHERE "deleted_at" IS NOT NULL;
  IF marked > 0 THEN
    RAISE EXCEPTION E'Cannot apply migration 0077: % document row(s) carry a deleted_at value, which no application path writes. Dropping the column would make them visible again. Decide per row whether it was meant as a delete (DELETE it through the application, which also removes its stored object and quota charge) or not (SET deleted_at = NULL), then re-run.',
      marked;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Drop the index that names the column, then the column
-- ---------------------------------------------------------------------------
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_documents_live_name_per_collection";

--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "deleted_at";

-- ---------------------------------------------------------------------------
-- 3. One human-uploaded document per (organization, collection, filename)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_documents_live_name_per_collection"
  ON "documents" ("organization_id", "collection_name", "filename")
  WHERE "authored_by" = 'user';

--> statement-breakpoint
COMMENT ON INDEX "uniq_documents_live_name_per_collection" IS
  'One human-uploaded document per (organization, collection, filename): the ingest pipeline replaces passages by filename, so a second row under one name is a ghost that is listed and downloadable but findable by nothing. The columns and predicate are exactly the WHERE clause of findLiveDocumentByFilename, which is what makes the application replace instead of insert; this index closes the concurrent-first-upload race that probe cannot. Partial on authored_by = ''user'' because a machine-authored row carries a model-chosen name, owns no chunks, and must coexist with a person''s file of the same name. Documents have no soft delete (0077 dropped the never-written deleted_at), so every row is live.';
