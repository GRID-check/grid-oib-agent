-- 0119: a vote keeps knowing that its conversation drew on a restricted folder,
-- after the conversation is gone (ADR-0086, ADR-0087).
--
-- `OUTSIDE_RESTRICTED_USE` (lib/feedback/repository.ts) leaves a vote out of
-- every cross-tenant reader (the platform drill-in, its CSV export, the
-- digest's model and the lessons distiller) when its conversation has a
-- `conversation_restricted_folders` row. Deleting the chat deletes that row
-- (`deleteConversationInOrg`), but not the vote: `answer_feedback` has no
-- foreign key to the conversation, and the vote is kept so the aggregates go
-- on counting it. Its `comment` and `expected_answer` may quote the folder, and
-- with the record gone they passed the filter.
--
-- So the fact moves onto the vote when the record goes: deleting a
-- `conversation_restricted_folders` row marks every vote on that conversation
-- `restricted_source`, whatever deletes it, and the filter reads both. Marked
-- at the delete rather than at the insert: a vote cast before the first
-- restricted turn is held back by the record while it exists, and the delete
-- is the one moment the record is about to stop doing that. The trigger runs
-- as the deleting role, in its tenant, which is the vote's tenant.
--
-- The backfill marks what is already recorded, so the column alone answers for
-- every vote from here on. A vote whose conversation was deleted before this
-- migration cannot be told apart and stays unmarked.
--
-- No new table, so no `grid_secure_table`: the column rides the table's
-- existing row-level-security policy.
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
    SELECT 1 FROM "conversation_restricted_folders" crf
    WHERE crf."organization_id" = f."organization_id"
      AND crf."conversation_id" = f."conversation_id"
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
