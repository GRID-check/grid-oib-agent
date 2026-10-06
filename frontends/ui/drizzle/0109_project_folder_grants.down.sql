-- Reverse 0109. ORDER: roll the frontend back first; the newer build reads and
-- writes `project_folder_grants`, `access_mode` and the tombstones.
--
-- Lossy, and in the safe direction for READING:
--   * every role a custom list names, at either level, becomes a role in
--     `restricted_roles`: the older build knows no read-only, so whoever may
--     read may write again, as far as their project permission allows. The
--     distinction between read and write is LOST on down.
--   * a list that grants `*` (every project member) at any level becomes open
--     (NULL): everyone could read it, which is what open means to the older
--     build.
--   * deleted folders' tombstones are removed; what was derived from them then
--     names a folder that does not exist, which the older build never reads.
DROP TRIGGER IF EXISTS "project_folders_access_list" ON "project_folders";
DROP TRIGGER IF EXISTS "project_folder_grants_access_list" ON "project_folder_grants";
DROP FUNCTION IF EXISTS grid_folder_access_list_on_folder();
DROP FUNCTION IF EXISTS grid_folder_access_list_on_grant();
DROP FUNCTION IF EXISTS grid_folder_access_list_check(uuid);
DELETE FROM "project_folders" WHERE "deleted_at" IS NOT NULL;
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "restricted_roles" text[];
UPDATE "project_folders" f
SET "restricted_roles" = g.roles
FROM (
  SELECT "folder_id", array_agg("role_slug" ORDER BY "role_slug") AS roles, bool_or("role_slug" = '*') AS everyone
  FROM "project_folder_grants"
  GROUP BY "folder_id"
) g
WHERE g."folder_id" = f."id" AND f."access_mode" = 'custom' AND NOT g.everyone;
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_access_custom_check";
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_access_mode_check";
DROP INDEX IF EXISTS "project_folders_custom_access_idx";
ALTER TABLE "project_folders" RENAME COLUMN "access_changed_by" TO "restricted_by";
ALTER TABLE "project_folders" RENAME COLUMN "access_changed_at" TO "restricted_at";
UPDATE "project_folders" SET "restricted_by" = NULL, "restricted_at" = NULL WHERE "restricted_roles" IS NULL;
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_restricted_roles_check" CHECK (
    "restricted_roles" IS NULL
    OR (cardinality("restricted_roles") BETWEEN 1 AND 20 AND "restricted_by" IS NOT NULL AND "restricted_at" IS NOT NULL)
  );
CREATE INDEX IF NOT EXISTS "project_folders_restricted_idx"
  ON "project_folders" USING btree ("project_id") WHERE "restricted_roles" IS NOT NULL;
DROP TABLE IF EXISTS "project_folder_grants";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "access_mode";
DROP INDEX IF EXISTS "uniq_project_folders_parent_name";
CREATE UNIQUE INDEX "uniq_project_folders_parent_name"
  ON "project_folders" (
    "organization_id",
    (coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid)),
    "name"
  );
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "deleted_by";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "deleted_at";
