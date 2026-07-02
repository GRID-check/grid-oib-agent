CREATE TABLE IF NOT EXISTS "project_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "parent_id" uuid REFERENCES "project_folders"("id"),
  "name" varchar(255) NOT NULL,
  "path" varchar(1024) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_folders_project_id" ON "project_folders"("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_folders_parent_id" ON "project_folders"("parent_id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'folder_id'
  ) THEN
    ALTER TABLE "documents" ADD COLUMN "folder_id" uuid REFERENCES "project_folders"("id");
    CREATE INDEX IF NOT EXISTS "idx_documents_folder_id" ON "documents"("folder_id");
  END IF;
END $$;
