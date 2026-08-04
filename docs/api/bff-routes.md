# BFF API Routes

All BFF (Backend-for-Frontend) routes are under `frontends/ui/src/app/api/`. They proxy to the Python backend, handle auth, and inject collection scope headers.

## Architecture & error contract (ADR-0017)

Every route is declared through a factory from `@/lib/api/handler`
(`apiRoute` / `internalApiRoute` / `publicApiRoute`) and delegates to a
domain service + repository (see
`docs/architecture/bff-service-architecture.md`). Error responses share one
envelope:

```json
{ "error": "<message>", "code": "<CODE>", "details": <optional> }
```

Common codes: `BAD_REQUEST` (400, zod issues in `details`), `FORBIDDEN`
(403), `NOT_FOUND` (404 — also used for denied access so responses never
confirm a resource exists), `CONFLICT` (409), `UNPROCESSABLE` (422),
`UPSTREAM_ERROR` (502), `SERVICE_UNAVAILABLE` (503), `INTERNAL` (500, no
internal details leaked).

Security behavior as of the ADR-0017 refactor:

- Document list/download/preview/status enforce `project:view` FGA, not just
  org membership; filenames are sanitized (RFC 5987) before
  `Content-Disposition` on presigned URLs.
- `POST /api/conversations` validates a supplied `projectId` via
  `project:view` FGA; message roles are restricted to
  `user|assistant|system|tool`.
- `PUT /api/organization/settings` requires `org:settings:manage`.
- List endpoints are bounded (projects 500, conversations 200, messages
  1000, documents 500, holds/deletions 200).

## Auth

| Method | Path | Auth | Description | Request | Response |
|--------|------|------|-------------|---------|----------|
| `GET` | `/api/auth/callback` | No | WorkOS AuthKit callback handler. Delegates to `@workos-inc/authkit-nextjs`'s `handleAuth()`. | Query params from WorkOS OAuth redirect | Redirect to app |
| `GET` | `/api/auth/websocket-scope` | Varies | Internal endpoint called by `server.js` during WebSocket upgrade. Resolves collection scope, auth headers, and returns base64url-encoded scope + org/user IDs + access token. | `?projectId=&conversationId=` | `{ scope, header, organizationId?, userId?, accessToken? }` |
| `GET` | `/api/auth/connection-diagnostics` | Required | Browser-safe reason discovery for a failed chat WebSocket upgrade. The gateway collapses a budget-exhausted upgrade into a bare failed handshake the browser can't read, so the chat client calls this after retries are exhausted to learn whether the cause was budget exhaustion. Read-only; reuses the same budget-check logic (ADR-0015). | `?projectId=` | `{ budgetExhausted, blockedScope, canManageBudgets }` |

Source: `frontends/ui/src/app/api/auth/callback/route.ts`, `frontends/ui/src/app/api/auth/websocket-scope/route.ts`, `frontends/ui/src/app/api/auth/connection-diagnostics/route.ts`

## Chat

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `POST` | `/api/chat` | Varies | Proxy to `POST /chat/stream` on Python backend. SSE stream of text chunks. | `{ messages, projectId?, conversationId?, data_sources? }` | SSE stream (`text/event-stream`) |

Proxies to: `{BACKEND_URL}/chat/stream`. Forwards `Authorization`, `X-Grid-Collection-Scope` headers.

Source: `frontends/ui/src/app/api/chat/route.ts`

## Generate

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `POST` | `/api/generate` | Varies | Proxy to `POST /generate/stream`. Rich SSE stream with typed events: `thinking`, `complete`, `error`, `prompt`, `intermediate`. | `{ query, projectId?, conversationId?, data_sources?, ... }` | SSE stream (`text/event-stream`) |
| `POST` | `/api/generate/respond` | Varies | Proxy to `POST /generate/respond`. Sends HITL prompt responses (approve/reject/input) from the frontend. | `{ promptId, response, conversationId?, projectId? }` | JSON `{}` |

Source: `frontends/ui/src/app/api/generate/route.ts`, `frontends/ui/src/app/api/generate/respond/route.ts`

