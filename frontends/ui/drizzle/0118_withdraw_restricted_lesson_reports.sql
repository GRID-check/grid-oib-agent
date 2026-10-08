-- 0118: withdraw what the lessons pipeline already took from a conversation
-- that drew on a folder with restricted access (ADR-0084, ADR-0085).
--
-- Since `OUTSIDE_RESTRICTED_USE` (lib/feedback/repository.ts) the sweep never
-- reads a down-vote on a conversation with a `conversation_restricted_folders`
-- row. A sweep that ran before that rule may have read one, and left two kinds
-- of row the rule alone does not reach:
--
--   * a lesson distilled from such a report (its `created` report) stays
--     active and is injected into every organization's turns;
--   * the report's `canonical_summary`, the distiller's restatement of it,
--     stays on Piloti staff's provenance view (Platform -> Lessons).
--
-- So, once, in the state the rule would have left: every such report keeps
-- its row (the provenance counts and the UNIQUE(feedback_id) key the sweep
-- skips by) without its summary, and every lesson created from one is retired
-- with an event and its text replaced. A lesson created from another report
-- and only LINKED to such a one keeps its text: none of it came from there.
--
-- Matched like `OUTSIDE_RESTRICTED_USE`: any record counts, including one for
-- a folder opened since. A report whose vote was retracted (no
-- `answer_feedback` row) cannot be matched and is left as it is.
--
-- The text is not kept anywhere: the down migration cannot bring it back. An
-- `edited` event's `previousContent` stays: the event trail is append-only.
WITH "restricted" AS (
  SELECT r."id" AS "report_id", r."lesson_id", r."outcome"
  FROM "platform_lesson_reports" r
  JOIN "answer_feedback" f ON f."id" = r."feedback_id"
  WHERE EXISTS (
    SELECT 1 FROM "conversation_restricted_folders" crf
    WHERE crf."organization_id" = f."organization_id"
      AND crf."conversation_id" = f."conversation_id"
  )
),
"lessons" AS (
  SELECT l."id", l."status" <> 'retired' AS "was_live"
  FROM "platform_lessons" l
  WHERE l."id" IN (SELECT "lesson_id" FROM "restricted" WHERE "outcome" = 'created')
),
"summaries" AS (
  UPDATE "platform_lesson_reports" r
  SET "canonical_summary" = NULL
  FROM "restricted" x
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
      "retired_by" = CASE WHEN x."was_live" THEN 'system:migration-0118' ELSE l."retired_by" END,
      "retired_reason" = CASE WHEN x."was_live" THEN 'restricted_source' ELSE l."retired_reason" END,
      "updated_at" = now()
  FROM "lessons" x
  WHERE l."id" = x."id"
  RETURNING l."id"
)
INSERT INTO "platform_lesson_events" ("lesson_id", "action", "actor", "detail")
SELECT x."id", 'retired', 'system:migration-0118', '{"reason": "restricted_source", "automatic": true}'::jsonb
FROM "lessons" x
WHERE x."was_live";
