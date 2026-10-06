-- 0110: restricted project memory names its SOURCE FOLDERS (ADR-0081), not
-- their retrieval collections.
--
-- 0107 stored `restricted_collections`, the `<project collection>_r<12 hex>`
-- names of the restricted folders a note depends on, and served a note only to
-- a session cleared for every one of them that was STILL a restricted
-- collection. A lifted restriction therefore hid the note from everybody, and a
-- note could not follow its folder's access as it changed.
--
-- `restricted_folder_ids` names the folders themselves. Who may be shown a note
-- is decided when it is read, from each folder's access as it is then
-- (`effectiveFolderLevel`): a loosened folder opens its notes, a tightened one
-- closes them, a deleted folder's tombstone (0109) keeps answering with the
-- access it had. Nothing here is rewritten when access changes.
--
-- ## Backfill
--
-- Each collection becomes the folder whose collection name it is. A collection
-- no folder of the project answers to (a folder deleted before tombstones
-- existed) becomes the nil UUID, which no folder has: the note stays restricted
-- and is shown to nobody, as 0107 already showed it to nobody.
ALTER TABLE "project_memory" ADD COLUMN IF NOT EXISTS "restricted_folder_ids" uuid[];
--> statement-breakpoint
UPDATE "project_memory" m
SET "restricted_folder_ids" = (
  SELECT array_agg(DISTINCT coalesce(f."id", '00000000-0000-0000-0000-000000000000'::uuid) ORDER BY coalesce(f."id", '00000000-0000-0000-0000-000000000000'::uuid))
  FROM unnest(m."restricted_collections") AS c(collection)
  JOIN "projects" p ON p."id" = m."project_id"
  LEFT JOIN "project_folders" f
    ON f."project_id" = p."id"
    AND c.collection = p."collection_name" || '_r' || lower(left(replace(f."id"::text, '-', ''), 12))
)
WHERE m."restricted_collections" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_restricted_collections_check";
--> statement-breakpoint
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_restricted_folders_check";
--> statement-breakpoint
ALTER TABLE "project_memory"
  ADD CONSTRAINT "project_memory_restricted_folders_check" CHECK (
    "restricted_folder_ids" IS NULL
    OR (
      cardinality("restricted_folder_ids") BETWEEN 1 AND 20
      AND array_position("restricted_folder_ids", NULL) IS NULL
      AND "scope" = 'project'
    )
  );
--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_project_memory_project_content_active";
--> statement-breakpoint
-- Two notes 0107 kept apart can name the same folders now (two collections
-- nothing answers to both became the nil UUID). The older one stays live and
-- the later one is superseded, so the index below can be built.
UPDATE "project_memory" m
SET "status" = 'superseded'
FROM (
  SELECT "id", row_number() OVER (
    PARTITION BY "project_id", coalesce("restricted_folder_ids", '{}'::uuid[]),
      btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g'))
    ORDER BY "created_at", "id"
  ) AS rank
  FROM "project_memory"
  WHERE "status" = 'active' AND "scope" = 'project'
) d
WHERE d."id" = m."id" AND d.rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_memory_project_content_active"
ON "project_memory" (
  "project_id",
  (coalesce("restricted_folder_ids", '{}'::uuid[])),
  (btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g')))
)
WHERE "status" = 'active' AND "scope" = 'project';
--> statement-breakpoint
ALTER TABLE "project_memory" DROP COLUMN IF EXISTS "restricted_collections";