## Conversations

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/conversations` | Required | List all conversations for the current org, ordered by `updatedAt` desc. | — | `[{ id, title, createdAt, updatedAt, ... }]` |
| `POST` | `/api/conversations` | Required | Create a new conversation. | `{ id, title?, projectId? }` | `{ id, title, ... }` (201) |
| `GET` | `/api/conversations/{id}` | Required | Get a single conversation. Verifies org ownership (404 if wrong org). | — | `{ id, title, ... }` |
| `PATCH` | `/api/conversations/{id}` | Required | Rename a conversation. | `{ title }` | `{ id, title, ... }` |
| `DELETE` | `/api/conversations/{id}` | Required | Delete a conversation. | — | `204 No Content` |
| `GET` | `/api/conversations/{id}/messages` | Required | List messages for a conversation, ordered by `createdAt` asc. Verifies org ownership. | — | `[{ id, role, content, metadata, createdAt }]` |
| `POST` | `/api/conversations/{id}/messages` | Required | Create one or more messages. Accepts a single message or an array. | `{ id, role, content }` or `[{ id, role, content }, ...]` | `[{ id, role, content, ... }]` (201) |
| `PATCH` | `/api/conversations/{id}/messages/{messageId}` | Required | Record the user's answers to that answer's interactive cards, merged **per card key** into `metadata.cardInteractions` (ADR-0030), so a settled `project_profile_patch` / `memory_proposal` cannot be re-offered after a server rehydrate. `decision` is validated against a closed union, `decidedAt` must be a UTC ISO-8601 instant (`…Z`; offset forms are rejected), keys are ≤64 chars and ≤64 entries; a non-uuid `messageId` is a 400. | `{ cardInteractions: { "<type>-<index>": { decision, decidedAt } } }` | `{ id, role, content, metadata, ... }` |

Two further per-conversation routes belong to the collaboration feature and are
documented with the rest of it in
[`collaboration-routes.md`](collaboration-routes.md): `POST /api/conversations/{id}/typing`
(composing presence) and `GET /api/conversations/{id}/live` (watch a turn stream in).
Both are gated on the collaboration flag.

All conversation routes access the PostgreSQL database directly (not proxied to Python). They enforce org-level scoping by filtering on `conversations.organizationId`. `messages` has no organization column, so message routes resolve the conversation org-scoped first and 404 on a mismatch.

Source: `frontends/ui/src/app/api/conversations/route.ts`, `frontends/ui/src/app/api/conversations/[id]/route.ts`, `frontends/ui/src/app/api/conversations/[id]/messages/route.ts`, `frontends/ui/src/app/api/conversations/[id]/messages/[messageId]/route.ts`

## Projects

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `GET` | `/api/projects` | Required | List all projects in the current org. | — | `[{ id, name, collectionName, createdAt, ... }]` |
| `POST` | `/api/projects` | Required | Create a project. Inserts DB row + creates WorkOS FGA resource + assigns creator as `project-admin`. | `{ name }` | `{ id, name, collectionName, ... }` (201) |
| `GET` | `/api/projects/{id}` | Required | Get project details. Checks `project:view` FGA permission. | — | `{ id, name, collectionName, ... }` |
| `PATCH` | `/api/projects/{id}` | Required | Rename a project. Checks `project:manage` FGA permission. | `{ name }` | `{ id, name, ... }` |
| `DELETE` | `/api/projects/{id}` | Required | Soft-delete a project (name confirmation) and enqueue the purge after the grace period (ADR-0011). Checks `project:manage`. | `{ confirmName }` | `{ status: 'pending', purgeAfter }` (202) |
| `GET` | `/api/projects/{id}/members` | Required | List project members. Checks `project:manage`. Merges FGA role assignments with WorkOS user list. | — | `{ members: [{ organizationMembershipId, userId, email, name, role }] }` |
| `POST` | `/api/projects/{id}/members` | Required | Add a member. Checks `project:manage`. Assigns a project-level FGA role. | `{ organizationMembershipId, roleSlug }` | `201 No Content` |
| `DELETE` | `/api/projects/{id}/members/{assignmentId}` | Required | Remove a member. Checks `project:manage`. Removes WorkOS FGA role assignment. | — | `204 No Content` |
| `POST` | `/api/projects/{id}/consistency-check` | Required | End-of-wizard **free-text** intake consistency check (FB-13). Checks `project:edit` FGA (as of commit 873754b — aligned with the profile save/summary flow; only editors save the wizard). Proxies the backend `POST /v1/consistency-check`, which asks an LLM whether the free-text answers contradict the structured answers (passed as read-only context) or each other. **Fully fail-open**: always `200`; any backend non-200/transport failure or missing-LLM config degrades to `{ findings: null, error }` so a check outage never blocks the save. `findings: []` = consistent. | `{ freeText: [{field,value}] (≤50), structured?: [{field,value}] (≤200), locale? }` | `{ findings: [{ kind:'ai', fields, severity:'warning'\|'inconsistency', message }] \| null, error? }` |

Source: `frontends/ui/src/app/api/projects/route.ts`, `frontends/ui/src/app/api/projects/[id]/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/[assignmentId]/route.ts`, `frontends/ui/src/app/api/projects/[id]/consistency-check/route.ts` (service: `frontends/ui/src/lib/project-profile/profile-service.ts`)

## Documents

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/documents` | Required | List documents for a project. Requires `projectId` query param. Checks `project:view` FGA. Read-only document metadata (`summary`, `pageCount`, `chunkCount`, `contentTypes`) is merged from the backend collection listing when available; the internal `metadata` jsonb (ingest job id) is never returned. | `?projectId=` | `{ documents: [{ id, filename, fileSize, contentType, status, errorMessage?, summary?, pageCount?, chunkCount?, contentTypes?, ... }] }` |
| `POST` | `/api/documents/upload` | Required | Upload a file. Checks `project:edit` FGA. Writes to SeaweedFS, creates DB row, triggers ingestion via `POST /v1/ingest` on Python backend. | `multipart/form-data` with `projectId` + `file` | `{ documentId, jobId?, status, filename }` |
| `POST` | `/api/documents/search` | Required | Document-centric **semantic search** over a project's corpus (deterministic vector search, no LLM). Checks `project:view` FGA (via `listDocuments`), resolves the project's RAG collection, and proxies to the backend `POST /v1/collections/{c}/search` (`{ query, top_k: 40, top_k_files: topK }`). Backend hits (one per file, best snippet, score-descending) are joined to the project's own file rows **by filename** (`hit.file_name === file.filename`; a filename collision resolves to the most-recent row), so every result is a real, visible document with its live status/metadata plus match evidence. Fail-open: a backend error/timeout yields `{ hits: [] }`, never a 5xx. Body is zod-validated (`q` 1–1000 chars; `topK` 1–100, default 20). | `{ projectId, q, topK? }` | `{ hits: [{ id, filename, status, ..., snippet, page, score }] }` (reordered by score) |
| `GET` | `/api/documents/{id}/download` | Required | Get a presigned download URL for a document. Verifies org ownership + `project:view` FGA. | — | `{ downloadUrl, filename, contentType, fileSize }` |
| `GET` | `/api/documents/{id}/preview` | Required | Presigned inline preview URL (PDF/image types only; 415 otherwise). Verifies org ownership + `project:view` FGA. | — | `{ url, contentType, filename }` |
| `GET` | `/api/documents/{id}/status` | Required | Get document ingestion status. Verifies org ownership + `project:view` FGA. Also merges the read-only document metadata (`summary`, `pageCount`, `chunkCount`, `contentTypes`) from the backend collection listing when available. | — | `{ id, status, filename, fileSize, contentType, collectionName, errorMessage?, createdAt, updatedAt, summary?, pageCount?, chunkCount?, contentTypes? }` |
| `POST` | `/api/documents/{id}/reingest` | Required | Re-dispatch a previously-**failed** document to the ingest pipeline (re-runs the same `POST /v1/ingest` call the upload path uses). Verifies org ownership + `project:edit` FGA. Rejects documents not in `failed` status with `409 CONFLICT`. | — | `{ id, status, jobId }` (status `pending` on success, `failed` if dispatch fails again) |
| `PATCH` | `/api/documents/{id}/tags` | Required | Replace a document's controlled ingestion tags. Verifies org ownership + `project:edit` FGA. Tags are validated against the mirrored controlled vocabulary (`ALLOWED_TAGS`) — off-vocabulary values are rejected fast with `400 BAD_REQUEST` (`invalidTags` in `details`) before any backend round-trip; the zod schema caps the count at `MAX_TAGS` (5, each 1–128 chars). An empty list clears the tags. Proxied to the backend `PATCH /v1/collections/{c}/documents/{f}/tags` (keyed by the document's `collectionName` + `filename`), which is the authority on the vocabulary and cap; a missing summary row surfaces as `404 NOT_FOUND`, an unreachable/failed backend as `502 UPSTREAM_ERROR`. The one-sentence summary is never touched. | `{ tags: string[] }` | `{ id, tags }` |
| `GET` | `/api/documents/{id}/visual-details` | Required | Per-page VLM descriptions of a document's visual chunks (drawings/images/charts) for the file-preview "detailed information" section. Verifies org ownership + `project:view` FGA. Proxied to the backend `GET /v1/collections/{c}/documents/{f}/visual-details`. Read-only and fail-soft: any backend hiccup or an unsupported backend yields `{ details: [] }` rather than an error. | — | `{ id, details: [{ page, contentType, drawingType, scale, text }] }` |
| `DELETE` | `/api/documents/{id}` | Required | Delete a project document: purges the RAG chunks (best-effort), removes the SeaweedFS object, deletes the row, audits (`document.deleted`). Verifies org ownership + `project:edit` FGA. Org-wide Archiv documents (NULL `projectId`) are not deletable here — they surface as `404 NOT_FOUND` and go through `DELETE /api/archiv/documents/{id}` instead. | — | `204 No Content` |

