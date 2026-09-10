-- Reverse 0085: `project_memory.embedded_at` and `project_memory.created_by`
-- return, NULL on every row.
--
-- No data is restored, and none was lost that mattered. `embedded_at` is
-- derivable — a row with a vector was embedded, and the fingerprint says
-- whether that vector is still comparable — so the honest reconstruction is
-- NULL rather than a timestamp invented from `updated_at`. `created_by` named
-- the author of a user-written note; the row still states `provenance_type =
-- 'user'`, which is the fact the product actually renders.
--
-- The application code of the same change no longer writes or reads either
-- column, so re-applying this is a schema-only step: it makes the rollback of
-- a deployment possible, it does not make the columns live again.

ALTER TABLE "project_memory"
  ADD COLUMN IF NOT EXISTS "embedded_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "created_by" text;
