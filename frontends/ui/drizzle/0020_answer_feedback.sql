-- Per-answer thumbs feedback (WS-7, click-dummy overhaul spec §1/§6).
-- One row per (user, assistant message): verdict 'up'/'down' + optional
-- down-vote reason key. Re-vote = upsert on (user_id, message_id);
-- toggle-off = delete (no tombstones). message_id/conversation_id are
-- client-side chat identifiers (no FK — shallow turns are not persisted as
-- `messages` rows and a vote must not race the conversation insert);
-- project_id keeps a cascading FK so a purged project takes its feedback
-- along; organization_id is denormalized for SQL-level tenancy scoping.
CREATE TABLE IF NOT EXISTS "answer_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "conversation_id" text,
  "message_id" text NOT NULL,
  "user_id" text NOT NULL,
  "verdict" text NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Upsert target: one vote per user per answer.
CREATE UNIQUE INDEX IF NOT EXISTS "answer_feedback_user_message_uidx" ON "answer_feedback"("user_id","message_id");
--> statement-breakpoint
-- Serves the per-conversation hydration list (scoped org + user + conversation).
CREATE INDEX IF NOT EXISTS "answer_feedback_org_conversation_idx" ON "answer_feedback"("organization_id","conversation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "answer_feedback_org_project_idx" ON "answer_feedback"("organization_id","project_id");
