-- 0123: the server marks a message whose conversation drew on a folder with
-- restricted access, and the mark outlives the chat (ADR-0091, ADR-0086,
-- ADR-0087).
--
-- ## Why the mark moves from the conversation to the message
--
-- Until now every cross-tenant reader of answer feedback (the platform
-- drill-in, its CSV export, the digest's model, the lessons distiller) left a
-- vote out when `conversation_restricted_folders` held a row for the vote's
-- `conversation_id`, or when 0120's trigger had copied that fact onto the vote
-- as the record was deleted. Both matched the CLIENT's `conversation_id`: a
-- vote that named another chat, or none, passed with a comment quoting the
-- folder. The vote's `message_id` is its identity (the upsert key) and, for a
-- persisted answer, the `messages` row's own id.
--
-- So the fact is written by the database, keyed by (organization, message id),
-- in `message_restricted_use`. ONE question decides it,
-- `grid_conversation_restricted_use(organization, conversation)`: the
-- conversation holds a restricted-use record (kept for the conversation's
-- life, deleted with it), or it is the thread of a revision task whose
-- document sits where not every member may read (below), or it was marked
-- before (marks are sticky, below). The server writes marks:
--
--   * at admission, by the answer's id: the BFF marks the id of the answer the
--     turn is writing (`answer_message_id(conversation, turn)`, minted by the
--     agent, streamed to the browser, persisted under it) in the transaction
--     that records the folder, and at turn start when an earlier turn already
--     drew on one (`markAnswerRestrictedUse`). That is before the model reads
--     anything, and whether or not the answer is ever persisted;
--
--   * on `messages`: a row INSERTED, or its `content` rewritten, while its
--     conversation answers yes. The record is written when the BFF admits
--     restricted content into a turn (`admitRestrictedUse`), before the model
--     reads it; the answer is persisted after the turn, and a run's report is
--     written into its message after the run;
--   * on `conversation_restricted_folders`: the first admission marks every
--     message the conversation already holds, and the message id of every vote
--     that names it. A vote cast after the admission, on an answer from before
--     it, is typed by someone who has seen the restricted content, and so is
--     a later edit of an older vote;
--   * on `answer_feedback`: a vote written or rewritten while its message's
--     conversation, or the conversation it names, answers yes marks its message
--     id: an added reason to hide, never the only one for an answer the server
--     knew about;
--   * on `task_runs`, `documents` and `project_folders`: a revision thread
--     that starts answering yes has every message it holds, and every vote
--     naming it, marked then (below).
--
-- What a client sends can add a mark and never lift one: the message id and
-- conversation id of a vote are the client's, so they are read only as reasons
-- to hide. Every reader asks `grid_feedback_restricted_use` of the vote, the
-- same question again at read time, so a revision task's document moved into a
-- restricted folder hides its thread's votes at once, with nothing written.
--
-- Marks have no foreign key, so deleting the chat (which deletes its messages
-- and its record) leaves them. They hold ids and a time, no content. A mark's
-- `conversation_id` is the conversation that answered yes when it was written,
-- never a client's claim alone ('' when unknown, for 0120's column), and the
-- rule asks it: a conversation once marked keeps answering yes, so marks are
-- sticky for both kinds of conversation. An ordinary chat already was (any
-- record counts, a folder since opened included); a revision thread now is
-- too, after its document moves back, its folder opens or it is deleted. The
-- runtime role may insert and read marks in its own tenant and may neither
-- change nor delete one: no tenant-path bug can lift a mark.
--
-- 0120's column and trigger are folded into marks and dropped.
--
-- ## Revision tasks
--
-- A revision task, and the thread it writes into, are judged when read by the
-- folder its document is in now: the tenant's own views ask the precise rule
-- (`lib/tasks/subject-access.ts`, `listRecordedSourceFolders`). The staff views
-- cannot ask a person's clearance, so `grid_conversation_restricted_use` asks a
-- superset of it: the document sits in another project than the task, or in a
-- folder of a project that has any folder with its own access list or any
-- folder in the Papierkorb. That branch is asked at read time and forgets a
-- thread whose document moved back or that was deleted
-- (`task_runs.conversation_id` is set null), so the moment it starts answering
-- yes is marked: a trigger on `task_runs` (a task opened, or re-pointed, for a
-- thread), on `documents` (its folder or project changed) and on
-- `project_folders` (a folder given its own list, or binned) marks every
-- message the thread holds and every vote naming it, and the marks keep it
-- answering yes from then on. The tenant's own views still follow the folder
-- as it is now.
--
-- ## Backfill, and what it cannot recover
--
--   * every message of a conversation that answers yes is marked, the ones
--     written before its first admission included, as the trigger on the
--     record now does too;
--   * every vote that answers yes marks its message id, and every vote 0120
--     marked `restricted_source` does;
--   * a conversation deleted before 0120, and a restricted-use record deleted
--     before this migration whose votes 0120 did not reach, left nothing to
--     match: those votes stay unmarked.
--
-- ## Withdrawal
--
-- As 0119 did for reports matched by conversation, now by mark: a report whose
-- vote's message is marked loses its `canonical_summary`, and a lesson
-- CREATED from one is retired (if live, with an event) and its text replaced.
-- A lesson only linked to such a report keeps its text. Then every withdrawn
-- lesson, 0119's included, loses the vector embedded from its old text
-- (`embedding`, `embedding_model`, `embedded_at`) and its events lose
-- `previousContent`, the text an owner's edit kept of an earlier version. A
-- report whose vote was retracted cannot be matched, and the text withdrawn is
-- not kept anywhere: the down migration cannot bring it back.
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
  'A message id whose conversation drew on a folder with restricted access (ADR-0091). Written by triggers on messages, conversation_restricted_folders and answer_feedback, never by a client; no foreign key, so it outlives the chat. Every cross-tenant reader of a vote asks grid_feedback_restricted_use, which reads this.';
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
-- A text id as a uuid when it is one, else null: a vote's message id and a
-- plan's document id are text, and the cast must neither fail nor defeat the
-- primary key's index. Inlined by the planner.
CREATE OR REPLACE FUNCTION grid_uuid_or_null(value text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN value::uuid
  END
$$;
--> statement-breakpoint
-- THE question (ADR-0091): did this conversation draw on a folder with
-- restricted access. Asked by the triggers that write marks, by every
-- cross-tenant reader of a vote (`grid_feedback_restricted_use`) and by the
-- staff profiler. A revision task's thread is asked by its document's place
-- NOW, with a superset of `lib/authz/folder-access.ts`'s rule (see the header),
-- and once marked it answers yes for good.
CREATE OR REPLACE FUNCTION grid_conversation_restricted_use(p_organization_id text, p_conversation_id text)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p_conversation_id IS NOT NULL AND p_conversation_id <> '' AND (
    EXISTS (
      SELECT 1 FROM "conversation_restricted_folders" crf
      WHERE crf."organization_id" = p_organization_id
        AND crf."conversation_id" = p_conversation_id
    )
    -- Sticky: a conversation that answered yes once, and had a message or a
    -- vote then, keeps answering yes. Every mark names the conversation that
    -- answered yes when it was written (or none, ''), never a client's claim
    -- alone, so this cannot make an open chat read as restricted.
    OR EXISTS (
      SELECT 1 FROM "message_restricted_use" mr
      WHERE mr."organization_id" = p_organization_id
        AND mr."conversation_id" = p_conversation_id
    )
    OR EXISTS (
      SELECT 1
      FROM "task_runs" r
      JOIN "documents" d
        ON d."organization_id" = r."organization_id"
       AND d."id" = grid_uuid_or_null(r."plan"->'subject'->>'documentId')
      WHERE r."organization_id" = p_organization_id
        AND r."conversation_id" = p_conversation_id
        AND r."kind" = 'revision'
        AND (
          d."project_id" IS DISTINCT FROM r."project_id"
          OR (
            d."folder_id" IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM "project_folders" pf
              WHERE pf."organization_id" = d."organization_id"
                AND pf."project_id" = d."project_id"
                AND (pf."access_mode" = 'custom' OR pf."deleted_at" IS NOT NULL)
            )
          )
        )
    )
  )
