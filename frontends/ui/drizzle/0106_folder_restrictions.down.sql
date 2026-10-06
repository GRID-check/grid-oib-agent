-- Reverse 0106. ORDER: roll the frontend back first, and OPEN every restricted
-- folder in the product before running this — the older build knows no
-- restrictions, and documents still filed in a restricted folder's collection
-- (`proj_…_r…`) would no longer be in anybody's scope. Opening re-ingests them
-- into the project's collection.
DROP INDEX IF EXISTS "project_folders_restricted_idx";
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_restricted_roles_check";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "restricted_at";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "restricted_by";
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "restricted_roles";
