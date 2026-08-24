-- Manual down migration (drizzle-kit has no down support; mirrors 0019/0020/0021's
-- convention). Reverts the documents storage-key column name back to minio_key.
ALTER TABLE "documents" RENAME COLUMN "storage_key" TO "minio_key";