$$;
--> statement-breakpoint
-- The same question of a vote: its message is marked, or the conversation its
-- message is in, or the conversation it names, drew on a restricted folder.
-- The vote's ids are the client's: they can only make the answer yes.
CREATE OR REPLACE FUNCTION grid_feedback_restricted_use(p_organization_id text, p_message_id text, p_conversation_id text)
RETURNS boolean LANGUAGE sql STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
      SELECT 1 FROM "message_restricted_use" mr
      WHERE mr."organization_id" = p_organization_id
        AND mr."message_id" = p_message_id
    )
    OR grid_conversation_restricted_use(p_organization_id, p_conversation_id)
    OR EXISTS (
      SELECT 1 FROM "messages" m
      WHERE m."organization_id" = p_organization_id
        AND m."id" = grid_uuid_or_null(p_message_id)
        AND grid_conversation_restricted_use(p_organization_id, m."conversation_id")
    )
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_mark_message_restricted_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF grid_conversation_restricted_use(NEW."organization_id", NEW."conversation_id") THEN
    INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
    VALUES (NEW."organization_id", NEW."id"::text, NEW."conversation_id")
    ON CONFLICT DO NOTHING;
  END IF;
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
-- Mark what a conversation that now answers yes already holds: its messages,
-- and the message id of every vote naming it. Called when it starts answering
-- yes: a first admission, or a revision thread whose task, document or
-- project's folders changed (below).
CREATE OR REPLACE FUNCTION grid_mark_conversation_messages(p_organization_id text, p_conversation_id text)
RETURNS void LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
  SELECT m."organization_id", m."id"::text, m."conversation_id"
  FROM "messages" m
  WHERE m."organization_id" = p_organization_id
    AND m."conversation_id" = p_conversation_id
  UNION
  SELECT f."organization_id", f."message_id", p_conversation_id
  FROM "answer_feedback" f
  WHERE f."organization_id" = p_organization_id
    AND f."conversation_id" = p_conversation_id
  ON CONFLICT DO NOTHING
