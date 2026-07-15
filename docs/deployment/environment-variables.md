# Environment Variables Reference

All environment variables are organized by category. Variables marked **Required** must be set for the system to function. Variables with values in `deploy/.env` are for the local development setup.

## Where Variables Are Set

| Source | File | Purpose |
|--------|------|---------|
| `.env` | `deploy/.env` (ignored by git) | Local development secrets and overrides |
| `.env.example` | `deploy/.env.example` | Template with all documented variables |
| `docker-compose.yaml` | `deploy/compose/docker-compose.yaml` | Defaults and hardcoded values for Docker networking |
| Code defaults | Python/JS source | Fallback values when nothing is set |

Variables set in `docker-compose.yaml` under `environment:` take precedence over the `env_file:`. Variables from `.env` propagate to both the compose file (via `${VAR}` substitution) and into the container.

---

## LLM Backend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KIMI_API_KEY` | Yes | — | Kimi (Moonshot AI) OpenAI-compatible API key for LLM inference. Used by `config_grid_oib.yml` for all LLM models (intent, reasoning, deep research, summaries). |
| `OPENROUTER_API_KEY` | Yes* | — | OpenRouter API key for embeddings. In the local `.env`, this replaces the NVIDIA API key for the embedding layer. |
| `NVIDIA_API_KEY` | Yes* | — | NVIDIA API key for NIM inference models. **Current workaround**: Set to the same value as `OPENROUTER_API_KEY` because the NVIDIAEmbedding class from LlamaIndex uses this env var name. A real NVIDIA NGC API key is required for production VLM features. |

*At least one API key for LLM and one for embeddings is required. The local setup uses Kimi for LLM + OpenRouter for embeddings (with NVIDIA_API_KEY as a workaround).

---

## Search

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TAVILY_API_KEY` | Yes | — | Tavily web search API key. Used by `tavily_web_search` tool in the NAT workflow config. Production key format: `tvly-...`, dev key format: `tvly-dev-...`. |
| `SERPER_API_KEY` | No | — | Serper.dev API key for Google search. Optional — requires updating the NAT config to enable. |
| `JINA_API_KEY` | No | — | Jina AI API key for evaluation. |

---

## WorkOS Auth

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORKOS_CLIENT_ID` | When `REQUIRE_AUTH=true` | — | WorkOS client ID. Format: `client_xxx`. |
| `WORKOS_API_KEY` | When `REQUIRE_AUTH=true` | — | WorkOS API key. Format: `sk_live_xxx` (production) or `sk_test_xxx` (test mode). |
| `WORKOS_REDIRECT_URI` | When `REQUIRE_AUTH=true` | `http://localhost:3000/api/auth/callback` | AuthKit OAuth callback URL. Must match the redirect URI configured in WorkOS dashboard. |
| `WORKOS_COOKIE_PASSWORD` | When `REQUIRE_AUTH=true` | — | 32-byte random hex string used to encrypt the AuthKit session cookie. Generate with: `openssl rand -hex 32`. |
| `REQUIRE_AUTH` | No | `false` | Set to `true` to require WorkOS AuthKit login. When `false`, the app uses a "Default User" with no login required. |

---

## Database

| Variable | Required | Default (Docker) | Default (Local) | Description |
|----------|----------|------------------|-----------------|-------------|
| `GRID_APP_DATABASE_URL` | Yes | `postgresql://aiq:aiq_dev@postgres:5432/grid_app` | `postgresql://postgres:postgres@localhost:5432/grid_app` | PostgreSQL URL for the Next.js BFF application database (Drizzle ORM). |
| `NAT_JOB_STORE_DB_URL` | No (SQLite fallback) | `postgresql+asyncpg://aiq:aiq_dev@postgres:5432/aiq_jobs` | `sqlite+aiosqlite:///./jobs.db` | NAT job store URL. PostgreSQL for Docker, SQLite for local dev. |
| `AIQ_CHECKPOINT_DB` | No (SQLite fallback) | `postgresql://aiq:aiq_dev@postgres:5432/aiq_checkpoints` | `./checkpoints.db` | LangGraph conversation checkpoint database. PostgreSQL for Docker, SQLite for local dev. |
| `AIQ_SUMMARY_DB` | No (SQLite fallback) | `postgresql+psycopg://aiq:aiq_dev@postgres:5432/aiq_jobs` | `sqlite+aiosqlite:///./summaries.db` | Document summaries database. Pointed at `aiq_jobs` in Docker to share the database. |

---

