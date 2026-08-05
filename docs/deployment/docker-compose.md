# Docker Compose Service Reference

The Docker Compose file is at `deploy/compose/docker-compose.yaml`. It defines 5 services, 4 named volumes, and 1 bridge network.

## Quick Start

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml up -d --build
```

For the release build target (no CLI, production-optimized):

```bash
BUILD_TARGET=release docker compose --env-file ../.env -f docker-compose.yaml up -d --build
```

To use pre-built images from a registry (skips local build):

```bash
BACKEND_IMAGE=nvcr.io/nvidia/blueprint/aiq-agent:2.0.0 \
FRONTEND_IMAGE=nvcr.io/nvidia/blueprint/aiq-frontend:2.0.0 \
docker compose --env-file ../.env -f docker-compose.yaml up -d
```

## Services

### aiq-agent

The Python backend service running NAT + FastAPI.

| Property | Value |
|----------|-------|
| Image | `nvcr.io/nvidia/blueprint/aiq-agent:2.0.0` (override with `BACKEND_IMAGE`) |
| Build context | `../../` (repo root) |
| Dockerfile | `deploy/Dockerfile` |
| Build target | `${BUILD_TARGET:-dev}` (dev = CLI included, release = web only) |
| Container name | `aiq-agent` |
| Ports | `${PORT:-8000}:8000` |
| Env file | `../.env` |
| Networks | `aiq-network` |

**Key environment variables** (set in compose, can be overridden via .env):

| Variable | Default |
|----------|---------|
| `APP_ENV` | `production` |
| `NAT_JOB_STORE_DB_URL` | `postgresql+asyncpg://aiq:aiq_dev@postgres:5432/aiq_jobs` |
| `AIQ_CHECKPOINT_DB` | `postgresql://aiq:aiq_dev@postgres:5432/aiq_checkpoints` |
| `AIQ_SUMMARY_DB` | `postgresql+psycopg://aiq:aiq_dev@postgres:5432/aiq_jobs` |
| `AIQ_CHROMA_DIR` | `/app/data/chroma_data` |
| `CONFIG_FILE` | `/app/configs/config_grid_oib.yml` |
| `HOST` | `0.0.0.0` |
| `PORT` | `8000` |
| `DASK_NWORKERS` | `1` |
| `DASK_NTHREADS` | `4` |

**Volumes**:

| Mount | Purpose |
|-------|---------|
| `../../configs:/app/configs:ro` | NAT workflow YAML configs |
| `../../data/oib:/app/data/oib:ro` | OIB Richtlinien PDFs |
| `aiq-data:/app/data` | Persistent data (summaries DB, job DB) |
| `chroma_data:/app/data/chroma_data` | ChromaDB vector persistence |

**Healthcheck**: `python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"` — interval 15s, timeout 10s, retries 10, start period 30s.

**Depends on**: `seaweedfs` (healthy), `postgres` (healthy).

**Restart**: `unless-stopped`.

### seaweedfs

S3-compatible object storage for documents (single `weed server -s3` process).

| Property | Value |
|----------|-------|
| Image | `chrislusf/seaweedfs:3.80` |
| Container name | (auto-generated) |
| Ports | `8333:8333` (S3 API), `8888:8888` (Filer UI), `9333:9333` (Master) |
| Networks | `aiq-network` |

**Environment**:

| Variable | Value |
|----------|-------|
| `SEAWEED_ACCESS_KEY` | `seaweedadmin` |
| `SEAWEED_SECRET_KEY` | `seaweedadmin` |

**Command**: an `sh -c` entrypoint writes an S3 identity config from the
access/secret keys, then starts the all-in-one server:
```bash
mkdir -p /etc/seaweedfs &&
printf '{"identities":[{"name":"grid","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\n' "$SEAWEED_ACCESS_KEY" "$SEAWEED_SECRET_KEY" > /etc/seaweedfs/s3.json &&
exec weed server -dir=/data -volume.max=0 -s3 -s3.config=/etc/seaweedfs/s3.json -s3.port=8333
```
`-volume.max=0` auto-sizes the volume count from available disk space instead
of the default cap of 8 volumes — with a fixed max, writes eventually fail with
"volume grow request failed" once the volume server hits it, even though disk
space remains.

