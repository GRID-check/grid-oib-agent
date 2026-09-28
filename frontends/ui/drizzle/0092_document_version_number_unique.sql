-- 0092: one version number per document, held by the database.
--
-- ## The gap this closes
--
-- `document_versions.version_number` had an index on `(document_id,
-- version_number)` and no uniqueness. The number was `max(version_number) + 1`,
-- read in one statement and inserted in another, and the upload paths read it
-- even earlier — before the bytes went to SeaweedFS — to build the `v<n>/`
-- storage key. Two overlapping re-uploads of one filename therefore read the
-- same N, wrote their bytes to the SAME object key (the second PUT silently
-- replacing the first), and both recorded „Version N". Nothing refused either.
--
-- The application now allocates the number INSIDE the inserting transaction,
-- under a per-document advisory lock (`allocateVersionNumber`,
-- `lib/documents/version-repository.ts`), and gives every write its own object
-- key (`v<n>/<write id>/<file>`), so the number in a key is a hint and never an
-- identity. This constraint is the ratchet under both: a path that forgets the
-- lock gets a 23505 instead of a second „Version N".
--
-- ## Existing duplicates
--
-- The race above could already have happened, and `ADD CONSTRAINT … UNIQUE`
-- fails the deploy on the first pair. So before the constraint, every row that
-- shares its number with an EARLIER row of the same document (by `created_at`,
-- then `id`) is moved to the end of that document's history: `max + 1`,
-- `max + 2`, … in creation order. Deliberately the minimal touch:
--
--   - the earliest row of each pair keeps its number, and so does every row
--     that was never ambiguous — audit events and review comments that say
--     „Version 4" still name the row they named;
--   - no storage key changes. A key is where the bytes ARE, and the number in a
--     key was never read back as the version's number;
--   - no state changes. A duplicate that is `published` stays the published
--     one, which `uniq_document_versions_published_per_document` already made
--     unique on its own.
--
-- A document with no duplicates is not touched at all; on a deployment where
-- the race never fired the UPDATE matches zero rows.
--
-- ## Why a constraint, and why the plain index goes
--
-- A named UNIQUE constraint rather than a bare unique index, so the 23505 a
-- forgotten lock produces names `document_versions_document_id_version_number_key`
-- and the drizzle schema can declare it (`unique(...)`). Its backing index covers
-- exactly the columns `idx_document_versions_document` did, in the same order,
-- so the plain index is redundant and is dropped.
--
-- ## RLS
--
-- Untouched, and this migration is deliberately NOT in `BOUNDARY_MIGRATIONS`: no
-- table is created, dropped or renamed, and a constraint does not move a
-- table's policy. `document_versions` was secured by 0082.

--> statement-breakpoint
WITH ranked AS (
  SELECT
    v."id",
    v."document_id",
    row_number() OVER (
      PARTITION BY v."document_id", v."version_number"
      ORDER BY v."created_at", v."id"
    ) AS "dup_rank"
  FROM "document_versions" v
),
movers AS (
  SELECT
    r."id",
    r."document_id",
    row_number() OVER (
      PARTITION BY r."document_id"
      ORDER BY v."created_at", v."id"
    ) AS "offset"
  FROM ranked r
  JOIN "document_versions" v ON v."id" = r."id"
  WHERE r."dup_rank" > 1
),
ceilings AS (
  SELECT "document_id", max("version_number") AS "top"
  FROM "document_versions"
  WHERE "document_id" IN (SELECT "document_id" FROM movers)
  GROUP BY "document_id"
)
UPDATE "document_versions" v
SET "version_number" = c."top" + m."offset",
    "updated_at" = now()
FROM movers m
JOIN ceilings c ON c."document_id" = m."document_id"
WHERE v."id" = m."id";

--> statement-breakpoint
ALTER TABLE "document_versions"
  ADD CONSTRAINT "document_versions_document_id_version_number_key"
  UNIQUE ("document_id", "version_number");

--> statement-breakpoint
COMMENT ON CONSTRAINT "document_versions_document_id_version_number_key" ON "document_versions" IS
  'One version number per document (migration 0092). The number is allocated inside the inserting transaction under a per-document advisory lock (allocateVersionNumber); a 23505 here means a path inserted a version without it.';

--> statement-breakpoint
DROP INDEX IF EXISTS "idx_document_versions_document";