## MinIO / Object Storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MINIO_ENDPOINT` | Yes (Docker) | `http://minio:9000` (compose), `http://localhost:9000` (local) | S3-compatible endpoint URL. In Docker this references the minio service. |
| `MINIO_ACCESS_KEY` | Yes | `minioadmin` | MinIO root/access key. Change in production. |
| `MINIO_SECRET_KEY` | Yes | `minioadmin` | MinIO root/secret key. Change in production. |
| `MINIO_BUCKET` | Yes | `grid-documents` | S3 bucket name for document storage. Created by `minio-init`. |
| `MINIO_PRESIGNED_URL_TTL_SECONDS` | No | `600` | TTL for presigned download URLs (10 minutes). |

---

## Backend Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BACKEND_CONFIG` | Yes | `/app/configs/config_grid_oib.yml` | Path to the NAT workflow YAML config file inside the container. The compose stack mounts `configs/` at `/app/configs`. |
| `AIQ_CHROMA_DIR` | No | `/tmp/chroma_data` | Directory for ChromaDB persistence. In Docker: `/app/data/chroma_data`. |
| `COLLECTION_NAME` | No | `oib_knowledge` | Default ChromaDB collection name. |
| `AIQ_EXTRACT_TABLES` | No | `false` | Enable table extraction from documents. |
| `AIQ_EXTRACT_IMAGES` | No | `false` | Enable image extraction from documents. |
| `AIQ_EXTRACT_CHARTS` | No | `false` | Enable chart extraction from documents. |
| `AIQ_VLM_MODEL` | No | `nvidia/nemotron-nano-12b-v2-vl` | VLM model for vision-language tasks. Requires a real NVIDIA API key. |
| `AIQ_VLM_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Base URL for VLM model API. |
| `AIQ_EMBED_MODEL` | No | `nvidia/llama-nemotron-embed-vl-1b-v2` | Embedding model name. Local override: `openai/text-embedding-3-large`. |
| `AIQ_INGEST_MAX_WORKERS` | No | `2` | Max concurrent ingestion jobs per backend process; excess uploads queue as PENDING instead of each spawning a thread against the embedding API and the embedded Chroma store. |
| `GRID_MAX_ACTIVE_JOBS` | No | `8` | Admission control: max non-terminal async research jobs accepted across all orgs. Beyond the cap, REST submits get 429 (+Retry-After) and chat answers with a friendly "queue full" message. `0` disables. |
| `GRID_MAX_ACTIVE_JOBS_PER_ORG` | No | `3` | Admission control: max non-terminal async research jobs per organization, so one tenant cannot occupy the whole cluster. `0` disables. |
| `REDIS_URL` | No | unset (compose: `redis://dragonfly:6379/0`) | Redis-protocol URL of the shared cache (Dragonfly, ADR-0020). Consumed by BOTH the frontend (read-through caches, WS rate limiter) and the backend (citation-registry snapshots). Unset = per-process in-memory fallback. |
| `GRID_WS_UPGRADE_RATE_LIMIT` | No | `30` | Max WebSocket upgrades per client IP per minute at the gateway. Counters live in the shared cache so the limit holds across replicas; fails open. `0` disables. |
| `GRID_CITATION_REGISTRY_TTL_SECONDS` | No | `86400` | TTL of per-conversation citation-source snapshots in the shared cache (lets a conversation keep prior-turn sources across restarts/replicas). |
| `AIQ_LISTEN_DB_URL` | No | job-store URL | Direct (non-pooled) Postgres URL for SSE LISTEN/NOTIFY. Set explicitly when a PgBouncer fronts the pooled DSNs — transaction pooling breaks LISTEN. |
| `AIQ_QUERY_EMBED_CACHE_SIZE` | No | `512` | Max query embeddings kept in the retriever's LRU (one query is embedded once and reused across the per-collection fan-out). |
| `AIQ_STATIC_RESULT_CACHE_COLLECTIONS` | No | `oib_knowledge` | Comma-separated collections whose retrieval results may be cached (static corpora only — never project/session collections). |
| `AIQ_STATIC_RESULT_CACHE_TTL_SECONDS` | No | `3600` | TTL for cached static-collection retrieval results; in-process writes invalidate immediately via a collection version. |
| `AIQ_EMBED_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Embedding model API base URL. Local override: `https://openrouter.ai/api/v1`. |
| `CONSISTENCY_LLM_MODEL` | No | `LLM_MODEL`, then `deepseek/deepseek-v4-flash` (if `OPENROUTER_API_KEY` set) / `gpt-4o-mini` | Model for the end-of-wizard free-text intake consistency-check endpoint (`POST /v1/consistency-check`). Falls back to the generic `LLM_MODEL`, then the OpenRouter/OpenAI default. |
| `CONSISTENCY_LLM_API_KEY` | No | `LLM_API_KEY`, then `OPENROUTER_API_KEY` | API key for the consistency-check LLM. Falls back to `LLM_API_KEY`, then `OPENROUTER_API_KEY`. If none resolves, the endpoint returns `error=llm_not_configured` (HTTP 200) so the wizard can still save. |
| `CONSISTENCY_LLM_BASE_URL` | No | `LLM_BASE_URL`, then `https://openrouter.ai/api/v1` (if `OPENROUTER_API_KEY` set) / `https://api.openai.com/v1` | Base URL for the consistency-check LLM (OpenAI-compatible `/chat/completions`). Falls back to `LLM_BASE_URL`, then the OpenRouter/OpenAI default. |