Generating the config from env at boot means the same service definition works
for both dev (hardcoded keys) and Coolify (generated secret) — SeaweedFS has no
`MINIO_ROOT_*`-style credential env; it reads identities from `-s3.config`.

**Volume**: `seaweedfs-data:/data`

**Healthcheck**: `wget -q -O /dev/null http://localhost:9333/cluster/status` —
the master status endpoint (auth-free 200) — interval 5s, timeout 5s, retries
10, start_period 15s. Bucket readiness is gated separately by `seaweedfs-init`.

**Restart**: `unless-stopped`.

### seaweedfs-init

One-shot container to create the `grid-documents` bucket. SeaweedFS does not
auto-create buckets (a put to a missing bucket returns `NoSuchBucket`), so the
app services wait on this via `service_completed_successfully`.

| Property | Value |
|----------|-------|
| Image | `chrislusf/seaweedfs:3.80` |
| Entrypoint | `/bin/sh -c` |
| Networks | `aiq-network` |

**Command**:
```bash
echo 's3.bucket.create -name grid-documents' | weed shell -master=seaweedfs:9333 || true
```
`weed shell` reaches the filer via the master; `|| true` keeps re-runs
idempotent (bucket-already-exists is a successful no-op).

**Depends on**: `seaweedfs` (healthy).

This container runs, creates the bucket, and exits. It is not restarted.

### grid-migrate

One-shot migrator, and the reason `frontend` no longer migrates. It provisions
the row-level-security roles (`scripts/ensure-rls-roles.mjs`) and then runs
`drizzle-kit migrate`, in that order — migration 0030 asserts the roles and
aborts without them, and `init-db.sql` only creates them when Postgres
initialises a **fresh** data directory, so an upgraded stack would otherwise
never get them.

It is the only long-running-image container that holds
`GRID_APP_MIGRATION_DATABASE_URL` (the schema owner). Keeping that credential
out of the container that serves requests is the point: row-level security does
not apply to a table's owner, so a bug that reached it would have a full bypass
inside the very process the boundary is meant to constrain. `frontend`,
`purger` and `workflow-scheduler` all wait on it via
`depends_on: { condition: service_completed_successfully }`.

Runbook: [row-level security](../database/row-level-security.md), ADR-0041.

### frontend

The Next.js UI application.

| Property | Value |
|----------|-------|
| Image | `nvcr.io/nvidia/blueprint/aiq-frontend:2.0.0` (override with `FRONTEND_IMAGE`) |
| Build context | `../../frontends/ui` |
| Dockerfile | `deploy/Dockerfile` |
| Container name | `aiq-blueprint-ui` |
| Ports | `${FRONTEND_PORT:-3000}:3000` |
| Networks | `aiq-network` |

**Environment**:

