-- Write-time de-duplication backstop for project_memory.
--
-- The BFF is the single writer and now de-duplicates in the service layer
-- (createProjectMemoryItem), but a DB constraint closes the race window and
-- documents the invariant: at most one ACTIVE item per (scope-owner, normalized
-- content). Normalization mirrors normalizeContent() in memory-service.ts:
-- lower-case, non-alphanumerics collapsed to single spaces, trimmed.

-- First collapse any pre-existing normalized-duplicate ACTIVE rows (keep the
-- most recently updated, supersede the rest) so the unique indexes can build.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY
        "scope",
        "project_id",
        "organization_id",
        btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g'))
      ORDER BY "updated_at" DESC, "created_at" DESC
    ) AS rn
  FROM "project_memory"
  WHERE "status" = 'active'
)
UPDATE "project_memory" p
SET "status" = 'superseded', "updated_at" = now()
FROM ranked r
WHERE p."id" = r."id" AND r.rn > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_memory_project_content_active"
ON "project_memory" (
  "project_id",
  (btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g')))
)
WHERE "status" = 'active' AND "scope" = 'project';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_memory_org_content_active"
ON "project_memory" (
  "organization_id",
  (btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g')))
)
WHERE "status" = 'active' AND "scope" = 'organization' AND "project_id" IS NULL;