$$;
--> statement-breakpoint
-- An admission marks what the conversation already holds.
CREATE OR REPLACE FUNCTION grid_mark_conversation_restricted_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM grid_mark_conversation_messages(NEW."organization_id", NEW."conversation_id");
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION grid_mark_conversation_restricted_use() SET search_path = pg_catalog, public;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "conversation_restricted_folders_mark_messages" ON "conversation_restricted_folders";
--> statement-breakpoint
CREATE TRIGGER "conversation_restricted_folders_mark_messages"
  AFTER INSERT ON "conversation_restricted_folders"
  FOR EACH ROW EXECUTE FUNCTION grid_mark_conversation_restricted_use();
--> statement-breakpoint
-- A vote marks its message id when it answers yes. The mark names the
-- conversation that answered yes, so a vote naming a restricted chat does not
-- make the voted message's own conversation read as restricted.
CREATE OR REPLACE FUNCTION grid_mark_feedback_restricted_use() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  voted_conversation text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM "message_restricted_use" mr
    WHERE mr."organization_id" = NEW."organization_id"
      AND mr."message_id" = NEW."message_id"
  ) THEN
    RETURN NULL;
  END IF;
  SELECT m."conversation_id" INTO voted_conversation
  FROM "messages" m
  WHERE m."organization_id" = NEW."organization_id"
    AND m."id" = grid_uuid_or_null(NEW."message_id");
  IF voted_conversation IS NOT NULL
     AND grid_conversation_restricted_use(NEW."organization_id", voted_conversation) THEN
    INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
    VALUES (NEW."organization_id", NEW."message_id", voted_conversation)
    ON CONFLICT DO NOTHING;
  ELSIF grid_conversation_restricted_use(NEW."organization_id", NEW."conversation_id") THEN
    INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
    VALUES (NEW."organization_id", NEW."message_id", NEW."conversation_id")
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION grid_mark_feedback_restricted_use() SET search_path = pg_catalog, public;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "answer_feedback_mark_restricted_use" ON "answer_feedback";
--> statement-breakpoint
CREATE TRIGGER "answer_feedback_mark_restricted_use"
  AFTER INSERT OR UPDATE ON "answer_feedback"
  FOR EACH ROW EXECUTE FUNCTION grid_mark_feedback_restricted_use();
