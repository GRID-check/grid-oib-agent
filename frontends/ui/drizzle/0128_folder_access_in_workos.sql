-- 0128: who holds a folder's own access list moves to WorkOS (ADR-0096).
--
-- A folder with its own list (`access_mode = 'custom'`) is now a WorkOS
-- `folder` resource, and the people on the list hold a folder role on it
-- (`folder-reader`, `folder-editor`). The one part of a list that names no
-- person stays here: whether everyone in the project reads the folder
-- (`everyone_reads`), which was the reserved `*` entry.
--
-- Carried over from `project_folder_grants`:
--   * a `*` entry that writes: everyone reads and writes, which is what a
--     folder that inherits already gives. The folder goes back to `inherit`;
--   * a `*` entry that reads: `everyone_reads`.
-- The role entries cannot be carried over in SQL, because they become folder
-- roles of the people who hold those roles, which only WorkOS knows. That is
-- `scripts/migrate-folder-grants-to-workos.ts`, which reads this table. Until
-- it has run, a custom folder is readable only by organization admins and, when
-- `everyone_reads`, by every project member: the narrow direction. The table
-- is dropped by a later migration, once the script has run everywhere.
--
-- The deferred trigger that held a custom list to 1–20 grant rows goes: the
-- people are no longer rows here, so it would refuse every new custom folder.
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "everyone_reads" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE "project_folders" AS f
  SET "access_mode" = 'inherit', "everyone_reads" = false
  WHERE f."access_mode" = 'custom'
    AND EXISTS (
      SELECT 1 FROM "project_folder_grants" AS g
      WHERE g."folder_id" = f."id" AND g."role_slug" = '*' AND g."level" = 'write'
    );
--> statement-breakpoint
UPDATE "project_folders" AS f
  SET "everyone_reads" = true
  WHERE f."access_mode" = 'custom'
    AND EXISTS (
      SELECT 1 FROM "project_folder_grants" AS g
      WHERE g."folder_id" = f."id" AND g."role_slug" = '*' AND g."level" = 'read'
    );
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folders_access_list" ON "project_folders";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folder_grants_access_list" ON "project_folder_grants";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_folder_access_list_on_folder();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_folder_access_list_on_grant();
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_folder_access_list_check(uuid);
