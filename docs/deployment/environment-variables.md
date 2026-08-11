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
| `GRID_DEFAULT_MODEL` | No | `openai/gpt-5.6-luna` | Boot-floor model id for every `llms:` entry in `configs/config_oib_openrouter.yml`. It applies only where neither a platform default (Platform → Models, `platform_model_defaults`) nor an org override exists. **On a deployment the BFF has bootstrapped, that is nothing for the eight `llms:` entries an agent group covers — this variable no longer moves those.** It DOES still fully control `summary_llm` and `rerank_llm`, which have no agent group and therefore always resolve to the config file. **Moving the fleet to a new model is a save in the admin UI, not a change to this variable.** See `docs/architecture/org-model-configuration.md`. |
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

> **The passwords in the "Default (Docker)" column are development values and
> nothing else.** `grid_app_rw_dev` and `aiq_dev` are in this repository, so they
> are public; they exist so `docker compose up` works on a laptop against a
> throwaway Postgres that is not reachable from anywhere. A deployment must
> inject its own — compose reads `GRID_APP_RUNTIME_PASSWORD` and
> `SERVICE_PASSWORD_POSTGRES` from the environment, Coolify supplies them per
> stack, and Kubernetes takes them from the `pg-runtime-credentials` and
> `pg-app-credentials` Secrets. If you can reach your database from outside the
> host, these defaults are already wrong for you. Note also that the default
> compose stack publishes Postgres on `5432`; bind it to `127.0.0.1` or drop the
> port mapping on anything that is not a laptop.

| Variable | Required | Default (Docker) | Default (Local) | Description |
|----------|----------|------------------|-----------------|-------------|
| `GRID_APP_DATABASE_URL` | Yes | `postgresql://grid_app_rw:grid_app_rw_dev@postgres:5432/grid_app` <!-- pragma: allowlist secret (documented compose default) --> | `postgresql://grid_app_rw:…@localhost:5432/grid_app` | PostgreSQL URL for the Next.js BFF application database (Drizzle ORM), and for the purger and skill-scheduler workers. Connects as **`grid_app_rw`**, the least-privilege role: DML only, no DDL, and subject to row-level security, so a query that loses its organization filter returns no rows rather than another tenant's (ADR-0041). Pointing this at the owner credential silently disables enforcement — RLS does not apply to a table's owner. |
| `GRID_APP_RUNTIME_PASSWORD` | No | `grid_app_rw_dev` | n/a | Compose only, and only a substitution into the DSNs below — the ROLE's password is set from `GRID_APP_DATABASE_URL` by `scripts/ensure-rls-roles.mjs`, so the two cannot drift. On Kubernetes CloudNativePG reconciles the role from the `pg-runtime-credentials` Secret (Pulumi config `pgRuntimePassword`, which is **required and has no fallback** — sharing the owner's password would let a runtime-DSN holder authenticate as the owner, who is exempt from every policy); this variable is not used there. |
| `GRID_APP_MIGRATION_DATABASE_URL` | No | `postgresql://aiq:aiq_dev@postgres:5432/grid_app` | unset | Owner credential, set only on the workload that runs `drizzle-kit migrate`. DDL needs the schema owner, and a data backfill run as `grid_app_rw` would silently update zero rows. `drizzle.config.ts` prefers this and falls back to `GRID_APP_DATABASE_URL`. |
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
| `SEAWEED_PUBLIC_ENDPOINT` | No (falls back to `SEAWEED_ENDPOINT`) | `http://localhost:8333` (compose dev) | Browser-reachable SeaweedFS endpoint. The UI signs presigned URLs against this host so the browser can fetch them. Also consumed by the backend tier: the `/v1/ingest` SSRF allowlist (`aiq_api.routes.ingest._object_store_hosts`) trusts exactly the hosts of `SEAWEED_ENDPOINT` and `SEAWEED_PUBLIC_ENDPOINT`, so the backend must receive the same value the UI presigns against or every presigned ingest URL is rejected. |
| `SEAWEED_ACCESS_KEY` | Yes | `seaweedadmin` | SeaweedFS access key. Change in production. |
| `SEAWEED_SECRET_KEY` | Yes | `seaweedadmin` | SeaweedFS secret key. Change in production. |
| `SEAWEED_BUCKET` | Yes | `grid-documents` | S3 bucket name for document storage. Created by `seaweedfs-init`. |
| `SEAWEED_PRESIGNED_URL_TTL_SECONDS` | No | `600` | TTL for presigned download URLs (10 minutes). |
| `SEAWEED_PER_ORG_BUCKETS` | No | `false` | `true` writes each organization's objects into its own bucket instead of a key prefix inside `SEAWEED_BUCKET` (ADR-0043). What it buys today is that a key-construction bug stops being a cross-tenant bug, and that a tenant's usage is measurable at the storage layer. What it will buy is organization erasure as one `DeleteBucket` instead of a paginated sweep that can half-finish — **not yet implemented**: the deletion pipeline (ADR-0011) covers `project` only, and a project is a subset of an organization's bucket, so it remains a prefix sweep. Only the literal string `true` enables it. Not a cutover: the bucket is recorded on each row (`documents.storage_bucket`, NULL = `SEAWEED_BUCKET`), so flipping it changes where the **next** object is written and leaves every existing object readable where it is. On Kubernetes set via `grid-oib:seaweedfsPerOrgBuckets`. Frontend service only — the purger reads the buckets a project's documents recorded and needs neither this flag nor a naming rule. |
| `SEAWEED_TENANT_BUCKET_PREFIX` | No | `grid-org-` | Leading segment of a tenant bucket name; the rest is the slugged organization id plus a truncated SHA-256 of the original id (`src/lib/storage/bucket.ts`). Also the string the tenant S3 grants are wildcarded on (`Read:<prefix>*`), so it must not be a prefix of any platform bucket name. Changing it after objects exist does not move them — their rows still name the old bucket — but new writes go elsewhere. Frontend service only: the purge reads which buckets a project's documents recorded rather than deriving them, so it needs no naming rule. |
| `SEAWEED_READONLY_ACCESS_KEY` | No | `grid-backend-read` in both compose stacks | Access key of the READ-ONLY identity the agent tier uses. `view_knowledge_image` (ADR-0039) only ever calls `get_object`, so it is granted `Read` on the documents bucket and the tenant prefix and nothing else — not `List`, which would turn a leaked read credential into a map of the tenant. `aiq-agent` and (through `extends`) `agent-worker` carry this instead of `SEAWEED_ACCESS_KEY`, which holds Write and Tagging on every document bucket. On Kubernetes set via `grid-oib:seaweedfsBackendReadAccessKey`. |
| `SEAWEED_READONLY_SECRET_KEY` | No | a distinct value in both compose stacks (Coolify generates `SERVICE_PASSWORD_SEAWEEDREADONLY`) | Secret key for the identity above. Must differ from `SEAWEED_SECRET_KEY`; the Pulumi stack refuses a shared value. |
| `SEAWEED_TENANT_ADMIN_ACCESS_KEY` | No | `grid-tenant-admin` in both compose stacks; falls back to `SEAWEED_ACCESS_KEY` when unset | Access key of the identity allowed to create and drop tenant buckets. A second credential rather than a second client, because SeaweedFS's `Admin:<bucket>` authorises CreateBucket and DeleteBucket together and cannot express one without the other. **The frontend holds it**, because bucket creation is lazy — it happens on an organization's first upload, inside the request — so a frontend compromise can delete tenant buckets. ADR-0043 records that residual risk and what bounds it (nothing in the product deletes a tenant bucket; the incremental offsite mirror does not propagate deletions, so one is recoverable). Moving provisioning off the request path is the documented follow-up. On Kubernetes set via `grid-oib:seaweedfsTenantAdminAccessKey`. Frontend service only — the purger gets neither this credential nor a naming rule: it reads the buckets a project's documents recorded, and an unattended queue worker is the last process that should be able to drop a bucket. |
| `SEAWEED_TENANT_ADMIN_SECRET_KEY` | No | a distinct value in both compose stacks (Coolify generates `SERVICE_PASSWORD_SEAWEEDTENANT`); falls back to `SEAWEED_SECRET_KEY` when unset | Secret key for the identity above. Required in practice wherever `SEAWEED_PER_ORG_BUCKETS=true`; the fallback exists so a deployment with per-org buckets off — where nothing calls the bucket-admin client — needs no extra credential, and it fails CLOSED when they are on: the ordinary credential carries no `Admin` grant, so bucket creation errors rather than proceeding with wider authority than intended. On Kubernetes it ships in the `grid-secrets` Secret from `grid-oib:seaweedfsTenantAdminSecretKey`, which the stack requires when per-org buckets are on. Frontend service only (see above). |

