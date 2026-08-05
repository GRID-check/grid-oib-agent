# Startup Flow

This document describes the detailed boot sequence when `docker compose up -d` is run.

## Sequence Diagram

```
docker compose up -d --build
         │
         ├── 1. Compose parses docker-compose.yaml
         │      • Reads --env-file ../.env
         │      • Resolves variables (${VAR:-default})
         │      • Determines build order from depends_on
         │
         ├── 2. postgres:16-alpine starts
         │      • Container name: aiq-postgres
         │      • Runs /docker-entrypoint-initdb.d/init-db.sql
         │      │   • Creates aiq_checkpoints database
         │      │   • Creates grid_app database
         │      │   • Grants ALL on all 3 DBs to aiq user
         │      │   • Connects to aiq_jobs
         │      │   │   • Creates job_info table
         │      │   │   • Creates job_access table
         │      │   │   • Creates job_events table
         │      │   │   • Creates document_metadata table
         │      │   • Connects to aiq_checkpoints
         │      │   │   • Creates checkpoint_migrations table
         │      │   │   • Creates checkpoints table
         │      │   │   • Creates checkpoint_blobs table
         │      │   │   • Creates checkpoint_writes table
         │      │   └── All statements use IF NOT EXISTS (idempotent)
         │      • Healthcheck passes (pg_isready on all 3 DBs)
         │
         ├── 3. seaweedfs starts
         │      • Ports: 8333 (S3 API), 8888 (Filer UI), 9333 (Master)
         │      • Entrypoint writes s3.json from SEAWEED_ACCESS_KEY/SECRET_KEY,
         │        then: weed server -dir=/data -s3 -s3.config=... -s3.port=8333
         │      • Healthcheck: wget http://localhost:9333/cluster/status
         │
         ├── 4. seaweedfs-init runs (depends on seaweedfs healthy)
         │      • echo 's3.bucket.create -name grid-documents' | weed shell -master=seaweedfs:9333
         │      • Container exits (one-shot)
         │
         ├── 5. aiq-agent starts (depends on postgres + seaweedfs healthy)
         │      • Container name: aiq-agent
         │      • ENTRYPOINT: python /app/deploy/entrypoint.py
         │      │
         │      │   entrypoint.py:
         │      │   1. Reads CONFIG_FILE, HOST, PORT, DASK_* env vars
         │      │   2. Starts dask-scheduler on port 8786
         │      │   3. Polls scheduler up to 30s until ready
         │      │   4. Starts dask-worker connecting to scheduler
         │      │      • nworkers (default 1), nthreads (default 4)
         │      │      • Optional: memory-limit, lifetime, lifetime-restart
         │      │   5. Waits 3s for worker to connect
         │      │   6. Sets NAT_DASK_SCHEDULER_ADDRESS env var
         │      │   7. Starts python /app/deploy/start_web.py as subprocess
         │      │
         │      │   start_web.py:
         │      │   1. Configures logging (LOG_LEVEL, format)
         │      │   2. Loads NAT config YAML via nat.runtime.loader.load_config()
         │      │      • Validates with Pydantic
         │      │   3. Sets NAT_CONFIG_FILE env var for NAT's FastAPI app
         │      │   4. Reads runner_class from config.general.front_end
         │      │      • Sets NAT_FRONT_END_WORKER (e.g., aiq_api.plugin.AIQAPIWorker)
         │      │   5. Runs uvicorn directly:
         │      │      • App: nat.front_ends.fastapi.main:get_app (factory)
         │      │      • Host: 0.0.0.0, Port: 8000
         │      │      • loop="asyncio" (avoids event loop conflict)
         │      │
         │      • Healthcheck: polls http://localhost:8000/health
         │      • Registers FastAPI extension routes:
         │      │   • /api/v1/collections/* (CRUD)
         │      │   • /api/v1/documents/* (management)
         │      │   • /api/v1/ingest/* (file ingestion)
         │      └── AIQ API worker starts (async job processing with SSE)
         │
         └── 6. frontend starts (depends on aiq-agent + postgres + seaweedfs healthy)
                • Container name: aiq-blueprint-ui
                • CMD: node node_modules/drizzle-kit/bin.js migrate && node server.js
                │
                │   Step 6a: Drizzle Kit migration
                │   • Reads GRID_APP_DATABASE_URL for grid_app database
                │   • Runs pending migrations from drizzle/ directory
                │   • Creates/updates grid_app schema tables
                │
                │   Step 6b: server.js starts
                │   • Production mode (NODE_ENV=production)
                │   • Initializes Next.js internally on port 3001
                │   • Prepares Next.js app
                │   • Starts HTTP server on port 3000
                │   • HTTP: handles via Next.js directly
                │   • WebSocket /websocket: proxies to Python backend
                │   • WebSocket other: handled by Next.js
                │   • Enables keep-alive (15s), disables timeouts
                │
                • Healthcheck: curl -f http://localhost:3000/
```

