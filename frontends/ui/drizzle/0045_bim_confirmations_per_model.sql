-- A human confirmation belongs to a BUILDING, not to a project.
--
-- ## The bug
--
-- 0035 keyed a confirmation on `(organization, project, rule)` — "a rule has
-- exactly one current human verdict" — and reasoned about it entirely in terms
-- of REVISIONS of one model: a newer revision arrives, `model_id` no longer
-- matches, the confirmation shows as stale. All of that is right, and all of it
-- assumed a project contains one building.
--
-- Projects do not. `Haus-A.ifc` and `Nebengebäude.ifc` sit side by side in the
-- ordinary case, and the viewer's own model rail is built for exactly that. Two
-- buildings sharing one confirmation row produced two failures, and the second
-- is the serious one:
--
--   1. **Mislabelling.** A confirmation made on Haus-A appeared on
--      Nebengebäude's Prüfbuch marked "Älterer Stand" — which is false twice
--      over. It is not an older revision; it is a different building, and
--      nothing about it says anything about this one.
--
--   2. **Silent loss of a signature.** Confirming the same rule on
--      Nebengebäude UPDATED Haus-A's row in place. The architect who signed
--      off `oib2-feuerwiderstand-tragend` on Haus-A last month opens it again
--      and their confirmation is simply gone — no record, no note, no
--      indication it ever existed. In a product whose Prüfbuch exists to
--      assemble something a person signs, that is the worst thing this table
--      can do.
--
-- ## The key
--
-- `(organization, project, rule, model)`. One row per rule per revision, so no
-- revision and no building can overwrite another's.
--
-- That does mean the table now keeps a row per revision rather than updating
-- one in place — which 0035 deliberately avoided as "a history nobody reads".
-- Two things changed that judgement. It is not a history, it is the record of
-- who signed what and against which file, which is the one thing here worth
-- keeping. And it is bounded by revisions × confirmed rules, i.e. tens of rows
-- for a project that is actively being worked, against a table that holds
-- nothing but text.
--
-- Which row is SHOWN is now a read-side decision (`attachConfirmations`): the
-- one against the model on screen if there is one, otherwise the most recent
-- one from another revision of the same building — marked stale, exactly as
-- before — and never one belonging to a different building at all. The
-- building is read from the file name, the same way the revision timeline
-- reads it (`lib/bim/revision-series.ts`), because a lineage column is a
-- column nobody fills in.
--
-- ## Migrating the existing rows
--
-- Nothing to do. Every existing row already carries a `model_id`, and dropping
-- a unique constraint cannot make an existing set of rows violate the wider one
-- that replaces it — `(org, project, rule)` unique implies `(org, project,
-- rule, model)` unique. No backfill, no deduplication, no data touched.
--
-- ## Locks
--
-- `DROP CONSTRAINT` is catalog-only. `ADD CONSTRAINT ... UNIQUE` builds an
-- index and takes an ACCESS EXCLUSIVE lock on `bim_check_confirmations` while
-- it does, which is a table with one row per confirmed rule per project — tens
-- of rows in the largest tenant. Not worth a CONCURRENTLY dance.
--
-- ## RLS
--
-- Untouched. The table was secured by 0035 and a constraint change does not
-- move it in or out of the tenant boundary, so this migration deliberately
-- makes no `grid_secure_table` call (`rls-coverage.spec.ts` reads those to
-- decide what is inside the boundary).

ALTER TABLE "bim_check_confirmations"
  DROP CONSTRAINT IF EXISTS "bim_check_confirmations_unique";
--> statement-breakpoint
ALTER TABLE "bim_check_confirmations"
  ADD CONSTRAINT "bim_check_confirmations_unique"
  UNIQUE ("organization_id", "project_id", "rule_id", "model_id");
--> statement-breakpoint

-- The next person reads `\d+ bim_check_confirmations`, not this file.
COMMENT ON CONSTRAINT "bim_check_confirmations_unique" ON "bim_check_confirmations" IS
  'One human verdict per rule per MODEL REVISION. Not per project: two buildings in one project would otherwise share a row, so confirming a rule on the second silently overwrote the signature on the first. Which row is displayed is decided on read (attachConfirmations): the current revision''s, else the newest from the same building, marked stale.';
