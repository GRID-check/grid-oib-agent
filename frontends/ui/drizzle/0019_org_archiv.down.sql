DROP INDEX IF EXISTS "documents_org_scope_idx";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "scope";--> statement-breakpoint
-- NOTE: `project_id` is intentionally left nullable. Restoring NOT NULL would
-- fail while any archive rows (project_id NULL) exist; drop those first if a
-- full revert is required.