## Healthcheck Propagation

Docker Compose uses `depends_on: condition: service_healthy` which means each service only starts after its dependencies pass their healthchecks:

```
postgres ──► aiq-agent ──► frontend
seaweedfs ─► seaweedfs-init ──► aiq-agent ──► frontend
                           postgres ─────► frontend
```

If a dependency fails its healthcheck within the retry limit, the dependent service never starts.

## Retry / Reconnect Behavior

- **PostgreSQL**: PostgreSQL manages its own connections. The Docker healthcheck runs `pg_isready` on all 3 databases every 5 seconds.
- **SeaweedFS**: Healthcheck runs `wget http://localhost:9333/cluster/status` every 5 seconds.
- **aiq-agent**: The Dask scheduler startup has a 30-attempt loop (1s per attempt). After that, the agent relies on Docker's `restart: unless-stopped` for crash recovery. There is no built-in reconnection to PostgreSQL or SeaweedFS if they become unavailable after startup.
- **frontend**: Same `restart: unless-stopped` policy. No built-in reconnection logic beyond Docker restart.

## Manual Step: OIB Ingestion

After the stack starts, OIB PDFs must be ingested into ChromaDB:

```bash
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python scripts/ingest_oib.py
```

This command:
1. Enumerates PDFs in `data/oib/`
2. Computes SHA-256 hashes and compares against `data/oib_registry.json`
3. Uploads new/changed files to the LlamaIndex ingestor
4. Polls file status until SUCCESS or FAILED (2s interval, 600s timeout)
5. Records successful hashes so unchanged files are skipped on next run

## Row-level security roles and migrations (ADR-0041)

Migrations no longer run from the `frontend` container in compose. The one-shot
`grid-migrate` service runs, in order:

1. `node scripts/ensure-rls-roles.mjs` — creates `grid_app_rw` and
   `grid_app_platform` if absent and syncs the runtime password from
   `GRID_APP_DATABASE_URL`. Idempotent and fail-soft.
2. `node node_modules/drizzle-kit/bin.cjs migrate` — as the schema owner via
   `GRID_APP_MIGRATION_DATABASE_URL`, because DDL and backfills need the owner
   (row-level security does not apply to it).

`frontend` then starts with `command: ["node", "server.js"]` and connects as
`grid_app_rw`. On Kubernetes the roles come from CloudNativePG's
`managed.roles` instead and the migration Job does step 2 alone.

## Init Database Script

The `init-db.sql` script (`deploy/compose/init-db.sql`) runs as part of PostgreSQL initialization. It creates 3 databases and their schemas. Key details:

- **aiq_jobs** database: Contains `job_info`, `job_access`, `job_events`, and `document_metadata` tables.
- **aiq_checkpoints** database: Contains `checkpoints`, `checkpoint_blobs`, `checkpoint_writes`, and `checkpoint_migrations` tables for LangGraph state persistence.
- **grid_app** database: Created but left empty (schema managed by Drizzle Kit migrations from the frontend).

The LangGraph checkpoint tables are created in the init script (not lazily by the application) to prevent crashes if PostgreSQL restarts while the backend is running — previously, restarts would drop the tables and running backends would crash with "relation checkpoints does not exist".
