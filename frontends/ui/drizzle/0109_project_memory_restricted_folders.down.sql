-- Reverse 0109. ORDER: roll the frontend back first; the newer build reads and
-- writes `restricted_folder_ids`.
--
-- Each folder id becomes its collection name again
-- (`<project collection>_r<12 hex of the folder id>`), which the older build
-- serves only while that is a current restricted collection: a note whose
-- folder was loosened since is then shown to nobody, the 0106 behaviour.
ALTER TABLE "project_memory" ADD COLUMN IF NOT EXISTS "restricted_collections" text[];
UPDATE "project_memory" m
SET "restricted_collections" = (
  SELECT array_agg(DISTINCT p."collection_name" || '_r' || lower(left(replace(f_id::text, '-', ''), 12)) ORDER BY p."collection_name" || '_r' || lower(left(replace(f_id::text, '-', ''), 12)))
  FROM unnest(m."restricted_folder_ids") AS f_id
  JOIN "projects" p ON p."id" = m."project_id"
)
WHERE m."restricted_folder_ids" IS NOT NULL;
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_restricted_folders_check";
ALTER TABLE "project_memory"
  ADD CONSTRAINT "project_memory_restricted_collections_check" CHECK (
    "restricted_collections" IS NULL
    OR (
      cardinality("restricted_collections") BETWEEN 1 AND 20
      AND array_position("restricted_collections", NULL) IS NULL
      AND "scope" = 'project'
    )
  );
DROP INDEX IF EXISTS "uniq_project_memory_project_content_active";
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_memory_project_content_active"
ON "project_memory" (
  "project_id",
  (coalesce("restricted_collections", '{}'::text[])),
  (btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g')))
)
WHERE "status" = 'active' AND "scope" = 'project';
ALTER TABLE "project_memory" DROP COLUMN IF EXISTS "restricted_folder_ids";
