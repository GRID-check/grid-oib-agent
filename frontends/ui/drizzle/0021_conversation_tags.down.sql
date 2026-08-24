-- Manual down migration (drizzle-kit has no down support; mirrors 0019/0020's
-- convention). Drops the conversation topic-tag column and its GIN index.
DROP INDEX IF EXISTS "conversations_tags_idx";
--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "tags";
