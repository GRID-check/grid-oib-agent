-- Reverse 0108: drop mail imports.
--
-- The mails an import filed are ordinary documents and stay. What goes is each
-- import's record, and with it the only pointer to an archive still staged for
-- an unfinished import. List those first and delete the objects, or they stay in
-- the organization's bucket with nothing left that knows about them:
--
--   SELECT staging_bucket, staging_key FROM mail_imports WHERE staging_deleted_at IS NULL;
--
-- The inbox rows that announced finished imports go too: they link to a status
-- that no longer exists.

DELETE FROM "inbox_items" WHERE "type" IN ('mail_import.completed', 'mail_import.failed');
--> statement-breakpoint
DROP TABLE IF EXISTS "mail_imports";
