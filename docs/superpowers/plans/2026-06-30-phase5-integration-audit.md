# Phase 5: Integration Audit — Findings & Fix Plan

Audit date: 2026-06-30
Audited by: automated deep-dry-run across compose, ingestion, env, and end-to-end flows.

---

## Critical Blockers (will fail on `docker compose up`)

### 1. Docker Compose YAML structure broken

**File:** `deploy/compose/docker-compose.yaml`, lines 75-98

**What's wrong:** `depends_on` under `aiq-agent` has an empty/null value (line 75), and `condition: service_healthy` appears as a service-level key (line 97) instead of nested under `depends_on`.

**Effect:** `docker compose up` will fail with `Additional property condition is not allowed` at parse time.

**Fix:** Restructure so `aiq-agent` has proper depends_on:
```yaml
    depends_on:
      minio:
        condition: service_healthy
      postgres:
        condition: service_healthy
```

Remove the orphan `postgres:` at line 96 (it was supposed to be part of `depends_on`).

### 2. MinIO bucket never created

**No init container or script** creates the `grid-documents` bucket. The MinIO service starts with an empty data directory. The first document upload will fail with `NoSuchBucket`.

**Fix:** Add an init container:
```yaml
  minio-init:
    image: minio/mc:latest
    entrypoint: ["/bin/sh", "-c"]
    command:
      - >
        mc alias set local http://minio:9000 minioadmin minioadmin &&
        mc mb local/grid-documents --ignore-existing
    depends_on:
      minio:
        condition: service_healthy
    networks:
      - aiq-network
```

### 3. WorkOS env vars MISSING from `deploy/.env`

The three WorkOS variables (`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_COOKIE_PASSWORD`) are **all commented out** in `deploy/.env`. They exist only in `frontends/ui/.env.local`.

In Docker Compose, these are referenced as `${WORKOS_CLIENT_ID}` with **no default value** (lines 110-112). If `REQUIRE_AUTH=true`, the frontend container will get empty values, and `getWorkOS()` will throw.

Additionally, `WORKOS_COOKIE_PASSWORD` is the **placeholder string** `replace-with-32-byte-random-string` — not a real cryptographic secret.

**Fixes:**
- Uncomment and set all three WorkOS vars in `deploy/.env` (both files should have real values)
- Generate a real `WORKOS_COOKIE_PASSWORD`: `openssl rand -base64 32`
- WorkOS redirect URI `http://localhost:3000/api/auth/callback` will need changing for non-localhost deployments

---

## OIB Ingestion Pipeline

### Tables & Images: Code exists, but DISABLED

The LlamaIndex adapter (`sources/knowledge_layer/src/llamaindex/adapter.py`) has **fully implemented** extraction for:
- **Tables** — via `pdfplumber`, stored as markdown with `content_type: "table"`
- **Images** — via `pypdfium2`, captioned by VLM, stored as text with `content_type: "image"`
- **Charts** — via same VLM pipeline, classified as `content_type: "chart"`

All three are **gated behind env vars** that default to `"false"`:
- `AIQ_EXTRACT_TABLES`
- `AIQ_EXTRACT_IMAGES`
- `AIQ_EXTRACT_CHARTS`

**To enable:** Uncomment these in `deploy/.env` and set to `"true"`.

### 🚨 NVIDIA API Key is actually OpenRouter

`deploy/.env` line 28:
```
NVIDIA_API_KEY=sk-or-v1-...
```

This is the **OpenRouter key** pretending to be an NVIDIA key. The code comment says "set to OpenRouter key so LlamaIndex NVIDIAEmbedding uses it" — which works for embeddings because the embedding base URL is overridden to `https://openrouter.ai/api/v1`.

**But for VLM image captioning** (adapter.py:321-324), the code calls `https://integrate.api.nvidia.com/v1` with this key. This will **fail with authentication errors** because OpenRouter and NVIDIA have different API key formats and auth systems.

**Fix:** You need a real NVIDIA API key (starts with `nvapi-`). Sign up at `https://build.nvidia.com/` to get one.

### Embedding model is text-only

Current setup uses `openai/text-embedding-3-large` via OpenRouter — text-only embeddings. Even if image extraction is enabled, images are captioned to text, then embedded. No true multi-modal vector search.

The native NVIDIA model `nvidia/llama-nemotron-embed-vl-1b-v2` does support vision-language but is not currently configured.

