-- Reverse 0102: folders belong to projects again; the Archiv is flat.
--
-- ## What is lost, and why the guard
--
-- An Archiv folder cannot exist in the old schema (`project_id` NOT NULL), and
-- neither can a document filed in one. Removing the folders by cascade would
-- also remove nothing but labels - but the documents' `folder_id` would be
-- cascaded AWAY with them, and the Python backend still carries the folder path
-- on those documents' metadata, so a silent rollback leaves the agent describing
-- a tree the database no longer has. So the guard refuses while any Archiv folder
-- exists. Delete them through the application, which re-files their documents
-- into the parent and mirrors the path rewrite to the backend first.
--
-- Nothing else is lost: every project folder keeps its row, its path and its
-- documents. `organization_id` and `scope` are derivable (the project's tenant,
-- 'project') and go with the columns.
--
-- The RLS policy is put back on the `projects` join BEFORE the column is dropped:
-- a policy that references a column blocks DROP COLUMN.

DO $$
DECLARE
  archiv_folders bigint;
BEGIN
  -- Re-running after a completed reverse is a no-op rather than an error about a
  -- missing column.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'project_folders' AND column_name = 'scope'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO archiv_folders FROM "project_folders" WHERE "scope" = 'archiv';

  IF archiv_folders > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse migration 0102: % Archiv folder(s) exist. The old schema has no place for a folder without a project. Delete them through the application first, so the documents filed in them move to the parent and the backend metadata follows.',
      archiv_folders;
  END IF;
END $$;

--> statement-breakpoint
SELECT grid_secure_table('project_folders',
  'EXISTS (SELECT 1 FROM projects p WHERE p.id = project_id AND p.organization_id = grid_current_org())');

--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_folder_id_organization_id_scope_fkey";

--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_folder_requires_project";

--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_folder_requires_project"
  CHECK ("folder_id" IS NULL OR "project_id" IS NOT NULL);

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_project_folders_parent_name";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_project_folders_parent_name"
  ON "project_folders" (
    "project_id",
    (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    "name"
  );

--> statement-breakpoint
COMMENT ON INDEX "uniq_project_folders_parent_name" IS
  'One folder per (project, parent, name). COALESCE over parent_id because a root folder has none and NULL never equals NULL in a unique index, which would leave root folders — the case the fixed Berichte destination is about — uncontrolled. It exists so get-or-create is safe under two runs finishing at once, not to police folder naming: it is case- and whitespace-sensitive on purpose.';

--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_parent_id_organization_id_scope_fkey";

--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_id_organization_id_scope_key";

--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_scope_owner_check";

--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_scope_check";

--> statement-breakpoint
ALTER TABLE "project_folders" ALTER COLUMN "project_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "scope";

--> statement-breakpoint
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "organization_id";