---

## Backend Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BACKEND_CONFIG` | Yes | `/app/configs/config_grid_oib.yml` | Path to the NAT workflow YAML config file inside the container. The compose stack mounts `configs/` at `/app/configs`. |
| `AIQ_CHROMA_DIR` | No | `/tmp/chroma_data` | Directory for ChromaDB persistence. In Docker: `/app/data/chroma_data`. Ignored once `AIQ_CHROMA_URL`/`AIQ_CHROMA_HOST` selects a shared server. |
| `AIQ_CHROMA_URL` | No | (unset — embedded client) | Full URL of a **shared** Chroma server (e.g. `http://chroma:8000`). Setting this (or `AIQ_CHROMA_HOST`) makes every backend replica and research worker talk to ONE Chroma over HTTP instead of each opening its own embedded `PersistentClient` on local disk — which is what otherwise pins the vector store to a single pod. A scheme-less value (`chroma:8000`) is accepted; `https://` implies TLS. Unset keeps today's embedded behaviour, so local dev and single-node are untouched. |
| `AIQ_CHROMA_HOST` | No | (unset — embedded client) | Host of a shared Chroma server, as an alternative to `AIQ_CHROMA_URL`. |
| `AIQ_CHROMA_PORT` | No | `8000`, or `443` when TLS is on | Port for the shared Chroma server. A port embedded in `AIQ_CHROMA_URL` wins over this. |
| `AIQ_CHROMA_SSL` | No | `false` | Use TLS when connecting via `AIQ_CHROMA_HOST` (`1`/`true`/`yes` enable). Ignored with `AIQ_CHROMA_URL`, where the `https://` scheme decides. |
| `COLLECTION_NAME` | No | `oib_knowledge` | Default ChromaDB collection name. |
| `AIQ_RETRIEVER_TOP_K` | No | `10` | Default number of chunks a retrieval returns when a caller names no `top_k`. |
| `AIQ_VERBOSE` | No | `false` | Verbose agent/callback logging (`1`/`true`/`yes` enable). Diagnostic only. |
| `AIQ_ENABLE_DEBUG` | No | `true` | Mounts the debug console at `/debug`. Set to `0`/`false`/`no`/`off` to disable it — worth doing on any deployment where that surface should not be reachable. |
| `GRID_AVAILABLE_DOCUMENTS_MAX` | No | `50` | Caps how many documents are listed in the agent's `available_documents` prompt block; the set is sorted before capping so the cut is deterministic. `0`/negative disables the cap. |
| `AIQ_EXTRACT_TABLES` | No | `false` | Enable table extraction from documents. |
| `AIQ_EXTRACT_IMAGES` | No | `false` | Enable extraction of **embedded raster images** (image XObjects) from PDFs for VLM captioning. Does NOT capture vector CAD drawings — see `AIQ_RENDER_VISUAL_PAGES`. |
| `AIQ_EXTRACT_CHARTS` | No | `false` | Enable chart extraction from documents. |
| `AIQ_RENDER_VISUAL_PAGES` | No | `true` | Render **text-sparse / vector-heavy PDF pages** to a full-page image and VLM-caption them (captures architectural/CAD drawings — vector plans, sections, elevations, perspectives — that carry almost no extractable text and no embedded raster image, so text and image extraction both miss them). Effective only when a VLM key resolves (`AIQ_VLM_API_KEY`); fires only on pages the heuristic flags as visual, so ordinary text PDFs cost nothing extra. The rendered-page description also feeds the document summary for such PDFs, so the summary describes the drawing (type + scale) instead of a watermark. |
| `AIQ_PAGE_RENDER_MAX_DIM` | No | `2048` | Long-edge target (px) for a full-page render before it is sent to the VLM. ~2048px keeps linework, room labels and scale bars legible while staying at/below current VLM vision-encoder caps (higher just gets downsampled provider-side). Scale is computed per page from its point size, so A0 and A4 sheets both land near this target. |
| `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS` | No | `200` | A PDF page is treated as "visual" (→ rendered + VLM-captioned) when its watermark-stripped extractable text is shorter than this many characters. |
| `AIQ_VISUAL_PAGE_MIN_PATHS` | No | `300` | …OR when the page carries at least this many vector path objects (a plan/section/elevation is typically hundreds-to-tens-of-thousands of paths). |
| `AIQ_MAX_RENDERED_PAGES` | No | `20` | Hard cap on rendered pages per document, bounding VLM cost/latency on large plan sets. Excess visual pages are skipped (logged); their text is still indexed. |
| `AIQ_HYBRID_RETRIEVAL` | No | `true` | Enable **hybrid lexical + vector retrieval** (ADR-0039): an extra exact-term lexical query per collection (up to 3 technical tokens via the shared `extract_exact_terms` utility, matched with Chroma `$contains`) fused with the vector channel by reciprocal rank fusion (Cormack k=60). Fixes exact-keyword misses without re-embedding. `false`/`0`/`no`/`off` disables it (plain vector retrieval). Fail-open. Backend (aiq-agent) service. |
| `AIQ_VIEW_IMAGES_ENABLED` | No | `true` | Enable the `view_knowledge_image` NAT tool (ADR-0039): returns a knowledge visual as a **multimodal image block during a research turn**, so the model can see plans/drawings at answer time — not only at ingestion. Covers PDF pages (pypdfium2 → JPEG, long edge `AIQ_PAGE_RENDER_MAX_DIM`; base corpus from disk, project/Archiv from SeaweedFS bytes) and standalone image uploads (PNG/JPG, fetched from SeaweedFS). Project/Archiv resolution needs `FRONTEND_INTERNAL_URL` + `GRID_INTERNAL_API_TOKEN` (BFF lookup) and the `SEAWEED_*` set on the aiq-agent tier; a base-corpus-only deployment works without them. Effective only when a VLM key resolves (`AIQ_VLM_API_KEY`); every failure path degrades to a text-only explanation block. `false`/`0`/`no`/`off` disables the tool. Backend (aiq-agent) service. |
| `AIQ_VLM_BATCH_WORKERS` | No | `4` | Max concurrent VLM caption calls per file in `enrich_vlm_batch` (embedded images + rendered drawing pages share one pool). Keep modest to avoid saturating the provider rate limit; with `AIQ_INGEST_MAX_WORKERS` jobs in flight, peak VLM concurrency is workers × jobs. |
| `AIQ_VLM_TIMEOUT_SECONDS` | No | `180` | Per-request timeout on the VLM OpenAI client (both image and drawing call sites), with a single retry — so a hung request is bounded to ~2×, and one caption to ~3× (the truncation retry adds at most one more request, with SDK retries disabled). Previously SDK defaults (≈600s × 2 retries) let one hung provider park an ingest worker for ~20 minutes. Clamped to ≥ 1s, so a misconfigured `0` cannot fail every caption instantly and silently disable captioning. |
| `AIQ_EMBED_BATCH_SIZE` | No | `64` | Texts per embedding HTTP call (`NVIDIAEmbedding.embed_batch_size`, ingestor and retriever alike). The llama-index default of 10 serialized ~50 round-trips for a 500-chunk document on the ingest worker. |
| `AIQ_VLM_MODEL` | No | `nvidia/nemotron-nano-12b-v2-vl` | VLM model for vision-language tasks (image captioning during ingestion). |
| `AIQ_VLM_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Base URL for the VLM API. Drives provider inference for the VLM key (an `openrouter.ai` base URL resolves `OPENROUTER_API_KEY`). |
| `AIQ_VLM_API_KEY` | No | `NVIDIA_API_KEY`, then the provider key inferred from `AIQ_VLM_BASE_URL` | Explicit VLM key override. Resolution chain: org **BYOK** (for per-project/Archiv uploads — `/v1/ingest` forwards `x-grid-organization-id`) → `AIQ_VLM_API_KEY` → `NVIDIA_API_KEY` → provider inference from the base URL. This one resolver (`resolve_vlm_credential`) is the single source of truth both ingestion and the `vlm_available` capability bit consult; an org's `ingest_vlm` runtime model override is applied on top (see `docs/architecture/org-model-configuration.md`). |
| `AIQ_EMBED_API_KEY` | No | `NVIDIA_API_KEY`, then the provider key inferred from `AIQ_EMBED_BASE_URL` | Explicit embeddings key override (now read by the adapter). Chain: `AIQ_EMBED_API_KEY` → `NVIDIA_API_KEY` → provider inference. Inference only selects the key for the configured base URL; it never changes the base URL (embeddings need an embeddings-capable endpoint). |
| `AIQ_EMBED_MODEL` | No | `nvidia/llama-nemotron-embed-vl-1b-v2` | Embedding model name. Local override: `openai/text-embedding-3-large`. |
| `AIQ_INGEST_MAX_WORKERS` | No | `2` | Max concurrent ingestion jobs per backend process; excess uploads queue as PENDING instead of each spawning a thread against the embedding API and the embedded Chroma store. |
| `AIQ_FILE_TRACKING_RETENTION_SECONDS` | No | `86400` (24h) | How long terminal (SUCCESS/FAILED) entries in the ingestor's in-memory per-file tracking dict (`self._files`) are kept before pruning, bounding a dict that otherwise grew for the process lifetime. SUCCESS files remain listable afterwards (rebuilt from Chroma chunks with a fresh id); FAILED rows drop off the listing once the window passes. In-flight (INGESTING/UPLOADING) entries are never pruned. |
| `GRID_MAX_ACTIVE_JOBS` | No | `8` | Admission control: max non-terminal async research jobs accepted across all orgs. Beyond the cap, REST submits get 429 (+Retry-After) and chat answers with a friendly "queue full" message. `0` disables. |
| `GRID_MAX_ACTIVE_JOBS_PER_ORG` | No | `3` | Admission control: max non-terminal async research jobs per organization, so one tenant cannot occupy the whole cluster. `0` disables. |
| `GRID_MAX_ACTIVE_TURNS` | No | `24` | Admission control for INTERACTIVE chat turns (ADR-0040 L3): max turns running concurrently across all orgs. A separate pool from `GRID_MAX_ACTIVE_JOBS` on purpose — that partition is what stops background deep research from starving chat, and vice versa. Past the cap a turn answers with a friendly "busy, try again" message rather than queueing. `0` disables. |
| `GRID_MAX_ACTIVE_TURNS_PER_ORG` | No | `6` | Max concurrent interactive chat turns per organization. Without it, one shared conversation with ten members answering at once starts ten multi-agent runs and only the euro budget (ADR-0015) ever says no — after the money is spent. `0` disables. |
| `GRID_TURN_LEASE_SECONDS` | No | `900` | How long a turn may hold its admission slot before it is reclaimed as stale. Leases rather than a counter: a replica OOM-killed mid-turn would otherwise leak its slot forever and shrink the pool permanently. Must exceed the longest plausible turn — too low over-admits, too high strands slots. |
| `GRID_MAX_RUN_COMPLETION_TOKENS` | No | `0` (disabled) | Per-run completion (output) token ceiling for `deep_research_agent` jobs, enforced across every LLM call in the run including concurrent researcher workers (backlog T4-4, 2026-07-16). Exceeding it fails the job with an explicit budget-exceeded message rather than a generic internal error. Independent of the USD budget ledger below. |
| `GRID_RESEARCHER_RECURSION_LIMIT` | No | `100` | Per-worker LangGraph step cap for single-query researcher runnables (`RESEARCHER_RECURSION_LIMIT` in `tools/research.py`). A stuck researcher hits this and is caught by the `GraphRecursionError` → terminal unresearchable-note path instead of burning its budget or looping through plan → batch → resubmit. `0`/invalid values fall back to `100`. |
| `GRID_MAX_QUERY_SUBMISSIONS` | No | `3` | Maximum times the same query digest may be re-submitted to `run_research_batch` before it is returned as a terminal unresearchable gap instead of being run again (`MAX_QUERY_SUBMISSIONS` in `tools/research.py`). `0`/invalid values fall back to `3`. |
| `GRID_WRITER_CHAR_BUDGET` | No | `200000` | Total-character ceiling for the writer's tool-result context (`ToolResultPruningMiddleware.total_char_budget`, wired in `deep_researcher/factory.py`). When the sum of kept oversized tool results exceeds it, the oldest are truncated so the writer's context cannot grow unbounded across many research notes. `0`/invalid values fall back to `200000`. |
| `REDIS_URL` | No | unset (compose: `redis://dragonfly:6379/0`) | Redis-protocol URL of the shared cache (Dragonfly, ADR-0020). Consumed by BOTH the frontend (read-through caches, WS rate limiter) and the backend (citation-registry snapshots). Unset = per-process in-memory fallback. **On Kubernetes this URL is a SECRET**: Dragonfly requires a password there, so the value is `redis://:<url-encoded-password>@dragonfly:6379/0` and Pulumi delivers it from the `grid-secrets` Secret, never inline on a pod spec. Empty username is intentional — both clients (ioredis, redis-py) read that as "no username" and send the one-argument `AUTH <password>` that `requirepass` expects. Percent-encode the password: the documented generator is `openssl rand -base64 32`, whose `/`, `+` and `=` would otherwise break URL parsing and surface as an auth failure. The compose stack still runs Dragonfly without a password (single host, no shared network), which is why its value has no userinfo. |
| `GRID_CONVERSATION_BUS` | No | `1` (on) | The Dragonfly pub/sub conversation bus (ADR-0028) that makes the chat tier stateless — any replica serves any conversation's WebSocket (owner publishes stream frames + HITL prompts; the socket-holding relay subscribes; HITL answers round-trip on `conv:<id>:input`). **On by default**, using `REDIS_URL`; **fails open** to local delivery on any Redis error, so a single node behaves exactly as before. With no `REDIS_URL` it uses an in-process transport (byte-identical single-process path). Set to `0` to opt out and fall back to conversation affinity. |
| `GRID_CONV_STREAM_MAXLEN` | No | `500` | Max frames buffered per conversation in the Redis reconnect-replay stream (`conv:<id>:stream`), bounding Dragonfly memory. Best-effort — the Postgres checkpoint is source of truth. |
| `GRID_CONV_OWNER_TTL_SECONDS` | No | `15` | TTL of the conversation owner key (`conv:<id>:owner`, `SET NX EX`) that elects the single replica running a turn once affinity is off; renewed by heartbeat. |
| `GRID_NORMS_DIR` | No | `configs/norms` | Root of the norm catalog seed (ADR-0025 v2): `configs/norms/<country>/registry.yml` files are globbed and merged. The catalog is a flat list of verified RIS pointers plus curated prose legal notes (`binding_note`/`review_note`) and per-entry `verify` seeds; it feeds the `ris_search` short-circuit, the `ris_catalog_lookup` tool, and the catalog block in researcher prompts. At runtime the admin-managed store (same DB as `AIQ_SUMMARY_DB`, seeded from this YAML on first boot, edited via `/app/platform`) takes precedence; missing/invalid data disables catalog features with a warning (fail-open). Pointers re-verified via `scripts/build_ris_catalog.py` or the admin verify endpoint. |
| `GRID_RIS_CACHE_TTL_DAYS` | No | `7` | Days a fetched RIS full text (and a live `ris_search` result) is kept in the shared Dragonfly/Redis cache (`aiq_agent.common.cache`, ADR-0020) and served without re-hitting the RIS API — cutting repeated OGD-RIS + planner-LLM spend across turns, replicas, and restarts. Cache-only/fail-open: a miss or cache error just performs a live fetch. `0`/invalid values fall back to `7`. |
| `GRID_WS_UPGRADE_RATE_LIMIT` | No | `30` | Max WebSocket upgrades per client IP per minute at the gateway. Enforced by `rate-limiter-flexible` against the shared cache so the limit holds across replicas; fails open. `0` disables. Note this is a PER-IP bound: it throttles one abusive client, not the fleet-wide reconnect a rolling update causes (those arrive from thousands of distinct IPs) — see the two settings below. The edge now carries the same budget (`rateLimitAppWsUpgrade` in `deploy/pulumi`); this one keeps working while that policy is in shadow mode. |
| `GRID_WS_MESSAGE_LIMITS` | No | `1` (on) | Frontend gateway only. Count and bound the frames a client sends on an ALREADY-OPEN WebSocket (ADR-0040 L2b) — the chat turns no edge policy can ever see, because to the gateway a whole session is the single upgrade request. Budgets come from the shared catalog (`src/lib/limits/rules.js`: `chat-turn`, `ws-control`); a socket past its budget is closed with WebSocket status 1008 and the client reconnects on its jittered backoff. Set to `0` for the pre-ADR-0040 behaviour. |
| `GRID_WS_UPGRADE_MAX_INFLIGHT` | No | `32` | Frontend gateway only. Ceiling on concurrent `/api/auth/websocket-scope` resolutions per pod. Every WebSocket upgrade resolves the session, runs FGA checks and reads budgets (ADR-0020), so a reconnect herd amplifies straight into WorkOS and Postgres. Past the ceiling upgrades are shed with `503` + `Retry-After` instead of queueing, and the client retries on its jittered backoff. `0` disables the ceiling. |
| `GRID_WS_SCOPE_CACHE_TTL_MS` | No | `10000` | Frontend gateway only. How long a resolved WebSocket scope is memoised per (session, project, conversation), plus single-flight coalescing of concurrent upgrades for the same key. Deliberately PER-POD and in-memory: the payload carries an access token, which must not land in the shared cache. Keep it short — it bounds how long a revoked session can still ride a cached scope. `0` disables the memo (every upgrade re-resolves). |
| `GRID_SHUTDOWN_DRAIN_MS` | No | `2000` | Frontend gateway only. How long `server.js` keeps serving after SIGTERM before forcing exit: it starts failing `/api/healthz`, refuses new WebSocket upgrades, and lets in-flight requests and streaming answers finish. The 2s default is for local runs; the Kubernetes deployment sets 30s and sizes the pod's `terminationGracePeriodSeconds` above it, so a rolling update no longer drops live chat sessions (`deploy/pulumi/src/platform/rollout.ts`). |
| `GRID_CITATION_EVENTS_ENABLED` | No | `true` | Emit citation-health events (`src/aiq_agent/common/citation_events.py`) to `POST /api/internal/citation-events`, feeding the platform dashboard's citation-quality surface. `false`/`0`/`no`/`off` disables emission entirely; the answer path is unaffected either way. Backend (aiq-agent) service. |
| `GRID_CITATION_REGISTRY_TTL_SECONDS` | No | `86400` | TTL of per-conversation citation-source snapshots in the shared cache (lets a conversation keep prior-turn sources across restarts/replicas). |
| `AIQ_LISTEN_DB_URL` | No | job-store URL | Direct (non-pooled) Postgres URL for SSE LISTEN/NOTIFY. Set explicitly when a PgBouncer fronts the pooled DSNs — transaction pooling breaks LISTEN. |
| `AIQ_QUERY_EMBED_CACHE_SIZE` | No | `512` | Max query embeddings kept in the retriever's LRU (one query is embedded once and reused across the per-collection fan-out). |
| `AIQ_STATIC_RESULT_CACHE_COLLECTIONS` | No | `oib_knowledge` | Comma-separated collections whose retrieval results may be cached (static corpora only — never project/session collections). |
| `AIQ_STATIC_RESULT_CACHE_TTL_SECONDS` | No | `3600` | TTL for cached static-collection retrieval results; in-process writes invalidate immediately via a collection version. |
| `AIQ_EMBED_BASE_URL` | No | `https://integrate.api.nvidia.com/v1` | Embedding model API base URL. Local override: `https://openrouter.ai/api/v1`. Drives provider inference for the embeddings key (see `AIQ_EMBED_API_KEY`). |
| `CONSISTENCY_LLM_MODEL` | No | `LLM_MODEL`, then `openai/gpt-5.6-luna` (if `OPENROUTER_API_KEY` set) / `gpt-4o-mini` | Model for the end-of-wizard free-text intake consistency-check endpoint (`POST /v1/consistency-check`). Falls back to the generic `LLM_MODEL`, then the OpenRouter/OpenAI default. |
| `CONSISTENCY_LLM_API_KEY` | No | org BYOK, then `LLM_API_KEY`, then `OPENROUTER_API_KEY`, then provider inference | API key for the consistency-check LLM. Resolved through the shared resolver: an org BYOK credential (forwarded `x-grid-organization-id`) wins, then `CONSISTENCY_LLM_API_KEY` → `LLM_API_KEY` → `OPENROUTER_API_KEY` → the provider key inferred from the resolved base URL. If none resolves, the endpoint returns `error=llm_not_configured` (HTTP 200) so the wizard can still save. |
| `CONSISTENCY_LLM_BASE_URL` | No | `LLM_BASE_URL`, then `https://openrouter.ai/api/v1` (if `OPENROUTER_API_KEY` set) / `https://api.openai.com/v1` | Base URL for the consistency-check LLM (OpenAI-compatible `/chat/completions`). Falls back to `LLM_BASE_URL`, then the OpenRouter/OpenAI default. An org BYOK credential overrides this base URL (and the key) at request time. |
| `SUMMARY_LLM_MODEL` | No | `LLM_MODEL`, then `openai/gpt-5.6-luna` (if `OPENROUTER_API_KEY` set) / `gpt-4o-mini` | Model for the AI project-summary endpoint (`POST /v1/generate-summary`). Falls back to the generic `LLM_MODEL`, then the OpenRouter/OpenAI default. BYOK never changes the model. |
| `SUMMARY_LLM_API_KEY` | No | org BYOK, then `LLM_API_KEY`, then `OPENROUTER_API_KEY`, then provider inference | API key for the summary LLM, resolved through the shared resolver exactly like `CONSISTENCY_LLM_API_KEY` (org BYOK via forwarded `x-grid-organization-id` first, then `SUMMARY_LLM_API_KEY` → `LLM_API_KEY` → `OPENROUTER_API_KEY` → provider inference). If none resolves the endpoint returns `error=llm_not_configured` (HTTP 200). |
| `SUMMARY_LLM_BASE_URL` | No | `LLM_BASE_URL`, then `https://openrouter.ai/api/v1` (if `OPENROUTER_API_KEY` set) / `https://api.openai.com/v1` | Base URL for the summary LLM (OpenAI-compatible `/chat/completions`). Falls back to `LLM_BASE_URL`, then the OpenRouter/OpenAI default. An org BYOK credential overrides this base URL (and the key) at request time. |

