-- Object storage migrated from MinIO to SeaweedFS (both S3-compatible). The
-- column stored an S3 object key all along, so this is a pure rename — the
-- values (org/<id>/project/<id>/doc/<id>/<file>) stay valid against SeaweedFS.
-- RENAME COLUMN preserves the data in place (no drop/recreate, no backfill).
ALTER TABLE "documents" RENAME COLUMN "minio_key" TO "storage_key";
