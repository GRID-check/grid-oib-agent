-- 0093: a legal hold stops every erasure, not only the purger's.
--
-- ## The gap this closes
--
-- `POST /api/holds` accepts a hold on a document, a conversation, a project, a
-- user or the whole organization, and promises it blocks purge. Only one reader
-- ever looked at `legal_holds`: the purger's claim query, and the purger only
-- erases PROJECTS. Deleting a single document, an Archiv document, a chat, or a
-- file attached to a chat is an immediate hard delete in the BFF — S3 objects,
-- chunks and rows — and none of those paths asked. A hold on a document was a
-- row that protected nothing.
--
-- ## One predicate, three readers
--
-- `grid_legal_hold_blocks(entity_type, entity_id, organization_id)` is the only
-- definition of "is this entity covered by an active hold". The BFF calls it
-- before its first destructive step (`lib/compliance/holds.ts`), the purger's
-- claim and its TOCTOU re-checks call it (`purger/db.js`), and the triggers
-- below call it as the backstop. Written once here so the three cannot drift:
-- the purger's hand-written predicate already had (it saw neither a document
-- hold inside a project nor a user hold).
--
-- Covered, for an entity E in organization O (every hold must be O's own):
--
--   - a hold on O itself, which freezes everything in the organization;
--   - a hold on E itself;
--   - a hold on whatever CONTAINS E: a document's project and conversation, a
--     conversation's project;
--   - a hold on whatever E CONTAINS, because erasing E erases it too: a
--     conversation's attachments, a project's documents, chats and the chats'
--     attachments; an organization contains everything, so ANY hold in O
--     blocks O's own erasure;
--   - a hold on a USER (custodian hold) covers what that user created: the
--     documents they uploaded or commissioned and the chats they started.
--
-- The early exit keeps the trigger cheap: an organization with no active hold
-- — nearly all of them, nearly always — answers after one indexed probe.
--
-- SECURITY INVOKER (the default), deliberately. Under `grid_app_rw` the
-- `legal_holds` policy shows the active tenant's holds, which is exactly the
-- set that can cover a row of that tenant; the purger runs as the BYPASSRLS
-- platform role and sees all of them.

CREATE INDEX IF NOT EXISTS "legal_holds_org_active_idx"
  ON "legal_holds" ("organization_id") WHERE "released_at" IS NULL;
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
-- The backstop. The BFF refuses first with a 409 it can explain; this is what
-- still holds when a code path forgets to ask — a new delete, a cascade from a
-- project row, a script. It stops the ROW, which is the handle every retry and
-- every audit needs; stores outside Postgres are the callers' to guard, which
-- is why the application check runs before their first destructive step.
--
-- `GLH01` is this repository's own SQLSTATE (class `GL` is unassigned by the
-- standard); `lib/api/handler.ts` answers it with a 409 instead of a 500.
CREATE OR REPLACE FUNCTION grid_refuse_held_delete() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF grid_legal_hold_blocks(TG_ARGV[0], OLD.id::text, OLD.organization_id) THEN
    RAISE EXCEPTION 'legal hold: % % is covered by an active legal hold and cannot be deleted', TG_ARGV[0], OLD.id
      USING ERRCODE = 'GLH01';
  END IF;
  RETURN OLD;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "documents_legal_hold_guard" ON "documents";
--> statement-breakpoint
CREATE TRIGGER "documents_legal_hold_guard"
  BEFORE DELETE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_held_delete('document');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "conversations_legal_hold_guard" ON "conversations";
--> statement-breakpoint
CREATE TRIGGER "conversations_legal_hold_guard"
  BEFORE DELETE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION grid_refuse_held_delete('conversation');
