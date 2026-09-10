-- Reverse 0082. Drops the version history of every document and the two columns
-- that point into it.
--
-- What disappears is the RECORD, not the bytes a reader can open: the item's own
-- `storage_key` still names the published version's object, so every document
-- still previews and downloads exactly as it did before this migration. What is
-- lost is every superseded version's row — the object it named becomes an orphan
-- nothing lists, findable only by a bucket sweep — and every editorial decision:
-- who submitted, who approved, who asked for changes and in which words. A draft
-- that was never published loses its row while its object stays.
--
-- So this is a rollback of a deploy, not a way to undo the feature. Take the
-- objects out first if the space matters.
DROP INDEX IF EXISTS "uniq_document_versions_published_per_document";
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_document_versions_open_per_document";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_published_version_id_fkey";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_lifecycle_known";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "published_version_id";
--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "lifecycle";
--> statement-breakpoint
DROP TABLE IF EXISTS "document_versions";