### OIB ingestion uses hardcoded path, not config

`scripts/ingest_oib.py` → `oib_sync.py` calls:
```python
ingestor = get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})
```

This bypasses all YAML configuration. It's consistent for development but means OIB ingestion behavior is NOT controlled by `config_grid_oib.yml`.

### Collection scope may not find user uploads

In `config_grid_oib.yml`:
```yaml
include_base_collection: false
include_session_collection: false
```

With `X-Grid-Collection-Scope` header, the fallback path uses only `oib_knowledge`. Documents uploaded to `proj_{id}` collections may not be searched unless `project_collections` is populated from the scope header. This needs verification.

---

## Environment Variables Gaps

### Critical gaps

| Variable | Status | Risk |
|----------|--------|------|
| `WORKOS_COOKIE_PASSWORD` | Placeholder `replace-with-32-byte-random-string` | Session cookie forgery |
| `GRID_ADMIN_TOKEN` | **MISSING** from `deploy/.env` | Admin OIB operations fail |
| `WORKOS_CLIENT_ID` | Commented out in `deploy/.env` | Auth fails in Docker |
| `WORKOS_API_KEY` | Commented out in `deploy/.env` | Auth fails in Docker |
| `NVIDIA_API_KEY` | Is actually OpenRouter key | VLM fails if enabled |
| `TAVILY_API_KEY` | Dev key (`tvly-dev-*`) | Rate limited, may expire |

### Missing env vars (not in any env file)

| Variable | Used by | Default |
|----------|---------|---------|
| `BASE_COLLECTION_NAME` | `frontends/ui/src/lib/collection-scope.ts` | `oib_knowledge` |
| `OIB_COLLECTION_NAME` | `src/aiq_agent/oib_sync.py` | `oib_knowledge` |
| `OIB_DOCUMENTS_DIR` | `src/aiq_agent/oib_sync.py` | `data/oib` |
| `MINIO_ENDPOINT` | `frontends/ui/src/lib/s3.ts` | commented out in .env |
| All other MinIO vars | Various | commented out in .env |

### Database URL inconsistency

| Environment | `GRID_APP_DATABASE_URL` |
|-------------|------------------------|
| Docker Compose | `postgresql://aiq:aiq_dev@postgres:5432/grid_app` |
| `frontends/ui/.env.local` | `postgresql://postgres:postgres@localhost:5432/grid_app` |

Different credentials for local vs Docker. This is intentional (Docker creates `aiq` user; local dev uses `postgres`), but worth noting.

### MinIO vars only hardcoded in compose

All MinIO env vars are **hardcoded** in `deploy/compose/docker-compose.yaml` lines 118-122, with no path to override via `.env`. To change MinIO credentials, you must edit the compose file.

---

## Startup Order & Dependencies

### Current startup sequence

```
docker compose up
  → postgres (init-db.sql creates databases + aiq tables)
  → minio (no bucket created)
  → aiq-agent (no depends_on due to YAML error, starts in parallel)
  → frontend (waits for aiq-agent container to exist, NOT for readiness)
     → drizzle-kit migrate (applies grid_app table migrations)
     → node server.js (gateway + Next.js)
```

### Issues in the sequence

1. **aiq-agent has NO depends_on** — may start before postgres is ready, crash, and not restart (no `restart: unless-stopped`)
2. **frontend has `depends_on: aiq-agent` but no `condition: service_healthy`** — starts as soon as the container exists, even if the backend hasn't finished initializing (Dask + uvicorn can take 10-30 seconds)
3. **aiq-agent does NOT have `restart: unless-stopped`** — if it crashes, it won't restart
4. **Bucket not created** — MinIO is ready but has no `grid-documents` bucket

### What needs healthcheck depends_on

| Service | Depends On | Condition |
|---------|-----------|-----------|
| `aiq-agent` | `postgres` | `service_healthy` |
| `aiq-agent` | `minio` | `service_healthy` (optional, backend may not need MinIO directly) |
| `frontend` | `aiq-agent` | `service_healthy` |
| `frontend` | `minio` | `service_healthy` |
| `frontend` | `postgres` | `service_healthy` |

---

## DB Migrations Status

### ✅ Frontend (Drizzle) — Good

