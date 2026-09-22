-- 0074: one live human-uploaded document per filename, per collection.
--
-- ## What was wrong
--
-- The ingest pipeline treats the filename as a document's identity inside a
-- collection: `_replace_previous_versions` deletes a file's chunks by name
-- before it writes the new ones. The `documents` table did not agree. A second
-- upload of one name minted a second id, a second row, a second stored object
-- and a second quota charge, while the pipeline replaced the FIRST row's chunks
-- with the second's. The first row stayed: listed, downloadable, cited by
-- nothing, findable by nothing. A ghost, and a paid-for one — and deleting it
-- through the app purged the chunks by filename, which took the SECOND row's
-- passages with it.
--
-- The application now replaces instead (`findLiveDocumentByFilename` probes,
-- `admitReplacementOrDiscard` points the existing id at the new bytes), on all
-- three shelves: project, Archiv and, as of this change, a conversation's
-- attachments. A probe is not a constraint (0064 makes the argument at length):
-- two concurrent first uploads of one name both miss it and both insert. This
-- index is the probe's WHERE clause as a rule, so the race ends in a unique
-- violation the upload path discards its object for, rather than in a ghost.
--
-- ## The columns, and the predicate
--
--   (organization_id, collection_name, filename)
--     WHERE authored_by = 'user' AND deleted_at IS NULL
--
-- Exactly what the probe asks, for 0064's reason: narrower rejects rows the
-- probe would accept, wider admits the duplicate it was meant to prevent.
--
-- `authored_by = 'user'` because a machine-authored row (`fileGeneratedDocument`)
-- carries a filename the model chose and owns no chunks. A person dropping a
-- file of that same name into the project is not correcting Piloti's report,
-- and the two rows must coexist; the probe skips such rows for the same reason.
--
-- `deleted_at IS NULL` matches the probe. Nothing writes `deleted_at` on
-- `documents` today (see 0064) — every delete is a hard DELETE — so the clause
-- is inert; it is here so the index and the probe stay the same predicate if a
-- soft delete ever arrives, rather than diverging on that day.
--
-- ## Existing data
--
-- Ghosts from before the replace path shipped may exist in a deployed
-- database. Building a unique index over them fails on ONE key and leaves the
-- rest to be found; and the resolution is not this migration's to make, because
-- each row names real bytes and a real quota charge, and because deleting the
-- wrong one through the app purges the survivor's chunks. The guarded block
-- below lists every duplicate group and refuses, so an operator can resolve
-- them deliberately: delete every entry but one in the application, then
-- re-upload the file once so its passages are rebuilt.
--
-- ## Locks and RLS
--
-- As 0064: a plain `CREATE UNIQUE INDEX` takes a SHARE lock for the build, and
-- CONCURRENTLY cannot run inside the runner's transaction. `documents` was
-- secured by 0031; an index does not move it across the tenant boundary.

-- ---------------------------------------------------------------------------
-- 1. Refuse to build over data that already violates (see the header)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(entry, E'\n  ' ORDER BY entry) INTO duplicates
  FROM (
    SELECT format(
             'organization %s, collection %L, filename %L (%s documents)',
             "organization_id",
             "collection_name",
             "filename",
             count(*)
           ) AS entry
    FROM "documents"
    WHERE "authored_by" = 'user'
      AND "deleted_at" IS NULL
    GROUP BY "organization_id", "collection_name", "filename"
    HAVING count(*) > 1
  ) AS dupes;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot apply migration 0074: a collection already holds more than one live document under one filename, so the unique index cannot be built.\n  %\nThese are re-upload ghosts: only the newest of each group still has passages in the retrieval index. Delete every entry but one through the application (which erases its stored object and quota charge), then re-upload the file once so its passages are rebuilt, because deleting any of them purges the passages by filename.',
      duplicates;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One live human-uploaded document per (organization, collection, filename)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_documents_live_name_per_collection"
  ON "documents" ("organization_id", "collection_name", "filename")
  WHERE "authored_by" = 'user' AND "deleted_at" IS NULL;

--> statement-breakpoint
COMMENT ON INDEX "uniq_documents_live_name_per_collection" IS
  'One live human-uploaded document per (organization, collection, filename): the ingest pipeline replaces passages by filename, so a second row under one name is a ghost that is listed and downloadable but findable by nothing. The columns and predicate are exactly the WHERE clause of findLiveDocumentByFilename, which is what makes the application replace instead of insert; this index closes the concurrent-first-upload race that probe cannot. Partial on authored_by = ''user'' because a machine-authored row carries a model-chosen name, owns no chunks, and must coexist with a person''s file of the same name.';