---

## OIB Base Corpus Sync

The platform-owner base corpus (`oib_knowledge`) — repo-shipped OIB Richtlinien PDFs plus admin uploads — is discovered and ingested by `src/aiq_agent/oib_sync.py`. aiq-agent service.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OIB_COLLECTION_NAME` | No | `COLLECTION_NAME`, then `oib_knowledge` | Chroma collection the base corpus is ingested into. |
| `OIB_UPLOADS_DIR` | No | `data/oib_uploads` | Writable home for base-corpus PDFs uploaded through the platform admin UI (inside the persistent `aiq-data` volume). Scanned by sync alongside the read-only repo corpus. |
| `OIB_REGISTRY_PATH` | No | `data/oib_registry.json` | Sync bookkeeping: which corpus files have been ingested, and at what content hash. |
| `OIB_EXCLUDED_PATH` | No | `data/oib_excluded.json` | Persistent set of corpus basenames an admin removed. Repo-shipped PDFs live in git and cannot be physically deleted, so "delete" means excluding them here: their chunks are dropped and both `discover_pdfs()` and `sync()` skip them from then on, so a later sync never silently re-ingests a document that was removed on purpose. Losing this file re-admits every previously deleted document. |
| `OIB_SYNC_MAX_WORKERS` | No | `4` | Concurrent files ingested per sync run. Invalid values warn and fall back to `4`; values below `1` are clamped to `1`. |

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
| `GRID_DEFAULT_STORAGE_QUOTA_BYTES` | No | _(unset)_ | Fleet-wide default per-organization storage quota, in bytes (ADR-0042). Unset means unlimited, which is the pre-existing behaviour. An org-level value set in Organization → Storage always wins, and an explicit org-level "unlimited" beats this default. |
| `GRID_STORAGE_ALERT_THRESHOLD_PERCENT` | No | `80` | Share of its storage quota at which an organization is warned that it is running out of space (ADR-0042), as a percentage. An hourly sweep (`POST /api/internal/storage/alerts`, driven by the `storage-alerts` CronJob) raises an inbox item for every active member holding `org:settings:manage`; escalation at 90% and 100% is automatic and not configurable, so that "you have run out" stays a distinct message from "you are nearly out". The alert fires **once per crossing** rather than once per sweep — an already-live row suppresses re-emission, so a dismissed warning is not resurfaced every hour — and outstanding rows are retired when usage falls back below the threshold, which is what lets a later re-crossing alert again. Organizations with no quota are skipped entirely. A value outside `(0, 100]` falls back to `80` rather than disabling the warning, because a typo must not silently switch off the notice that stops a tenant walking into a full disk. Frontend service. On Kubernetes it is set from the Pulumi stack key `grid-oib:storageAlertThresholdPercent`, which **rejects** an out-of-range value at deploy time (where an operator is present to read the error) instead of quietly clamping it; the schedule and on/off switch are `grid-oib:storageAlertSchedule` (default `0 * * * *`) and `grid-oib:storageAlertsEnabled` (default `true`). |
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
| `memory-reflection` *(WorkOS feature flag, not env)* | No | off | Runtime on/off switch for the reflection stage **when `GRID_ENFORCE_FEATURE_FLAGS=true`**: evaluated per organization at the WS upgrade (`isOrgFeatureEnabled`); fail-closed, including org-less/anonymous sessions. Without enforcement this flag is ignored and `GRID_MEMORY_REFLECTION_ENABLED` decides instead. See `docs/architecture/project-memory-design.md` §3.5. |
| `GRID_MEMORY_REFLECTION_ENABLED` | No | `true` | Runtime on/off switch for the reflection stage **when `GRID_ENFORCE_FEATURE_FLAGS` is off** (the default). Reflection is a shipped core capability, not a dark-launched product gate, so like every non-dark feature it defaults ON in non-enforcing environments, including org-less/anonymous sessions. Only an explicit `false` disables it. Frontend service. On Kubernetes it is set from the Pulumi stack key `grid-oib:memoryReflectionEnabled` (default `true`; see `deploy/pulumi/README.md`), not by hand. |
| `MEMORY_REFLECTION_MAX_CONCURRENCY` | No | `4` | Maximum reflection LLM calls running concurrently per backend process. Reflections share the event loop with live chat turns; this bounds their background LLM traffic. |
| `MEMORY_REFLECTION_MAX_PENDING` | No | `16` | Maximum reflections pending (scheduled + running) per backend process. Beyond the cap new reflections are dropped with a warning — reflection is a best-effort safety net, never queued unboundedly. |
| `GRID_ALLOW_AGENT_ORG_MEMORY` | No | `false` | When `true`, the internal memory endpoint accepts **agent-authored organization-scoped** writes. Default-deny: org-wide memory reaches every project in the tenant and the service-token endpoint cannot verify the human's org role, so an autonomous/prompt-injected write would poison the tenant (audit finding S1). Leave unset unless you accept that risk; org-wide findings are otherwise a human-only action via the org-memory panel. |

---

## Agent Skills (ADR-0046)

The org skill toolbox, and project-level **jobs** — a prompt on a timer that may attach a skill — fired manually or on a cron schedule by the `skill-scheduler` worker container (the ADR-0023 workflow scheduler's successor; the Workflows feature and its `GRID_WORKFLOW*` variables were removed). The container and these variables keep their skill-era names although the tables they read are now `jobs`/`job_runs`: renaming them would be a deployment change with no user-visible gain. See `docs/architecture/agent-skills.md`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_COLLABORATION_ENABLED` | No | `false` | Dark-launch gate for collaboration (ADR-0032…0035: shared chats, `@`-mentions with the agent hand-off, the inbox) while `GRID_ENFORCE_FEATURE_FLAGS` is off. `true` shows the inbox nav entry + page, the share surfaces and the mention picker, and enables the `/api/inbox/*`, `/api/sharing/*`, `/api/mentions/*`, `/api/stream` and the per-conversation `/live` + `/typing` routes (ADR-0039). With enforcement on, the per-org `collaboration` WorkOS flag controls them instead. **Default-off deliberately, not fail-open like ordinary flags:** the feature changes who can see conversations, so it must not switch itself on in an environment whose operator has not chosen it. Note there is no paired capability variable — live updates degrade to polling without `REDIS_URL`, so the feature has no infrastructure dependency to gate on. One capability is genuinely reduced without a shared cache tier: **watching a colleague's turn stream in (ADR-0039) needs `REDIS_URL`**, because the frames are read from the Python tier's conversation bus. Without it the observer keeps the static turn banner and still receives the finished answer — the feature degrades, it does not break, so it is still not worth a gate. Frontend service. On Kubernetes it is set from the Pulumi stack key `grid-oib:collaborationEnabled` (see `deploy/pulumi/README.md`), not by hand. |
| `GRID_IFC_MODELS_ENABLED` | No | `true` | Gate for IFC/BIM models (ADR-0045) while `GRID_ENFORCE_FEATURE_FLAGS` is off. **On by default** — `.ifc` is in the upload accept-list (client and the server-side allow-list), the Model nav entry and `/model` page render, and every `/api/**/bim/*` route plus the agent's `ifc_query` tool answer. Set it to `false` to withdraw the feature; it keeps its own variable rather than riding the fail-open path so a deployment can do that WITHOUT switching on flag enforcement for every other feature at the same time. With enforcement on, the per-org `ifc-models` WorkOS flag decides instead. No paired capability variable: extraction runs in the BFF process with `@ifc-lite/parser` and the viewer runs in the browser; the viewer's WebGPU requirement is a per-browser fact detected at render time, which degrades to the data explorer. Worth knowing before you enable it for a customer: the feature renders OIB compliance verdicts, and `docs/roadmap/ifc-review-findings.md` lists the rules that still overstate. Frontend service. On Kubernetes it is set from the Pulumi stack key `grid-oib:ifcModelsEnabled` (see `deploy/pulumi/README.md`), not by hand. |
| `GRID_HITL_RESPONSE_TIMEOUT_SECONDS` | No | `1800` | How long a human-in-the-loop prompt stays open before the turn gives up and fails (ADR-0033 follow-up). Generous on purpose — a clarifying question can legitimately sit while somebody checks a drawing — but finite: an unanswered prompt used to pin the turn and its langgraph checkpoint indefinitely, released only when a *new* turn on the same conversation cancelled the stale task. A shared conversation makes that worse, since the asker can close the tab while colleagues keep reading. On expiry the prompt is abandoned rather than answered, so the client renders a failed turn instead of a response the user never gave. Agent service. |
| `GRID_SKILLS_ENABLED` | No | `false` | Dark-launch gate while `GRID_ENFORCE_FEATURE_FLAGS` is off: `true` shows the Skills and Jobs sections and enables every `/api/skills/*` and `/api/projects/*/jobs/*` route, and it is the **start gate for the skill-scheduler container** — when neither this nor flag enforcement is on, the scheduler logs why and exits 0 rather than polling for work nobody can create. Read case-insensitively by both, so the UI and the worker can never disagree. With enforcement on, the per-org `skills` WorkOS flag controls the UI/API instead. Frontend + skill-scheduler services. On Kubernetes it is set from the Pulumi stack key `grid-oib:skillsEnabled` (see `deploy/pulumi/README.md`), not by hand — and that key is also what decides whether the skill-scheduler Deployment is created at all. |
| `GRID_SKILL_SCHEDULER_POLL_MS` | No | `30000` | Scheduler tick interval. Each tick claims due `jobs` rows (`FOR UPDATE SKIP LOCKED`), advances `next_run_at`, then fires them through the BFF internal endpoint. skill-scheduler service. |
| `GRID_SKILL_SCHEDULER_BATCH` | No | `20` | Max due jobs claimed per tick. skill-scheduler service. |
| `GRID_SKILL_MIN_INTERVAL_MINUTES` | No | `15` | Minimum cadence a job's cron expression may have; enforced at save time in the BFF. Frontend service. |
| `GRID_SKILL_RUNS_RETENTION_DAYS` | No | `90` | Run-history retention; the scheduler prunes older `job_runs` rows. skill-scheduler service. |
| `GRID_SKILLS_CACHE_TTL_SECONDS` | No | `60` | Seconds an organization's resolved skill set (builtin + org, shadowing applied) is cached in the shared Dragonfly/Redis cache (`aiq_agent.skills.resolver`, ADR-0020) before re-resolving via the BFF internal endpoint — cutting per-turn resolution across replicas and restarts. Cache-only/fail-open: a miss or fetch error falls back to the builtin set. `0`/invalid falls back to `60`. Backend (aiq-agent) service. See `docs/architecture/agent-skills.md`. |

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

