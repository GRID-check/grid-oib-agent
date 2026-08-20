-- One filed report per run, per project — as a constraint, not as a lookup.
--
-- ## What was wrong
--
-- 0063 shipped the filing path with idempotency implemented as a PROBE:
-- `findDocumentAuthoredByRun(runId, organizationId, projectId)` runs before the
-- render, and a hit returns the existing row instead of filing a second one.
-- That closes the window it was written for — a person re-opening the report tab
-- — and nothing else, because a lookup is not a constraint.
--
-- The write sits on a GET (`/api/jobs/async/job/{id}/report`) that is re-fetched
-- every time the tab is opened. Two tabs, or a tab and a reload, produce two
-- concurrent calls; both run the probe before either has inserted; both miss;
-- both file. The result is two `documents` rows, two SeaweedFS objects, two
-- quota charges and two audit events for one run.
--
-- What makes that worse than an ordinary duplicate is that the two are
-- INDISTINGUISHABLE. `generatedFilename` is deterministic — slug + date +
-- extension — so both rows carry the same filename, the same display name, the
-- same size, the same folder, the same author, the same run, the same second.
-- `repository.ts` already names this outcome ("a duplicate of a report is
-- indistinguishable from a second run's, which is precisely the thing an office
-- cannot untangle later") and then leaves it to a probe to prevent. An office
-- that cannot tell which of two identical reports is the real one has to keep
-- both, and a Ziviltechniker signs one of them.
--
-- ## The columns, and why exactly these three
--
--   (organization_id, project_id, authored_by_run_id) WHERE authored_by <> 'user'
--
-- They are the probe's own WHERE clause, and that is the whole argument. An
-- index narrower than the probe rejects a row the probe would have accepted
-- (the caller gets a 23505 it cannot recover from, because the re-probe finds
-- no winner); an index wider than the probe admits a second row the probe would
-- have answered "already filed" for, so the duplicate the probe was meant to
-- prevent arrives anyway and the constraint reports success. Either way one of
-- the two is wrong, so they are written from the same three columns on purpose.
--
-- `authored_by_run_id` alone is the identity a reader assumes, and it is not
-- enough on its own here: `project_id` is in the key because 0063's probe was
-- FIXED to be project-scoped (a run's report is filed into the project the
-- report request names, and an org-wide probe handed back a different project's
-- document id). `organization_id` is in the key because `documents` denormalises
-- it and every read in this domain scopes by it — dropping it would make the
-- index disagree with the probe over a run id colliding across tenants, which is
-- exactly the shape RLS is not asked to reason about.
--
-- `authored_by_producer` is deliberately NOT in the key. Adding it would let two
-- producers file one run into one project, and the probe — which does not ask
-- about the producer — would then return whichever row Postgres happened to
-- hand back first. That is the "index wider than the probe" failure above, in
-- the one place it looks like extra safety.
--
-- ## Why the predicate, rather than relying on NULLs
--
-- Every row a person uploaded carries `authored_by_run_id IS NULL`, and NULL is
-- never equal to NULL in a unique index, so human rows would already be exempt
-- without any predicate. The predicate is here for the rows that are NOT exempt
-- that way: 0063's CHECK is one-directional on purpose, so a `'user'` row MAY
-- carry a producer and a run id ("a person saving an artefact a run showed
-- them"). Without `WHERE authored_by <> 'user'`, two colleagues saving the same
-- run's artefact into the same project would collide with each other — an index
-- built to stop a machine racing itself rejecting an ordinary human action.
--
-- `<> 'user'` rather than `= 'agent'` for 0063's reason, restated: the invariant
-- is true of every producer, so the next member of `DOCUMENT_AUTHORS` arrives
-- already constrained instead of arriving as a hole nobody notices. This differs
-- from `documents_agent_authored_idx`, which names `'agent'` because it serves a
-- QUERY that asks about Piloti specifically; this one enforces a RULE.
--
-- ## What it does not cover, deliberately
--
--   - A machine-authored row with `project_id IS NULL` (an org-wide Archiv row)
--     is not constrained, because NULL never equals NULL. Nothing writes one:
--     `fileGeneratedDocument` requires a project and the probe takes a
--     `projectId` that is not optional. A future org-scoped producer needs BOTH
--     changed together — the probe to ask a question it can answer for a null
--     project, and this index to key on the same COALESCE the folder index uses.
--   - Soft-deleted rows stay in the index, because the probe does not filter
--     `deleted_at` either. So deleting a filed report and re-fetching its tab
--     still answers "already filed", pointing at the deleted row. That is 0063's
--     behaviour, preserved rather than changed here; changing it means changing
--     the probe and this predicate in the same commit, or they disagree again.
--
-- ## Existing data
--
-- The guarded DO block below is 0063's pattern and is here for the same reason:
-- `CREATE UNIQUE INDEX` on data that already violates reports ONE key and leaves
-- the operator to find the rest, and the resolution — which of two identical
-- reports to keep — is a decision this migration must not make, because the
-- rows carry real bytes and real quota. In practice the list is empty (nothing
-- has filed against a released build), which is the reason to add the index now
-- rather than after somebody has to untangle it.
--
-- Rows with a NULL project or a NULL run id are excluded from the check: they
-- cannot violate the index (NULL never equals NULL), but SQL's `GROUP BY` puts
-- all NULLs in one group, so counting them would report duplicates that are not.
--
-- ## Locks
--
-- Plain `CREATE UNIQUE INDEX` takes a SHARE lock, blocking writes to `documents`
-- for the build. The partial predicate means the index covers a handful of rows
-- and the build is a scan the planner satisfies from
-- `documents_agent_authored_idx`; CONCURRENTLY is deliberately not used because
-- it cannot run inside the transaction the migration runner wraps each file in,
-- and a failed concurrent build leaves an INVALID index behind that nothing here
-- would notice.
--
-- ## RLS
--
-- Nothing to do. `documents` was secured by 0031 and an index does not move a
-- table across the tenant boundary. Deliberately absent from
-- `rls-coverage.spec.ts`'s BOUNDARY_MIGRATIONS, like 0063.

-- ---------------------------------------------------------------------------
-- 1. Refuse to build over data that already violates (see the header)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(entry, E'\n  ' ORDER BY entry) INTO duplicates
  FROM (
    SELECT format(
             'organization %s, project %s, run %L (%s documents)',
             "organization_id",
             "project_id",
             "authored_by_run_id",
             count(*)
           ) AS entry
    FROM "documents"
    WHERE "authored_by" <> 'user'
      AND "project_id" IS NOT NULL
      AND "authored_by_run_id" IS NOT NULL
    GROUP BY "organization_id", "project_id", "authored_by_run_id"
    HAVING count(*) > 1
  ) AS dupes;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot apply migration 0064: a run has already filed more than one document into one project, so the unique index cannot be built.\n  %\nThese rows are byte-identical by construction (the generated filename is slug + date + extension), so a machine cannot tell which one an office is relying on. Delete the extras through the application, so the stored object and the quota charge go with the row instead of being orphaned in a store this migration cannot see.',
      duplicates;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. One filed report per (organization, project, run)
-- ---------------------------------------------------------------------------
--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_documents_authored_run_per_project"
  ON "documents" ("organization_id", "project_id", "authored_by_run_id")
  WHERE "authored_by" <> 'user';

--> statement-breakpoint
COMMENT ON INDEX "uniq_documents_authored_run_per_project" IS
  'One machine-authored document per (organization, project, run). The columns are exactly the WHERE clause of findDocumentAuthoredByRun, because an index narrower than that probe rejects rows the probe would accept, and an index wider than it admits duplicates the probe was meant to prevent. Partial on authored_by <> ''user'' because 0063''s CHECK deliberately allows a HUMAN row to carry a run id as well, and two people saving the same run''s artefact into one project must not collide. Rows with a NULL project are not covered (NULL never equals NULL): nothing writes one, and a producer that does must change the probe and this index together.';
