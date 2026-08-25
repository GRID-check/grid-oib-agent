-- Document roles: which file plays which part in a project's intake.
--
-- The wizard's `B2_upl` ("Bebauungsplan ablegen") and every Modul I category
-- need one thing the repo could not express: a declared, scoped binding between
-- a document and a slot in the project model. Tags are LLM-guessed content
-- labels, `doc_class` is the base-corpus norm hierarchy, and a folder is a
-- renameable string — none can answer "which file is THE Bebauungsplan here",
-- which every downstream feature (extraction, the B3 review, the completeness
-- checklist, the agent's project context) is built on top of.
--
-- Empty-valid: no project has a row until somebody declares one.

-- The composite foreign key below needs a unique key to point at. `id` is
-- already the primary key, so uniqueness is implied and this constraint adds no
-- new restriction — it exists so `(document_id, project_id)` is referenceable,
-- exactly as `project_folders_id_project_id_key` does for folders (0031).
ALTER TABLE "documents"
  DROP CONSTRAINT IF EXISTS documents_id_project_id_key;
--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT documents_id_project_id_key UNIQUE (id, project_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "document_roles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" uuid NOT NULL,
  "document_id" uuid NOT NULL,
  "role" text NOT NULL,
  "scope_instance_id" text,
  "confidence" text DEFAULT 'declared' NOT NULL,
  "source" text DEFAULT 'user' NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT document_roles_scope_instance_not_blank
    CHECK ("scope_instance_id" IS NULL OR length("scope_instance_id") > 0),
  CONSTRAINT document_roles_confidence_known
    CHECK ("confidence" IN ('declared', 'suggested')),
  CONSTRAINT document_roles_source_known
    CHECK ("source" IN ('user', 'wizard', 'classifier'))
);
--> statement-breakpoint
-- A role binds a document in its OWN project. Composite rather than a plain
-- reference to documents(id): `organization_id` is denormalised here, so
-- without the project inside the key nothing stops a row claiming this project
-- while pointing at another project's — and therefore possibly another
-- tenant's — file. Both columns are NOT NULL, so MATCH SIMPLE never skips the
-- check the way it does for a nullable key.
ALTER TABLE "document_roles"
  ADD CONSTRAINT document_roles_document_id_project_id_fkey
  FOREIGN KEY ("document_id", "project_id")
  REFERENCES "documents"("id", "project_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "document_roles"
  ADD CONSTRAINT document_roles_project_id_fkey
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
--> statement-breakpoint
-- One binding per (project, document, role, instance). NULLS NOT DISTINCT
-- because a project-scope role stores NULL for the instance, and under the
-- default NULLS DISTINCT two identical project-scope bindings would both be
-- accepted — the uniqueness would silently apply only to the scoped roles.
-- PostgreSQL 15+; the deployment runs 16.
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_document_roles_binding"
  ON "document_roles" ("project_id", "document_id", "role", "scope_instance_id")
  NULLS NOT DISTINCT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_roles_project_role_idx"
  ON "document_roles" ("project_id", "role");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_roles_document_idx"
  ON "document_roles" ("document_id");
--> statement-breakpoint
SELECT grid_secure_table('document_roles', 'organization_id = grid_current_org()');