Document upload stores files in SeaweedFS at key `{orgId}/{projectId}/{documentId}/{filename}`. Presigned URLs expire after `SEAWEED_PRESIGNED_URL_TTL_SECONDS` (default 600s). Ingestion is best-effort: on the first upload a failed backend dispatch marks the document `failed` with an `errorMessage`; `POST /api/documents/{id}/reingest` lets the user retry that dispatch from the Files workspace.

Source: `frontends/ui/src/app/api/documents/route.ts`, `frontends/ui/src/app/api/documents/upload/route.ts`, `frontends/ui/src/app/api/documents/search/route.ts`, `frontends/ui/src/app/api/documents/[id]/route.ts`, `frontends/ui/src/app/api/documents/[id]/download/route.ts`, `frontends/ui/src/app/api/documents/[id]/status/route.ts`, `frontends/ui/src/app/api/documents/[id]/reingest/route.ts`, `frontends/ui/src/app/api/documents/[id]/tags/route.ts`, `frontends/ui/src/app/api/documents/[id]/visual-details/route.ts`

## Archiv (org-wide documents, ADR-0024, feature-gated)

The org-wide **Archiv** is a top-level document store shared by every project in
the organization. It reuses the whole document pipeline: an Archiv document is a
`documents` row with `project_id = NULL`, `scope = 'archiv'`, and
`collection_name = archiv_<orgId>`, and its download/preview/status/reingest/tags
go through the **same** `/api/documents/{id}/*` routes above (those routes are
scope-aware: for an `archiv` document they authorize at the org level instead of
per-project FGA). Only the org-scoped list/upload/delete need their own routes.
All routes are gated by the `organization-archiv` feature flag (available to all
while flag enforcement is off; per-org once on); a disabled org gets `403 { error: 'feature-disabled' }`.