---

## Tag Backfill Script (`scripts/backfill_document_tags.py`)

The one-off tag-backfill script runs **outside** the NAT runtime, so it builds an OpenAI-compatible client directly from these env vars, which must match the `summary_llm` block in `configs/config_*.yml`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BACKFILL_SUMMARY_API_KEY` | Yes* | `NVIDIA_API_KEY` fallback | API key for the tagging LLM. Falls back to `NVIDIA_API_KEY`. If neither is set the script exits with code `2` (LLM could not be constructed). |
| `BACKFILL_SUMMARY_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Base URL for the tagging LLM. |
| `BACKFILL_SUMMARY_MODEL` | No | `nvidia/nemotron-mini-4b-instruct` | Tagging model name. |

*Required only when running the backfill script; not needed by the running services. The store/source come from `AIQ_SUMMARY_DB` and `AIQ_CHROMA_DIR` (or `--summary-db` / `--chroma-dir`). Exit codes: `0` success (or nothing to do; `--dry-run` always `0`), `1` a real run finished with per-document classification failures, `2` missing LLM key.

---

## File Upload

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FILE_UPLOAD_ACCEPTED_TYPES` | No | `.pdf,.docx,.txt,.md` | Comma-separated list of accepted file extensions (include leading dots). Add `.pptx` for Foundational RAG backend. **Images are opt-in**: image types (`.png,.jpg,.jpeg`) are no longer shipped in the defaults — image ingestion needs a configured VLM (`AIQ_VLM_*`), so add them here explicitly AND enable the `image-upload` WorkOS flag to accept them. Images added here are stripped from the client accept-list and rejected server-side (400) when the flag is off. |
| `FILE_UPLOAD_MAX_SIZE_MB` | No | `100` | Maximum total file size in MB. |
| `FILE_UPLOAD_MAX_FILE_COUNT` | No | `10` | Maximum number of files per upload session. |
| `FILE_EXPIRATION_CHECK_INTERVAL_HOURS` | No | `0` | Hours after upload before files may expire (0 = no expiry shown). Should match backend TTL (e.g., 12 hours). |

---

## Frontend

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BACKEND_URL` | Yes | `http://aiq-agent:8000` (Docker), `http://localhost:8000` (local) | Backend API URL used by the Node.js gateway. |
| `NEXT_PUBLIC_BACKEND_URL` | No | `http://localhost:8000` | Public-facing backend URL. Fallback if `BACKEND_URL` is not set. |
| `PORT` | No | `3000` | Node.js gateway listen port. |
| `FRONTEND_PORT` | No | `3000` | Docker host port mapping for the frontend container. |

---

## Admin

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_ADMIN_TOKEN` | No | `change-me-in-production` | Bearer token for admin-protected endpoints. Change in production. |

---

## Project Memory

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_INTERNAL_API_TOKEN` | Yes (agent memory) | — | Shared service token authenticating the backend agent's memory writes to the internal BFF endpoint (`POST /api/internal/memory`). Must match between the `aiq-agent` and `frontend` services. Never ship the dev default outside dev. |
| `memory_reflection_llm` *(NAT config key, not env)* | No | unset | LLM ref in the chat-agent config that makes the async post-answer memory-reflection stage **available**. Unset = the stage is compiled out (no extra LLM call ever). Being available is necessary but not sufficient — each turn is still gated at runtime (next two rows). Set in `config_oib_openrouter.yml`. See `docs/architecture/project-memory-design.md` §3.5. |
| `memory-reflection` *(WorkOS feature flag, not env)* | No | off | Runtime on/off switch for the reflection stage, evaluated **per organization** at the WS upgrade (`isOrgFeatureEnabled`). Create a feature flag with this slug in WorkOS and enable it for the orgs that should get reflection. Fail-closed: if WorkOS/plan/flag is unavailable, the stage stays off. |
| `MEMORY_REFLECTION_ENABLED` | No | `false` | Fallback runtime switch for **anonymous / non-WorkOS** deployments (no org to evaluate the flag against). `true` turns the reflection stage on globally. Ignored when a WorkOS org is in scope (the feature flag wins). |
| `MEMORY_REFLECTION_MAX_CONCURRENCY` | No | `4` | Maximum reflection LLM calls running concurrently per backend process. Reflections share the event loop with live chat turns; this bounds their background LLM traffic. |
| `MEMORY_REFLECTION_MAX_PENDING` | No | `16` | Maximum reflections pending (scheduled + running) per backend process. Beyond the cap new reflections are dropped with a warning — reflection is a best-effort safety net, never queued unboundedly. |
| `GRID_ALLOW_AGENT_ORG_MEMORY` | No | `false` | When `true`, the internal memory endpoint accepts **agent-authored organization-scoped** writes. Default-deny: org-wide memory reaches every project in the tenant and the service-token endpoint cannot verify the human's org role, so an autonomous/prompt-injected write would poison the tenant (audit finding S1). Leave unset unless you accept that risk; org-wide findings are otherwise a human-only action via the org-memory panel. |

