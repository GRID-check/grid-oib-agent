-- 0114: a project is active or closed (ADR-0082, ticket „Abgeschlossene Projekte").
--
-- ## The status
--
-- `status` is `active` (every project until now) or `closed`. A closed project
-- carries when and by whom: `closed_at` and `closed_by` are set exactly when the
-- status is `closed`, so a reopen clears them and the audit log keeps the
-- history. Closing never deletes or purges anything; deletion stays the soft
-- delete with its grace period.
--
-- ## Nothing new lands in a closed project
--
-- A closed project is read-only for its files, folders, versions and project
-- memory. The application refuses every write at one seam
-- (`requireProjectAccess`, `lib/authz/projects.ts`), and the agent's
-- service-token paths ask the same status. The trigger below is the backstop for
-- a path that forgets: an INSERT of a document, a folder, a document version or
-- a project memory item into a closed project is refused with SQLSTATE `GPC01`.
-- Updates are not refused: ingestion finishing for a file uploaded before the
-- close, the Papierkorb's own sweeps and a legal hold still have to write.
--
-- The trigger reads the project row FOR SHARE, so a close (an UPDATE of that
-- row) and an insert into the project serialize: the insert either commits
-- before the close or waits for it and is refused.

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "status" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "closed_by" text;
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_status_check";
--> statement-breakpoint
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_status_check" CHECK ("status" IN ('active', 'closed'));
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_closed_state_check";
--> statement-breakpoint
-- Closed exactly when it says when and by whom.
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_closed_state_check" CHECK (
    ("status" = 'closed') = ("closed_at" IS NOT NULL)
    AND ("status" = 'closed') = ("closed_by" IS NOT NULL)
  );
--> statement-breakpoint
COMMENT ON COLUMN "projects"."status" IS
  'active or closed (ADR-0082). A closed project is read-only for files, folders, versions, the profile and project memory, and every organization member may read it.';
--> statement-breakpoint
COMMENT ON COLUMN "projects"."closed_at" IS 'When the project was closed. Set exactly when status = closed.';
--> statement-breakpoint
COMMENT ON COLUMN "projects"."closed_by" IS 'The WorkOS user id of whoever closed the project. Set exactly when status = closed.';
--> statement-breakpoint
-- The projects list filters on the status, and a search over closed projects
-- reads only those.
CREATE INDEX IF NOT EXISTS "projects_org_status_idx"
  ON "projects" USING btree ("organization_id", "status") WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_refuse_insert_into_closed_project() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  project_status text;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;  -- an Archiv document or folder, or organization memory
  END IF;
  SELECT p.status INTO project_status FROM projects p WHERE p.id = NEW.project_id FOR SHARE;
  IF project_status = 'closed' THEN
    RAISE EXCEPTION 'project % is closed; nothing may be added to it', NEW.project_id
      USING ERRCODE = 'GPC01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_closed_project_guard" ON "documents";
--> statement-breakpoint
CREATE TRIGGER "documents_closed_project_guard"
  BEFORE INSERT ON "documents"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_insert_into_closed_project();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folders_closed_project_guard" ON "project_folders";
--> statement-breakpoint
CREATE TRIGGER "project_folders_closed_project_guard"
  BEFORE INSERT ON "project_folders"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_insert_into_closed_project();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "document_versions_closed_project_guard" ON "document_versions";
--> statement-breakpoint
CREATE TRIGGER "document_versions_closed_project_guard"
  BEFORE INSERT ON "document_versions"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_insert_into_closed_project();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_memory_closed_project_guard" ON "project_memory";
--> statement-breakpoint
CREATE TRIGGER "project_memory_closed_project_guard"
  BEFORE INSERT ON "project_memory"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_insert_into_closed_project();
