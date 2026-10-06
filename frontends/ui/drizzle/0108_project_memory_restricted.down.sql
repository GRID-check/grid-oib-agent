-- Reverse 0108. ORDER: roll the frontend back first; the newer build writes and
-- filters the column.
--
-- Lossy, on purpose, and in the safe direction: restricted memory is DELETED,
-- not opened. Dropping the column alone would turn every restricted note into
-- an open one and serve it to people the folder excludes. The older build
-- wrote no memory from a restricted turn, so this returns to that state.
DELETE FROM "project_memory" WHERE "restricted_collections" IS NOT NULL;
DROP INDEX IF EXISTS "uniq_project_memory_project_content_active";
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_memory_project_content_active"
ON "project_memory" (
  "project_id",
  (btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g')))
)
WHERE "status" = 'active' AND "scope" = 'project';
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_restricted_collections_check";
ALTER TABLE "project_memory" DROP COLUMN IF EXISTS "restricted_collections";
