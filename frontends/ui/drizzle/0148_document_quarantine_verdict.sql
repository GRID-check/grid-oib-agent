-- 0148: a held document's reason is a typed verdict, stored as data (ADR-0113).
--
-- ## Why
--
-- The content gate (ADR-0086) said why it held a file only inside a string:
-- the ingest job wrote `error_message = 'quarantined:' || json`, the reconcile
-- stored that string, and every reader that showed a reason parsed it back
-- (the review queue, the release audit, the upload summary, the Files preview,
-- the tray). Two adapters stringified a parsed verdict again only to hand it
-- to the parser. A reason is data the screen produced; it is stored as data.
--
-- ## What
--
-- `documents.quarantine`: the job's verdict (`QuarantineVerdict` in
-- `aiq_agent/knowledge/schema.py`, `verdictSchema` in
-- `lib/upload-screening/quarantine.ts`), written with `status = 'quarantined'`
-- by `setDocumentReconciledStatus` and cleared by `markScreeningReleased`.
-- The database guarantees an object with a `reasons` array, and that only a
-- quarantined row carries one; what is inside is the application's.
--
-- `document_quarantine_decisions.reasons_omitted`: how many reasons the job
-- found and left out of its verdict (more than ten, or too long to store
-- whole). The decision recorded only the listed reasons, so the audit trail
-- could read a short list as the whole one.
--
-- ## The backfill
--
-- Every quarantined row whose `error_message` is a `quarantined:` verdict gets
-- it as the column, row by row: a message that is not JSON, or JSON of the
-- wrong shape, leaves that row NULL and the migration goes on. Readers fall
-- back to the message for exactly those rows (`quarantineVerdictOf`).
-- `error_message` is left as it is: a build from before this migration still
-- reads the reason there.
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "quarantine" jsonb;
--> statement-breakpoint
DO $$
DECLARE
  held record;
  verdict jsonb;
BEGIN
  FOR held IN
    SELECT "id", "error_message" FROM "documents"
     WHERE "status" = 'quarantined'
       AND "quarantine" IS NULL
       AND "error_message" LIKE 'quarantined:%'
  LOOP
    BEGIN
      verdict := substr(held."error_message", length('quarantined:') + 1)::jsonb;
      IF jsonb_typeof(verdict) = 'object' AND jsonb_typeof(verdict->'reasons') IS NOT DISTINCT FROM 'array' THEN
        UPDATE "documents" SET "quarantine" = verdict WHERE "id" = held."id";
      END IF;
    EXCEPTION WHEN others THEN
      -- Not JSON: this row keeps its message, and its readers read that.
      NULL;
    END;
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_quarantine_shape_check";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_quarantine_shape_check" CHECK (
    -- IS NOT DISTINCT FROM, never `=`: a missing `reasons` is NULL, and a
    -- CHECK whose expression is NULL passes.
    "quarantine" IS NULL
    OR (jsonb_typeof("quarantine") = 'object' AND jsonb_typeof("quarantine"->'reasons') IS NOT DISTINCT FROM 'array')
  );
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_quarantine_held_check";
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_quarantine_held_check" CHECK ("quarantine" IS NULL OR "status" = 'quarantined');
--> statement-breakpoint
COMMENT ON COLUMN "documents"."quarantine" IS
  'Why the content gate held the document back (ADR-0086, ADR-0113): the ingest job''s typed verdict {reasons, checked, omitted}, set with status = quarantined and cleared by the release. NULL on every other row. Read through quarantineVerdictOf; error_message keeps the legacy quarantined: text for one release.';
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions"
  ADD COLUMN IF NOT EXISTS "reasons_omitted" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions" DROP CONSTRAINT IF EXISTS "document_quarantine_decisions_reasons_omitted_check";
--> statement-breakpoint
ALTER TABLE "document_quarantine_decisions"
  ADD CONSTRAINT "document_quarantine_decisions_reasons_omitted_check" CHECK ("reasons_omitted" >= 0);
--> statement-breakpoint
COMMENT ON COLUMN "document_quarantine_decisions"."reasons_omitted" IS
  'How many reasons the job found and left out of its verdict (0148): the trail reads reasons as a partial list when this is not zero.';
