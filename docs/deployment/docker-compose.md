# Docker Compose Service Reference

The Docker Compose file is at `deploy/compose/docker-compose.yaml`. It defines
23 services, several named volumes, and 2 bridge networks. The backend image
runs as four of them (ADR-0082): the `chat` role (`aiq-agent`), the `api` role
(`aiq-api`), the research `agent-worker` and the `ingest-worker`, all against the
shared `chroma` server. This page describes the core ones; the observability stack
(`dragonfly`, `clickhouse`, the three `langfuse-*` services) and the four
background workers (`purger`,
`skill-scheduler`, `bff-jobs`, `housekeeping`) are defined in the compose file
with their own comments and are not covered here. `housekeeping` is the
backend's housekeeping clock (ADR-0082 step A1): the backend runs no cleanup
loop of its own, and this calls its `/v1/maintenance/housekeeping/*` routes on
the cadences Kubernetes runs as CronJobs. One of them is the base-corpus sync
(`base-corpus`, every ten minutes), which queues an ingest job for each uploaded OIB PDF that is
not indexed yet (the `ingest-worker` service claims and runs it); the backend does no sync at boot. `bff-jobs` (ADR-0079) is the frontend image
running `workers/jobs/index.js`: the BFF plus the claim loop that runs the jobs
in `bff_job_queue` (project reindex, failed-ingestion rescan, IFC extraction,
Office rendition through `gotenberg`, research-report filing), with no
published port. Without it none of them runs. It shares the frontend's environment by YAML alias, so a
variable added to `frontend` reaches it.

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

### aiq-agent (the `chat` role)

