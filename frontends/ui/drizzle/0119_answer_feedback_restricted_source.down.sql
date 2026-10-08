-- Reverse 0119. An older build filters on the conversation_restricted_folders
-- record alone, so a vote on a deleted conversation that drew on a restricted
-- folder reaches its cross-tenant readers again once this runs.
DROP TRIGGER IF EXISTS "conversation_restricted_folders_mark_feedback" ON "conversation_restricted_folders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_feedback_keeps_restricted_source();
--> statement-breakpoint
ALTER TABLE "answer_feedback" DROP COLUMN IF EXISTS "restricted_source";
