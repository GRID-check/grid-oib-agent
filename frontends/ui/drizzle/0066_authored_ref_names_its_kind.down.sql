-- Back to one untyped identifier, named after the only producer that ever fit it.
--
-- This direction DELETES a fact, so unlike the up migration it can fail on real
-- data, and it should. Dropping `authored_by_ref_kind` and renaming the column
-- back to `authored_by_run_id` restores a name that is true of `deep_research`
-- rows and false of every diagram row — and false in the specific way 0066
-- exists to fix, because the value also rides the `document.generated` audit
-- event as the id of an `agent_run` target. A diagram's reference put back under
-- that name is a row asserting that a chat-answer artifact id is a job id, with
-- nothing left in the table to say otherwise.
--
-- So the guard refuses while any machine-authored row carries a kind other than
-- `agent_run`, and it names them rather than deciding for the operator. The
-- resolution is an application one — delete those documents through the product,
-- so their objects and their quota charges go with their rows — exactly as 0065's
-- down migration says about the pair of rows it cannot represent. Deleting them
-- in SQL would strand objects in SeaweedFS that no cascade can reach.
--
-- Note what this means in practice, so it is expected rather than discovered:
-- **rolling 0066 back is clean only while no diagram has been filed.** That is
-- the same window 0063's down migration has, and it is stated on the rollout
-- page for the same reason.
--
-- The order below is the reverse of the up migration's, and it has to be: the
-- 0063 CHECK being restored names `authored_by_run_id`, so the column has to
-- carry that name again before the constraint can be written against it.
--
-- ## Locks
--
-- The index build and the CHECK's validation scan both read `documents`; the
-- rest is catalog-only. The validation rejects nothing — every row that
-- satisfies 0066's three-column constraint satisfies 0063's two-column one by
-- construction — and the index cannot reject anything either, because the guard
-- above has already established that the only rows it covers are the ones 0065's
-- key already kept apart.

-- ---------------------------------------------------------------------------
-- 1. Refuse to put a reference back under a name that would misdescribe it
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  mistyped text;
BEGIN
  SELECT string_agg(entry, E'\n  ' ORDER BY entry) INTO mistyped
  FROM (
    SELECT format(
             'organization %s, project %s, producer %L, reference kind %L (%s documents)',
             "organization_id",
             "project_id",
             "authored_by_producer",
             "authored_by_ref_kind",
             count(*)
           ) AS entry
    FROM "documents"
    WHERE "authored_by" <> 'user'
      AND "authored_by_ref_kind" IS DISTINCT FROM 'agent_run'
    GROUP BY "organization_id", "project_id", "authored_by_producer", "authored_by_ref_kind"
  ) AS rows_that_are_not_runs;

  IF mistyped IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot roll back migration 0066: machine-authored documents carry a reference that is not a backend run id.\n  %\nRolling back renames the column to authored_by_run_id and drops the kind, so these rows would claim to name a run they cannot name — and that value is also the id of the agent_run target on their document.generated audit events. Delete these documents through the application first, so the stored object and the quota charge go with the row.',
      mistyped;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Back to 0063's constraint, over 0063's column names
-- ---------------------------------------------------------------------------
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT IF EXISTS "documents_authorship_requires_provenance";

--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN IF EXISTS "authored_by_ref_kind";

--> statement-breakpoint
ALTER TABLE "documents" RENAME COLUMN "authored_by_ref" TO "authored_by_run_id";

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_documents_authored_run_producer_per_project"
  ON "documents" ("organization_id", "project_id", "authored_by_run_id", "authored_by_producer")
  WHERE "authored_by" <> 'user';

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_documents_authored_ref_producer_per_project";

--> statement-breakpoint
ALTER TABLE "documents"
  ADD CONSTRAINT "documents_authorship_requires_provenance"
  CHECK (
    "authored_by" = 'user'
    OR ("authored_by_producer" IS NOT NULL AND "authored_by_run_id" IS NOT NULL)
  )
  NOT VALID;

--> statement-breakpoint
ALTER TABLE "documents" VALIDATE CONSTRAINT "documents_authorship_requires_provenance";

-- ---------------------------------------------------------------------------
-- 3. The catalog comments 0063 and 0065 wrote, restored with their objects
-- ---------------------------------------------------------------------------
--> statement-breakpoint
COMMENT ON COLUMN "documents"."authored_by_run_id" IS
  'The backend async job id of the run that wrote an authored_by <> user document; NULL for everything a person uploaded. Required together with authored_by_producer (documents_authorship_requires_provenance) because a machine-written document nobody can trace back to a run is an audit trail in appearance only.';

--> statement-breakpoint
COMMENT ON INDEX "uniq_documents_authored_run_producer_per_project" IS
  'One machine-authored document per (organization, project, run, producer). The columns are exactly the WHERE clause of findDocumentAuthoredByRun, because an index narrower than that probe rejects rows the probe would accept, and an index wider than it admits duplicates the probe was meant to prevent. Supersedes uniq_documents_authored_run_per_project (0064), which keyed on the first three columns only and so allowed a run to file at most one document — impossible for a diagram, which is a previewable SVG and an attachable PDF and needs both. Partial on authored_by <> ''user'' because 0063''s CHECK deliberately allows a HUMAN row to carry a run id as well, and two people saving the same run''s artefact into one project must not collide. A NULL producer is not covered (NULL never equals NULL), which 0063''s documents_authorship_requires_provenance CHECK makes unreachable for these rows.';
