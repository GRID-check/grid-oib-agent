-- Reverse 0114: no Papierkorb, and a legal hold no longer names a folder.
--
-- Refuses while the bin holds anything. An older build has no bin: it would
-- list a binned folder's documents (their chunks already purged) under a folder
-- nobody can see, and its purger would fail the bin's queue rows. Restore or
-- purge every bin entry first (`deletion_queue` rows with entity_type 'folder'
-- and status 'pending' or 'purging').
--
-- Purged tombstones stay tombstones (`deleted_at`), which is what 0110 calls a
-- deleted folder; only the purge marker and the bin pointer go. Holds on
-- folders stay in `legal_holds` and protect nothing until 0114 is re-applied.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM project_folders WHERE deleted_at IS NOT NULL AND purged_at IS NULL
  ) THEN
    RAISE EXCEPTION 'the Papierkorb is not empty: restore or purge every deleted folder before reversing 0114';
  END IF;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_deleted_folder_guard" ON "documents";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "project_folders_deleted_parent_guard" ON "project_folders";
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_refuse_write_into_deleted_folder();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION grid_legal_hold_blocks(
  p_entity_type text,
  p_entity_id text,
  p_organization_id text
) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  -- `documents.id` and `projects.id` are uuid; `entity_id` is text because an
  -- organization or a user id is not. Cast only a value of the right shape, so
  -- a malformed id answers "nothing contains it" instead of raising.
  uuid_shape constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM legal_holds h
    WHERE h.released_at IS NULL AND h.organization_id = p_organization_id
  ) THEN
    RETURN false;
  END IF;

  -- Everything in an organization goes with it.
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
       )
      WHERE d.id = p_entity_id::uuid AND d.organization_id = p_organization_id
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
    );
  END IF;

  RETURN false;
END
$$;
--> statement-breakpoint
COMMENT ON FUNCTION grid_legal_hold_blocks(text, text, text) IS
  'Whether an active legal hold covers erasing this entity: a hold on it, on what contains it, on what it contains, on its creator (custodian hold), or on its organization. The one predicate the BFF, the purger and the delete triggers share (migration 0093).';
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_folder_subtree(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_folder_ancestry(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS grid_folder_bin_lock_key(uuid);
--> statement-breakpoint
DROP INDEX IF EXISTS "project_folders_bin_idx";
--> statement-breakpoint
ALTER TABLE "project_folders" DROP CONSTRAINT IF EXISTS "project_folders_bin_state_check";
--> statement-breakpoint
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "purged_at";
--> statement-breakpoint
ALTER TABLE "project_folders" DROP COLUMN IF EXISTS "bin_root_id";
