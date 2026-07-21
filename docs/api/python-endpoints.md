# Python Backend API Endpoints

The Python backend is a FastAPI application registered as a NAT (NeMo Agent Toolkit) front-end plugin. A single plugin registration contributes all custom routes:

- **`aiq_api`** (`frontends/aiq_api/src/aiq_api/plugin.py`) — unified API with async job routes, knowledge routes (collections, documents, ingestion), and OIB admin routes.

(The old duplicate `src/aiq_agent/fastapi_extensions/` front-end was deleted on 2026-07-03, commit `2570b1b`; its `/v1/ingest` route was ported into `aiq_api`.)

## Knowledge / Collections

These routes manage knowledge collections (logical groupings of documents for retrieval).

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/collections` | Create a collection | `{ name, description?, metadata? }` | `CollectionInfo` (201) | `add_collection_routes` in `aiq_api.routes.collections` |
| `GET` | `/v1/collections` | List all collections | — | `[CollectionInfo]` | Same |
| `GET` | `/v1/collections/{name}` | Get collection details | — | `CollectionInfo` (404 if missing) | Same |
| `DELETE` | `/v1/collections/{name}` | Delete a collection | — | `{ success, collection }` | Same |
| `GET` | `/v1/knowledge/health` | Check knowledge backend health | — | `{ status, backend }` (503 if unhealthy) | Same |

**Config**: Knowledge backend is configured in the NAT workflow YAML (`knowledge_retrieval` function). Supports `llamaindex` (ChromaDB) and `foundational_rag` backends.

**NAT registration**: knowledge routes are mounted by the `aiq_api` plugin (`frontends/aiq_api/src/aiq_api/plugin.py`), which wires `add_collection_routes`, `add_document_routes`, and `add_ingest_routes` onto the knowledge router.

## Ingestion

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/ingest` | Ingest a file from a presigned URL | `{ file_ref, collection, document_id? }` | `{ job_id, status, document_id }` (202) | `add_ingest_routes` in `aiq_api.routes.ingest` (`frontends/aiq_api/src/aiq_api/routes/ingest.py`) |

Downloads the file from `file_ref` (presigned MinIO URL), saves to a temporary file, infers extension from `Content-Type` or URL path, then submits to the ingestor's `submit_job()`. The BFF upload route (`POST /api/documents/upload`) calls this endpoint after writing to MinIO.

**Supported formats**: PDF, TXT, MD, DOCX, PPTX.

## Documents

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/collections/{collection_name}/documents` | Upload documents | `multipart` with `files` | `{ job_id, file_ids, message }` (202) | `add_document_routes` in `aiq_api.routes.documents` |
| `GET` | `/v1/collections/{collection_name}/documents` | List documents in a collection (enriched with persisted per-document summaries **and tags** from the `summaries` table) | — | `[FileInfo]` | Same |
| `PATCH` | `/v1/collections/{collection_name}/documents/{file_name}/tags` | Replace a document's controlled tags (never touches the summary). Dedups then validates against the ingestion vocabulary `ALLOWED_TAGS`. | `{ tags: [string] }` | `{ collection_name, file_name, tags }` | Same |
| `GET` | `/v1/collections/{collection_name}/documents/{file_name}/visual-details` | Per-page VLM descriptions of a document's visual chunks (drawings/images/charts) — the "detailed information" the summary is distilled from. Read-only; fail-open (`{ details: [] }`) when the backend lacks the method or the lookup errors. | — | `{ details: [{ page, content_type, drawing_type, scale, text }] }` | Same |
| `DELETE` | `/v1/collections/{collection_name}/documents` | Delete files from a collection | `{ file_ids }` | `{ message, successful, failed, total_deleted }` | Same |
| `GET` | `/v1/documents/{job_id}/status` | Get ingestion job status | — | `IngestionJobStatus` (404 if missing) | Same |
| `POST` | `/v1/documents/status/batch` | Get up to 200 ingestion job statuses in one call (used by the BFF document-list reconciliation) | `{ job_ids: [string] }` | `{ statuses: { [job_id]: IngestionJobStatus \| null } }` | Same |

Uploads save files to temp locations and submit async ingestion jobs. Temp files are cleaned up by the ingestion job after processing (`cleanup_files: true` config).

**Tag edit errors** (`PATCH …/tags`): tags outside `ALLOWED_TAGS` → `400` with `detail.invalid_tags`; more than `MAX_TAGS` (5) after dedup → `400` with `detail.max_tags` + `detail.tag_count`; no summary row for `(collection, file_name)` → `404` (the summary is the anchor — there is nothing to tag without one). An empty list is accepted and clears the tags. End-user access is enforced at the BFF (`project:edit`); this route only requires the knowledge API to be configured, matching the rest of the documents router.

## Project Intake

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/consistency-check` | End-of-wizard **free-text** intake consistency check (FB-13). Calls an LLM to detect contradictions between the free-text intake answers and the structured answers (passed as read-only context) or within the free text itself; structured-vs-structured checks are done deterministically on the client and never sent here. | `{ free_text: [{field, value}], structured?: [{field, value}], locale? }` | `ConsistencyCheckResponse`: `{ findings: [{ fields, severity: "warning"\|"inconsistency", explanation }] \| null, error? }` | `add_consistency_check_routes` in `aiq_api.routes.consistency_check` |

