-- 0111: a project memory item can be restricted to the folders it was drawn
-- from (ADR-0086, "Memory from a restricted turn is restricted memory";
-- ADR-0087).
--
-- `restricted_folder_ids` names the SOURCE FOLDERS a note depends on: folders
-- not every project member may read. NULL is open memory, the state of every
-- row before this migration. Who may be shown a restricted note is decided
-- when it is read, from each folder's access as it is then
-- (`effectiveFolderLevel`): a loosened folder opens its notes, a tightened one
-- closes them, a deleted folder's tombstone (0109) keeps answering with the
-- access it had. Nothing here is rewritten when access changes. Folder ids,
-- not retrieval collection names, so a note follows its folder's access.
--
-- The CHECK says what the service already does, so a second writer cannot
-- forget it:
--   * 1 to 20 entries, none NULL: an empty restriction is not one anybody could
--     satisfy, and "open" is NULL;
--   * project scope only (and so a project id, by 0008's scope CHECK):
--     organization memory reaches every project in the tenant, so a finding
--     that depends on restricted content is kept as restricted memory of the
--     project it came from.
--
-- The service stores the array sorted and de-duplicated, so two items carry
-- the same restriction exactly when the arrays are equal. That is what the
-- dedup index below keys on.
ALTER TABLE "project_memory" ADD COLUMN IF NOT EXISTS "restricted_folder_ids" uuid[];
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
  (coalesce("restricted_folder_ids", '{}'::uuid[])),
  (btrim(regexp_replace(lower("content"), '[^a-z0-9]+', ' ', 'g')))
)
WHERE "status" = 'active' AND "scope" = 'project';
