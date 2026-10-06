-- 0111: the download log (ADR-0081, plan 2026-10-06-folder-access-lifecycle,
-- decision 4): who took a document's bytes out, and who opened one in a folder
-- with its own access list.
--
-- Personal data about staff, kept for security and accountability and for
-- nothing else: no per-person statistics read it. At most 12 months, less when
-- the organization chose a shorter time (`organizations.settings
-- .downloadLogRetentionDays`, 30-365); the scheduler purges it daily
-- (`frontends/ui/scheduler/db.js`, `pruneDownloadLog`).
--
-- ## No foreign keys
--
-- The log has to outlive the document, version, folder and project it names:
-- "who downloaded the contract that was deleted last week" is the question it
-- exists to answer. A row therefore carries its own context: the document's name
-- at the time, the shelf, whether the folder (or an ancestor) had its own list.
--
-- ## What the database refuses
--
-- * An OPEN (any kind but `download`) of a document that is not under a folder
--   with its own list: the product logs downloads everywhere and opens only
--   there, and a path that logs more is a bug, not a feature.
-- * A project column and a shelf that disagree, a folder without a project.
-- * Any UPDATE, by anyone; any DELETE by anyone but the platform role (the
--   retention sweep). A tenant-facing bug cannot rewrite who downloaded what.
CREATE TABLE IF NOT EXISTS "document_access_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "scope" text NOT NULL,
  "project_id" uuid,
  "document_id" uuid NOT NULL,
  "document_name" text NOT NULL,
  "version_id" uuid,
  "folder_id" uuid,
  "own_list" boolean DEFAULT false NOT NULL,
  CONSTRAINT "document_access_log_kind_check" CHECK ("kind" IN ('download', 'preview', 'pdf', 'text', 'version', 'model')),
  CONSTRAINT "document_access_log_scope_check" CHECK ("scope" IN ('project', 'archiv', 'session')),
  CONSTRAINT "document_access_log_scope_project" CHECK (("scope" = 'project') = ("project_id" IS NOT NULL)),
  CONSTRAINT "document_access_log_folder_needs_project" CHECK ("folder_id" IS NULL OR "project_id" IS NOT NULL),
  CONSTRAINT "document_access_log_open_needs_own_list" CHECK ("kind" = 'download' OR "own_list"),
  CONSTRAINT "document_access_log_name_length" CHECK (char_length("document_name") BETWEEN 1 AND 500)
);
--> statement-breakpoint
COMMENT ON TABLE "document_access_log" IS
  'The download log (0111): one row per hand-over of a document''s bytes, written in the request that hands them over. Downloads everywhere, opens only under a folder with its own access list. Personal data about staff: security and accountability only, 12 months at most. No foreign keys: the row outlives what it names. Immutable; only the platform role deletes (the retention sweep).';
--> statement-breakpoint
COMMENT ON COLUMN "document_access_log"."user_id" IS
  'The WorkOS user id of the person the bytes went to. Names and emails are resolved from WorkOS when the admin page is read, never copied here.';
--> statement-breakpoint
COMMENT ON COLUMN "document_access_log"."own_list" IS
  'Whether the folder, or an ancestor, had its own access list when the bytes were taken. Always true for an open.';
--> statement-breakpoint
-- Keyset pagination of the admin view is (occurred_at DESC, id DESC) within one
-- organization, alone, by person, and by document.
CREATE INDEX IF NOT EXISTS "document_access_log_org_time_idx"
  ON "document_access_log" ("organization_id", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_access_log_org_user_idx"
  ON "document_access_log" ("organization_id", "user_id", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_access_log_org_document_idx"
  ON "document_access_log" ("organization_id", "document_id", "occurred_at" DESC, "id" DESC);
--> statement-breakpoint
-- The retention sweep's cap: everything older than the longest retention goes,
-- whatever the organization says, found without a scan.
CREATE INDEX IF NOT EXISTS "document_access_log_occurred_idx"
  ON "document_access_log" ("occurred_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_document_access_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'document_access_log rows are never changed'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_access_log_immutable';
  END IF;
  -- `current_user` is the role after SET LOCAL ROLE: the retention sweep steps up
  -- to the platform role (ADR-0041), a tenant session never does.
  IF current_user <> 'grid_app_platform' THEN
    RAISE EXCEPTION 'document_access_log rows are deleted only by the retention sweep'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_access_log_immutable';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "document_access_log_guard" ON "document_access_log";
--> statement-breakpoint
CREATE TRIGGER "document_access_log_guard"
  BEFORE UPDATE OR DELETE ON "document_access_log"
  FOR EACH ROW EXECUTE FUNCTION grid_document_access_log_guard();
--> statement-breakpoint
SELECT grid_secure_table('document_access_log', 'organization_id = grid_current_org()');
