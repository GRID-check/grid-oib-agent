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

Downloads the file from `file_ref` (presigned SeaweedFS URL), saves to a temporary file, infers extension from `Content-Type` or URL path, then submits to the ingestor's `submit_job()`. The BFF upload route (`POST /api/documents/upload`) calls this endpoint after writing to SeaweedFS.

**Supported formats**: PDF, TXT, MD, DOCX, PPTX.

## Documents

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/collections/{collection_name}/documents` | Upload documents | `multipart` with `files` | `{ job_id, file_ids, message }` (202) | `add_document_routes` in `aiq_api.routes.documents` |
| `GET` | `/v1/collections/{collection_name}/documents` | List documents in a collection (enriched with persisted per-document summaries **and tags** from the `document_metadata` table) | — | `[FileInfo]` | Same |
| `PATCH` | `/v1/collections/{collection_name}/documents/{file_name}/tags` | Replace a document's controlled tags (never touches the summary). Dedups then validates against the ingestion vocabulary `ALLOWED_TAGS`. | `{ tags: [string] }` | `{ collection_name, file_name, tags }` | Same |
| `GET` | `/v1/collections/{collection_name}/documents/{file_name}/visual-details` | Per-page VLM descriptions of a document's visual chunks (drawings/images/charts) — the "detailed information" the summary is distilled from. Read-only; fail-open (`{ details: [] }`) when the backend lacks the method or the lookup errors. | — | `{ details: [{ page, content_type, drawing_type, scale, text }] }` | Same |
| `DELETE` | `/v1/collections/{collection_name}/documents` | Delete files from a collection | `{ file_ids }` | `{ message, successful, failed, total_deleted }` | Same |
| `GET` | `/v1/documents/{job_id}/status` | Get ingestion job status | — | `IngestionJobStatus` (404 if missing) | Same |
| `POST` | `/v1/documents/status/batch` | Get up to 200 ingestion job statuses in one call (used by the BFF document-list reconciliation) | `{ job_ids: [string] }` | `{ statuses: { [job_id]: IngestionJobStatus \| null } }` | Same |

Uploads save files to temp locations and submit async ingestion jobs. Temp files are cleaned up by the ingestion job after processing (`cleanup_files: true` config).

## Document Search

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/collections/{collection_name}/search` | Deterministic semantic vector search over one collection's already-embedded chunks (**no LLM, no agent loop**). Retrieves the top `top_k` chunks via the cached retriever singleton, then aggregates document-centric: one hit per `file_name` (its max-score chunk → `score`, `snippet` ≈300 chars, `page_number`), sorted by score descending, capped at `top_k_files`. **Collection-scope check (defense-in-depth):** the target `collection_name` must be within the caller's HMAC-signed `X-Grid-Request-Context` scope envelope (the BFF `fetchSemanticHits` forwards it scoped to the one collection it authorized) — an out-of-scope collection returns `404` (indistinguishable from a missing one, so cross-tenant existence never leaks); under `REQUIRE_AUTH=true` a request carrying no valid signed scope is rejected `403`; anonymous mode (`REQUIRE_AUTH=false`) enforces nothing. `404` if the collection is missing; `422` on empty query. | `{ query (1–1000), top_k=40 (1–100), top_k_files=20 (1–100) }` | `{ hits: [{ file_name, score, snippet, page_number, collection }] }` | `add_document_search_routes` in `aiq_api.routes.document_search` |

The retriever is a **cached singleton** (`get_active_retriever` in `aiq_agent.knowledge.factory`), lazily built on first use from the **same backend + Chroma persist dir + embedding model as the active ingestor**, so a fresh process serving `/search` initializes the retriever once and reuses it (no per-request embed-client / Chroma re-init). Unlike the agent's `knowledge_retrieval` tool this route returns the structured `RetrievalResult` directly (no LLM formatting, no forced base-corpus inclusion).

**Tag edit errors** (`PATCH …/tags`): tags outside `ALLOWED_TAGS` → `400` with `detail.invalid_tags`; more than `MAX_TAGS` (5) after dedup → `400` with `detail.max_tags` + `detail.tag_count`; no summary row for `(collection, file_name)` → `404` (the summary is the anchor — there is nothing to tag without one). An empty list is accepted and clears the tags. End-user access is enforced at the BFF (`project:edit`); this route only requires the knowledge API to be configured, matching the rest of the documents router.

