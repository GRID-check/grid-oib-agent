-- 0083: the live-name rule covers the `piloti/` filename namespace too.
--
-- ## What changed above it
--
-- ADR-0054 opened one door: a PUBLISHED version of an agent-authored document
-- is dispatched to `/v1/ingest`. Until then nothing `authored_by <> 'user'` was
-- ever indexed, which is why 0074 made its unique index partial on
-- `authored_by = 'user'` — a machine-authored row carried a model-chosen name,
-- owned no chunks, and had to be free to coexist with a person's file of the
-- same name.
--
-- That reasoning still holds for every producer whose output is filed and never
-- published (a research report, a diagram). It stops holding for a document a
-- chat turn wrote and a person released: that one has chunks, and the ingest
-- pipeline replaces passages BY FILENAME. Two rows under one name is once more
-- the ghost 0074 exists to prevent, only now with the collision reachable by
-- the model — `generatedFilename` builds `slug(title)-YYYY-MM-DD.ext` out of a
-- title the model chose, into the project's own collection.
--
-- ## The namespace, and why the index can trust it
--
-- A publishable Piloti document is filed under
-- `piloti/<document id>/<name>` from the moment it is created
-- (`frontends/ui/src/lib/documents/agent-namespace.ts`; the row's `filename` is
-- the chunk join key and is never renamed, so applying the namespace only on
-- the way into the index would index under one string and purge under
-- another).
--
-- No browser on any platform produces a file whose name contains `/`, so none
-- of the three upload shelves can present a name inside this namespace whatever
-- the person types. The two arms of the predicate below are therefore DISJOINT
-- BY CONSTRUCTION, not merely unlikely to meet:
--
--   (organization_id, collection_name, filename)
--     WHERE authored_by = 'user' OR filename LIKE 'piloti/%'
--
-- Which is what makes this a safe widening rather than a behaviour change: no
-- row that satisfied the old predicate leaves it, no row that a person can
-- create enters the new arm, and the rule a reader takes away is one sentence —
-- inside this collection, a name that can address chunks names one document.
--
-- 0074's doctrine says the index and `findLiveDocumentByFilename` must be the
-- same predicate, because a narrower index rejects rows the probe would accept
-- and a wider one admits duplicates the probe was meant to prevent. That
-- doctrine is about the arm the probe reads, and the probe is unchanged: it
-- still asks `authored_by = 'user'`, and no upload it serves can reach the new
-- arm. The new arm has no probe because its writer needs none — the document id
-- inside the namespace is unique by construction, and the filing path's
-- idempotency is `uniq_documents_authored_ref_producer_per_project` (0065/0066)
-- one level up. The arm is the database refusing to hold a collision that the
-- application has no way to create, which is the point: the day the namespace
-- derivation changes, this is what says so.
--
-- ## Existing data
--
-- Nothing in a deployed database can violate the new arm. A row matching
-- `piloti/%` can only have been written by the filing path, whose key carries a
-- fresh `documents.id`. The guarded block below refuses anyway rather than
-- failing the index build on one key and leaving the rest to be found by hand —
-- same shape, and same reason, as 0074's.
--
-- ## Locks and RLS
--
-- As 0074 and 0077: `DROP INDEX` is a catalogue update, and a plain
-- `CREATE UNIQUE INDEX` takes a SHARE lock for the build (CONCURRENTLY cannot
-- run inside the runner's transaction). No table is added or removed, so the
-- tenant boundary is untouched — `documents` was secured by 0031 and an index
-- does not move it.

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
    WHERE "authored_by" = 'user' OR "filename" LIKE 'piloti/%'
    GROUP BY "organization_id", "collection_name", "filename"
    HAVING count(*) > 1
  ) AS groups;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot apply migration 0083: a collection already holds more than one live document under one filename, so the widened unique index cannot be built.\n  %\nOnly the newest of each group still has passages in the retrieval index. Delete every entry but one through the application (which erases its stored object and quota charge), then re-upload or re-publish the file once so its passages are rebuilt, because deleting any of them purges the passages by filename.',
      duplicates;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One live document per (organization, collection, filename), over every row
--    that can own chunks
-- ---------------------------------------------------------------------------
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_documents_live_name_per_collection";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_documents_live_name_per_collection"
  ON "documents" ("organization_id", "collection_name", "filename")
  WHERE "authored_by" = 'user' OR "filename" LIKE 'piloti/%';

--> statement-breakpoint
COMMENT ON INDEX "uniq_documents_live_name_per_collection" IS
  'One live document per (organization, collection, filename) over every row that can own chunks: the ingest pipeline replaces passages by filename, so a second row under one name is a ghost that is listed and downloadable but findable by nothing. Two disjoint arms. authored_by = ''user'' is migration 0074''s original rule and is exactly the WHERE clause of findLiveDocumentByFilename, the probe that makes a re-upload replace instead of insert; this index closes the concurrent-first-upload race the probe cannot. filename LIKE ''piloti/%'' covers the namespace an agent-authored document is filed under when a version of it may be published and therefore indexed (ADR-0054, migration 0083) — no browser produces a filename containing a slash, so no upload can reach that arm and the two cannot collide. A machine-authored row OUTSIDE the namespace is in neither arm: it carries a model-chosen name, owns no chunks, and must coexist with a person''s file of the same name.';