| Method | Path | Auth | Notes | Request | Response |
|--------|------|------|-------|---------|----------|
| `GET` | `/api/archiv/documents` | Any org member | List the org's Archiv documents (bounded, lazily status-reconciled + metadata-merged, same as the project list). | — | `{ documents: [...], collectionName, canManage }` |
| `POST` | `/api/archiv/documents/search` | Any org member | Document-centric **semantic search** over the org's shared Archiv (deterministic vector search, no LLM). Resolves the `archiv_<orgId>` collection and proxies to the backend `POST /v1/collections/{c}/search`, then joins the hits to the Archiv's own file rows **by filename** — the exact same treatment as `POST /api/documents/search`, differing only in scope (org membership instead of per-project FGA). Fail-open: a backend error/timeout yields `{ hits: [] }`. Body is zod-validated (`q` 1–1000 chars; `topK` 1–100, default 20). | `{ q, topK? }` | `{ hits: [{ id, filename, status, ..., snippet, page, score }] }` (reordered by score) |
| `POST` | `/api/archiv/documents/upload` | `org:archiv:manage` | Upload a file into the Archiv. Writes to SeaweedFS under `org/{orgId}/archiv/doc/{documentId}/{filename}`, creates an `archiv`-scoped DB row, and dispatches `POST /v1/ingest` into `archiv_<orgId>`. Best-effort ingest, same as the project path. | `multipart/form-data` with `file` | `{ documentId, jobId?, status, filename }` |
| `DELETE` | `/api/archiv/documents/{id}` | `org:archiv:manage` | Delete an Archiv document: purges the RAG chunks (best-effort), removes the SeaweedFS object, deletes the row, audits. | — | `204 No Content` |

Every project in the org retrieves across its Archiv automatically: the
`archiv_<orgId>` collection is injected into the retrieval scope by
`computeCollectionScope` (see `buildCollectionScopeFromRequest`), so no per-project
copy and no backend retrieval change are needed. Audited as
`archiv.document.uploaded` / `archiv.document.deleted`.

Source: `frontends/ui/src/app/api/archiv/documents/route.ts`, `.../upload/route.ts`, `.../search/route.ts`, `.../[id]/route.ts`; `frontends/ui/src/lib/archiv/*`.

## Answer feedback (per-answer thumbs, feature-gated)

Per-answer thumbs feedback (WS-7 of the click-dummy overhaul spec): one vote
per (user, answer), where `messageId` is the **client-side** assistant message
identifier (shallow chat turns are not persisted as `messages` rows). Voting
model: re-vote = upsert, toggle-off = `DELETE` (no tombstones). All routes are
gated by the `answer-feedback` feature flag (available to all while
`GRID_ENFORCE_FEATURE_FLAGS` is off; stable `feature-disabled` 403 once on).
Users only ever read/write their **own** votes; when a vote carries a
`projectId`, `project:view` FGA is additionally enforced.

| Method | Path | Auth | Description | Request | Response |
|--------|------|------|-------------|---------|----------|
| `POST` | `/api/feedback/answers` | Required | Upsert the caller's vote on one answer. `reason` (fixed keys `inaccurate`/`too_slow`/`wrong_source`/`other`) is only valid with `verdict: "down"`. | `{ messageId, verdict: 'up'\|'down', reason?, conversationId?, projectId? }` | `{ messageId, verdict, reason }` |
| `DELETE` | `/api/feedback/answers?messageId=` | Required | Retract (toggle off) the caller's vote. Idempotent. | — | `204 No Content` |
| `GET` | `/api/feedback/answers?conversationId=` | Required | The caller's own votes in one conversation (bounded to 200), for client hydration. | — | `{ feedback: [{ messageId, verdict, reason }] }` |

These three routes are the whole of the tenant-facing surface — nobody in an
organization can read anyone else's votes. The collected feedback is read back
cross-organization by the platform owner only, through
`/api/platform/answer-feedback` (and its `/export` and `/digest` siblings) in the
platform-tier table below.

Source: `frontends/ui/src/app/api/feedback/answers/route.ts`; `frontends/ui/src/lib/feedback/*`.

