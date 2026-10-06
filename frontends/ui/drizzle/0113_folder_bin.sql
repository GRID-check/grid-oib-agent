-- 0113: deleting a folder puts it in the Papierkorb (ADR-0081, deletion
-- pipeline), and a legal hold can cover a folder.
--
-- ## The bin
--
-- A PROJECT folder only: `project_folders` also holds the Archiv's folders
-- (0102), which keep their delete (contents re-filed into the parent, the row
-- removed) and never enter any state below.
--
-- Until now a deleted project folder moved its documents and subfolders up into its
-- parent and stayed behind as a tombstone (0110). Deleting a folder now takes
-- its subfolders and documents WITH it: every folder of the subtree gets
-- `deleted_at`, and `bin_root_id` names the folder the person deleted (itself
-- for that one), which is what a restore puts back together. The documents keep
-- their `folder_id`; a folder that is deleted hides them from every reader
-- (`lib/authz/folder-access-rule.ts`). A `deletion_queue` row (`entity_type =
-- 'folder'`) is the bin entry and the purge task. When the purge has run, the
-- folder rows stay as permanent tombstones with their grants: `purged_at`.
--
-- Every tombstone that exists before this migration was made by the old delete,
-- which had already moved its contents out. Nothing is left to purge in it, so
-- it is backfilled as purged: it is a tombstone, not a bin entry.
--
-- ## Nothing lands in a deleted folder
--
-- The application asks `requireFolderWrite` before a write, but a check and the
-- insert after it are two statements, and a folder can go to the bin between
-- them. The triggers below make it atomic: an insert of a document or a folder,
-- or a move of one, into a folder takes the project's bin lock SHARED and then
-- refuses (SQLSTATE `GFD01`) when the target folder is deleted. Moving a folder
-- to the bin and restoring one take the same lock EXCLUSIVE before they read
-- the subtree, so a concurrent insert either commits first (and the bin sees
-- and takes its row) or waits and is refused.
--
-- ## Legal holds on folders
--
-- `grid_legal_hold_blocks` learns `folder`: a hold on the folder, on a folder
-- above it (which contains it) or below it, on a document in its subtree, on
-- the project, on the creator of a document in it (custodian), or on the
-- organization. A document is now also covered by a hold on any folder on its
-- path, and a project by a hold on any of its folders.

ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "bin_root_id" uuid;
--> statement-breakpoint
ALTER TABLE "project_folders" ADD COLUMN IF NOT EXISTS "purged_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "project_folders" SET "purged_at" = "deleted_at" WHERE "deleted_at" IS NOT NULL AND "purged_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_bin_state_check";
--> statement-breakpoint
-- A bin entry or a purged tombstone is a deleted folder; a living folder is in
-- neither state. Only a PROJECT folder is ever deleted in place: an Archiv
-- folder (0102) has no Papierkorb, no purge and no tombstone, its delete
-- re-files what it holds and removes the row.
ALTER TABLE "project_folders"
  ADD CONSTRAINT "project_folders_bin_state_check" CHECK (
    ("purged_at" IS NULL OR "deleted_at" IS NOT NULL)
    AND ("bin_root_id" IS NULL OR "deleted_at" IS NOT NULL)
    AND ("deleted_at" IS NULL OR "scope" = 'project')
  );
--> statement-breakpoint
COMMENT ON COLUMN "project_folders"."bin_root_id" IS
  'The folder a person deleted, for every folder that went to the Papierkorb with it (itself included). NULL for a living folder and for a tombstone older than 0113.';
--> statement-breakpoint
COMMENT ON COLUMN "project_folders"."purged_at" IS
  'When the purge removed what the folder held. Set: a permanent tombstone (row and grants kept, ADR-0081). NULL with deleted_at set: in the Papierkorb.';
--> statement-breakpoint
-- The decision point probes a project for a folder in the bin on most document
-- reads (a document filed in one is hidden from everyone), and the Papierkorb
-- view lists them; almost no folder is ever in the bin.
CREATE INDEX IF NOT EXISTS "project_folders_bin_idx"
  ON "project_folders" USING btree ("project_id") WHERE "deleted_at" IS NOT NULL AND "purged_at" IS NULL;
