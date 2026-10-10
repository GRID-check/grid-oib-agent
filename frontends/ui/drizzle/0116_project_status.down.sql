-- Reverse 0115: no project status.
--
-- Lossy in the open direction, so it refuses while any project is closed: an
-- older build has no read-only check and would let every member's write into
-- it, while its list would hide the project again from everyone who reads it
-- only because it is closed. Reopen every closed project first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE status = 'closed') THEN
    RAISE EXCEPTION 'closed projects exist: reopen every closed project before reversing 0115';
  END IF;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_memory_closed_project_guard" ON "project_memory";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "document_versions_closed_project_guard" ON "document_versions";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folders_closed_project_guard" ON "project_folders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_closed_project_guard" ON "documents";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_refuse_insert_into_closed_project();
--> statement-breakpoint
DROP INDEX IF EXISTS "projects_org_status_idx";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_closed_state_check";
--> statement-breakpoint
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "projects_status_check";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "closed_by";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "closed_at";
--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN IF EXISTS "status";
