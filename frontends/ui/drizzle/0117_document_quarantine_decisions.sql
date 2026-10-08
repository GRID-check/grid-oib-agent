-- 0117: the content gate's quarantine decisions, kept until the audit trail
-- has them (ADR-0083; AI Act transparency).
--
-- `document.quarantined` was emitted once, from the read whose guarded status
-- write moved the row. An emit that failed (WorkOS down, the process gone
-- between the write and the emit) was lost: nothing came back for it, and the
-- trail could say who released a file without ever saying the system held it.
--
-- One row per decision, inserted in the same transaction as the status write
-- that records it, so a decision cannot exist without its row. The emitter
-- sends it to the trail and sets `audited_at`; the upload sweep sends whatever
-- is still unaudited after a minute. At least once, and once per decision:
-- the WorkOS idempotency key is the row's id, and the event is built from this
-- row alone (its time is `decided_at`), so a repeated emit is the same event.
--
-- ## Keyed on the dispatch
--
-- A decision is one ingest job's verdict on one document: UNIQUE
-- (`document_id`, `job_id`). Two reads that resolve the same job record one
-- decision; a release re-dispatches under a new job, so a later quarantine of
-- the same document is a second decision. `job_id` is NULL only when the row
-- carried no job and the backend's file list said quarantined; the guarded
-- status write alone keeps that to one.
--
-- ## No foreign keys
--
-- A reviewer may delete a quarantined document at once. The decision must
-- still reach the trail, so the row carries what the event says: the name at
-- the time, the shelf and the folder it was filed in, the uploader, and the
-- reasons as kinds and terms (never a matched sample or text). The folder is
-- what the trail asks before it names the file: a name filed under a folder
-- not every project member may read is withheld (ADR-0084).
--
-- ## What the database refuses
--
-- * A second decision for one dispatch.
-- * Any change but `audited_at` going from NULL to a time, by anyone; any
--   DELETE by anyone but the platform role. A decision is not rewritten.
CREATE TABLE IF NOT EXISTS "document_quarantine_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "job_id" text,
  "decided_at" timestamp with time zone DEFAULT now() NOT NULL,
  "scope" text NOT NULL,
  "project_id" uuid,
  "folder_id" uuid,
  "filename" text NOT NULL,
  "reasons" text DEFAULT '' NOT NULL,
  "checked" text DEFAULT '' NOT NULL,
  "uploaded_by" text NOT NULL,
  "audited_at" timestamp with time zone,
  CONSTRAINT "document_quarantine_decisions_dispatch_key" UNIQUE ("document_id", "job_id"),
  CONSTRAINT "document_quarantine_decisions_scope_check" CHECK ("scope" IN ('project', 'archiv', 'session')),
  CONSTRAINT "document_quarantine_decisions_scope_project" CHECK (("scope" = 'project') = ("project_id" IS NOT NULL)),
  CONSTRAINT "document_quarantine_decisions_filename_length" CHECK (char_length("filename") BETWEEN 1 AND 500)
);
--> statement-breakpoint
COMMENT ON TABLE "document_quarantine_decisions" IS
  'The content gate''s quarantine decisions (0117, ADR-0083): one row per ingest job that quarantined a document, written with the status, sent to the audit trail as document.quarantined until audited_at is set. No foreign keys: the row outlives the document. Only audited_at changes; only the platform role deletes.';
--> statement-breakpoint
-- The sweep's discovery: what is still owed to the trail, found without a scan.
CREATE INDEX IF NOT EXISTS "document_quarantine_decisions_due_idx"
  ON "document_quarantine_decisions" ("decided_at")
  WHERE "audited_at" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_document_quarantine_decisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.audited_at IS NOT NULL
      OR NEW.audited_at IS NULL
      OR (to_jsonb(NEW) - 'audited_at') IS DISTINCT FROM (to_jsonb(OLD) - 'audited_at') THEN
      RAISE EXCEPTION 'a quarantine decision is never changed, only marked audited once'
        USING ERRCODE = 'check_violation', CONSTRAINT = 'document_quarantine_decisions_immutable';
    END IF;
    RETURN NEW;
  END IF;
  -- `current_user` is the role after SET LOCAL ROLE: only the platform role
  -- (ADR-0041) deletes, a tenant session never does.
  IF current_user <> 'grid_app_platform' THEN
    RAISE EXCEPTION 'quarantine decisions are deleted only by the platform role'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_quarantine_decisions_immutable';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "document_quarantine_decisions_guard" ON "document_quarantine_decisions";
--> statement-breakpoint
CREATE TRIGGER "document_quarantine_decisions_guard"
  BEFORE UPDATE OR DELETE ON "document_quarantine_decisions"
  FOR EACH ROW EXECUTE FUNCTION grid_document_quarantine_decisions_guard();
--> statement-breakpoint
SELECT grid_secure_table('document_quarantine_decisions', 'organization_id = grid_current_org()');
