-- Reverse 0122. The marks go, and 0119's column and trigger come back: a vote
-- whose message was marked is marked `restricted_source`, so an older build,
-- which matches by the vote's conversation and that column, still leaves it
-- out. A message marked after its chat was deleted is still kept out that way.
-- The lesson text and the `previousContent` 0122 withdrew stay withdrawn: they
-- are not kept anywhere.
DROP TRIGGER IF EXISTS "messages_mark_restricted_use" ON "messages";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_mark_message_restricted_use();
--> statement-breakpoint
ALTER TABLE "answer_feedback"
  ADD COLUMN IF NOT EXISTS "restricted_source" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
COMMENT ON COLUMN "answer_feedback"."restricted_source" IS
  'The conversation drew on a folder with restricted access, recorded when its conversation_restricted_folders row was deleted (0119). Never read across tenants (OUTSIDE_RESTRICTED_USE).';
--> statement-breakpoint
UPDATE "answer_feedback" f
SET "restricted_source" = true
WHERE NOT f."restricted_source"
  AND EXISTS (
    SELECT 1 FROM "message_restricted_use" mr
    WHERE mr."organization_id" = f."organization_id"
      AND mr."message_id" = f."message_id"
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_feedback_keeps_restricted_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "answer_feedback"
  SET "restricted_source" = true
  WHERE "organization_id" = OLD."organization_id"
    AND "conversation_id" = OLD."conversation_id"
    AND NOT "restricted_source";
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "conversation_restricted_folders_mark_feedback" ON "conversation_restricted_folders";
--> statement-breakpoint
CREATE TRIGGER "conversation_restricted_folders_mark_feedback"
  BEFORE DELETE ON "conversation_restricted_folders"
  FOR EACH ROW EXECUTE FUNCTION grid_feedback_keeps_restricted_source();
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_task_runs_revision_conversation";
--> statement-breakpoint
DROP TABLE IF EXISTS "message_restricted_use";