| Variable | Default / Source |
|----------|------------------|
| `REQUIRE_AUTH` | `${REQUIRE_AUTH:-false}` |
| `BACKEND_URL` | `${BACKEND_URL:-http://aiq-agent:8000}` |
| `GRID_APP_DATABASE_URL` | `${GRID_APP_DATABASE_URL:-postgresql://grid_app_rw:${GRID_APP_RUNTIME_PASSWORD:-grid_app_rw_dev}@postgres:5432/grid_app}` — the least-privilege role, subject to row-level security (ADR-0041). Migrations use the owner credential in `GRID_APP_MIGRATION_DATABASE_URL`, set only on `grid-migrate`. |
| `WORKOS_CLIENT_ID` | `${WORKOS_CLIENT_ID}` |
| `WORKOS_API_KEY` | `${WORKOS_API_KEY}` |
| `WORKOS_REDIRECT_URI` | `${WORKOS_REDIRECT_URI:-http://localhost:3000/api/auth/callback}` |
| `WORKOS_COOKIE_PASSWORD` | `${WORKOS_COOKIE_PASSWORD}` |
| `FILE_UPLOAD_ACCEPTED_TYPES` | `${FILE_UPLOAD_ACCEPTED_TYPES:-.pdf,.docx,.txt,.md}` |
| `SEAWEED_ENDPOINT` | `http://seaweedfs:8333` (hardcoded in compose) |
| `SEAWEED_ACCESS_KEY` | `seaweedadmin` (hardcoded in compose) |
| `SEAWEED_SECRET_KEY` | `seaweedadmin` (hardcoded in compose) |
| `SEAWEED_BUCKET` | `grid-documents` (hardcoded in compose) |
| `SEAWEED_PRESIGNED_URL_TTL_SECONDS` | `600` (hardcoded in compose) |

**Resource limits**:

| Resource | Limit | Reservation |
|----------|-------|-------------|
| CPU | 0.5 | 0.1 |
| Memory | 512M | 256M |

**Healthcheck**: `curl -f http://localhost:3000/` — interval 30s, timeout 10s, start period 30s, retries 3.

**Depends on**: `grid-migrate` (completed successfully), `aiq-agent` (healthy), `seaweedfs` (healthy), `postgres` (healthy).

**Restart**: `unless-stopped`.

### postgres

PostgreSQL 16 database.

| Property | Value |
|----------|-------|
| Image | `postgres:16-alpine` |
| Container name | `aiq-postgres` |
| Ports | `5432:5432` |
| Networks | `aiq-network` |

**Environment**:

| Variable | Value |
|----------|-------|
| `POSTGRES_USER` | `aiq` |
| `POSTGRES_PASSWORD` | `aiq_dev` |
| `POSTGRES_DB` | `aiq_jobs` |

**Volumes**:

| Mount | Purpose |
|-------|---------|
| `postgres-data:/var/lib/postgresql/data` | Persistent database storage |
| `./init-db.sql:/docker-entrypoint-initdb.d/init-db.sql:ro` | Initialization script |

**Resource limits**:

| Resource | Limit | Reservation |
|----------|-------|-------------|
| CPU | 2 | 1 |
| Memory | 4G | 2G |

**Healthcheck**: `pg_isready -U aiq -d aiq_jobs && pg_isready -U aiq -d aiq_checkpoints && pg_isready -U aiq -d grid_app` — interval 5s, timeout 5s, retries 5.

**Restart**: `unless-stopped`.

## Volumes

| Name | Driver | Mounted By |
|------|--------|------------|
| `aiq-data` | local | aiq-agent (`/app/data`) |
| `chroma_data` | local | aiq-agent (`/app/data/chroma_data`) |
| `seaweedfs-data` | local | seaweedfs (`/data`) |
| `postgres-data` | local | postgres (`/var/lib/postgresql/data`) |

## Networks

| Name | Driver | Services |
|------|--------|----------|
| `aiq-network` | bridge | All 5 services |

## Build Targets

The backend `deploy/Dockerfile` defines two build targets:

### dev (default)

- Based on `nvcr.io/nvidia/distroless/python:3.13-v4.0.5`
- Includes CLI (`aiq-research`) and debug UI (`aiq_debug`)
- Includes Node.js 22 for frontend development inside the dev container
- `APP_ENV` defaults to `development` (when unset, compose default is `production`)

### release

- Based on `nvcr.io/nvidia/distroless/python:3.13-v4.0.5`
- Web only — no CLI, no debug UI, no Node.js
- `APP_ENV` is hardcoded to `production`
- Validates required environment variables at startup

Select with: `BUILD_TARGET=release docker compose ... up -d --build`
