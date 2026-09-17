-- Reverse 0063: documents forget who wrote them, and a project may hold two
-- folders with the same name again.
--
-- ## What is lost, and why the guard
--
-- 0063 only ADDED things, so removing them puts both tables back exactly as
-- 0062 left them — for every row that predates it. For a row no person wrote it
-- is destructive in a way no earlier rollback is: the three columns are the ONLY
-- record that a machine wrote the document, what wrote it, and in which run.
-- Drop them and the row survives, keeps its bytes, keeps its quota, keeps its
-- place in the Files pane — and is now indistinguishable from a file a
-- Ziviltechniker uploaded and stands behind. That is precisely the
-- conflation of provenance with responsibility that ADR-0047 exists to
-- prevent, and it is silent: nothing errors, a badge simply stops rendering.
--
-- So the guard refuses while any machine-authored document exists. Clearing them
-- is a real deletion of user data, which is why it is not done here: run it
-- through the application's own delete path so the SeaweedFS object goes with
-- the row instead of being orphaned in a store this migration cannot see.
--
-- If the objects have already been dealt with by other means, the rows can be
-- cleared directly:
--   DELETE FROM documents WHERE authored_by <> 'user';
--
-- ## The `stored` status is not reverted
--
-- Nothing to revert: `status` is plain `text` with no CHECK, so `stored` was
-- never a schema fact. Any row still carrying it is covered by the guard above
-- — a machine-authored document is the only writer of that status — and the
-- guard's remedy (delete through the application) takes it with the row.
--
-- ## The folder uniqueness
--
-- Dropped without a guard, because dropping a unique index destroys nothing:
-- it only stops rejecting future writes. What it does mean is that a
-- get-or-create of the fixed `Berichte` folder is racy again the moment this
-- runs, so anything still filing reports has to be switched off first — which
-- the guard above already forces, since such a run would produce a
-- machine-authored row.
--
-- Dropping in the reverse order of creation. `DROP COLUMN` would take the check
-- constraint and the partial index with it anyway; naming them keeps the
-- rollback honest about everything it removes.

DO $$
DECLARE
  machine_rows bigint;
BEGIN
  -- Skip when the column is already gone, so re-running is a no-op rather than
  -- an error about a missing column.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'authored_by'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO machine_rows FROM documents WHERE authored_by <> 'user';

  IF machine_rows > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse migration 0063: % document row(s) were written by something '
      'other than a person. Dropping the columns would leave them looking like '
      'files a human uploaded and stands behind, with no record of what wrote '
      'them or in which run. Delete them through the application so the objects '
      'go with the rows.',
      machine_rows;
  END IF;
END $$;

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_project_folders_parent_name";

--> statement-breakpoint
DROP INDEX IF EXISTS "documents_agent_authored_idx";

--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_authorship_requires_provenance";

--> statement-breakpoint
-- The column comments go with the columns; no separate `COMMENT ... IS NULL`
-- is needed.
ALTER TABLE "documents" DROP COLUMN IF EXISTS "authored_by_run_id";

--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "authored_by_producer";

--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "authored_by";