## Project Intake

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/consistency-check` | End-of-wizard **free-text** intake consistency check (FB-13). Calls an LLM to detect contradictions between the free-text intake answers and the structured answers (passed as read-only context) or within the free text itself; structured-vs-structured checks are done deterministically on the client and never sent here. | `{ free_text: [{field, value}], structured?: [{field, value}], locale? }` | `ConsistencyCheckResponse`: `{ findings: [{ fields, severity: "warning"\|"inconsistency", explanation }] \| null, error? }` | `add_consistency_check_routes` in `aiq_api.routes.consistency_check` |

**Best-effort by design**: always returns HTTP `200`. Any failure (no resolvable LLM key → `error=llm_not_configured`; upstream LLM error/transport failure → `llm_request_failed`; unparseable/odd-shaped LLM output → `llm_response_malformed`) yields `findings: null` + an `error` code so the wizard can save anyway. Empty free text short-circuits to `findings: []`. The LLM is resolved from `CONSISTENCY_LLM_MODEL` / `CONSISTENCY_LLM_API_KEY` / `CONSISTENCY_LLM_BASE_URL` (falling back to `LLM_*` then the OpenRouter/OpenAI defaults — see the environment-variables reference). Proxied by the BFF `POST /api/projects/{id}/consistency-check` (which adds `project:edit` authorization).

## Conversations

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/generate-conversation-title` | ChatGPT-style naming of a chat from its opening exchange, plus 0–3 OIB topic tags drawn from the caller's closed vocabulary. Backs the BFF `POST /api/conversations/{id}/generate-title`, which persists both on the `conversations` row so Historie can name and filter the chat. | `{ messages: [{role, content}], allowed_tags: string[], locale? }` | `GenerateConversationTitleResponse`: `{ title, tags, error? }` | `add_generate_conversation_title_routes` in `aiq_api.routes.generate_conversation_title` |

**Best-effort by design**: always returns HTTP `200`, with the same `llm_not_configured` / `llm_request_failed` / `llm_response_malformed` codes as its siblings and an empty title. A title is **cosmetic** — the client has already set a provisional name from the first message and keeps it — so there is deliberately no server-side fallback title (inventing one would overwrite a better name), an empty title is never persisted, and **both sides log a handled failure at WARNING rather than ERROR** so a model's phrasing cannot open a GitHub issue (issue #233). LLM settings resolve through the shared summary chain (`SUMMARY_LLM_*` → `LLM_*` → OpenRouter/OpenAI defaults, plus BYOK via the forwarded `x-grid-organization-id`).

### Reading a reply that must be JSON

