# MinIO → SeaweedFS data migration

The MinIO → SeaweedFS switch keeps the **same bucket name** (`grid-documents`)
and the **same object-key layout** (`lib/s3.ts` `buildStorageKey`), so migrating
data is a straight 1:1 object copy — no re-ingestion, and the
`documents.storage_key` pointers keep resolving unchanged.

Switching the running service does **not** move data on its own: a fresh
SeaweedFS starts empty, and every existing document would become a dangling
pointer. Copy the objects **before** cutting the app over.

## No data loss — the guarantees

- The DB change is a pure `RENAME COLUMN` (`minio_key` → `storage_key`); values
  are untouched (migration `0023`).
- The copy script only **reads** from MinIO and **writes** to SeaweedFS — it
  never deletes from either side, so a bad run cannot lose data.
- It is **idempotent**: objects already present in the destination with a
  matching size are skipped, so you can re-run it (e.g. a final sync at cutover).

## Cutover procedure

Run SeaweedFS **alongside** the still-running MinIO — do not tear MinIO down yet.

```bash
cd frontends/ui

# 1. Preview (reads only, changes nothing)
SRC_ENDPOINT=http://localhost:9000 SRC_ACCESS_KEY=minioadmin  SRC_SECRET_KEY=minioadmin \
DST_ENDPOINT=http://localhost:8333 DST_ACCESS_KEY=seaweedadmin DST_SECRET_KEY=seaweedadmin \
npm run migrate:storage -- --dry-run

# 2. Copy everything (same env as above, drop --dry-run)
npm run migrate:storage

# 3. Confirm the destination matches the source
npm run migrate:storage -- --verify-only
```

`SRC_*` fall back to the legacy `MINIO_*` and `DST_*` to the new `SEAWEED_*`, so
a box that still has both env sets configured needs no extra wiring. Bucket names
default to `grid-documents` (`SRC_BUCKET` / `DST_BUCKET` to override), and
`MIGRATE_CONCURRENCY` (default 8) bounds parallel transfers.

Then:

4. Apply the DB rename — the app runs `drizzle-kit migrate` on boot, or run
   `npm run db:migrate` manually.
5. Point the app at SeaweedFS (`SEAWEED_*` env) and cut traffic over. Verify
   preview/download of a few existing documents.
6. Only after verifying, retire MinIO.

## Two things that WILL lose data if skipped

- **Cutting over before the copy** → existing files unreachable (the DB points at
  objects that are not yet in SeaweedFS).
- **`docker compose down -v` before verifying** → that deletes the old
  `minio-data` volume, your source of truth. The compose rename to
  `seaweedfs-data` merely *orphans* the MinIO volume; it is not removed unless you
  force-remove volumes.

## Large objects

The script buffers one object at a time per worker — fine for documents/PDFs. For
multi-GB objects prefer a streaming tool, e.g.
`rclone sync minio:grid-documents seaweedfs:grid-documents`.
