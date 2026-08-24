-- Record which S3 bucket each document's bytes are in (ADR-0043).
--
-- ## Why a column and not a computation
--
-- Per-organization buckets are being introduced behind a flag. The obvious
-- alternative — derive the bucket from `organization_id` at read time — looks
-- simpler and is wrong: it makes the flag a CUTOVER. The instant it flips,
-- every object written before it becomes unreachable, because the read path
-- would start looking for it in a bucket it was never written to. Flipping back
-- would then strand everything written while it was on.
--
-- With the bucket recorded per row there is no cutover and no window. Turning
-- the flag on changes where the NEXT object goes and nothing else; old rows
-- keep resolving from what they recorded, indefinitely. Turning it off again is
-- equally uneventful. It is the same shape as `storage_key` itself, which is
-- why keys written under the pre-0023 `minio_key` layout still resolve today.
--
-- ## Why NULL rather than a backfill
--
-- NULL means "the shared bucket" — `SEAWEED_BUCKET`, `grid-documents` by
-- default. Every existing row means exactly that, so backfilling the literal
-- name would write millions of rows to say something already true, and would
-- bake a deployment-specific value into data that outlives the deployment. A
-- stack that renames its shared bucket keeps working; one whose rows were
-- backfilled would not.
--
-- New rows always write the bucket explicitly, including when it IS the shared
-- one, so the ambiguity is bounded to rows that predate this migration.
--
-- ## Locks
--
-- `ADD COLUMN` with no default and no constraint is metadata-only in Postgres
-- 11+: no table rewrite, no scan, ACCESS EXCLUSIVE held for the catalog update
-- alone. Safe online at any table size.

ALTER TABLE documents ADD COLUMN storage_bucket text;

COMMENT ON COLUMN documents.storage_bucket IS
  'S3 bucket holding this document''s bytes. NULL means the deployment''s shared bucket (SEAWEED_BUCKET) — see ADR-0043.';