- `CMD ["sh", "-c", "node node_modules/drizzle-kit/bin.js migrate && node server.js"]` in `frontends/ui/deploy/Dockerfile:146`
- Runs `drizzle-kit migrate` on every container start (idempotent)
- Applies pending migrations for `grid_app` database (projects, conversations, messages, documents, user_preferences)
- 4 migrations generated (0000-0003), all committed

### ✅ PostgreSQL init — Good

- `deploy/compose/init-db.sql` creates 3 databases and all aiq_jobs/aiq_checkpoints tables
- Runs once on first postgres startup via `docker-entrypoint-initdb.d/`
- Creates databases: `aiq_jobs`, `aiq_checkpoints`, `grid_app`
- Creates tables: `job_info`, `job_access`, `job_events`, `summaries`, `checkpoints`, etc.

### ❓ Python backend — No migration system

The Python backend has no Alembic or `db.create_all()` — it relies entirely on `init-db.sql`. If schemas diverge between NAT versions and what `init-db.sql` defines, there's no migration safety net.

---

## Minion Dependency Analysis

### New MinIO dependency chain

```
User uploads file
  → frontend (browser) POST to BFF /api/documents/upload
    → BFF requires:
        1. MinIO (S3 API) — to store the file
        2. PostgreSQL (documents table) — to store metadata
        3. Python backend /v1/ingest — to trigger ingestion
          → Python backend requires:
              1. ChromaDB — to index the document
              2. PostgreSQL (aiq_jobs) — to track job status
```

### What breaks if MinIO is down

| Scenario | Result |
|----------|--------|
| MinIO down → user uploads file | BFF upload route throws S3 `PutObjectCommand` error → 500 response |
| MinIO down → user tries to download | BFF download route throws `GetObjectCommand` error → 500 response |
| MinIO down → existing docs | No impact; docs are already ingested. Just can't download originals |
| MinIO down → OIB re-ingestion | No impact; OIB uses local file paths, not MinIO |

All failures return HTTP 500 with no user-friendly error UI.

### DB connection failure scenarios

| Scenario | Result |
|----------|--------|
| PG down → BFF route | Drizzle query throws → 500 (no retry) |
| PG down → Python backend | uvicorn startup fails (can't connect to job store) |

---

## Summary: Fix Plan by Priority

### 🔴 P0 — Must fix before next `docker compose up`

1. **Fix YAML structure** (lines 75-98) — `depends_on` + `condition` nesting
2. **Add MinIO bucket init container** — `minio-init` with `mc mb`
3. **Add `depends_on` with healthcheck conditions** to all services
4. **Add `restart: unless-stopped` to `aiq-agent`**

### 🟡 P1 — Must fix before production

5. **Set real `WORKOS_COOKIE_PASSWORD`** — `openssl rand -base64 32`
6. **Uncomment WorkOS vars in `deploy/.env`** — `CLIENT_ID`, `API_KEY`, `COOKIE_PASSWORD`, `REDIRECT_URI`
7. **Set `GRID_ADMIN_TOKEN`** — for admin OIB operations
8. **Change MinIO credentials** from `minioadmin`/`minioadmin`
9. **Get real NVIDIA API key** (`nvapi-*`) — needed for VLM image captioning
10. **Get production Tavily key** — replace `tvly-dev-*`

### 🔵 P2 — Should fix for full feature set

11. **Enable table/image extraction** — uncomment `AIQ_EXTRACT_TABLES=true`, `AIQ_EXTRACT_IMAGES=true`, `AIQ_EXTRACT_CHARTS=true`
12. **Make MinIO vars configurable via `.env`** — not hardcoded in compose
13. **Add graceful error UI** for backend/MinIO unavailability
14. **Add `BASE_COLLECTION_NAME`** to env docs
15. **Fix `MinIO_ENDPOINT` typo** in `deploy/.env.example`
16. **Add MinIO vars to `frontends/ui/.env.local`** for local dev
17. **Verify collection scope routing for project uploads** — do user-uploaded docs get searched?

### ⚪ P3 — Long-term improvements

18. **Verify VLM embedding support** — `nvidia/llama-nemotron-embed-vl-1b-v2` for true multi-modal search
19. **Add database retry logic** to `aiq-agent` startup
20. **Consider Alembic** for Python-side schema migrations
21. **Make OIB sync config-driven** instead of hardcoding `"llamaindex"` ingestor