--> statement-breakpoint
-- The key of a project's bin lock. One function so the triggers and the
-- services (`lib/projects/folder-bin-repository.ts`) cannot name different locks.
CREATE OR REPLACE FUNCTION grid_folder_bin_lock_key(p_project_id uuid) RETURNS bigint
  LANGUAGE sql IMMUTABLE AS $$
  SELECT hashtextextended('grid-folder-bin:' || p_project_id::text, 0)
$$;
--> statement-breakpoint
-- A folder and every folder below it, deleted ones included (a bin entry's
-- subfolders are deleted too).
CREATE OR REPLACE FUNCTION grid_folder_subtree(p_folder_id uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE AS $$
  WITH RECURSIVE subtree AS (
    SELECT f.id FROM project_folders f WHERE f.id = p_folder_id
    UNION
    SELECT c.id FROM project_folders c JOIN subtree s ON c.parent_id = s.id
  )
  SELECT id FROM subtree
$$;
--> statement-breakpoint
-- A folder and every folder above it.
CREATE OR REPLACE FUNCTION grid_folder_ancestry(p_folder_id uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE AS $$
  WITH RECURSIVE ancestry AS (
    SELECT f.id, f.parent_id FROM project_folders f WHERE f.id = p_folder_id
    UNION
    SELECT p.id, p.parent_id FROM project_folders p JOIN ancestry a ON p.id = a.parent_id
  )
  SELECT id FROM ancestry
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_refuse_write_into_deleted_folder() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  target_project uuid;
  target_deleted timestamptz;
BEGIN
  IF TG_TABLE_NAME = 'documents' THEN
    target := NEW.folder_id;
    IF TG_OP = 'UPDATE' AND target IS NOT DISTINCT FROM OLD.folder_id THEN
      RETURN NEW;
    END IF;
  ELSE
    target := NEW.parent_id;
    IF TG_OP = 'UPDATE' AND target IS NOT DISTINCT FROM OLD.parent_id THEN
      RETURN NEW;
    END IF;
  END IF;
  IF target IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT f.project_id INTO target_project FROM project_folders f WHERE f.id = target;
  IF NOT FOUND THEN
    RETURN NEW;  -- the foreign key answers for a folder that does not exist
  END IF;
  -- Waits while the folder's project is being moved to or from the bin; the
  -- read below is a new statement, so it sees what that transaction committed.
  -- A folder with no project (an Archiv shelf folder) has no Papierkorb and no
  -- lock to wait for.
  IF target_project IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock_shared(grid_folder_bin_lock_key(target_project));
  END IF;
  SELECT f.deleted_at INTO target_deleted FROM project_folders f WHERE f.id = target;
  IF target_deleted IS NOT NULL THEN
    RAISE EXCEPTION 'folder % is deleted; nothing may be filed into it', target
      USING ERRCODE = 'GFD01';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_deleted_folder_guard" ON "documents";
--> statement-breakpoint
CREATE TRIGGER "documents_deleted_folder_guard"
  BEFORE INSERT OR UPDATE OF "folder_id" ON "documents"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_write_into_deleted_folder();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folders_deleted_parent_guard" ON "project_folders";
--> statement-breakpoint
CREATE TRIGGER "project_folders_deleted_parent_guard"
  BEFORE INSERT OR UPDATE OF "parent_id" ON "project_folders"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_write_into_deleted_folder();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_legal_hold_blocks(
  p_entity_type text,
  p_entity_id text,
  p_organization_id text
) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM legal_holds h
    WHERE h.released_at IS NULL AND h.organization_id = p_organization_id
  ) THEN
    RETURN false;
  END IF;

  IF p_entity_type = 'organization' THEN
    RETURN true;
  END IF;

  IF EXISTS (
    SELECT 1 FROM legal_holds h
    WHERE h.released_at IS NULL
      AND h.organization_id = p_organization_id
      AND (
        (h.entity_type = 'organization' AND h.entity_id = p_organization_id)
        OR (h.entity_type = p_entity_type AND h.entity_id = p_entity_id)
      )
  ) THEN
    RETURN true;
  END IF;

  IF p_entity_type = 'document' THEN
    IF p_entity_id !~ uuid_shape THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1
      FROM documents d
      JOIN legal_holds h
        ON h.released_at IS NULL
       AND h.organization_id = p_organization_id
       AND (
         (h.entity_type = 'project' AND h.entity_id = d.project_id::text)
         OR (h.entity_type = 'conversation' AND h.entity_id = d.conversation_id)
         OR (h.entity_type = 'user' AND h.entity_id = d.created_by)
         OR (
           h.entity_type = 'folder' AND d.folder_id IS NOT NULL
           AND h.entity_id IN (SELECT a::text FROM grid_folder_ancestry(d.folder_id) a)
         )
       )
      WHERE d.id = p_entity_id::uuid AND d.organization_id = p_organization_id
    );
  END IF;

  IF p_entity_type = 'folder' THEN
    IF p_entity_id !~ uuid_shape THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1
      FROM legal_holds h
      WHERE h.released_at IS NULL
        AND h.organization_id = p_organization_id
        AND (
          (
            h.entity_type = 'folder'
            AND h.entity_id IN (
              SELECT s::text FROM grid_folder_subtree(p_entity_id::uuid) s
              UNION
              SELECT a::text FROM grid_folder_ancestry(p_entity_id::uuid) a
            )
          )
          OR (
            h.entity_type = 'project'
            AND h.entity_id = (SELECT f.project_id::text FROM project_folders f WHERE f.id = p_entity_id::uuid)
          )
          OR (
            h.entity_type IN ('document', 'user')
            AND EXISTS (
              SELECT 1 FROM documents d
              WHERE d.organization_id = p_organization_id
                AND d.folder_id IN (SELECT grid_folder_subtree(p_entity_id::uuid))
                AND (
                  (h.entity_type = 'document' AND h.entity_id = d.id::text)
                  OR (h.entity_type = 'user' AND h.entity_id = d.created_by)
                )
            )
          )
        )
    );
  END IF;

  IF p_entity_type = 'conversation' THEN
    RETURN EXISTS (
      SELECT 1
      FROM conversations c
      JOIN legal_holds h
        ON h.released_at IS NULL
       AND h.organization_id = p_organization_id
       AND (
         (h.entity_type = 'project' AND h.entity_id = c.project_id::text)
         OR (h.entity_type = 'user' AND h.entity_id = c.created_by)
       )
      WHERE c.id = p_entity_id AND c.organization_id = p_organization_id
    ) OR EXISTS (
      SELECT 1
      FROM documents d
      JOIN legal_holds h
        ON h.released_at IS NULL
       AND h.organization_id = p_organization_id
       AND (
         (h.entity_type = 'document' AND h.entity_id = d.id::text)
         OR (h.entity_type = 'user' AND h.entity_id = d.created_by)
       )
      WHERE d.conversation_id = p_entity_id AND d.organization_id = p_organization_id
    );
  END IF;

  IF p_entity_type = 'project' THEN
    IF p_entity_id !~ uuid_shape THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1
      FROM conversations c
      JOIN legal_holds h
        ON h.released_at IS NULL
       AND h.organization_id = p_organization_id
       AND (
         (h.entity_type = 'conversation' AND h.entity_id = c.id)
         OR (h.entity_type = 'user' AND h.entity_id = c.created_by)
       )
      WHERE c.project_id = p_entity_id::uuid AND c.organization_id = p_organization_id
    ) OR EXISTS (
      SELECT 1
      FROM documents d
      JOIN legal_holds h
        ON h.released_at IS NULL
       AND h.organization_id = p_organization_id
       AND (
         (h.entity_type = 'document' AND h.entity_id = d.id::text)
         OR (h.entity_type = 'user' AND h.entity_id = d.created_by)
       )
      WHERE d.organization_id = p_organization_id
        AND (
          d.project_id = p_entity_id::uuid
          OR d.conversation_id IN (
            SELECT c.id FROM conversations c
            WHERE c.project_id = p_entity_id::uuid AND c.organization_id = p_organization_id
          )
        )
    ) OR EXISTS (
      SELECT 1
      FROM project_folders f
      JOIN legal_holds h
        ON h.released_at IS NULL
       AND h.organization_id = p_organization_id
       AND h.entity_type = 'folder'
       AND h.entity_id = f.id::text
      WHERE f.project_id = p_entity_id::uuid
    );
  END IF;

  RETURN false;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION grid_legal_hold_blocks(text, text, text) IS
  'Whether an active legal hold covers erasing this entity: a hold on it, on what contains it, on what it contains, on its creator (custodian hold), or on its organization. Folders since 0113. The one predicate the BFF, the purger and the delete triggers share (migration 0093).';
