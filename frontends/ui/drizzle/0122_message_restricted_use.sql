-- 0122: the server marks a message that was written while its conversation
-- drew on a folder with restricted access, and the mark outlives the chat
-- (ADR-0089, ADR-0084, ADR-0085).
--
-- ## Why the mark moves from the conversation to the message
--
-- Until now every cross-tenant reader of answer feedback (the platform
-- drill-in, its CSV export, the digest's model, the lessons distiller) left a
-- vote out when `conversation_restricted_folders` held a row for the vote's
-- `conversation_id`, or when 0119's trigger had copied that fact onto the vote
-- as the record was deleted. Both matched the CLIENT's `conversation_id`: a
-- vote that named another chat, or none, passed with a comment quoting the
-- folder. The vote's `message_id` is its identity (the upsert key) and, for a
-- persisted answer, the `messages` row's own id.
--
-- So the fact is written by the database onto the message, keyed by
-- (organization, message id), in `message_restricted_use`:
--
--   * a trigger on `messages` marks a row when it is INSERTED, or its `content`
--     is rewritten, while its conversation holds a restricted-use record. The
--     record is written when the BFF admits restricted content into a turn
--     (`admitRestrictedUse`), before the model reads it; the answer is
--     persisted after the turn, and a run's report is written into its message
--     after the run. So the answer of the turn that drew on the folder is
--     marked, and so is every later message of the conversation, whose turns
--     had that content in their history. A message written before the first
--     admission is not;
--   * no foreign key, so deleting the chat (which deletes its messages and its
--     record) leaves the mark. It holds ids and a time, no content;
--   * the runtime role may insert and read marks in its own tenant and may
--     neither change nor delete one: no tenant-path bug can lift a mark.
--
-- Every reader keys on the mark by the vote's `message_id`; none reads the
-- vote's `conversation_id` for this question any more. 0119's column and
-- trigger are folded into marks and dropped.
--
-- ## Backfill, and what it cannot recover
--
--   * every message of a conversation with a restricted-use record is marked,
--     the ones written before its first admission included: when that was is
--     not recoverable (`messages.created_at` can be supplied by the client), so
--     the backfill marks too much rather than too little;
--   * every vote 0119 marked `restricted_source` marks its `message_id`;
--   * a conversation deleted before 0119, and a restricted-use record deleted
--     before this migration whose votes 0119 did not reach, left nothing to
--     match: those votes stay unmarked;
--   * a vote on an answer that was never persisted (the client dropped and the
--     backend's own persist failed) has no message to mark, now or later.
--
-- ## Withdrawal
--
-- As 0118 did for reports matched by conversation, now by mark: a report whose
-- vote's message is marked loses its `canonical_summary`, and a lesson
-- CREATED from one is retired (if live, with an event) and its text replaced.
-- A lesson only linked to such a report keeps its text. Then every withdrawn
-- lesson's events lose `previousContent`, the text an owner's edit kept of an
-- earlier version, which 0118 left in the trail. A report whose vote was
-- retracted cannot be matched, and the text withdrawn is not kept anywhere:
-- the down migration cannot bring it back.
--
-- ## Revision tasks
--
-- Not stored: a revision task, and the thread it writes into, are judged when
-- read by the folder its document is in now. The partial index below is the
-- thread's lookup.
CREATE TABLE IF NOT EXISTS "message_restricted_use" (
  "organization_id" text NOT NULL,
  "message_id" text NOT NULL,
  "conversation_id" text NOT NULL,
  "marked_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "message_restricted_use_pk" PRIMARY KEY ("organization_id", "message_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_restricted_use_conversation_idx"
  ON "message_restricted_use" ("organization_id", "conversation_id");
--> statement-breakpoint
COMMENT ON TABLE "message_restricted_use" IS
  'A message written while its conversation drew on a folder with restricted access (ADR-0089). Written by a trigger on messages, never by a client; no foreign key, so it outlives the chat. Every cross-tenant reader of a message or a vote on it keys on this.';
--> statement-breakpoint
SELECT grid_secure_table('message_restricted_use', 'organization_id = grid_current_org()');
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "message_restricted_use" FROM grid_app_rw;
--> statement-breakpoint
-- A revision task's thread is read as drawing on its document's CURRENT folder
-- (`listRevisionSubjectFolders`): the lookup by conversation, for revisions only.
CREATE INDEX IF NOT EXISTS "idx_task_runs_revision_conversation"
  ON "task_runs" ("organization_id", "conversation_id") WHERE "kind" = 'revision';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_mark_message_restricted_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
  SELECT NEW."organization_id", NEW."id"::text, NEW."conversation_id"
  WHERE EXISTS (
    SELECT 1 FROM "conversation_restricted_folders" crf
    WHERE crf."organization_id" = NEW."organization_id"
      AND crf."conversation_id" = NEW."conversation_id"
  )
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION grid_mark_message_restricted_use() SET search_path = pg_catalog, public;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "messages_mark_restricted_use" ON "messages";
--> statement-breakpoint
CREATE TRIGGER "messages_mark_restricted_use"
  AFTER INSERT OR UPDATE OF "content" ON "messages"
  FOR EACH ROW EXECUTE FUNCTION grid_mark_message_restricted_use();
--> statement-breakpoint
INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
SELECT m."organization_id", m."id"::text, m."conversation_id"
FROM "messages" m
WHERE EXISTS (
  SELECT 1 FROM "conversation_restricted_folders" crf
  WHERE crf."organization_id" = m."organization_id"
    AND crf."conversation_id" = m."conversation_id"
)
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'answer_feedback' AND column_name = 'restricted_source'
  ) THEN
    INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
    SELECT f."organization_id", f."message_id", coalesce(f."conversation_id", '')
    FROM "answer_feedback" f
    WHERE f."restricted_source"
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "conversation_restricted_folders_mark_feedback" ON "conversation_restricted_folders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_feedback_keeps_restricted_source();
--> statement-breakpoint
ALTER TABLE "answer_feedback" DROP COLUMN IF EXISTS "restricted_source";
--> statement-breakpoint
WITH "marked" AS (
  SELECT r."id" AS "report_id", r."lesson_id", r."outcome"
  FROM "platform_lesson_reports" r
  JOIN "answer_feedback" f ON f."id" = r."feedback_id"
  JOIN "message_restricted_use" mr
    ON mr."organization_id" = f."organization_id"
   AND mr."message_id" = f."message_id"
),
"lessons" AS (
  SELECT l."id", l."status" <> 'retired' AS "was_live"
  FROM "platform_lessons" l
  WHERE l."id" IN (SELECT "lesson_id" FROM "marked" WHERE "outcome" = 'created')
    AND l."content" <> 'Zurückgezogen: aus einem Chat gelernt, der einen Ordner mit eingeschränktem Zugriff verwendet hat.'
),
"summaries" AS (
  UPDATE "platform_lesson_reports" r
  SET "canonical_summary" = NULL
  FROM "marked" x
  WHERE r."id" = x."report_id"
    AND r."canonical_summary" IS NOT NULL
  RETURNING r."id"
),
"withdrawn" AS (
  UPDATE "platform_lessons" l
  SET "status" = 'retired',
      "content" = 'Zurückgezogen: aus einem Chat gelernt, der einen Ordner mit eingeschränktem Zugriff verwendet hat.',
      "held_reason" = NULL,
      "retired_at" = CASE WHEN x."was_live" THEN now() ELSE l."retired_at" END,
      "retired_by" = CASE WHEN x."was_live" THEN 'system:migration-0122' ELSE l."retired_by" END,
      "retired_reason" = CASE WHEN x."was_live" THEN 'restricted_source' ELSE l."retired_reason" END,
      "updated_at" = now()
  FROM "lessons" x
  WHERE l."id" = x."id"
  RETURNING l."id"
)
INSERT INTO "platform_lesson_events" ("lesson_id", "action", "actor", "detail")
SELECT x."id", 'retired', 'system:migration-0122', '{"reason": "restricted_source", "automatic": true}'::jsonb
FROM "lessons" x
WHERE x."was_live";
--> statement-breakpoint
UPDATE "platform_lesson_events" e
SET "detail" = (e."detail" - 'previousContent') || '{"previousContentWithdrawn": true}'::jsonb
FROM "platform_lessons" l
WHERE l."id" = e."lesson_id"
  AND l."content" = 'Zurückgezogen: aus einem Chat gelernt, der einen Ordner mit eingeschränktem Zugriff verwendet hat.'
  AND e."detail" ? 'previousContent';