`/v1/generate-conversation-title`, `/v1/feedback-digest` and `/v1/consistency-check` all ask an OpenAI-compatible endpoint for "ONLY a JSON object" and share one reader for what comes back (`aiq_api.routes._llm_json`). All three request `response_format: {"type": "json_object"}` so the constraint is on the endpoint and not only on the prompt, and all three tolerate the same, bounded, set of deviations: a ```` ```json ```` fence (closing fence optional), prose before and after the object, and a reply the completion-token cap cut off mid-object (closed with **structural closers only** — no value is ever invented). A reply that contained no JSON object at all is still reported as `llm_response_malformed`: every caller fails open to something better than the model's prose. Unparseable replies are logged with the upstream `finish_reason`, which is what separates "the completion budget was too small" from "the model ignored the contract".

## Platform quality

| Method | Path | Description | Request | Response | Handler |
|--------|------|-------------|---------|----------|---------|
| `POST` | `/v1/feedback-digest` | Plain-language digest of one window of answer feedback, backing the platform's **Answer feedback** card. Turns an aggregate (vote counts, reason mix, per-topic and anonymised per-organization splits, trend delta) plus a bounded sample of the **questions** that were rated into a short readable summary. `strengths` and `concerns` are separate required fields: a single free-form summary of a feedback dataset comes back as a list of complaints every time. | `{ window_days, answers, up, down, voters, down_voters, reasons, topics, organizations, trend_delta_points?, samples, locale? }` | `FeedbackDigestResponse`: `{ headline, strengths, concerns, recommendation?, error? }` | `add_feedback_digest_routes` in `aiq_api.routes.feedback_digest` |

**What the caller sends, and what it does not.** Counts and questions only. No answer text, no user/conversation/message identifiers, and — deliberately — **no organization identifiers**: the digest needs the shape of the distribution ("one tenant accounts for most of the negative votes"), never the identity, and the per-organization table renders directly beneath it on the same screen. The BFF strips these at its own boundary (`lib/feedback/digest.ts`), so this route never receives them.

**The sampled questions are treated as data, not instructions.** They are the one piece of raw, user-authored text that reaches the model here, so each is fenced in `<question>…</question>` markers (with any closing marker inside the text neutralised) and the system prompt declares everything between those markers as data to summarise. A user who anticipates being sampled cannot steer the digest a platform owner reads by writing instructions into their question.

**Best-effort by design**: always returns HTTP `200`. `no_feedback` (nothing was rated — the model is never called), `llm_not_configured`, `llm_request_failed` and `llm_response_malformed` all come back with an empty digest so the page, which works without it, keeps working. LLM settings resolve through the shared summary chain (`SUMMARY_LLM_*` → `LLM_*` → OpenRouter/OpenAI defaults, plus BYOK). Proxied by the BFF `GET /api/platform/answer-feedback/digest`, which adds the platform-owner gate and a 6-hour shared cache.

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
| `POST` | `/v1/jobs/async/submit` | Submit a new async job. Admission-controlled: returns `429` (+`Retry-After`) when `GRID_MAX_ACTIVE_JOBS` / `GRID_MAX_ACTIVE_JOBS_PER_ORG` active-job caps are reached. **Fixed 2026-07-16**: this route (`aiq_api.routes.jobs`) now applies org model-config overrides (ADR-0014) — via the forwarded `x-grid-model-overrides`/`X-Grid-Request-Context` header when present, else a just-in-time org-side resolution (`common/model_overrides.py`'s `resolve_org_model_overrides()`) — same as `/v1/internal/skills/submit` below. `REQUIRE_AUTH=true` + a JWT caller additionally requires a valid `X-Grid-Request-Context` envelope on this path (`context_envelope.py`); see `docs/architecture/org-model-configuration.md` and `docs/api/websocket-protocol.md`. | `{ agent_type, input, job_id?, expiry_seconds?, data_sources? }` | `{ job_id, status, agent_type }` | Same |
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

## Agent Skills / Jobs (internal; replaces the removed ADR-0023 workflow submit route)

| Method | Path | Auth | Description | Request | Response | Handler |
|--------|------|------|-------------|---------|----------|---------|
| `POST` | `/v1/internal/skills/submit` | Internal token matching `GRID_INTERNAL_API_TOKEN`, sent as **`X-Grid-Internal-Token`** (`X-Internal-Token` also accepted — see the note below); dev-default refused outside dev; not on the external-path allowlist | Submit a **job** run as an async job on behalf of the job's owner (no user JWT — called by the BFF fire path for scheduled and manual runs). Wraps `submit_agent_job`, so admission control, cost tracking (explicit identity), and `job_access` ownership apply exactly like the public submit route. Agent selection is deterministic from the JOB's `output` (`chat` → `shallow_researcher`, `deep-research` → `deep_researcher` — `_OUTPUT_AGENT_TYPES`) unless `agent_type` overrides it; nothing is read off the skill. `skills` is the attached skill's name or an **empty list** (a job may attach none, and then the prompt runs alone), and it becomes `force_skills` on the submitted job. `conversation_id` is the conversation the BFF created for an `output='chat'` run to land in; absent for deep-research and for any run whose conversation could not be created. | `{ input, skills, output, agent_type?, job_id?, data_sources?, collection_scope?, project_context?, organization_id, user_id?, project_id?, conversation_id?, owner_email?, budget_header?, model_overrides? }` — `input` is the composed prompt (job prompt + the attached skill's body), max 48000 chars | `{ job_id }`; 429 + `Retry-After` (caps), 409 (duplicate job id), 503 (Dask/scheduler unconfigured), 422 (invalid payload / unknown data sources / neither `output` nor `execution`), 400 (unknown agent), 403 (token) | `add_skill_routes` in `aiq_api.routes.skills` |

**`output` vs. `execution` (temporary).** `execution` is the pre-rename spelling of `output` and is still accepted, used only when `output` is absent; sending both logs a warning and `output` wins. The BFF and this service deploy separately, so a hard rename would 422 every scheduled run in the window between the two deploys. Both fields are Optional in the schema, which leaves "neither" structurally legal — a model validator rejects that case as a 422 rather than letting it become a 500. Delete the alias once every BFF sending `output` is deployed.

**Internal token header (fixed).** `_require_internal_token` (`aiq_api.routes.internal_auth`) accepts **both** `x-grid-internal-token` and `x-internal-token`, constant-time and with every candidate compared even after one matches. It previously accepted `x-internal-token` only, while every caller in the repo sends `x-grid-internal-token` — so this route 403'd every real request and scheduled runs never worked in a deployment. It went unnoticed because the two sides are tested separately and each pinned its own spelling, and because the ASGI envelope middleware (`context_envelope._INTERNAL_TOKEN_HEADER_NAMES`) already accepted both, letting a request look healthy right up to the route guard.

## OIB Admin

| Method | Path | Auth | Description | Request | Response | Handler |
|--------|------|------|-------------|---------|----------|---------|
| `POST` | `/v1/admin/oib/sync` | Admin token (`X-Admin-Token` header matching `GRID_ADMIN_TOKEN` env) | Trigger incremental OIB PDF ingestion. Runs `sync()` from `aiq_agent.oib_sync` in a thread pool. | — | `{ status, message, files_added, files_total }` | `add_oib_routes` in `aiq_api.routes.oib` |
| `PATCH` | `/v1/admin/oib/documents/{file_name}/doc-class` | Admin token | Set a base-corpus document's explicit `doc_class` ("Dokumentart"). Store-authoritative — no re-ingest. `400` off-vocabulary, `404` when no metadata row. | `{ doc_class }` | `{ file_name, doc_class }` | `add_oib_routes` |
| `PATCH` | `/v1/admin/oib/documents/{file_name}/display-title` | Admin token | Rename a base-corpus document (user-facing `display_title` on citation chips). Store-authoritative — no re-ingest. Empty/null clears the override, restoring the derived default. `404` when no metadata row. | `{ display_title }` | `{ file_name, display_title }` | `add_oib_routes` |

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
