-- 0106: a project memory item can be restricted (ADR-0078, "Memory from a
-- restricted turn is restricted memory").
--
-- `restricted_collections` names the restricted-folder collections
-- (`<project collection>_r<12 hex>`) the item depends on. NULL is open memory,
-- the state of every row before this migration. A restricted item is served
-- and shown only to a session cleared for ALL of its collections; a collection
-- that is no longer a current restricted collection of the project (the
-- restriction was lifted, the folder deleted) clears nobody, so the item is
-- then shown to nobody: the safe direction, accepted in ADR-0078.
--
-- The CHECK says what the service already does, so a second writer cannot
-- forget it:
--   * 1 to 20 entries, none NULL: an empty restriction is not one anybody could
--     satisfy, and "open" is NULL, as for `project_folders.restricted_roles`;
--   * project scope only (and so a project id, by 0008's scope CHECK):
--     organization memory reaches every project in the tenant, so a finding
--     that depends on restricted content is kept as restricted memory of the
--     project it came from.
--
-- The service stores the array sorted and de-duplicated, so two items carry
-- the same restriction exactly when the arrays are equal. That is what the
-- dedup index below keys on.
ALTER TABLE "project_memory" ADD COLUMN IF NOT EXISTS "restricted_collections" text[];
--> statement-breakpoint
ALTER TABLE "project_memory" DROP CONSTRAINT IF EXISTS "project_memory_restricted_collections_check";
--> statement-breakpoint
ALTER TABLE "project_memory"
  ADD CONSTRAINT "project_memory_restricted_collections_check" CHECK (
    "restricted_collections" IS NULL
    OR (
      cardinality("restricted_collections") BETWEEN 1 AND 20
      AND array_position("restricted_collections", NULL) IS NULL
      AND "scope" = 'project'
    )
  );
--> statement-breakpoint
-- One live row per (project, restriction, normalized content). Before this the
-- key had no restriction, so an open note and a restricted note saying the same
-- thing could not both be live: the second write hit the index, and the race
-- backstop would hand the caller the OTHER row. Consolidation keeps open and
-- restricted memory apart (`createProjectMemoryItem`); the index now agrees.
-- `coalesce` because NULLs are distinct in a unique index, which would let any
-- number of identical open notes through.
DROP INDEX IF EXISTS "uniq_project_memory_project_content_active";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_project_memory_project_content_active"
ON "project_memory" (
  "project_id",
  (coalesce("restricted_collections", '{}'::text[])),
  (btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g')))
)
WHERE "status" = 'active' AND "scope" = 'project';
