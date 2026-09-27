-- 0094: a version belongs to a document that exists, on every shelf.
--
-- ## The gap this closes
--
-- Migration 0082 bound a version to its document with ONE foreign key, the
-- composite `(document_id, project_id) → documents (id, project_id)`, so a
-- version could not name another project's document. It is MATCH SIMPLE, and a
-- MATCH SIMPLE key with a NULL column is not checked at all — and, because the
-- delete-side check looks for referencing rows by the whole key, not cascaded
-- either. `project_id` is NULL on exactly two shelves, the org-wide Archiv and a
-- conversation's attachments. There:
--
--   - deleting a document left every one of its version rows behind (the
--     delete paths erase the objects those rows name first, so what stayed was
--     dead rows naming deleted keys);
--   - a version could be INSERTED for a document that no longer existed. An
--     upload racing a delete did exactly that: it recorded a published version,
--     naming its own freshly stored object, for a row the delete had already
--     removed — an object and a row nothing would ever reach again.
--
-- A plain `document_id → documents (id) ON DELETE CASCADE` holds for every
-- shelf. The composite key stays: it is the tenant-and-project binding, and this
-- one is the existence binding. On the project shelf both apply; on the two
-- NULL-project shelves only this one does.
--
-- ## Existing orphans
--
-- `ADD CONSTRAINT … FOREIGN KEY` fails the deploy on the first version row whose
-- document is gone, and the gap above made such rows on every Archiv and
-- attachment delete. They are deleted first. Nothing is lost that any reader can
-- reach: no listing, no version history and no quota reading joins a version
-- without its document (the ledger's overhead is an INNER JOIN on documents), and
-- the delete that orphaned each row erased the objects of every version it saw.
-- A document that still exists is not touched.
--
-- ## RLS
--
-- Untouched, and deliberately NOT in `BOUNDARY_MIGRATIONS`: no table is created,
-- dropped or renamed, and a constraint does not move a table's policy. Runs as
-- the table owner, which RLS does not restrict here (0082 does not FORCE it).

--> statement-breakpoint
DELETE FROM "document_versions" v
WHERE NOT EXISTS (SELECT 1 FROM "documents" d WHERE d."id" = v."document_id");

--> statement-breakpoint
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_document_id_fkey"
  FOREIGN KEY ("document_id") REFERENCES "documents" ("id") ON DELETE CASCADE;

--> statement-breakpoint
COMMENT ON CONSTRAINT "document_versions_document_id_fkey" ON "document_versions" IS
  'A version belongs to a document that exists, on every shelf (migration 0094). The composite (document_id, project_id) key is MATCH SIMPLE and checks nothing when project_id is NULL (Archiv, session). A 23503 here is an upload recording its version for a document deleted first: DocumentDeletedError, a 409.';
