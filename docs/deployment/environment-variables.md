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
| `OPENROUTER_API_KEY` | Yes* | — | OpenRouter API key. Powers embeddings, the VLM, and the BFF-invoked LLM routes. Because the bespoke LLM call sites now resolve credentials through the shared resolver with **provider inference** (see note below), setting this alone is enough whenever the corresponding base URL points at `openrouter.ai`. |
| `NVIDIA_API_KEY` | Yes* | — | NVIDIA API key for NIM inference models, and the historical fallback env for embeddings/VLM (the LlamaIndex `NVIDIAEmbedding` class reads this name). With OpenRouter base URLs, provider inference now picks up `OPENROUTER_API_KEY` natively, so aliasing `NVIDIA_API_KEY=${OPENROUTER_API_KEY}` is only a belt-and-suspenders back-compat. A real NVIDIA NGC key is required only for actual NVIDIA endpoints. |

*At least one API key for LLM and one for embeddings is required. The local setup uses Kimi for LLM + OpenRouter for embeddings (with NVIDIA_API_KEY as a workaround).

> **Unified LLM credential resolution.** The bespoke (non-NAT) LLM call sites — the VLM captioner, the embeddings client, the tag-backfill script, and the BFF-invoked `/v1/consistency-check` and `/v1/generate-summary` routes — resolve credentials through one shared resolver (`aiq_agent.common.credential_resolution.resolve_llm_credential`). Resolution order: (1) **org BYOK** credential when an organization id is supplied (the two BFF routes forward `x-grid-organization-id`; a BYOK swap changes the api key + base URL only, never the model); (2) the call site's explicit key env var; (3) its fallback env vars; (4) **provider inference** — the conventional key env for whatever provider the resolved base URL points at (`openrouter.ai`→`OPENROUTER_API_KEY`, `integrate.api.nvidia.com`→`NVIDIA_API_KEY`, `api.openai.com`→`OPENAI_API_KEY`). All env reads treat a literal, uninterpolated `${...}` placeholder (a docker compose `env_file` non-interpolation) as unset. BYOK is **not** wired for embeddings/VLM: ingestion is org-agnostic today (no org id crosses `/v1/ingest`) — a known follow-up.

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
| `GRID_DB_POOL_MAX` | No | `10` | `10` | Max PostgreSQL connections the BFF connection pool holds open. Bounds resource use so connection acquisition fails fast under load instead of piling requests up behind a saturated/unreachable database. Invalid/non-positive values fall back to `10`. |
| `NAT_JOB_STORE_DB_URL` | No (SQLite fallback) | `postgresql+asyncpg://aiq:aiq_dev@postgres:5432/aiq_jobs` | `sqlite+aiosqlite:///./jobs.db` | NAT job store URL. PostgreSQL for Docker, SQLite for local dev. |
| `AIQ_CHECKPOINT_DB` | No (SQLite fallback) | `postgresql://aiq:aiq_dev@postgres:5432/aiq_checkpoints` | `./checkpoints.db` | LangGraph conversation checkpoint database. PostgreSQL for Docker, SQLite for local dev. |
| `AIQ_DEEP_CHECKPOINT_DB` | No | unset (durability OFF — strictly opt-in) | unset | Optional durable LangGraph checkpointing for **async deep-research jobs** (backlog T3-8, 2026-07-16) — separate from `AIQ_CHECKPOINT_DB` above, which only covers the sync chat graph. Sets `deep_research_agent.checkpoint_db`; a worker crash no longer loses execution state (`thread_id = job_id`, `durability="async"`), but resume is manual-resubmit-based, not automatic. Unset/empty = durability off. MUST point at a writable volume path or Postgres DSN — a default-on relative path crashed container startup on read-only workdirs (post-#72 hotfix); an unopenable value now fails open with a warning instead of failing startup. |
| `AIQ_SUMMARY_DB` | No (SQLite fallback) | `postgresql+psycopg://aiq:aiq_dev@postgres:5432/aiq_jobs` | `sqlite+aiosqlite:///./summaries.db` | Document summaries database. Pointed at `aiq_jobs` in Docker to share the database. |

---

## SeaweedFS / Object Storage

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SEAWEED_ENDPOINT` | Yes (Docker) | `http://seaweedfs:8333` (compose), `http://localhost:8333` (local) | S3-compatible endpoint URL. In Docker this references the seaweedfs service. |
| `SEAWEED_ACCESS_KEY` | Yes | `seaweedadmin` | SeaweedFS access key. Change in production. |
| `SEAWEED_SECRET_KEY` | Yes | `seaweedadmin` | SeaweedFS secret key. Change in production. |
| `SEAWEED_BUCKET` | Yes | `grid-documents` | S3 bucket name for document storage. Created by `seaweedfs-init`. |
| `SEAWEED_PRESIGNED_URL_TTL_SECONDS` | No | `600` | TTL for presigned download URLs (10 minutes). |

---

## Backend Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BACKEND_CONFIG` | Yes | `/app/configs/config_grid_oib.yml` | Path to the NAT workflow YAML config file inside the container. The compose stack mounts `configs/` at `/app/configs`. |
| `AIQ_CHROMA_DIR` | No | `/tmp/chroma_data` | Directory for ChromaDB persistence. In Docker: `/app/data/chroma_data`. |
| `COLLECTION_NAME` | No | `oib_knowledge` | Default ChromaDB collection name. |
| `AIQ_EXTRACT_TABLES` | No | `false` | Enable table extraction from documents. |
| `AIQ_EXTRACT_IMAGES` | No | `false` | Enable extraction of **embedded raster images** (image XObjects) from PDFs for VLM captioning. Does NOT capture vector CAD drawings — see `AIQ_RENDER_VISUAL_PAGES`. |
| `AIQ_EXTRACT_CHARTS` | No | `false` | Enable chart extraction from documents. |
| `AIQ_RENDER_VISUAL_PAGES` | No | `true` | Render **text-sparse / vector-heavy PDF pages** to a full-page image and VLM-caption them (captures architectural/CAD drawings — vector plans, sections, elevations, perspectives — that carry almost no extractable text and no embedded raster image, so text and image extraction both miss them). Effective only when a VLM key resolves (`AIQ_VLM_API_KEY`); fires only on pages the heuristic flags as visual, so ordinary text PDFs cost nothing extra. The rendered-page description also feeds the document summary for such PDFs, so the summary describes the drawing (type + scale) instead of a watermark. |
| `AIQ_PAGE_RENDER_MAX_DIM` | No | `2048` | Long-edge target (px) for a full-page render before it is sent to the VLM. ~2048px keeps linework, room labels and scale bars legible while staying at/below current VLM vision-encoder caps (higher just gets downsampled provider-side). Scale is computed per page from its point size, so A0 and A4 sheets both land near this target. |
| `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS` | No | `200` | A PDF page is treated as "visual" (→ rendered + VLM-captioned) when its watermark-stripped extractable text is shorter than this many characters. |
| `AIQ_VISUAL_PAGE_MIN_PATHS` | No | `300` | …OR when the page carries at least this many vector path objects (a plan/section/elevation is typically hundreds-to-tens-of-thousands of paths). |
| `AIQ_MAX_RENDERED_PAGES` | No | `20` | Hard cap on rendered pages per document, bounding VLM cost/latency on large plan sets. Excess visual pages are skipped (logged); their text is still indexed. |
| `AIQ_VLM_MODEL` | No | `nvidia/nemotron-nano-12b-v2-vl` | VLM model for vision-language tasks (image captioning during ingestion). |
| `AIQ_VLM_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Base URL for the VLM API. Drives provider inference for the VLM key (an `openrouter.ai` base URL resolves `OPENROUTER_API_KEY`). |
| `AIQ_VLM_API_KEY` | No | `NVIDIA_API_KEY`, then the provider key inferred from `AIQ_VLM_BASE_URL` | Explicit VLM key override. Resolution chain: org **BYOK** (for per-project/Archiv uploads — `/v1/ingest` forwards `x-grid-organization-id`) → `AIQ_VLM_API_KEY` → `NVIDIA_API_KEY` → provider inference from the base URL. This one resolver (`resolve_vlm_credential`) is the single source of truth both ingestion and the `vlm_available` capability bit consult; an org's `ingest_vlm` runtime model override is applied on top (see `docs/architecture/org-model-configuration.md`). |
| `AIQ_EMBED_API_KEY` | No | `NVIDIA_API_KEY`, then the provider key inferred from `AIQ_EMBED_BASE_URL` | Explicit embeddings key override (now read by the adapter). Chain: `AIQ_EMBED_API_KEY` → `NVIDIA_API_KEY` → provider inference. Inference only selects the key for the configured base URL; it never changes the base URL (embeddings need an embeddings-capable endpoint). |
| `AIQ_EMBED_MODEL` | No | `nvidia/llama-nemotron-embed-vl-1b-v2` | Embedding model name. Local override: `openai/text-embedding-3-large`. |
| `AIQ_INGEST_MAX_WORKERS` | No | `2` | Max concurrent ingestion jobs per backend process; excess uploads queue as PENDING instead of each spawning a thread against the embedding API and the embedded Chroma store. |
| `AIQ_FILE_TRACKING_RETENTION_SECONDS` | No | `86400` (24h) | How long terminal (SUCCESS/FAILED) entries in the ingestor's in-memory per-file tracking dict (`self._files`) are kept before pruning, bounding a dict that otherwise grew for the process lifetime. SUCCESS files remain listable afterwards (rebuilt from Chroma chunks with a fresh id); FAILED rows drop off the listing once the window passes. In-flight (INGESTING/UPLOADING) entries are never pruned. |
| `GRID_MAX_ACTIVE_JOBS` | No | `8` | Admission control: max non-terminal async research jobs accepted across all orgs. Beyond the cap, REST submits get 429 (+Retry-After) and chat answers with a friendly "queue full" message. `0` disables. |
| `GRID_MAX_ACTIVE_JOBS_PER_ORG` | No | `3` | Admission control: max non-terminal async research jobs per organization, so one tenant cannot occupy the whole cluster. `0` disables. |
| `GRID_MAX_RUN_COMPLETION_TOKENS` | No | `0` (disabled) | Per-run completion (output) token ceiling for `deep_research_agent` jobs, enforced across every LLM call in the run including concurrent researcher workers (backlog T4-4, 2026-07-16). Exceeding it fails the job with an explicit budget-exceeded message rather than a generic internal error. Independent of the USD budget ledger below. |
| `GRID_RESEARCHER_RECURSION_LIMIT` | No | `100` | Per-worker LangGraph step cap for single-query researcher runnables (`RESEARCHER_RECURSION_LIMIT` in `tools/research.py`). A stuck researcher hits this and is caught by the `GraphRecursionError` → terminal unresearchable-note path instead of burning its budget or looping through plan → batch → resubmit. `0`/invalid values fall back to `100`. |
| `GRID_MAX_QUERY_SUBMISSIONS` | No | `3` | Maximum times the same query digest may be re-submitted to `run_research_batch` before it is returned as a terminal unresearchable gap instead of being run again (`MAX_QUERY_SUBMISSIONS` in `tools/research.py`). `0`/invalid values fall back to `3`. |
| `GRID_WRITER_CHAR_BUDGET` | No | `200000` | Total-character ceiling for the writer's tool-result context (`ToolResultPruningMiddleware.total_char_budget`, wired in `deep_researcher/factory.py`). When the sum of kept oversized tool results exceeds it, the oldest are truncated so the writer's context cannot grow unbounded across many research notes. `0`/invalid values fall back to `200000`. |
| `REDIS_URL` | No | unset (compose: `redis://dragonfly:6379/0`) | Redis-protocol URL of the shared cache (Dragonfly, ADR-0020). Consumed by BOTH the frontend (read-through caches, WS rate limiter) and the backend (citation-registry snapshots). Unset = per-process in-memory fallback. |
| `GRID_CONVERSATION_BUS` | No | `1` (on) | The Dragonfly pub/sub conversation bus (ADR-0028) that makes the chat tier stateless — any replica serves any conversation's WebSocket (owner publishes stream frames + HITL prompts; the socket-holding relay subscribes; HITL answers round-trip on `conv:<id>:input`). **On by default**, using `REDIS_URL`; **fails open** to local delivery on any Redis error, so a single node behaves exactly as before. With no `REDIS_URL` it uses an in-process transport (byte-identical single-process path). Set to `0` to opt out and fall back to conversation affinity. |
| `GRID_CONV_STREAM_MAXLEN` | No | `500` | Max frames buffered per conversation in the Redis reconnect-replay stream (`conv:<id>:stream`), bounding Dragonfly memory. Best-effort — the Postgres checkpoint is source of truth. |
| `GRID_CONV_OWNER_TTL_SECONDS` | No | `15` | TTL of the conversation owner key (`conv:<id>:owner`, `SET NX EX`) that elects the single replica running a turn once affinity is off; renewed by heartbeat. |
| `GRID_NORMS_DIR` | No | `configs/norms` | Root of the norm catalog seed (ADR-0025 v2): `configs/norms/<country>/registry.yml` files are globbed and merged. The catalog is a flat list of verified RIS pointers plus curated prose legal notes (`binding_note`/`review_note`) and per-entry `verify` seeds; it feeds the `ris_search` short-circuit, the `ris_catalog_lookup` tool, and the catalog block in researcher prompts. At runtime the admin-managed store (same DB as `AIQ_SUMMARY_DB`, seeded from this YAML on first boot, edited via `/app/platform`) takes precedence; missing/invalid data disables catalog features with a warning (fail-open). Pointers re-verified via `scripts/build_ris_catalog.py` or the admin verify endpoint. |
| `GRID_RIS_CACHE_TTL_DAYS` | No | `7` | Days a fetched RIS full text (and a live `ris_search` result) is kept in the shared Dragonfly/Redis cache (`aiq_agent.common.cache`, ADR-0020) and served without re-hitting the RIS API — cutting repeated OGD-RIS + planner-LLM spend across turns, replicas, and restarts. Cache-only/fail-open: a miss or cache error just performs a live fetch. `0`/invalid values fall back to `7`. |
| `GRID_WS_UPGRADE_RATE_LIMIT` | No | `30` | Max WebSocket upgrades per client IP per minute at the gateway. Counters live in the shared cache so the limit holds across replicas; fails open. `0` disables. |
| `GRID_CITATION_REGISTRY_TTL_SECONDS` | No | `86400` | TTL of per-conversation citation-source snapshots in the shared cache (lets a conversation keep prior-turn sources across restarts/replicas). |
| `AIQ_LISTEN_DB_URL` | No | job-store URL | Direct (non-pooled) Postgres URL for SSE LISTEN/NOTIFY. Set explicitly when a PgBouncer fronts the pooled DSNs — transaction pooling breaks LISTEN. |
| `AIQ_QUERY_EMBED_CACHE_SIZE` | No | `512` | Max query embeddings kept in the retriever's LRU (one query is embedded once and reused across the per-collection fan-out). |
| `AIQ_STATIC_RESULT_CACHE_COLLECTIONS` | No | `oib_knowledge` | Comma-separated collections whose retrieval results may be cached (static corpora only — never project/session collections). |
| `AIQ_STATIC_RESULT_CACHE_TTL_SECONDS` | No | `3600` | TTL for cached static-collection retrieval results; in-process writes invalidate immediately via a collection version. |
| `AIQ_EMBED_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Embedding model API base URL. Local override: `https://openrouter.ai/api/v1`. Drives provider inference for the embeddings key (see `AIQ_EMBED_API_KEY`). |
| `CONSISTENCY_LLM_MODEL` | No | `LLM_MODEL`, then `deepseek/deepseek-v4-flash` (if `OPENROUTER_API_KEY` set) / `gpt-4o-mini` | Model for the end-of-wizard free-text intake consistency-check endpoint (`POST /v1/consistency-check`). Falls back to the generic `LLM_MODEL`, then the OpenRouter/OpenAI default. |
| `CONSISTENCY_LLM_API_KEY` | No | org BYOK, then `LLM_API_KEY`, then `OPENROUTER_API_KEY`, then provider inference | API key for the consistency-check LLM. Resolved through the shared resolver: an org BYOK credential (forwarded `x-grid-organization-id`) wins, then `CONSISTENCY_LLM_API_KEY` → `LLM_API_KEY` → `OPENROUTER_API_KEY` → the provider key inferred from the resolved base URL. If none resolves, the endpoint returns `error=llm_not_configured` (HTTP 200) so the wizard can still save. |
| `CONSISTENCY_LLM_BASE_URL` | No | `LLM_BASE_URL`, then `https://openrouter.ai/api/v1` (if `OPENROUTER_API_KEY` set) / `https://api.openai.com/v1` | Base URL for the consistency-check LLM (OpenAI-compatible `/chat/completions`). Falls back to `LLM_BASE_URL`, then the OpenRouter/OpenAI default. An org BYOK credential overrides this base URL (and the key) at request time. |
| `SUMMARY_LLM_MODEL` | No | `LLM_MODEL`, then `deepseek/deepseek-v4-flash` (if `OPENROUTER_API_KEY` set) / `gpt-4o-mini` | Model for the AI project-summary endpoint (`POST /v1/generate-summary`). Falls back to the generic `LLM_MODEL`, then the OpenRouter/OpenAI default. BYOK never changes the model. |
| `SUMMARY_LLM_API_KEY` | No | org BYOK, then `LLM_API_KEY`, then `OPENROUTER_API_KEY`, then provider inference | API key for the summary LLM, resolved through the shared resolver exactly like `CONSISTENCY_LLM_API_KEY` (org BYOK via forwarded `x-grid-organization-id` first, then `SUMMARY_LLM_API_KEY` → `LLM_API_KEY` → `OPENROUTER_API_KEY` → provider inference). If none resolves the endpoint returns `error=llm_not_configured` (HTTP 200). |
| `SUMMARY_LLM_BASE_URL` | No | `LLM_BASE_URL`, then `https://openrouter.ai/api/v1` (if `OPENROUTER_API_KEY` set) / `https://api.openai.com/v1` | Base URL for the summary LLM (OpenAI-compatible `/chat/completions`). Falls back to `LLM_BASE_URL`, then the OpenRouter/OpenAI default. An org BYOK credential overrides this base URL (and the key) at request time. |

---

## Tag Backfill Script (`scripts/backfill_document_tags.py`)

The one-off tag-backfill script runs **outside** the NAT runtime, so it builds an OpenAI-compatible client directly from these env vars, which must match the `summary_llm` block in `configs/config_*.yml`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BACKFILL_SUMMARY_API_KEY` | Yes* | `NVIDIA_API_KEY`, then provider inference | API key for the tagging LLM, resolved through the shared resolver: `BACKFILL_SUMMARY_API_KEY` → `NVIDIA_API_KEY` → the provider key inferred from `BACKFILL_SUMMARY_BASE_URL`. If none resolves the script exits with code `2` (LLM could not be constructed). The script runs outside NAT, so BYOK does not apply. |
| `BACKFILL_SUMMARY_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Base URL for the tagging LLM. Drives provider inference for the tagging key. |
| `BACKFILL_SUMMARY_MODEL` | No | `nvidia/nemotron-mini-4b-instruct` | Tagging model name. |

*Required only when running the backfill script; not needed by the running services. The store/source come from `AIQ_SUMMARY_DB` and `AIQ_CHROMA_DIR` (or `--summary-db` / `--chroma-dir`). Exit codes: `0` success (or nothing to do; `--dry-run` always `0`), `1` a real run finished with per-document classification failures, `2` missing LLM key.

---

## File Upload

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FILE_UPLOAD_ACCEPTED_TYPES` | No | `.pdf,.docx,.txt,.md` | Comma-separated list of accepted file extensions (include leading dots). Add `.pptx` for Foundational RAG backend. Governs **non-image** types only. **Image types (`.png,.jpg,.jpeg`) are derived, not env-listed**: they are offered automatically when the `image-upload` WorkOS flag allows AND the backend reports a configured VLM (`vlm_available`, derived from `AIQ_VLM_*`). Listing images here has no effect without a VLM — they are stripped from the client accept-list and rejected server-side (400) whenever the flag is off OR the VLM capability is absent (fail-closed), closing the old silent-failure hole where env-listed images without a VLM were accepted then failed ingestion. |
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
| `memory-reflection` *(WorkOS feature flag, not env)* | No | off | Sole runtime on/off switch for the reflection stage, evaluated **per organization** at the WS upgrade (`isOrgFeatureEnabled`). Create a feature flag with this slug in WorkOS and enable it for the orgs that should get reflection. Fail-closed: if WorkOS/plan/flag is unavailable, or there is no org in scope (anonymous/non-WorkOS deployments), the stage stays off — there is no env-var fallback. |
| `MEMORY_REFLECTION_MAX_CONCURRENCY` | No | `4` | Maximum reflection LLM calls running concurrently per backend process. Reflections share the event loop with live chat turns; this bounds their background LLM traffic. |
| `MEMORY_REFLECTION_MAX_PENDING` | No | `16` | Maximum reflections pending (scheduled + running) per backend process. Beyond the cap new reflections are dropped with a warning — reflection is a best-effort safety net, never queued unboundedly. |
| `GRID_ALLOW_AGENT_ORG_MEMORY` | No | `false` | When `true`, the internal memory endpoint accepts **agent-authored organization-scoped** writes. Default-deny: org-wide memory reaches every project in the tenant and the service-token endpoint cannot verify the human's org role, so an autonomous/prompt-injected write would poison the tenant (audit finding S1). Leave unset unless you accept that risk; org-wide findings are otherwise a human-only action via the org-memory panel. |

---

## Workflows (ADR-0023)

Scheduled deep research: saved per-project research briefs fired manually or on a cron schedule by the `workflow-scheduler` worker container. See `docs/architecture/workflows.md`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_WORKFLOWS_ENABLED` | No | `false` | Dark-launch gate while `GRID_ENFORCE_FEATURE_FLAGS` is off: `true` shows the Workflows tab and enables the BFF workflow routes. Also the `workflow-scheduler` service's start gate — when neither this nor flag enforcement is on, the scheduler exits cleanly at boot. With enforcement on, the per-org `workflows` WorkOS flag controls the UI/API instead. Frontend + workflow-scheduler services. |
| `GRID_WORKFLOW_SCHEDULER_POLL_MS` | No | `30000` | Scheduler tick interval. Each tick claims due schedules (`FOR UPDATE SKIP LOCKED`), advances `next_run_at`, then fires them through the BFF internal endpoint. workflow-scheduler service. |
| `GRID_WORKFLOW_SCHEDULER_BATCH` | No | `20` | Max due workflows claimed per tick. workflow-scheduler service. |
| `GRID_WORKFLOW_MIN_INTERVAL_MINUTES` | No | `15` | Minimum cadence a workflow cron expression may have; enforced at save time in the BFF. Frontend service. |
| `GRID_WORKFLOW_RUNS_RETENTION_DAYS` | No | `90` | Run-history retention; the scheduler prunes older `workflow_runs` rows. workflow-scheduler service. |

The scheduler also reuses `GRID_APP_DATABASE_URL`, `FRONTEND_INTERNAL_URL`, and `GRID_INTERNAL_API_TOKEN`. Scheduled runs go through the same async-job admission control as interactive research (`GRID_MAX_ACTIVE_JOBS[_PER_ORG]`); cap-rejected occurrences are recorded as `skipped` runs and not retried until their next scheduled slot.

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

## Observability (ADR-0029, Kubernetes/Pulumi-injected)

These are set by the Pulumi stack on the respective Deployments — not part of
`deploy/.env`. In Compose they are unset and tracing no-ops. Pulumi injects them
only when the observability tier is actually deployed (`observabilityEnabled`
AND its config dependencies — `docs/deployment/kubernetes.md` §9); otherwise
they stay unset and no producer exports.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | No | unset | OTLP/HTTP collector endpoint. Python tiers get the FULL path (`http://otel-collector:4318/v1/traces` — the NAT exporter posts as-is); the frontend gets the BASE URL (JS exporter appends `/v1/traces` per spec). Unset → frontend instrumentation no-ops. |
| `OTEL_SERVICE_NAME` | No | per-tier | `service.name` resource: `grid-ui` / `grid-aiq-agent` / `grid-agent-worker`. |

The Aspire ingestion key is NOT an env var on producers — it lives in the
Kubernetes Secret `aspire-dashboard-secrets`, referenced only by the collector and the
dashboard (see `docs/deployment/kubernetes.md` §9).

---

## Notes

- **Placeholder values**: The `.env.example` file contains commented-out optional variables. The `.env` file contains actual development keys.
- **Docker networking**: In Docker Compose, services communicate over the internal `aiq-network` bridge network. Variables like `BACKEND_URL=http://aiq-agent:8000` and `SEAWEED_ENDPOINT=http://seaweedfs:8333` use Docker DNS resolution.
- **SeaweedFS credentials**: The SeaweedFS credentials are currently hardcoded in `docker-compose.yaml` for all three services that use them. For production, these should be externalized to the `.env` file.

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

## Project Authorization (frontend)

Tune the per-project FGA authorization path (`lib/authz/projects.ts`), the WorkOS round-trips that are unique to the project save / summary / consistency-check flows (a normal chat-message persistence POST does no FGA call).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_AUTHZ_SLOW_CALL_MS` | No | `2000` | Threshold (ms) above which a WorkOS authorization call on the project-authz path is logged as slow (`[WorkOS] slow call: …`), so a production stall names the exact leg instead of an anonymous hang. The fast path stays silent. `0` disables the warning. |
| `GRID_AUTHZ_CACHE_TTL_MS` | No | `0` (off) | When `> 0`, caches per-project FGA `authorization.check` results for `(organizationMembershipId, projectId, permission)` for this many ms in the shared cache (Redis/Dragonfly, fail-open). Cuts the two WorkOS round-trips each save/summary/consistency-check makes down to zero on a cache hit. **Security tradeoff:** a project-role grant or revocation propagates up to TTL later — keep it short (30000–60000, matching the 30s feature-flag cache). The org **tenancy** check is never cached (runs every request), so a project can never be served cross-org from cache, and org-admin bypass is unaffected. Off by default; enable only where a ≤TTL revocation lag is acceptable. |
