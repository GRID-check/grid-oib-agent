-- Reverse 0110. ORDER: roll the frontend back first, and give every folder with
-- its own access list back to its parent's access in the product before running
-- this — the older build knows no folder access, and documents still filed in
-- such a folder's collection (`proj_…_r…`) would no longer be in anybody's
-- scope. Inheriting again re-ingests them into the project's collection.
--
-- Lossy: deleted folders' tombstones are removed with their grants; what was
-- derived from them then names a folder that does not exist, which the older
-- build never reads.
DROP TRIGGER IF EXISTS "project_folders_access_list" ON "project_folders";
DROP TRIGGER IF EXISTS "project_folder_grants_access_list" ON "project_folder_grants";
DROP FUNCTION IF EXISTS grid_folder_access_list_on_folder();
DROP FUNCTION IF EXISTS grid_folder_access_list_on_grant();
DROP FUNCTION IF EXISTS grid_folder_access_list_check(uuid);
DELETE FROM "project_folders" WHERE "deleted_at" IS NOT NULL;
DROP TABLE IF EXISTS "project_folder_grants";
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_access_custom_check";
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_access_mode_check";
DROP INDEX IF EXISTS "project_folders_custom_access_idx";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "access_mode";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "access_changed_by";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "access_changed_at";
DROP INDEX IF EXISTS "uniq_project_folders_parent_name";
CREATE UNIQUE INDEX "uniq_project_folders_parent_name"
  ON "project_folders" (
    "organization_id",
    (coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    "name"
  );
COMMENT ON INDEX "uniq_project_folders_parent_name" IS
  'One folder per (organization, project, parent, name) - project is NULL for an Archiv folder. COALESCE to the nil UUID over project_id and parent_id because NULL never equals NULL in a unique index, which would leave root folders and every Archiv folder uncontrolled. It exists so get-or-create is safe under two runs finishing at once, not to police folder naming: it is case- and whitespace-sensitive on purpose.';
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "deleted_at";
