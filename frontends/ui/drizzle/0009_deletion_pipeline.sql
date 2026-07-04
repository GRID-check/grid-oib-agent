CREATE TABLE "deletion_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"display_name" text NOT NULL,
	"organization_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_after" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"payload" jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_queue_active_entity_idx" ON "deletion_queue" ("entity_type", "entity_id") WHERE "status" IN ('pending', 'purging');
--> statement-breakpoint
CREATE INDEX "deletion_queue_claim_idx" ON "deletion_queue" ("status", "purge_after");
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "legal_holds" ("entity_type", "entity_id") WHERE "released_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "deleted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DO $$
DECLARE
  fk_name text;
BEGIN
  -- The folder_id FK was created inline via ADD COLUMN ... REFERENCES (migration 0005/0007),
  -- so its name is the Postgres default (documents_folder_id_fkey). Drop whatever FK exists
  -- on documents(folder_id) rather than assuming a name.
  SELECT con.conname INTO fk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
  WHERE con.contype = 'f'
    AND rel.relname = 'documents'
    AND att.attname = 'folder_id';
  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE "documents" DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_project_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."project_folders"("id") ON DELETE cascade ON UPDATE no action;