The Python backend running NAT + FastAPI as `GRID_ROLE=chat`: the chat WebSocket
and the answers running on it, plus NAT's own routes (`/generate`, `/chat`,
`/v1/chat/completions`, ...). It serves no other route. The frontend's gateway
reaches it with `BACKEND_CHAT_URL=http://aiq-agent:8000`, and nothing else does.
Every other HTTP route is [`aiq-api`](#aiq-api-the-api-role)'s.

| Property | Value |
|----------|-------|
| Image | `nvcr.io/nvidia/blueprint/aiq-agent:2.0.0` (override with `BACKEND_IMAGE`) |
| Build context | `../../` (repo root) |
| Dockerfile | `deploy/Dockerfile` |
| Build target | `${BUILD_TARGET:-dev}` (dev = CLI included, release = web only) |
| Container name | `aiq-agent` |
| Ports | `${CHAT_PORT:-8001}:8000` (the WebSocket, for a client that dials it directly, such as `task be:eval:loop`) |
| Env file | `../.env` |
| Networks | `aiq-network` |

**Key environment variables** (set in compose, can be overridden via .env):

| Variable | Default |
|----------|---------|
| `APP_ENV` | `production` |
| `NAT_JOB_STORE_DB_URL` | `postgresql+asyncpg://aiq:aiq_dev@pgbouncer:5432/aiq_jobs` (pooled) |
| `AIQ_CHECKPOINT_DB` | `postgresql://aiq:aiq_dev@pgbouncer:5432/aiq_checkpoints` (pooled) |
| `AIQ_SUMMARY_DB` | `postgresql+psycopg://aiq:aiq_dev@pgbouncer:5432/aiq_jobs` (pooled) |
| `AIQ_LISTEN_DB_URL` | `postgresql://aiq:aiq_dev@postgres:5432/aiq_jobs` (direct: SSE LISTEN/NOTIFY) |
| `AIQ_LOCK_DB_URL` | `postgresql://aiq:aiq_dev@postgres:5432/aiq_jobs` (direct: session advisory locks) |
| `GRID_ROLE` | `chat` |
| `GRID_JOB_EXECUTION` | `db` (the chat role submits research jobs in process, the api role streams and cancels them, so the jobs live in Postgres and the `agent-worker` runs them) |
| `AIQ_CHROMA_URL` | `http://chroma:8000` (no embedded fallback: the backend keeps no volume) |
| `CONFIG_FILE` | `/app/configs/config_oib_openrouter.yml` |
| `HOST` | `0.0.0.0` |
| `PORT` | `8000` |
| `DASK_NWORKERS` | `1` |
| `DASK_NTHREADS` | `4` |

The environment is written once, on this service, as a YAML anchor
(`&backend-environment`); `aiq-api`, `agent-worker` and `ingest-worker` alias it
and set their own `GRID_ROLE`, so the four cannot drift.

**Volumes**:

| Mount | Purpose |
|-------|---------|
| `../../configs:/app/configs:ro` | NAT workflow YAML configs |

There is no mount for the OIB Richtlinien PDFs: the base corpus lives in SeaweedFS
and the `oib_corpus_files` table (ADR-0082 step A2). Upload it in the admin UI, or
`scripts/upload_oib_corpus.py <directory>`; an empty corpus boots fine and answers
nothing until it is filled. A stack upgraded from before A2 needs neither: the
one-shot `legacy-corpus-import` service reads the old `aiq-data` volume and
`data/oib` read-only and stores what they held, and the base-corpus housekeeping
route indexes it. Remove the `aiq-data` volume once the knowledge view lists the
corpus. The backend keeps no volume at all: the vectors are in
the shared `chroma` server, whose one-shot `chroma-data-permissions` service
chowns its volume for the server's user before it starts.

**Healthcheck**: `python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"` — interval 15s, timeout 10s, retries 10, start period 30s.

**Depends on**: `seaweedfs` (healthy), `postgres` (healthy), `pgbouncer` (healthy), `chroma` (healthy).

**Restart**: `unless-stopped`.

### aiq-api (the `api` role)

The same image as `aiq-agent`, started as `GRID_ROLE=api`: the Knowledge API
(collections, documents, search, ingest enqueue), the Async Job API with its SSE
streams, the LLM utilities (titles, summaries, consistency check, feedback digest,
lesson distillation, skill review, note embeddings), admin, the housekeeping
routes, and the debug console. It is what `BACKEND_URL=http://aiq-api:8000` names,
for the frontend, the purger and the `housekeeping` clock. It serves no chat
socket. [`docs/api/python-endpoints.md`](../api/python-endpoints.md) lists which
role serves which route.

| Property | Value |
|----------|-------|
| Container name | `aiq-api` |
| Ports | `${PORT:-8000}:8000` (the API, `/docs`, `/debug`) |
| Environment | `aiq-agent`'s, with `GRID_ROLE=api` |
| Healthcheck | the same `/health` probe as `aiq-agent` |
| Depends on | `seaweedfs`, `postgres`, `pgbouncer`, `chroma` (healthy) |

### agent-worker

The same image as `GRID_ROLE=worker` (ADR-0021): claims research jobs from
Postgres (`FOR UPDATE SKIP LOCKED`) and runs them against the shared Chroma. No
web port. Healthy while `/tmp/research-worker.alive` is fresh; `stop_grace_period`
is 660 s, the 600 s drain budget plus the time to give claims back.

### ingest-worker

The same image as `GRID_ROLE=ingest-worker` (ADR-0076): `POST /v1/ingest`, served
by `aiq-api`, only puts a job in the durable ingest queue, and this is the one
process that claims it, fairly across organizations. With it stopped, uploads sit
pending. `AIQ_INGEST_MAX_WORKERS` (default 2) is the jobs it runs at once. No web
port. Healthy while `/tmp/ingest-worker.alive` is fresh.

### chroma

The shared vector store (`chromadb/chroma`, pinned to the client's version,
`CHROMA_IMAGE` overrides). The four backend services query it over HTTP, which an
embedded store opened by each process separately could not do. It mounts the
`chroma_data` volume at `/data`: the 1.5.9 server reads the format the embedded
store wrote, so an existing corpus needs no re-embedding.

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
`purger` and `skill-scheduler` all wait on it via
`depends_on: { condition: service_completed_successfully }`.

Runbook: [row-level security](../database/row-level-security.md), ADR-0041.

### grid-audit-schemas

One-shot reconciler for the **WorkOS Audit Log schemas**, from the same frontend
image, and the compose equivalent of the Kubernetes Job `grid-app-audit-schemas`
(`deploy/pulumi/src/app/audit-schemas-job.ts`). It runs
`node scripts/provision-workos-audit-schemas.mjs --apply`, which reads the
environment first and writes only the actions whose schema is missing or
different — so re-running it on every `up` writes nothing when the registry
(`frontends/ui/src/lib/audit/schemas.mjs`) has not changed.

**`frontend` waits on it** (`service_completed_successfully`), which the
Kubernetes Job is deliberately not waited on. The reason is
`document.generated`: it is emitted with the *throwing* audit emitter, so a
rejected event does not merely lose an audit line — the document it was about is
unfiled again, row and object both, and the user sees a report with no file and
no error. WorkOS rejects an event whose action has no schema **and** one whose
registered schema has the wrong targets or metadata keys, so this matters after
a registry change as much as on a fresh environment.

**With `WORKOS_API_KEY` unset the container prints one line and exits 0.** The
default stack is anonymous (`REQUIRE_AUTH=false`) and has no WorkOS environment
to reconcile against, so nothing is blocked. Set the key — as any stack with
login does — and WorkOS becomes a boot dependency of `frontend`, which it
already was for authentication.

| Property | Value |
|----------|-------|
| Image | `${FRONTEND_IMAGE:-…/aiq-frontend:2.0.0}` (the frontend image) |
| Container name | `aiq-blueprint-audit-schemas` |
| Environment | `WORKOS_API_KEY` (optional) |
| Depends on | nothing — it only needs egress to WorkOS |
| Restart | `"no"` |

Runbook: [WorkOS provisioning](workos-provisioning.md) §5,
[agent-authored documents rollout](agent-authored-documents-rollout.md) §3.

### frontend

The Next.js UI application.

| Property | Value |
|----------|-------|
| Image | `nvcr.io/nvidia/blueprint/aiq-frontend:2.0.0` (override with `FRONTEND_IMAGE`) |
| Build context | `../../frontends/ui` |
| Dockerfile | `deploy/Dockerfile` |
| Container name | `aiq-blueprint-ui` |
| Ports | `${FRONTEND_PORT:-3000}:3000` |
| Networks | `aiq-network`, `gotenberg-internal` |

**Environment**:

| Variable | Default / Source |
|----------|------------------|
| `REQUIRE_AUTH` | `${REQUIRE_AUTH:-false}` |
| `BACKEND_URL` | `${BACKEND_URL:-http://aiq-api:8000}` (the api role: every HTTP call) |
| `BACKEND_CHAT_URL` | `${BACKEND_CHAT_URL:-http://aiq-agent:8000}` (the chat role: the WebSocket proxy alone; required, no fallback to `BACKEND_URL`) |
| `GRID_APP_DATABASE_URL` | `${GRID_APP_DATABASE_URL:-postgresql://grid_app_rw:${GRID_APP_RUNTIME_PASSWORD:-grid_app_rw_dev}@pgbouncer:5432/grid_app}` — the least-privilege role, subject to row-level security (ADR-0041), through the pooler. Migrations use the owner credential in `GRID_APP_MIGRATION_DATABASE_URL`, set only on `grid-migrate`, straight to `postgres`. |
| `WORKOS_CLIENT_ID` | `${WORKOS_CLIENT_ID}` |
| `WORKOS_API_KEY` | `${WORKOS_API_KEY}` |
| `NEXT_PUBLIC_WORKOS_REDIRECT_URI` | `${NEXT_PUBLIC_WORKOS_REDIRECT_URI:-${WORKOS_REDIRECT_URI:-http://localhost:3000/api/auth/callback}}` |
| `WORKOS_COOKIE_PASSWORD` | `${WORKOS_COOKIE_PASSWORD}` |
| `FILE_UPLOAD_ACCEPTED_TYPES` | `${FILE_UPLOAD_ACCEPTED_TYPES:-.pdf,.docx,.txt,.md,.csv,.xlsx,.pptx}` — the same list as the code default in `frontends/ui/src/shared/config/file-upload.ts` |
| `GOTENBERG_URL` | `${GOTENBERG_URL-http://gotenberg:3000}`. Required for indexing Word, presentation, `.xls` and `.ods` files (ADR-0071). An empty value disables conversion: those files are then marked failed with a retryable reason, and `.xlsx`/`.xlsm` index without a preview. No colon in the expansion, so an empty value is kept rather than replaced by the default. The Coolify file uses `:-`, so there an empty value falls back to the bundled converter |
| `SEAWEED_ENDPOINT` | `http://seaweedfs:8333` (hardcoded in compose) |
| `SEAWEED_ACCESS_KEY` | `seaweedadmin` (hardcoded in compose) |
| `SEAWEED_SECRET_KEY` | `${SEAWEED_SECRET_KEY:?}` — **required**; the deploy fails fast if it is unset (see `deploy/.env.example`) |
| `SEAWEED_BUCKET` | `grid-documents` (hardcoded in compose) |
| `SEAWEED_PRESIGNED_URL_TTL_SECONDS` | `600` (hardcoded in compose) |

**Resource limits**:

| Resource | Limit | Reservation |
|----------|-------|-------------|
| CPU | 0.5 | 0.1 |
| Memory | 512M | 256M |

**Healthcheck**: `curl -f http://localhost:3000/api/healthz` — interval 15s, timeout 10s, start period 60s, retries 5. The dependency-free `/api/healthz`, not `/` (a full SSR render) and not `/api/health` (which proxies the backend and reports 502 while the agent boots).

**Depends on**: `grid-migrate` (completed successfully), `grid-audit-schemas` (completed successfully), `aiq-agent` (healthy), `aiq-api` (healthy), `seaweedfs` (healthy), `seaweedfs-init` (completed successfully), `postgres` (healthy), `gotenberg` (started, not healthy: a broken converter fails Word and presentation ingests retryably, and must not also take down the UI and every other upload type).

**Restart**: `unless-stopped`.

### gotenberg

Office → PDF converter (ADR-0070). The frontend BFF posts Word, Excel,
PowerPoint, ODF and RTF originals to its LibreOffice route and stores the PDF
beside the original. Nothing else calls it.

It is required. The backend indexes Word, presentation, `.xls` and `.ods`
files from that PDF and has no fallback reader (ADR-0071). While it is down, or
when a conversion fails, those files are marked failed with a retryable reason
and "Erneut lesen" recovers them. `.xlsx` and `.xlsm` still index, only without
preview or thumbnail.

| Property | Value |
|----------|-------|
| Image | `gotenberg/gotenberg:8.37.0-libreoffice` (pinned, LibreOffice-only variant; Pulumi pins the same tag, and `deploy/pulumi/src/app/gotenberg.spec.ts` fails when they differ) |
| Container name | `aiq-gotenberg` |
| Ports | none published |
| Networks | `gotenberg-internal` only |

**Command flags**:

| Flag | Why |
|------|-----|
| `--api-timeout=120s` | Matches the BFF's conversion timeout |
| `--api-disable-download-from` | Never fetches an input from a URL |
| `--webhook-disable` | Never calls a URL back |
| `--libreoffice-auto-start=true` | Starts LibreOffice at boot, so the first upload does not pay its cold start |
| `--gotenberg-graceful-shutdown-duration=120s` | A conversion in flight when the container stops runs to the same 120s. With `stop_grace_period: 130s`, a `docker compose up` that replaces the container does not cut it, which would fail that ingest |
| `--libreoffice-deny-private-ips` | LibreOffice refuses to fetch a URL an office file links when it resolves to a loopback, RFC 1918, link-local or unique-local address: the other containers and the host |
| `--libreoffice-deny-public-ips` | The same for public addresses. Together the two refuse every outbound fetch |

The image contains no Chromium, so the HTML/URL → PDF routes do not exist. It also refuses to start with any `--chromium-*` flag, so none may be added.

Here the `gotenberg-internal` network already stops LibreOffice reaching anything. The two deny flags matter where no such network exists. On Coolify the converter shares a network with Postgres, SeaweedFS and the backend, and a host firewall sees none of that traffic, so the flags are what stop a crafted file from reaching those containers. Kubernetes has the same gap when `networkPolicies` is off.

**Resource limits**:

| Resource | Limit | Reservation |
|----------|-------|-------------|
| CPU | 1 | 0.2 |
| Memory | 1G | 512M |

**Healthcheck**: `curl -fsS http://localhost:3000/health` — interval 15s, timeout 5s, start period 30s, retries 5.

**Restart**: `unless-stopped`.

**Coolify**: `docker-compose.coolify.yaml` runs the same image and flags but
cannot isolate it on its own network, because a second network on the frontend
breaks Traefik routing there. On Coolify the converter keeps egress; block it
at the host firewall if outbound traffic matters.

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

### pgbouncer

Transaction pooler in front of the pooled DSNs (ADR-0083), mirroring the
CloudNativePG `Pooler` Kubernetes runs, so a session feature that only works on
a direct connection fails here and not first in production.

| Property | Value |
|----------|-------|
| Image | `edoburu/pgbouncer:v1.26.0-p0`, digest-pinned (PgBouncer 1.26.0; `max_prepared_statements` needs 1.21 or newer) |
| Container name | `aiq-pgbouncer` |
| Ports | none published; `pgbouncer:5432` on `aiq-network` |
| Pool mode | `transaction` |

**Environment**: `DATABASE_URLS` (one login per pooled role, from which the
image writes its userlist), `POOL_MODE=transaction`, `AUTH_TYPE=scram-sha-256`,
`MAX_CLIENT_CONN=2000`, `DEFAULT_POOL_SIZE=12`, `MAX_PREPARED_STATEMENTS=200`,
`IGNORE_STARTUP_PARAMETERS=extra_float_digits,options`. Passwords are written
into URLs, so they cannot contain `:`, `@` or `/`.

**Routing**: the pooled DSNs above and every `GRID_APP_DATABASE_URL` go through
it. `AIQ_LISTEN_DB_URL`, `AIQ_LOCK_DB_URL`, `GRID_APP_MIGRATION_DATABASE_URL` and
Langfuse's `DATABASE_URL` go straight to `postgres`, as in Kubernetes.

**Healthcheck**: `pg_isready -h 127.0.0.1 -p 5432` — interval 5s, timeout 3s, retries 5.

**Restart**: `unless-stopped`.

## Volumes

| Name | Driver | Mounted By |
|------|--------|------------|
| `chroma_data` | local | chroma (`/data`) |
| `seaweedfs-data` | local | seaweedfs (`/data`) |
| `postgres-data` | local | postgres (`/var/lib/postgresql/data`) |

## Networks

| Name | Driver | Services |
|------|--------|----------|
| `aiq-network` | bridge | Every service except `gotenberg` |
| `gotenberg-internal` | bridge, `internal: true` (no route off the host) | `gotenberg`, `frontend` |

## Build Targets

The backend `deploy/Dockerfile` defines two build targets:

### dev (default)

- Based on `debian:bookworm-slim` with a uv-managed Python 3.14 (`python-build-standalone`)
- Includes CLI (`aiq-research`) and debug UI (`aiq_debug`)
- Includes Node.js 22 for frontend development inside the dev container
- `APP_ENV` defaults to `development` (when unset, compose default is `production`)

### release

- Based on `debian:bookworm-slim` with a uv-managed Python 3.14 (`python-build-standalone`)
- Web only — no CLI, no debug UI, no Node.js
- `APP_ENV` is hardcoded to `production`
- Validates required environment variables at startup

Select with: `BUILD_TARGET=release docker compose ... up -d --build`