## Research Workers (ADR-0021, DB-claimed execution)

The alternative to the Dask section above. With `GRID_JOB_EXECUTION=db` the submit path persists a deep-research job as a `research_job_queue` row instead of dispatching it to a per-pod Dask cluster; dedicated worker containers (`python -m aiq_api.jobs.worker`) claim rows with `FOR UPDATE SKIP LOCKED`, run the job in-process, and heartbeat the claim so a crashed worker's job is reclaimed. This is what lets research execution scale horizontally, independently of the web tier. See `docs/adr/0021-db-claimed-research-workers.md`.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_JOB_EXECUTION` | No | `dask` | Execution backend for research jobs: `dask` (per-pod cluster) or `db` (DB-claimed workers). Any other value is treated as `dask`. |
| `GRID_JOB_PAYLOAD_KEK` | **In production** | (unset — payloads stored as plaintext JSON) | 32-byte base64 key (`openssl rand -base64 32`) that AES-256-GCM encrypts the queued job payload at rest. The `research_job_queue.payload` row durably persists the full `run_agent_job` payload, which carries **the user's auth token** plus identity/budget context — unlike the Dask path, which held it only transiently in worker memory, so this is real at-rest exposure (table, WAL, backups, replicas). Unset keeps dev/single-node working with a one-time plaintext warning; **set it in any multi-node or production deployment**. Invalid base64, or a key that does not decode to exactly 32 bytes, raises `PayloadKeyError` rather than silently falling back. Only meaningful with `GRID_JOB_EXECUTION=db`. |
| `GRID_RESEARCH_WORKERS` | No | `1` | Concurrent jobs claimed per worker process. |
| `GRID_RESEARCH_WORKER_POLL_SECONDS` | No | `5` | Idle poll interval between claim attempts. |
| `GRID_RESEARCH_WORKER_STALE_SECONDS` | No | `90` | A claim whose heartbeat is older than this is considered dead and may be reclaimed by another worker. Keep comfortably above `GRID_RESEARCH_WORKER_HEARTBEAT_SECONDS`. |
| `GRID_RESEARCH_WORKER_MAX_ATTEMPTS` | No | `3` | Reclaim attempts before the job is marked FAILURE. |
| `GRID_RESEARCH_WORKER_HEARTBEAT_SECONDS` | No | `30` | Heartbeat cadence while a job runs. |
| `GRID_WORKER_LIVENESS_FILE` | No | `/tmp/research-worker.alive` | Marker file the Kubernetes liveness probe checks — the backend image ships no `pgrep`/procps. Touched every loop tick, so a stale mtime means the claim loop hung. A write failure warns rather than killing the worker. |

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

