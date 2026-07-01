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

**Depends on**: `minio` (healthy), `postgres` (healthy).

**Restart**: `unless-stopped`.

### minio

S3-compatible object storage for documents.

| Property | Value |
|----------|-------|
| Image | `minio/minio:RELEASE.2024-06-29T01-20-47Z` |
| Container name | (auto-generated) |
| Ports | `9000:9000` (API), `9001:9001` (Console) |
| Networks | `aiq-network` |

**Environment**:

| Variable | Value |
|----------|-------|
| `MINIO_ROOT_USER` | `minioadmin` |
| `MINIO_ROOT_PASSWORD` | `minioadmin` |

**Command**: `server /data --console-address ":9001"`

**Volume**: `minio-data:/data`

**Healthcheck**: `mc ready local` — interval 5s, timeout 5s, retries 5.

**Restart**: `unless-stopped`.

### minio-init

One-shot container to create the `grid-documents` bucket.

| Property | Value |
|----------|-------|
| Image | `minio/mc:latest` |
| Entrypoint | `/bin/sh -c` |
| Networks | `aiq-network` |

**Command**:
```bash
mc alias set local http://minio:9000 minioadmin minioadmin &&
mc mb local/grid-documents --ignore-existing
```

**Depends on**: `minio` (healthy).

This container runs, creates the bucket, and exits. It is not restarted.

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
| `GRID_APP_DATABASE_URL` | `${GRID_APP_DATABASE_URL:-postgresql://aiq:aiq_dev@postgres:5432/grid_app}` |
| `WORKOS_CLIENT_ID` | `${WORKOS_CLIENT_ID}` |
| `WORKOS_API_KEY` | `${WORKOS_API_KEY}` |
| `WORKOS_REDIRECT_URI` | `${WORKOS_REDIRECT_URI:-http://localhost:3000/api/auth/callback}` |
| `WORKOS_COOKIE_PASSWORD` | `${WORKOS_COOKIE_PASSWORD}` |
| `FILE_UPLOAD_ACCEPTED_TYPES` | `${FILE_UPLOAD_ACCEPTED_TYPES:-.pdf,.docx,.txt,.md}` |
| `MINIO_ENDPOINT` | `http://minio:9000` (hardcoded in compose) |
| `MINIO_ACCESS_KEY` | `minioadmin` (hardcoded in compose) |
| `MINIO_SECRET_KEY` | `minioadmin` (hardcoded in compose) |
| `MINIO_BUCKET` | `grid-documents` (hardcoded in compose) |
| `MINIO_PRESIGNED_URL_TTL_SECONDS` | `600` (hardcoded in compose) |

**Resource limits**:

| Resource | Limit | Reservation |
|----------|-------|-------------|
| CPU | 0.5 | 0.1 |
| Memory | 512M | 256M |

**Healthcheck**: `curl -f http://localhost:3000/` — interval 30s, timeout 10s, start period 30s, retries 3.

**Depends on**: `aiq-agent` (healthy), `minio` (healthy), `postgres` (healthy).

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
| `minio-data` | local | minio (`/data`) |
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
