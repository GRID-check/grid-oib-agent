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

## Cutover on Coolify (recommended): the transitional stack

You cannot simply deploy the new compose over the old one — the object copy
needs **both stores reachable at the same time**, and the final compose has no
MinIO anymore. So for one deploy window the transitional stack **occupies the
active compose path** (`deploy/compose/docker-compose.coolify.yaml`) — the
normal push-triggered deploy runs the migration, no Coolify settings change
needed — while the permanent stack is parked at
`deploy/compose/docker-compose.coolify.final.yaml`. The transitional stack:

- `minio` stays up on its existing volume and existing `SERVICE_PASSWORD_MINIO`
  secret (Coolify secrets are stable per stack, so the old password still fits).
- The app **keeps using MinIO** during the transition — the `SEAWEED_*` env vars
  in the transitional file deliberately point at `http://minio:9000`, so nothing
  breaks while the copy runs. (The DB column rename also applies on this deploy;
  it is independent of which store the app talks to.)
- `seaweedfs`/`seaweedfs-init` come up exactly as in the final compose.
- `storage-migrate` (one-shot, frontend image) runs
  `node scripts/migrate-storage.mjs` MinIO → SeaweedFS and verifies, on **every
  deploy/restart** of the stack — idempotent, so re-running is cheap.

Steps:

1. Push — Coolify deploys the transitional stack automatically.
2. Watch the `storage-migrate` container logs until it prints
   `verification OK` and exits.
3. Flip: restore the final compose to the active path and push:
   ```bash
   git mv deploy/compose/docker-compose.coolify.final.yaml \
          deploy/compose/docker-compose.coolify.yaml
   git commit -m "Complete MinIO -> SeaweedFS cutover" && git push
   ```
   Do this in a quiet window — or restart `storage-migrate` (one click in
   Coolify) right before pushing, as a seconds-fast final sync. That deploy
   drops MinIO; the app now talks to SeaweedFS.
4. In the app, open/preview/download a few pre-existing documents to confirm.
5. Only then delete the orphaned `minio-data` volume. Until you do, nothing is
   lost and you can roll back by re-deploying the transitional compose (it is
   preserved in git history).

Caveat: uploads made between the last `storage-migrate` run and the flip exist
only in MinIO (that is what the pre-push restart in step 3 is for). Documents
purged during the window after being copied linger as invisible orphan bytes in
SeaweedFS — harmless.

## Cutover by hand (docker compose / other CD)

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
