-- Reverse 0033.
--
-- DESTRUCTIVE if per-organization buckets were ever enabled: dropping the
-- column discards the only record of which bucket each object is in, and the
-- read path falls back to the shared bucket for every row — so every object
-- written into a tenant bucket becomes unreachable. The bytes survive; the
-- pointer does not.
--
-- Before running this, set SEAWEED_PER_ORG_BUCKETS=false and move any object
-- out of a tenant bucket back into the shared one (the keys are identical, so
-- it is a copy, not a rewrite).
--
-- ## Why the guard, and what it can and cannot check
--
-- The paragraph above used to be the whole protection, which made it a
-- convention: a rollback at 2am drops the column whether or not anyone read it.
-- The guard below refuses instead, so the precondition is enforced by the
-- database rather than trusted to the reader.
--
-- What it checks is that no row still NAMES a bucket other than the shared one.
-- Rows whose `storage_bucket` equals the deployment's shared bucket are fine —
-- they are what the NULL convention means, written explicitly — so they do not
-- block the rollback. What SQL cannot check is whether the objects have actually
-- been copied: bucket contents are not visible from here. That half stays a
-- documented step, and the external S3 inventory in
-- `docs/deployment/kubernetes.md` is how it gets verified.
--
-- To proceed after moving the objects, clear the pointers first:
--   UPDATE documents SET storage_bucket = NULL WHERE storage_bucket IS NOT NULL;

DO $$
DECLARE
  tenant_rows bigint;
BEGIN
  -- Skip when the column is already gone, so re-running is a no-op rather than
  -- an error about a missing column.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'documents' AND column_name = 'storage_bucket'
  ) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO tenant_rows FROM documents WHERE storage_bucket IS NOT NULL;

  IF tenant_rows > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse migration 0033: % document row(s) still record a storage bucket. '
      'Dropping the column now would make every object in a tenant bucket unreachable. '
      'Set SEAWEED_PER_ORG_BUCKETS=false, copy the objects back into the shared bucket, '
      'then clear the pointers with: UPDATE documents SET storage_bucket = NULL;',
      tenant_rows;
  END IF;
END $$;

ALTER TABLE documents DROP COLUMN IF EXISTS storage_bucket;