--> statement-breakpoint
-- A revision thread starts answering yes when its task, its document or its
-- project's folders change, with nothing written into the thread. Marking it
-- THEN is what makes the answer outlive the change back and the thread's
-- deletion (the rule's revision branch is asked at read time and forgets a
-- deleted thread: `task_runs.conversation_id` is set null). Each trigger finds
-- the threads the change can touch and marks those the rule now answers yes for.
CREATE OR REPLACE FUNCTION grid_mark_revision_thread(p_organization_id text, p_conversation_id text)
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF grid_conversation_restricted_use(p_organization_id, p_conversation_id) THEN
    PERFORM grid_mark_conversation_messages(p_organization_id, p_conversation_id);
  END IF;
END
$$;
--> statement-breakpoint
-- The subject lookup the two triggers below make, by document.
CREATE INDEX IF NOT EXISTS "idx_task_runs_revision_subject"
  ON "task_runs" ("organization_id", grid_uuid_or_null("plan"->'subject'->>'documentId'))
  WHERE "kind" = 'revision';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_mark_revision_thread_of_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."kind" = 'revision' AND NEW."conversation_id" IS NOT NULL THEN
    PERFORM grid_mark_revision_thread(NEW."organization_id", NEW."conversation_id");
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION grid_mark_revision_thread_of_task() SET search_path = pg_catalog, public;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "task_runs_mark_revision_thread" ON "task_runs";
--> statement-breakpoint
CREATE TRIGGER "task_runs_mark_revision_thread"
  AFTER INSERT OR UPDATE OF "conversation_id", "plan", "kind", "project_id" ON "task_runs"
  FOR EACH ROW EXECUTE FUNCTION grid_mark_revision_thread_of_task();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_mark_revision_threads_of_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  thread text;
BEGIN
  FOR thread IN
    SELECT DISTINCT r."conversation_id"
    FROM "task_runs" r
    WHERE r."organization_id" = NEW."organization_id"
      AND r."kind" = 'revision'
      AND grid_uuid_or_null(r."plan"->'subject'->>'documentId') = NEW."id"
      AND r."conversation_id" IS NOT NULL
  LOOP
    PERFORM grid_mark_revision_thread(NEW."organization_id", thread);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION grid_mark_revision_threads_of_document() SET search_path = pg_catalog, public;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_mark_revision_threads" ON "documents";
--> statement-breakpoint
CREATE TRIGGER "documents_mark_revision_threads"
  AFTER UPDATE OF "folder_id", "project_id" ON "documents"
  FOR EACH ROW
  WHEN (OLD."folder_id" IS DISTINCT FROM NEW."folder_id" OR OLD."project_id" IS DISTINCT FROM NEW."project_id")
  EXECUTE FUNCTION grid_mark_revision_threads_of_document();
--> statement-breakpoint
-- A folder of a project gets its own access list, or goes to the Papierkorb:
-- every revision thread whose document sits in a folder of that project.
CREATE OR REPLACE FUNCTION grid_mark_revision_threads_of_folder() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  thread text;
BEGIN
  IF NEW."access_mode" IS DISTINCT FROM 'custom' AND NEW."deleted_at" IS NULL THEN
    RETURN NULL;
  END IF;
  FOR thread IN
    SELECT DISTINCT r."conversation_id"
    FROM "documents" d
    JOIN "task_runs" r
      ON r."organization_id" = d."organization_id"
     AND r."kind" = 'revision'
     AND grid_uuid_or_null(r."plan"->'subject'->>'documentId') = d."id"
    WHERE d."organization_id" = NEW."organization_id"
      AND d."project_id" = NEW."project_id"
      AND d."folder_id" IS NOT NULL
      AND r."conversation_id" IS NOT NULL
  LOOP
    PERFORM grid_mark_revision_thread(NEW."organization_id", thread);
  END LOOP;
  RETURN NULL;