## Data-tier authentication (Kubernetes/Pulumi-injected)

Set by the Pulumi stack on infrastructure containers, not on any first-party
service and not in `deploy/.env`. Listed because they are the other half of the
`REDIS_URL` above: they are what the *server* checks the URL's password
against. Both arrive by `secretKeyRef` — never as a container argument, since a
pod spec is readable by anything with `get pod` in the namespace.

| Variable | Container | Description |
|----------|-----------|-------------|
| `DFLY_requirepass` | both Dragonfly instances (`dragonfly`, `dragonfly-ratelimit`) | Dragonfly's `--requirepass` supplied as an env var. `DFLY_<flag>` is **case sensitive** and must be spelled exactly like this; the older `DFLY_PASSWORD` is deprecated and makes Dragonfly exit fatally. Sourced from the Secret `<instance>-auth`, whose contents are hashed onto the pod template so a rotation is a rolling update rather than a silent split-brain between the server and its consumers. Set from `grid-oib:dragonflyPassword` / `grid-oib:rateLimitStorePassword`, which must differ. |
| `REDIS_AUTH` | Envoy Gateway's rate limit service (`envoy-gateway-system`) | The counter store's password, read by upstream `envoyproxy/ratelimit`. It cannot travel in the URL: Envoy Gateway's `RateLimitRedisSettings` has only `url`, `urlRef` and `tls`, and renders `url` into `REDIS_URL` as a bare `host:port` dial address, not a URI. Injected through `provider.kubernetes.rateLimitDeployment.container.env` from the Secret `grid-ratelimit-redis-auth` in that namespace. A mismatch is **fail-open** — rate limits stop enforcing, traffic keeps flowing. |

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
| `GRID_LANDING_URL` | No | — | Base URL of the public landing site (Astro microservice, `frontends/web`) that replaces the retired in-app marketing page. The signed-out root redirect (`/`) points here — but only when `REQUIRE_AUTH=true` (the redirect lives inside the `isAuthRequired()` branch of `frontends/ui/src/app/page.tsx`; with auth off, `/` always goes to `/app/projects`). Unset falls back to the WorkOS sign-in URL. Set by the Kubernetes deployment from `ingress.webDomain`. **`/?sign-in` bypasses this bounce and goes to WorkOS** — the landing site's sign-in button must use it (`SIGN_IN_URL` in `frontends/web/src/consts.ts`), or the button returns the visitor to the landing site and the app has no reachable entry point. |
| `GRID_DISABLE_SELF_SERVE_ORGS` | No | `false` | `true` makes the platform invite-only: fresh users can no longer self-create organizations (403 `self-serve-disabled`). |
| `GRID_ENFORCE_FEATURE_FLAGS` | No | `false` | `true` enforces WorkOS feature flags (`runtime-model-config`, `deep-research` — registry: `lib/authz/feature-flags.ts`). Turn on only after the flags exist in WorkOS and orgs are targeted; sessions without the JWT `feature_flags` claim then fail closed until re-login. |

