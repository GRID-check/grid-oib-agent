# NVIDIA AI-Q Blueprint - Docker Compose

Use this guide to deploy the AI-Q blueprint with Docker Compose. The deployment
starts a FastAPI backend, PostgreSQL for async jobs and checkpoints, and an embedded Dask scheduler and worker for background work.

## Prerequisites

Make sure you have the following before you start:
- Docker Engine and Docker Compose v2.
- API keys for the models and tools you plan to use.
- Ports `3000`, `8000`, and `5432` available on your host.
- Enough disk space for Docker volumes and cached model artifacts.

## Files and Directories

The Docker Compose setup uses these files and folders:
- `deploy/compose/docker-compose.yaml` for the Docker Compose stack.
- `deploy/.env` for environment variables.
- `configs/config_oib_openrouter.yml` for the workflow configuration (the one shipped config).
- `deploy/compose/init-db.sql` for PostgreSQL initialization.

## Configure Environment Variables

Follow these steps to prepare your environment:
1. Copy the example environment file: `cp deploy/.env.example deploy/.env`.
2. Update `deploy/.env` with API keys and database settings.

### Backend Configuration

Set `BACKEND_CONFIG` in `deploy/.env` to select the backend workflow config:

- `/app/configs/config_oib_openrouter.yml` (default, and the only config shipped).

### Required API Keys

Set the following keys in `deploy/.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Every model, the embeddings, the VLM and the reranker route through OpenRouter. |
| `TAVILY_API_KEY` | One required | Web search provider key. |
| `SERPER_API_KEY` | One required | Web search provider key (alternative to Tavily). |

### Optional API Keys

Set these keys only if the configuration enables the related features:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | No | Required only if your config uses OpenAI models. |
| `JINA_API_KEY` | No | Required only if you enable the evaluation suite. |
| `WANDB_API_KEY` | No | Required only if you enable experiment tracking. |

### Database Settings

Choose one database configuration in `deploy/.env`:

**PostgreSQL (recommended):**
- Set `NAT_JOB_STORE_DB_URL` to
  `postgresql+asyncpg://aiq:aiq_dev@postgres:5432/aiq_jobs`.
- Set `AIQ_CHECKPOINT_DB` to
  `postgresql://aiq:aiq_dev@postgres:5432/aiq_checkpoints`.
- Set `AIQ_SUMMARY_DB` to
  `postgresql+psycopg://aiq:aiq_dev@postgres:5432/aiq_jobs`.

**SQLite (dev environment):**
- Set `NAT_JOB_STORE_DB_URL` to
  `sqlite+aiosqlite:///./data/jobs.db`.
- Set `AIQ_CHECKPOINT_DB` to
  `/app/data/checkpoints.db`.
- Leave `AIQ_SUMMARY_DB` unset (defaults to `sqlite+aiosqlite:///./summaries.db`).
- You can keep the `postgres` service running or remove the `depends_on` block
  for `aiq-agent` if you want a SQLite-only setup.

## Start Services

### Option 1: Build locally (default)

Run the following commands from the repository root:

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml up -d --build
```

### Option 2: Use pre-built images from registry

To use pre-built images instead of building locally, set the `BACKEND_IMAGE` and `FRONTEND_IMAGE` environment variables and omit the `--build` flag:

```bash
cd deploy/compose

# Login to the container registry first
docker login nvcr.io

# Run with pre-built images
BACKEND_IMAGE=nvcr.io/nvidia/blueprint/aiq-agent:2.0.0 \
FRONTEND_IMAGE=nvcr.io/nvidia/blueprint/aiq-frontend:2.0.0 \
docker compose --env-file ../.env -f docker-compose.yaml up -d
```

You can also add these to your `deploy/.env` file:

```bash
BACKEND_IMAGE=nvcr.io/nvidia/blueprint/aiq-agent:2.0.0
FRONTEND_IMAGE=nvcr.io/nvidia/blueprint/aiq-frontend:2.0.0
```

Then run without specifying them on the command line:

```bash
docker compose --env-file ../.env -f docker-compose.yaml up -d
```

Services started:
- `aiq-agent` (port 8000)
- `aiq-blueprint-ui` (port 3000)
- `postgres` (port 5432)

### Frontend runtime variables

The compose files pass these variables into the UI container:

- `REQUIRE_AUTH`: Set to `true` to require WorkOS AuthKit login, or `false` (default) for anonymous access.
- `BACKEND_URL`: Backend API URL for the UI container (default uses the backend service name).
- `WORKOS_CLIENT_ID`: WorkOS client ID (required when `REQUIRE_AUTH=true`).
- `WORKOS_API_KEY`: WorkOS API key (required when `REQUIRE_AUTH=true`).
- `WORKOS_REDIRECT_URI`: AuthKit callback URL, e.g. `http://localhost:3000/api/auth/callback` (required when `REQUIRE_AUTH=true`).
- `WORKOS_COOKIE_PASSWORD`: 32-byte random string used to encrypt the AuthKit session cookie (required when `REQUIRE_AUTH=true`).

Set these variables in `deploy/.env` and use `--env-file ../.env` when you run `docker compose`.

### Release Build

```bash
cd deploy/compose
BUILD_TARGET=release docker compose --env-file ../.env -f docker-compose.yaml up -d --build
```

## Stop Services

```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml down
# OR stop and remove volumes
docker compose --env-file ../.env -f docker-compose.yaml down -v
```

## Port Configuration

You can customize the host ports if the defaults conflict with other services:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8000 | Backend API host port |
| `FRONTEND_PORT` | 3000 | Frontend UI host port |

Set these variables in `deploy/.env` or pass them on the command line:

```bash
PORT=8100 docker compose --env-file ../.env -f docker-compose.yaml up -d
```

**Note**: The backend API always runs on port 8000 inside the container. The `PORT` variable only changes the host port mapping.

Common conflicts:
- RAG Blueprint `page-elements` service uses ports 8000-8002. Set `PORT=8100` to avoid this conflict.
- Other development servers may use common ports like 8000, 8080, or 3000.

## Troubleshooting

**Check logs:**
```bash
docker logs aiq-agent -f
docker logs aiq-blueprint-ui -f
docker logs aiq-postgres -f
```

**Health check:**
```bash
curl http://localhost:8000/health
```

**Database connection:**
```bash
docker exec -it aiq-postgres psql -U aiq -d aiq_jobs
```

**Rebuild:**
```bash
cd deploy/compose
docker compose --env-file ../.env -f docker-compose.yaml down
docker compose --env-file ../.env -f docker-compose.yaml build --no-cache
docker compose --env-file ../.env -f docker-compose.yaml up -d
```

## Custom Startup Script

The container uses `start_web.py` instead of `nat serve` to avoid asyncio event loop conflicts between the
NeMo Agent toolkit runtime and FastAPI/Starlette anyio event loop management. See [start_web.py](../start_web.py)
for details.

## Security

- Non-root user (`aiq`, UID 1000)
- Read-only config mounts

## Next Steps

- [Main README](../../README.md)
- [Development and Contributing Guide](../../CONTRIBUTING.md)