END
$$;
--> statement-breakpoint
ALTER FUNCTION grid_mark_revision_threads_of_folder() SET search_path = pg_catalog, public;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folders_mark_revision_threads" ON "project_folders";
--> statement-breakpoint
CREATE TRIGGER "project_folders_mark_revision_threads"
  AFTER INSERT OR UPDATE OF "access_mode", "deleted_at", "project_id" ON "project_folders"
  FOR EACH ROW EXECUTE FUNCTION grid_mark_revision_threads_of_folder();
--> statement-breakpoint
INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
SELECT m."organization_id", m."id"::text, m."conversation_id"
FROM "messages" m
WHERE grid_conversation_restricted_use(m."organization_id", m."conversation_id")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'answer_feedback' AND column_name = 'restricted_source'
  ) THEN
    -- No conversation: the column says the message is to be hidden, not which
    -- conversation answered yes (after a down and a re-apply it names the
    -- vote's claim), and a mark's conversation is asked by the rule.
    INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
    SELECT f."organization_id", f."message_id", ''
    FROM "answer_feedback" f
    WHERE f."restricted_source"
    ON CONFLICT DO NOTHING;
  END IF;
END
$$;
--> statement-breakpoint
-- Every vote that answers yes now, by its message or by the conversation it
-- names, marks its message id (the trigger above, for the votes already cast).
INSERT INTO "message_restricted_use" ("organization_id", "message_id", "conversation_id")
SELECT f."organization_id", f."message_id",
  CASE
    WHEN grid_conversation_restricted_use(f."organization_id", m."conversation_id") THEN m."conversation_id"
    ELSE coalesce(f."conversation_id", '')
  END
FROM "answer_feedback" f
LEFT JOIN "messages" m
  ON m."organization_id" = f."organization_id"
 AND m."id" = grid_uuid_or_null(f."message_id")
WHERE grid_feedback_restricted_use(f."organization_id", f."message_id", f."conversation_id")
ON CONFLICT DO NOTHING;
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
      "retired_by" = CASE WHEN x."was_live" THEN 'system:migration-0123' ELSE l."retired_by" END,
      "retired_reason" = CASE WHEN x."was_live" THEN 'restricted_source' ELSE l."retired_reason" END,
      "updated_at" = now()
  FROM "lessons" x
  WHERE l."id" = x."id"
  RETURNING l."id"
)
INSERT INTO "platform_lesson_events" ("lesson_id", "action", "actor", "detail")
SELECT x."id", 'retired', 'system:migration-0123', '{"reason": "restricted_source", "automatic": true}'::jsonb
FROM "lessons" x
WHERE x."was_live";
--> statement-breakpoint
UPDATE "platform_lessons"
SET "embedding" = NULL, "embedding_model" = NULL, "embedded_at" = NULL
WHERE "content" = 'Zurückgezogen: aus einem Chat gelernt, der einen Ordner mit eingeschränktem Zugriff verwendet hat.'
  AND ("embedding" IS NOT NULL OR "embedding_model" IS NOT NULL OR "embedded_at" IS NOT NULL);
--> statement-breakpoint
UPDATE "platform_lesson_events" e
SET "detail" = (e."detail" - 'previousContent') || '{"previousContentWithdrawn": true}'::jsonb
FROM "platform_lessons" l
WHERE l."id" = e."lesson_id"
  AND l."content" = 'Zurückgezogen: aus einem Chat gelernt, der einen Ordner mit eingeschränktem Zugriff verwendet hat.'
  AND e."detail" ? 'previousContent';
