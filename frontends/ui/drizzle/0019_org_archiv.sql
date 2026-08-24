-- Org-wide "Archiv": a document store that lives ABOVE projects, shared across
-- an entire organization — every project's agent retrieval also sees it.
--
-- It is built as a hierarchical add-on on top of the existing `documents`
-- machinery rather than a parallel table: an archive row is just a document
-- with `project_id` NULL, `scope = 'archiv'`, and `collection_name =
-- 'archiv_<orgId>'`. This lets the whole document pipeline (MinIO storage,
-- `/v1/ingest`, status reconciliation, download/preview/reingest/tags, the audit
-- trail) be reused unchanged — only the authorization scope differs
-- (org-level instead of per-project FGA).

-- Archive documents belong to an org, not a project.
ALTER TABLE "documents" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint

-- Discriminator so a query can cheaply separate project documents from archive
-- documents without inferring it from a NULL project_id. Existing rows are all
-- project-scoped, hence the default.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'scope'
  ) THEN
    ALTER TABLE "documents" ADD COLUMN "scope" text DEFAULT 'project' NOT NULL;
  END IF;
END $$;--> statement-breakpoint

-- Bounds the org-scoped archive listing (WHERE organization_id = ? AND scope = 'archiv').
CREATE INDEX IF NOT EXISTS "documents_org_scope_idx" ON "documents" ("organization_id","scope");