## Knowledge base

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/knowledge-base` | Required | Transparency report over the shared OIB base corpus: every corpus file with its live index state (`ingested` / `stale` / `pending` / `snapshot` / `removed` / `inconsistent`), origin (`corpus` / `uploaded` / `index_only`), chunk counts, checksums, and aggregate counts. Proxies the backend's `GET /v1/oib/status` (the generic `/api/v1` proxy deliberately blocks the base collection, so this dedicated service is the only path). Read-only; any authenticated session. | — | `{ collectionName, collectionExists, collectionUpdatedAt, summary: { totalFiles, ingested, stale, pending, snapshot, removed, inconsistent, totalChunks }, files: [{ fileName, state, origin, sizeBytes, chunkCount, ingestedSha256, currentSha256, ingestedAt, summary }] }` |
| `GET` | `/api/knowledge-base/documents/{fileName}` | Required | Streams a base-corpus source PDF inline (powers the in-app PDF viewer for clicked citations and knowledge pages). 404 when the deployment ships no sources (pre-baked index seed). | — | `application/pdf` stream |
| `POST` | `/api/platform/knowledge/documents` | Platform owner | Upload a PDF into the shared base corpus. The backend persists it to the writable uploads dir and ingests it synchronously (up to ~10 min), so the response reflects the terminal state. Proxies `POST /v1/admin/oib/documents` with `X-Admin-Token` (`GRID_ADMIN_TOKEN`). | `multipart/form-data` with `file` | `{ status: 'success'\|'failed'\|'timeout', fileName, message }` (502 on failed) |
| `DELETE` | `/api/platform/knowledge/documents/{fileName}` | Platform owner | Remove an admin-uploaded corpus document (source file + registry entry + indexed chunks). Repo-shipped corpus files are immutable (404). | — | `{ success, fileName }` |
| `POST` | `/api/platform/knowledge/sync` | Platform owner | Trigger an incremental corpus re-sync (proxies `POST /v1/admin/oib/sync`). | — | `{ filesAdded, filesTotal, message }` |

Source: `frontends/ui/src/app/api/knowledge-base/**`, `frontends/ui/src/app/api/platform/knowledge/**` (service: `frontends/ui/src/lib/knowledge/service.ts`). Rendered by the project "Knowledge" page (`/app/projects/{id}/knowledge`, feature-flagged via `project-knowledge-page` / `GRID_PROJECT_KNOWLEDGE_PAGE_ENABLED`, default off) and the platform dashboard's "Base knowledge" manager. The platform routes require `GRID_ADMIN_TOKEN` on the frontend service (must match the aiq-agent value).

## Health

| Method | Path | Auth | Description | Response |
|--------|------|------|-------------|----------|
| `GET` | `/api/health` | No | Proxy to `GET /health` on Python backend. Used by K8s health checks. 5s timeout. Returns `502` on failure. | Passthrough from backend, or `502` |

Source: `frontends/ui/src/app/api/health/route.ts`

## V1 API (generic proxy)

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `GET` | `/api/v1/{path}` | Varies | Generic proxy for Python `/v1/*` endpoints. Validates collection names for collection-scoped routes. | — | JSON from backend |
| `POST` | `/api/v1/{path}` | Varies | Same as GET, for POST requests. Supports `multipart/form-data` (streams raw body without buffering). | JSON or `multipart/form-data` | JSON from backend |
| `DELETE` | `/api/v1/{path}` | Varies | Same as GET, for DELETE requests. | Optional JSON body | JSON or `204 No Content` |

Collection validation rules in `validateCollectionName()`:
- Base collection (e.g., `oib_knowledge`): uploads rejected with `400 INVALID_COLLECTION`.
- Project collections (`proj_*`): requires authenticated session + `project:edit` permission.
- Session collections (`s_*`): must match the `conversationId` query/body param.

Source: `frontends/ui/src/app/api/v1/[...path]/route.ts`

## Deep Research / Async Jobs

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/jobs/async/agents` | Varies | List registered agent types. Proxies to `GET /v1/jobs/async/agents`. | — | `{ agents: [{ agent_type, description }] }` |
| `POST` | `/api/jobs/async/submit` | Varies | Submit a new async job. Proxies to `POST /v1/jobs/async/submit`. **Fixed 2026-07-16**: resolves the caller's active model overrides (`getActiveModelOverrides`) and forwards them, plus the signed `X-Grid-Request-Context` envelope, alongside `X-Grid-Collection-Scope` — jobs submitted here now apply the org's active model-config version (ADR-0014) exactly like the WS chat path and `/api/internal/workflows/fire`; see `docs/architecture/org-model-configuration.md`. | `{ agent_type, input, job_id?, expiry_seconds?, data_sources? }` | `{ job_id, status, agent_type }` |
| `GET` | `/api/jobs/async/job/{job_id}` | Varies | Get job status. Proxies to `GET /v1/jobs/async/job/{id}`. | — | `{ job_id, status, error?, created_at }` |
| `GET` | `/api/jobs/async/job/{job_id}/stream` | Varies | SSE stream from beginning. Proxies to `GET /v1/jobs/async/job/{id}/stream`. Supports `?token=` for EventSource auth fallback. | — | SSE stream (`text/event-stream`) |
| `GET` | `/api/jobs/async/job/{job_id}/stream/{last_event_id}` | Varies | SSE stream reconnection from event ID. | — | SSE stream |
| `POST` | `/api/jobs/async/job/{job_id}/cancel` | Varies | Cancel a running job. Proxies to `POST /v1/jobs/async/job/{id}/cancel`. | — | `{ job_id, status, task_cancelled }` |
| `DELETE` | `/api/jobs/async/job/{job_id}/cancel` | Varies | Same as POST cancel. | — | `{ job_id, status, task_cancelled }` |
| `GET` | `/api/jobs/async/job/{job_id}/state` | Varies | Get job artifacts (tool calls, outputs, sources). Proxies to `GET /v1/jobs/async/job/{id}/state`. | — | `{ job_id, has_state, artifacts }` |
| `GET` | `/api/jobs/async/job/{job_id}/report` | Varies | Get final report. Proxies to `GET /v1/jobs/async/job/{id}/report`. | — | `{ job_id, has_report, report }` |

SSE streams pass through the response body unmodified. The `?token=` query parameter provides an auth fallback for `EventSource` connections that cannot set custom headers (token is extracted and forwarded as `Authorization: Bearer`, not passed to the backend in the URL).

Source: `frontends/ui/src/app/api/jobs/async/[...path]/route.ts`

## Workflows (ADR-0023, feature-gated)

All routes 403 (`feature-disabled`) unless the Workflows feature is on (`workflows` WorkOS flag under enforcement, else `GRID_WORKFLOWS_ENABLED=true`). Read = `project:view`, mutate/run = `project:edit` via `requireProjectAccess`; every query is additionally org-filtered.

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/projects/{id}/workflows` | project:view | List the project's workflows. | — | `{ workflows }` |
| `POST` | `/api/projects/{id}/workflows` | project:edit | Create a workflow. Compiles the prompt server-side, validates cron (+ min interval, IANA timezone), computes `next_run_at`. | `{ name, description?, definition, dataSources?, enabled?, scheduleCron?, scheduleTimezone? }` | `Workflow` (201) |
| `GET` | `/api/projects/{id}/workflows/{workflowId}` | project:view | Get one workflow (incl. definition + compiled prompt). | — | `Workflow` |
| `PATCH` | `/api/projects/{id}/workflows/{workflowId}` | project:edit | Update; recompiles/revalidates and recomputes `next_run_at`. | partial create body | `Workflow` |
| `DELETE` | `/api/projects/{id}/workflows/{workflowId}` | project:edit | Delete the workflow (runs cascade). | — | `{ deleted: true }` |
| `POST` | `/api/projects/{id}/workflows/{workflowId}/run` | project:edit | Manual "Run now" through the shared fire path. 409 when disabled; a backend 429 (job caps) comes back as a `skipped` run, not an error. | — | `{ run }` |
| `GET` | `/api/projects/{id}/workflows/{workflowId}/runs` | project:view | Run history, newest first. | `?limit&offset` | `{ runs }` |

`dataSources` on create/PATCH is the list of **additional** sources; the `knowledge_layer` source (project documents + OIB base corpus) is always included — the service prepends it on save and again at fire time — so a stored non-null array always contains it. `null` still means all sources.

Source: `frontends/ui/src/app/api/projects/[id]/workflows/…`, service in `frontends/ui/src/lib/workflows/`. See `docs/architecture/workflows.md`.

## Organizations

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `POST` | `/api/organizations` | Required | Create a new WorkOS organization. Makes the caller an admin member. Refreshes the AuthKit session with the new `org_id` claim. | `{ name }` | `{ organizationId }` |

Source: `frontends/ui/src/app/api/organizations/route.ts`

### Organization settings, model configuration, budgets & usage

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `GET` | `/api/organization/model-config` | Org admin | Agent-group registry + active model-config version (ADR-0014). `defaults` is what the org *inherits* per group — the platform default, or the workflow YAML where none is pinned. | — | `{ agentGroups, defaults, catalogSource, zdrOnly, activeVersion, updatedBy, updatedAt }` |
| `PUT` | `/api/organization/model-config` | Org admin | Validate overrides against the live OpenRouter catalog, write a new immutable version, activate it. 422 = validation errors, 503 = catalog down. | `{ overrides: {group: {model}}, comment? }` | `{ activeVersion }` (201) |
| `GET` | `/api/organization/model-config/versions` | Org admin | Version history. | — | `{ versions, activeVersionId }` |
| `POST` | `/api/organization/model-config/versions/{id}/activate` | Org admin | Roll back / re-activate a version; `{id}` = `none` deactivates all overrides. | — | `{ activeVersion }` |
| `GET` | `/api/organization/model-config/models?group&q` | Org admin | OpenRouter catalog search filtered to models appropriate for the agent group. | — | `{ group, models }` |
| `GET` | `/api/organization/budgets` | Required | Org limits + caller's member limit; admins also get all active scoped policies (ADR-0015). | — | `{ organization, ownMemberLimit, policies? }` |
| `PUT` | `/api/organization/budgets` | Org admin (org/member scope); project admin or org admin (project scope) | Set a budget policy (supersedes the previous active one). Member/project limits must not exceed org limits (422). | `{ scope, subjectId?, dailyLimitEur, monthlyLimitEur, note? }` | `{ policy }` (201) |
| `DELETE` | `/api/organization/budgets` | Org admin (member scope); project admin or org admin (project scope) | Remove a scoped limit (supersedes the active policy without replacement — org limits apply alone again). | `{ scope, subjectId }` | `{ removed }` |
| `GET` | `/api/organization/members` | Org admin | Active member directory from WorkOS (id, email, name) for admin pickers (e.g. member budget limits). | — | `{ members }` |
| `GET` | `/api/organization/usage` | Required | Day/month spend + per-model breakdown. Members always see their own usage; admins the org (narrowable via `?userId`/`?projectId`) plus the 30-day `dailyTrend`. | — | `{ summary, orgBudget, status, eurPerUsd, dailyTrend? }` |
| `POST` | `/api/organization/audit-portal` | `org:audit:view` | Short-lived WorkOS Admin Portal link (`intent: audit_logs`) scoped to the caller's org — the native audit-log viewer. 502 = WorkOS unavailable. | — | `{ link }` |

Sources: `frontends/ui/src/app/api/organization/{model-config,budgets,usage,audit-portal}/…`

### Platform tier (platform owner only, ADR-0016)

| Method | Path | Auth | Description | Response |
|--------|------|------|-------------|----------|
| `GET` | `/api/platform/overview` | Platform owner | Cross-org directory (WorkOS) joined with Grid stats: project counts + LLM spend per org from the usage ledger, totals, and the platform-wide 30-day `dailyTrend`. | `{ organizations, dailyTrend, totals, eurPerUsd }` |
| `GET` | `/api/platform/citation-health?days=` | Platform owner | Cross-org citation-quality rollup over the `citation_events` ledger: clean rate, defect mix, per-day trend, removal reasons, flagged-turn source mix, missing-source candidates, per-org table, recent findings, and the derived `findings` action list. `days` clamps to 1–90 (default 30). | `{ windowDays, totals, findings, byKind, dailyTrend, reasons, sourceMix, unavailableTools, missingSources, organizations, recent }` |
| `GET` | `/api/platform/citation-health/export?days=` | Platform owner | Diagnostic bundle for the same window as a downloadable JSON file (`Content-Disposition: attachment`, `Cache-Control: no-store`): one record per flagged turn with the sources retrieval returned, the sources the answer cited, and which citation failed for which reason — plus a glossary so a human or an AI agent can interpret it without further context. | `grid.citation-health.export/v1` bundle |
| `GET` | `/api/platform/model-defaults` | Platform owner | The agent-group registry, the current platform default per group (with `zdrSafe` from the save-time snapshot), and the workflow YAML model each group falls back to. | `{ agentGroups, defaults, workflowDefaults }` |
| `PUT` | `/api/platform/model-defaults` | Platform owner | Replace the fleet defaults. Every model is revalidated against the live OpenRouter catalog + the group's capability requirements; groups omitted from `defaults` are cleared back to the YAML. 422 = validation errors, 503 = catalog down. Audited as `platform.model_defaults.updated`. | `{ defaults }` |
| `GET` | `/api/platform/model-defaults/models?group&q` | Platform owner | Platform OpenRouter catalog search filtered to models appropriate for the group, each annotated with `zdrSafe`. | `{ group, models }` |
| `GET` | `/api/platform/retrieval-settings` | Platform owner | The retrieval-count catalog (labels, bounds, defaults) and the effective value per key — a pinned platform value or the build-time config default. | `{ definitions, settings }` |
| `PUT` | `/api/platform/retrieval-settings` | Platform owner | Replace the fleet retrieval counts. Every value is validated against the catalog bounds (422 with per-key errors); keys omitted from `settings` are cleared back to the config defaults. Audited as `platform.retrieval_settings.updated`. | `{ settings }` |
| `POST` | `/api/platform/audit-portal` | Platform owner | Admin Portal audit-logs link for the GRID Platform org (platform trail incl. break-glass events). 404 = platform org not provisioned. | `{ link }` |
| `GET` | `/api/platform/answer-feedback?days=&verdict=&reason=&org=&topic=&q=` | Platform owner | Cross-org rollup of the per-answer thumbs (`answer_feedback`), which were written since WS-7 and read by nobody until this surface: helpful/unhelpful totals with the DISTINCT voters behind them, the assistant-answer count in the window as a denominator, the down-vote reason mix, a per-day series, per-organization and per-topic rollups, and a drill-in of rated turns joined back to the question that produced them. `verdict` (`down` default, `up`) picks which half the drill-in lists; `reason`/`q` narrow the drill-in only, `org`/`topic` narrow the aggregates too. `days` coerces to 7/30/90 (default 30); the drill-in is capped at 50 rows. | `{ windowDays, answers, totals, reasons, daily, organizations, topics, turns }` |
| `GET` | `/api/platform/answer-feedback/export?…` | Platform owner | The same drill-in, same filters and same gate, as a downloadable UTF-8 CSV with a BOM (`Content-Disposition: attachment`, `Cache-Control: no-store`). Carries `verdict` as both a column and part of the filename, so a praise export and a defect export are distinguishable once the file leaves the browser. | `text/csv` |
| `GET` | `/api/platform/answer-feedback/digest?…&locale=&refresh=1` | Platform owner | The same window in sentences: an LLM-written headline plus separate `strengths`/`concerns` lists and one suggested next step (backend `POST /v1/feedback-digest`). Cached for 6 hours through the shared cache (`@/lib/cache`, Dragonfly when `REDIS_URL` is set), keyed by window + `org` + `topic` + locale — never by the drill-in filters, which do not change the sentences. `refresh=1` bypasses the cached value. Answers `200` with `digest: null` and a reason (`no_feedback`, `too_few_votes`, or a failure code) rather than an error status: a young window is an ordinary state. | `{ digest: { headline, strengths, concerns, recommendation, generatedAt, windowDays, votes } \| null, error }` |
| `GET` | `/api/widgets/token?org=platform&scope=…` | Platform owner | Widget token minted against the GRID Platform organization (platform dashboard widgets). | `{ token }` |

`POST /api/organizations` now returns stable error codes (`self-serve-disabled` 403 when `GRID_DISABLE_SELF_SERVE_ORGS=true`, `create-failed` 500) — never raw provider messages. Org routes are permission-gated per area (`org:models:manage`, `org:budgets:manage`, `org:compliance:manage`; see `lib/authz/permissions.ts`).

### Internal service endpoints (service token, not user-facing)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/internal/memory` | `x-grid-internal-token` | Backend `remember`/reflection memory writes (single-writer bridge). Optional `supersedesContent` — the verbatim text of an entry the finding makes obsolete, quoted from the digest the agent was shown: it is resolved to an active item in the same scope, which is then marked `superseded` and linked via `supersedes_id`. Unresolvable quotes are ignored and human-curated entries (pinned / `user_confirmed` / user-authored) are never retired this way, so the write always lands; the response's `supersededId` reports which entry (if any) was actually retired. |
| `POST` | `/api/internal/usage` | `x-grid-internal-token` | Backend cost tracker's LLM usage-event batches into the `llm_usage_events` ledger. Org-less (anonymous) events are skipped. |
| `POST` | `/api/internal/citation-events` | `x-grid-internal-token` | Backend citation-health emitter's per-turn batches into the `citation_events` ledger (`src/aiq_agent/common/citation_events.py`). One row per `(turnId, kind)`; conflicts are ignored so a retried flush cannot double-count. |
| `POST` | `/api/internal/workflows/fire` | `x-grid-internal-token` | Scheduler-fired workflow run (`{ workflowId }`). Re-checks `enabled` + the org's workflows gate, then submits through the shared fire path (ADR-0023). |
| `GET` | `/api/internal/model-overrides?organizationId=` | `x-grid-internal-token` | **New 2026-07-16.** Just-in-time org model-override resolution (ADR-0014) for backend call sites whose request carries no `x-grid-model-overrides`/`X-Grid-Request-Context` header — `common/model_overrides.py`'s `resolve_org_model_overrides()` calls this, cached in-process. Returns `{ overrides: {group: modelId} \| null }`; reuses the write-invalidated cache inside `getActiveModelOverrides`, so a config save is visible on the next backend fetch. |
| `GET` | `/api/internal/document-file?collection=&filename=` | `x-grid-internal-token` | **New 2026-08-03.** Just-in-time storage-key resolution for the backend's `view_knowledge_image` tool (ADR-0039): maps the `(collection, filename)` pair the backend carries to the SeaweedFS `storage_key` in the `documents` table. Returns `{ storageKey, contentType }` (404 when unknown); the backend fetches the bytes itself via boto3. Collection name is the tenancy boundary (`proj_<uuid>`/`archiv_<orgId>`), so no per-org FGA — read-only metadata. |
| `GET` | `/api/internal/retrieval-settings` | `x-grid-internal-token` | **New 2026-07-31.** Just-in-time fleet retrieval-count resolution for backend tools (knowledge retrieval, surface documents, web/RIS search): `common/retrieval_settings.py`'s `get_retrieval_setting()` calls this, TTL-cached in-process (60s positive / 30s negative) and fail-open to the build-time YAML values. Returns `{ settings: {key: value} }` — only the pinned (non-default) keys. |

## User Preferences

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `GET` | `/api/user/preferences` | Required | Get stored user preferences (opaque key-value store). | — | `{ prefs: { ... } }` |
| `POST` | `/api/user/preferences` | Required | Upsert user preferences. Uses `ON CONFLICT DO UPDATE` on `workosUserId`. | `{ prefs }` | `{ prefs }` |

Source: `frontends/ui/src/app/api/user/preferences/route.ts`

## WebSocket

| Protocol | Path | Auth | Description |
|----------|------|------|-------------|
| `ws`/`wss` | `/websocket` | Varies | WebSocket gateway for real-time chat with HITL support. Proxied by `server.js` (not a Next.js API route). Headers (`X-Grid-Collection-Scope`, `Authorization`, etc.) are resolved via internal `GET /api/auth/websocket-scope` before forwarding to `ws://{BACKEND_WS_URL}/websocket`. |

Source: `docs/technical-reference/websocket-gateway.md`
