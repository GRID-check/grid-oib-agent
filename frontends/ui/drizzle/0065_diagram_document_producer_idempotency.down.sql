-- Back to one filed document per run, whatever produced it.
--
-- This direction NARROWS, so unlike the up migration it can fail on real data:
-- any run that filed both a diagram SVG and a diagram PDF into one project is
-- two rows that 0064's key cannot tell apart. The guard below reports all of
-- them at once rather than letting `CREATE UNIQUE INDEX` name one and leave the
-- operator to find the rest, and it deliberately does not choose which row to
-- delete — those rows carry real bytes and a real quota charge, and deleting one
-- outside the application would orphan its object in a store this file cannot
-- see. Delete them through the product, then run this again.

DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(entry, E'\n  ' ORDER BY entry) INTO duplicates
  FROM (
    SELECT format(
             'organization %s, project %s, run %L (%s documents: %s)',
             "organization_id",
             "project_id",
             "authored_by_run_id",
             count(*),
             string_agg(coalesce("authored_by_producer", '?'), ', ' ORDER BY "authored_by_producer")
           ) AS entry
    FROM "documents"
    WHERE "authored_by" <> 'user'
      AND "project_id" IS NOT NULL
      AND "authored_by_run_id" IS NOT NULL
    GROUP BY "organization_id", "project_id", "authored_by_run_id"
    HAVING count(*) > 1
  ) AS dupes;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION E'Cannot roll back migration 0065: a run has filed more than one document into one project, which 0065 allows and 0064 does not.\n  %\nThese are different artifacts of one diagram (an SVG that previews and a PDF that is attached), not duplicates — rolling back means deciding which one the office loses. Delete the extras through the application, so the stored object and the quota charge go with the row.',
      duplicates;
  END IF;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX "uniq_documents_authored_run_per_project"
  ON "documents" ("organization_id", "project_id", "authored_by_run_id")
  WHERE "authored_by" <> 'user';

--> statement-breakpoint
DROP INDEX IF EXISTS "uniq_documents_authored_run_producer_per_project";
