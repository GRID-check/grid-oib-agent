DROP TABLE IF EXISTS "document_roles";
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS documents_id_project_id_key;
