-- A document can be renamed, and its file cannot.
--
-- ## Why a second name rather than an edit to `filename`
--
-- `filename` is not a label. It is the JOIN KEY between the three systems that
-- hold a document: the BFF row, the SeaweedFS object (`storage_key` is derived
-- from it at upload), and — the one that matters — the retrieval index, which
-- addresses every chunk by `(collection_name, file_name)`. The tag edit, the
-- visual-details read, the preview and the delete purge all reach the Python
-- side by that pair, and `find_storage_key_by_collection_and_filename` reaches
-- back the same way for the agent's own file lookups.
--
-- So an UPDATE of `filename` would rename the row and nothing else: the chunks
-- keep the old name, and every subsequent call on that document addresses a
-- file the backend has never heard of. The document stops being taggable,
-- previewable and deletable — silently, and only for documents somebody
-- renamed. Re-ingesting to fix that would mean re-embedding a corpus because
-- someone corrected a typo.
--
-- `display_name` is therefore what a rename writes, and `filename` stays the
-- identity it always was. NULL means "never renamed" — the file's own name is
-- shown, which is what every existing row means and why no backfill is needed.
--
-- The same rename also PATCHes the backend's `display_title` for the pair
-- (`/v1/collections/{c}/documents/{f}/display-title`), which is the identical
-- split one layer down: the metadata store keeps a user-facing title beside the
-- immutable file name, and retrieval prefers it when it builds a citation chip.
-- The two columns are the same fact recorded on both sides of the wire, and the
-- rename endpoint writes them together.
--
-- ## Locks
--
-- `ADD COLUMN` with no default and no constraint is catalog-only in Postgres
-- 11+ — no table rewrite, no scan, an ACCESS EXCLUSIVE lock held for the
-- duration of the catalog update. Safe on a live `documents` table.
--
-- ## RLS
--
-- Untouched. `documents` was secured when it was created and a new column on a
-- secured table stays inside the tenant boundary, so this migration
-- deliberately makes no `grid_secure_table` call (`rls-coverage.spec.ts` reads
-- those to decide what is inside it).

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint

-- The next person reads `\d+ documents`, not this file.
COMMENT ON COLUMN "documents"."display_name" IS
  'User-facing name shown wherever the document is listed or previewed. NULL = never renamed, show `filename`. Deliberately NOT `filename`: that column is the join key to the SeaweedFS object and to the retrieval index (collection_name, file_name), so renaming it would orphan the document''s chunks. A rename writes here and mirrors the value to the backend metadata store''s display_title, which is what citation chips read.';