**Best-effort by design**: always returns HTTP `200`. Any failure (no resolvable LLM key → `error=llm_not_configured`; upstream LLM error/transport failure → `llm_request_failed`; unparseable/odd-shaped LLM output → `llm_response_malformed`) yields `findings: null` + an `error` code so the wizard can save anyway. Empty free text short-circuits to `findings: []`. The LLM is resolved from `CONSISTENCY_LLM_MODEL` / `CONSISTENCY_LLM_API_KEY` / `CONSISTENCY_LLM_BASE_URL` (falling back to `LLM_*` then the OpenRouter/OpenAI defaults — see the environment-variables reference). Proxied by the BFF `POST /api/projects/{id}/consistency-check` (which adds `project:edit` authorization).

## Chat / Generation

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/chat/stream` | Chat completion SSE stream | `{ messages, projectId?, conversationId?, data_sources? }` | SSE stream | NAT framework internal |
| `POST` | `/generate/stream` | Agent generation SSE stream (thinking, searching, planning, writing, complete, error, prompt, intermediate events) | `{ query, projectId?, conversationId?, ... }` | SSE stream | NAT framework internal |
| `POST` | `/generate/respond` | HITL prompt response | `{ promptId, response, conversationId?, ... }` | `{}` | NAT framework internal |

These routes are **not registered by custom code** — they are provided by the NAT (NeMo Agent Toolkit) FastAPI front-end plugin internally. The BFF routes (`/api/chat`, `/api/generate`, `/api/generate/respond`) proxy to them.

## Async Jobs

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `GET` | `/v1/jobs/async/agents` | List available agent types | — | `{ agents: [{ agent_type, description }] }` | `register_job_routes` in `aiq_api.routes.jobs` |
| `POST` | `/v1/jobs/async/submit` | Submit a new async job. Admission-controlled: returns `429` (+`Retry-After`) when `GRID_MAX_ACTIVE_JOBS` / `GRID_MAX_ACTIVE_JOBS_PER_ORG` active-job caps are reached. **Fixed 2026-07-16**: this route (`aiq_api.routes.jobs`) now applies org model-config overrides (ADR-0014) — via the forwarded `x-grid-model-overrides`/`X-Grid-Request-Context` header when present, else a just-in-time org-side resolution (`common/model_overrides.py`'s `resolve_org_model_overrides()`) — same as `/v1/internal/workflows/submit` below. `REQUIRE_AUTH=true` + a JWT caller additionally requires a valid `X-Grid-Request-Context` envelope on this path (`context_envelope.py`); see `docs/architecture/org-model-configuration.md` and `docs/api/websocket-protocol.md`. | `{ agent_type, input, job_id?, expiry_seconds?, data_sources? }` | `{ job_id, status, agent_type }` | Same |
| `GET` | `/v1/jobs/async/job/{job_id}` | Get job status | — | `{ job_id, status, agent_type, error?, created_at }` | Same |
| `GET` | `/v1/jobs/async/job/{job_id}/stream` | SSE event stream (from beginning) | — | SSE stream (`text/event-stream`) | Same |
| `GET` | `/v1/jobs/async/job/{job_id}/stream/{last_event_id}` | SSE event stream (reconnection) | — | SSE stream | Same |
| `POST` | `/v1/jobs/async/job/{job_id}/cancel` | Cancel a running job | — | `{ job_id, status, task_cancelled }` | Same |
| `GET` | `/v1/jobs/async/job/{job_id}/state` | Get job artifacts (tool calls, outputs, sources) | — | `{ job_id, has_state, artifacts }` | Same |
| `GET` | `/v1/jobs/async/job/{job_id}/report` | Get final report | — | `{ job_id, has_report, report }` | Same |
| `GET` | `/v1/data_sources` | List available data sources | — | `[{ id, name, description, requires_auth }]` | Same |

### Async Job details

- **Agent types**: Registered via `register_agent()` in `aiq_api.registry`. Default agents: `deep_researcher`, `shallow_researcher`.
- **Job orchestration**: Uses NAT's JobStore for metadata and Dask for distributed execution. Requires `NAT_DASK_SCHEDULER_ADDRESS` and `NAT_JOB_STORE_DB_URL`.
- **Auth**: Every job endpoint calls `require_verified_principal()` for caller authentication. Job access is authorized via `authorize_job_access()`.
- **SSE**: PostgreSQL uses `LISTEN/NOTIFY` for sub-10ms event delivery; SQLite falls back to 500ms polling. Supports reconnection via `last_event_id` query param.
- **Phase progress events** (backlog T4-4, 2026-07-16): for `deep_research_agent` jobs, `PhaseProgressCallback` (`aiq_api.jobs.phase_events`) observes the orchestrator's existing task-dispatch and `run_research_batch` callback events to detect planning/research/writing/citation-verification/done transitions, persisting each as a `job.phase` row (`{"type": "job.phase", "data": {"phase": ..., ...}}`) matching the existing `job.*` lifecycle event shape — no client-side event-type changes needed. The UI status pill consumes `planning_started` / `research_started` / `writing_started` / `citation_verification_started`.
- **Per-run completion-token budget** (backlog T4-4, 2026-07-16): `GRID_MAX_RUN_COMPLETION_TOKENS` (default `0` = disabled) caps total completion tokens across every LLM call in a job, including concurrent researcher workers, via `BudgetGuardCallback` (`aiq_agent.common.budget_guard`). Exceeding it raises `RunBudgetExceededError`, which fails the job with an explicit "run exceeded the configured completion-token budget of N" message instead of a generic internal error.
- **Ghost job reaper**: Background task marks stale RUNNING jobs as FAILURE after 5 minutes without events.
- **Event cleanup**: Time-based (expiry config) + coordinated (events for expired jobs in `job_info`). PostgreSQL uses advisory locks for multi-pod safety.

**Config**: `AIQAPIConfig` in `frontends/aiq_api/src/aiq_api/plugin.py`:
- `db_url`: Job store database URL (default `sqlite+aiosqlite:///./jobs.db`)
- `expiry_seconds`: Job TTL (default 86400, min 600, max 604800)

