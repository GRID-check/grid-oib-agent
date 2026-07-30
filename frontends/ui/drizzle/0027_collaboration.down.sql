-- Rollback for 0027_collaboration.sql.
--
-- NOTE the asymmetry: dropping the tables destroys grants, mention requests,
-- inbox items and read state permanently. That is correct — they are all
-- derivative of a feature that no longer exists — but it is not reversible, so
-- take a dump first if the data matters.
--
-- The `visibility` backfill is NOT undone by design: dropping the column returns
-- conversations to their previous (org-scoped) read behaviour, so there is
-- nothing to restore.

DROP TABLE IF EXISTS "conversation_reads";
--> statement-breakpoint
DROP TABLE IF EXISTS "inbox_items";
--> statement-breakpoint
DROP TABLE IF EXISTS "mention_requests";
--> statement-breakpoint
DROP TABLE IF EXISTS "resource_shares";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "visibility";
--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "author_user_id";