## Project Authorization (frontend)

Tune the per-project FGA authorization path (`lib/authz/projects.ts`), the WorkOS round-trips that are unique to the project save / summary / consistency-check flows (a normal chat-message persistence POST does no FGA call).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GRID_AUTHZ_SLOW_CALL_MS` | No | `2000` | Threshold (ms) above which a WorkOS authorization call on the project-authz path is logged as slow (`[WorkOS] slow call: …`), so a production stall names the exact leg instead of an anonymous hang. The fast path stays silent. `0` disables the warning. |
| `GRID_AUTHZ_CACHE_TTL_MS` | No | `0` (off) | When `> 0`, caches per-project FGA `authorization.check` results for `(organizationMembershipId, projectId, permission)` for this many ms in the shared cache (Redis/Dragonfly, fail-open). Cuts the two WorkOS round-trips each save/summary/consistency-check makes down to zero on a cache hit. **Security tradeoff:** a project-role grant or revocation propagates up to TTL later — keep it short (30000–60000, matching the 30s feature-flag cache). The org **tenancy** check is never cached (runs every request), so a project can never be served cross-org from cache, and org-admin bypass is unaffected. Off by default; enable only where a ≤TTL revocation lag is acceptable. |
| `BIM_MAX_IFC_BYTES` | No | `262144000` (250 MB) | **Three** limits in one number, so they cannot disagree about the same file: the upload ceiling for a `.ifc`, the largest file the BFF will extract, and — via `next.config.ts` — the server's request-body ceiling (`proxyClientMaxBodySize`, `serverActions.bodySizeLimit`), which is `max(FILE_UPLOAD_MAX_SIZE_MB, BIM_MAX_IFC_BYTES)`. That last one matters: when the transport limit followed the 100 MB document figure instead, a 149 MB model passed both validators and was then cut off in front of the handler, so `request.formData()` threw `TypeError: Failed to parse body as FormData` — an unhandled 500 naming neither the file nor a size. Deliberately independent of `FILE_UPLOAD_MAX_SIZE_MB` (100 MB), which is sized for documents; an Einreichung model is routinely 50–500 MB. Parsing runs in the Node process and allocates several times the file's own size, so raise this only alongside moving extraction out of the request process (ADR-0045). The batch total-size limit is also lifted to this value for a batch that carries a model, so one legal model cannot fail a limit it could never satisfy. |
| `BIM_ELEMENT_LIMIT` | No | `200000` | Cap on `bim_elements` rows written per model. The summary's counts and totals stay EXACT above the cap (they are computed while walking, before it applies); only the per-element rows stop, and `summary.truncatedAt` records it so every surface says so out loud. |
