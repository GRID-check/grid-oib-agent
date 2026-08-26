DROP TABLE IF EXISTS "document_roles";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS documents_id_project_id_key;
ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS projects_id_organization_id_key;
