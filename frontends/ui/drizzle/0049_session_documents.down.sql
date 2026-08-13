-- Reverse 0049: documents forget which conversation they were attached to.
--
-- ## What is lost, and why the guard
--
-- 0049 only ADDED things, so removing them puts the table back exactly as 0045
-- left it — for every row that predates it. For a `scope = 'session'` row it is
-- destructive in a way no other rollback in this history is: the conversation
-- id is the ONLY thing that says which chat the file belongs to once the FK is
-- gone, and `scope = 'session'` itself becomes a value nothing can resolve. The
-- row would list nowhere, authorize as nothing, and still count against the
-- organization's storage quota.
--
-- So the guard refuses while any session document exists, rather than trusting
-- whoever is reading this at 2am. Clearing them is a real deletion of user
-- data, which is why it is not done here: run it through the application's own
-- delete path (`DELETE /api/session/documents/[id]`, or discard the chats), so
-- the SeaweedFS objects and the Chroma chunks go with the rows instead of being
-- orphaned in two stores that this migration cannot see.
--
-- If the objects have already been dealt with by other means, the rows can be
-- cleared directly:
--   DELETE FROM documents WHERE scope = 'session';
--
-- Dropping in the reverse order of creation: check, index, constraint, column.
-- `DROP COLUMN` would take the dependents with it anyway; naming them keeps the
-- rollback honest about everything it removes.
--
-- The check being dropped is the whole scope partition — a session row has a
-- conversation, and a session row has no project. Both halves go, so after this
-- runs nothing stops a `scope = 'session'` row from carrying a `project_id` and
-- being cascade-deleted by a project purge with its SeaweedFS objects and Chroma
-- chunks left behind. That is another reason the guard above refuses while any
-- session document exists: the rollback is only safe when there is nothing left
-- for the invariant to protect.

DO $$
DECLARE
  session_rows bigint;
BEGIN
  -- Skip when the column is already gone, so re-running is a no-op rather than
  -- an error about a missing column.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'conversation_id'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO session_rows FROM documents WHERE conversation_id IS NOT NULL;

  IF session_rows > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse migration 0049: % session document row(s) still name a conversation. '
      'Dropping the column would leave them unreachable by every surface while they still '
      'hold storage quota and still have objects in SeaweedFS. Delete them through the '
      'application (DELETE /api/session/documents/[id], or discard the conversations) so the '
      'objects and chunks go with them.',
      session_rows;
  END IF;
END $$;

--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_session_requires_conversation";
--> statement-breakpoint
DROP INDEX IF EXISTS "documents_conversation_idx";
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_conversation_id_organization_id_fkey";
--> statement-breakpoint
-- The column comment goes with the column; no separate `COMMENT ... IS NULL`
-- is needed.
ALTER TABLE "documents" DROP COLUMN IF EXISTS "conversation_id";