## Workflows (internal, ADR-0023)

| Method | Path | Auth | Description | Request | Response | Handler |
|--------|------|------|-------------|---------|----------|---------|
| `POST` | `/v1/internal/workflows/submit` | Internal token (`X-Internal-Token` matching `GRID_INTERNAL_API_TOKEN`; dev-default refused outside dev; not on the external-path allowlist) | Submit a workflow-fired deep-research job on behalf of the workflow creator (no user JWT — called by the BFF fire path for scheduled and manual workflow runs). Wraps `submit_agent_job`, so admission control, cost tracking (explicit identity), and `job_access` ownership apply exactly like the public submit route. | `{ agent_type, input, job_id?, data_sources?, collection_scope?, project_context?, organization_id, user_id?, project_id?, owner_email?, budget_header?, model_overrides? }` | `{ job_id }`; 429 + `Retry-After` (caps), 409 (duplicate job id), 503 (Dask/scheduler unconfigured), 400 (unknown agent), 403 (token) | `add_workflow_routes` in `aiq_api.routes.workflows` |

## OIB Admin

| Method | Path | Auth | Description | Request | Response | Handler |
|--------|------|------|-------------|---------|----------|---------|
| `POST` | `/v1/admin/oib/sync` | Admin token (`X-Admin-Token` header matching `GRID_ADMIN_TOKEN` env) | Trigger incremental OIB PDF ingestion. Runs `sync()` from `aiq_agent.oib_sync` in a thread pool. | — | `{ status, message, files_added, files_total }` | `add_oib_routes` in `aiq_api.routes.oib` |

## Health

| Method | Path | Description | Response | Handler |
|--------|------|-------------|----------|---------|
| `GET` | `/health` | Health check endpoint registered by async job routes. Validates DB connectivity and Dask availability. Returns `200 OK` or `503 degraded`. | `{ status, dask_available, db }` | `register_job_routes` in `aiq_api.routes.jobs` |

## Auth middleware

The `AuthMiddleware` (`frontends/aiq_api/src/aiq_api/auth/middleware.py`) wraps all routes:

- **Path allowlist**: External requests only reach allowed paths (`/health`, `/docs`, `/chat`, `/chat/stream`, `/v1/chat/completions`, `/v1/data_sources`, `/v1/jobs/async/agents`, `/v1/jobs/async/submit`, `/v1/jobs/async/job/*`).
- **Auth exempt**: `/health`, `/docs`, `/redoc`, `/openapi.json` require no token even on external requests.
- **Validator chain**: Token validators are registered via `register_validator()` or `aiq_api.validators` entry points. The first successful validation wins.
- **Caller type detection**: Sets `user.type` to `"jwt"`, `"internal"`, `"unverified_jwt"`, or `"anonymous"` for downstream logic (e.g., clarifier bypass for headless callers).

## WebSocket

| Protocol | Path | Description |
|----------|------|-------------|
| `ws`/`wss` | `/websocket` | Real-time bidirectional chat with HITL support. Uses NAT's `WebSocketMessageHandler` protocol. The `ReconnectableWebSocketMessageHandler` in `aiq_api.websocket_reconnect` monkey-patches NAT to support HITL reconnection after network interruption. |

WebSocket auth mirrors the HTTP middleware: `authenticate_websocket_connection()` validates the handshake token using the same validator chain. Per-message token expiry checks reject work under expired handshake JWTs with `auth_expired` error messages.

## Configuration introspection

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| GET | `/v1/config/llm-defaults` | Model name per named LLM in the loaded workflow YAML; the BFF resolves these into per-agent-group "workflow defaults" for the org model-config UI (ADR-0014). Guarded by `x-grid-internal-token` when `GRID_INTERNAL_API_TOKEN` is set. | — | `{ llms: {name: model} }` | `routes/config_info.py` |
