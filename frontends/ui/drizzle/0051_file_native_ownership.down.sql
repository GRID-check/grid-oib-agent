DROP TABLE IF EXISTS "resource_assignments";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "subject_resource_id";
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "subject_resource_type";
ALTER TABLE "documents" DROP COLUMN IF EXISTS "visibility";