---

## Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `APP_ENV` | No | `development` | Application environment. Set to `production` in release Docker build. |
| `LOG_LEVEL` | No | `INFO` | Logging level: DEBUG, INFO, WARNING, ERROR. |
| `PYTHONWARNINGS` | No | `ignore` | Python warnings filter. |

---

## Dask

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DASK_NWORKERS` | No | `1` | Number of Dask worker processes. |
| `DASK_NTHREADS` | No | `4` | Number of threads per Dask worker. |
| `DASK_MEMORY_LIMIT` | No | (unset) | Per-worker memory limit (e.g., `4GB`). Dask spills/restarts above this. |
| `DASK_LIFETIME` | No | (unset) | Worker lifetime in seconds. Workers are recycled after this time to clear accumulated state. |
| `DASK_LIFETIME_RESTART` | No | `true` | Set to `false` to let workers exit gracefully without respawning. |
| `DASK_DISTRIBUTED__LOGGING__DISTRIBUTED` | No | `warning` | Reduce Dask log noise. |

---

## Optional Integrations

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MODAL_TOKEN_ID` | No | — | Modal sandbox token ID for skills execution. |
| `MODAL_TOKEN_SECRET` | No | — | Modal sandbox token secret for skills execution. |
| `LANGCHAIN_API_KEY` | No | — | LangSmith tracing API key. |
| `LANGCHAIN_PROJECT` | No | `aiq-research` | LangSmith project name. |
| `LANGCHAIN_TRACING_V2` | No | — | Set to `true` to enable LangSmith tracing. |
| `WANDB_API_KEY` | No | — | Weights & Biases API key for experiment tracking. |

---

## Notes

- **Placeholder values**: The `.env.example` file contains commented-out optional variables. The `.env` file contains actual development keys.
- **Docker networking**: In Docker Compose, services communicate over the internal `aiq-network` bridge network. Variables like `BACKEND_URL=http://aiq-agent:8000` and `MINIO_ENDPOINT=http://minio:9000` use Docker DNS resolution.
- **MinIO credentials**: The MinIO credentials are currently hardcoded in `docker-compose.yaml` for all three services that use them. For production, these should be externalized to the `.env` file.

## Model Configuration & Budgets (frontend)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENROUTER_API_KEY` | No | — | Frontend container: authenticates the OpenRouter model-catalog fetch for the org model-config picker/validation (catalog also works unauthenticated). Same key the backend uses for LLM calls. |
| `OPENROUTER_BASE_URL` | No | `https://openrouter.ai/api/v1` | Override the catalog endpoint (tests / self-hosted gateways). |
| `GRID_BUDGET_EUR_PER_USD` | No | `0.86` | Euros per 1 USD used to compare EUR budget limits against the USD costs OpenRouter reports (ADR-0015). |

Org budget defaults (until an admin sets explicit limits): €10/day and
€100/month — constants in `frontends/ui/src/lib/budgets/service.ts`, not env
vars. See `docs/architecture/usage-budgets.md`.

## Platform Tier (frontend, ADR-0016)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_PLATFORM_OWNER_EMAILS` | No | — | Break-glass bootstrap: comma-separated emails treated as platform owner even without the WorkOS platform-org membership. For first-run in a fresh environment; keep empty in steady state. |
| `GRID_PLATFORM_ORG_EXTERNAL_ID` | No | `grid-platform` | External id of the GRID Platform organization in WorkOS. |
| `GRID_DISABLE_SELF_SERVE_ORGS` | No | `false` | `true` makes the platform invite-only: fresh users can no longer self-create organizations (403 `self-serve-disabled`). |
| `GRID_ENFORCE_FEATURE_FLAGS` | No | `false` | `true` enforces WorkOS feature flags (`runtime-model-config`, `deep-research` — registry: `lib/authz/feature-flags.ts`). Turn on only after the flags exist in WorkOS and orgs are targeted; sessions without the JWT `feature_flags` claim then fail closed until re-login. |
