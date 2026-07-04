CREATE TABLE IF NOT EXISTS "project_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scope" text DEFAULT 'project' NOT NULL,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "kind" text NOT NULL,
  "content" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "confidence" text DEFAULT 'medium' NOT NULL,
  "verification" text DEFAULT 'unverified' NOT NULL,
  "provenance_type" text DEFAULT 'agent' NOT NULL,
  "source_conversation_id" text,
  "supersedes_id" uuid,
  "salience" real DEFAULT 0.5 NOT NULL,
  "pinned" boolean DEFAULT false NOT NULL,
  "created_by" text,
  "last_referenced_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_memory_scope_project" CHECK (
    ("scope" = 'project' AND "project_id" IS NOT NULL) OR ("scope" = 'organization' AND "project_id" IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_memory_project_id" ON "project_memory"("project_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_memory_project_status" ON "project_memory"("project_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_memory_org_scope" ON "project_memory"("organization_id","scope","status");
