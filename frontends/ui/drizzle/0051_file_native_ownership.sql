-- File-native work objects: document visibility, conversation subject,
-- and polymorphic assignment (ADR-0047).
--
-- `documents.visibility` default `project` — a file is evidence the whole
-- project can see. Existing rows get that default; no backfill scan needed
-- beyond ADD COLUMN DEFAULT.
--
-- `resource_assignments` is empty-valid: upload writes no row.

ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'project' NOT NULL;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "subject_resource_type" text;
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "subject_resource_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_subject_idx"
  ON "conversations" ("subject_resource_type", "subject_resource_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "resource_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "subject_user_id" text NOT NULL,
  "assigned_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_resource_assignments_resource_subject"
  ON "resource_assignments" ("resource_type", "resource_id", "subject_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resource_assignments_resource"
  ON "resource_assignments" ("resource_type", "resource_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_resource_assignments_org_subject"
  ON "resource_assignments" ("organization_id", "subject_user_id", "resource_type");
--> statement-breakpoint
SELECT grid_secure_table('resource_assignments', 'organization_id = grid_current_org()');
