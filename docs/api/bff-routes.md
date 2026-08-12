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
| `GET` | `/api/documents` | Required | List documents for a project. Requires `projectId` query param. Checks `project:view` FGA. Read-only document metadata (`summary`, `pageCount`, `chunkCount`, `contentTypes`) is merged from the backend collection listing when available; the internal `metadata` jsonb (ingest job id) is never returned. | `?projectId=` | `{ documents: [{ id, filename, fileSize, contentType, status, errorMessage?, summary?, pageCount?, chunkCount?, contentTypes?, displayName?, ... }] }` (`displayName` is the rename, `null` when the document has never been renamed — surfaces show `displayName ?? filename` via `documentDisplayName`) |
| `POST` | `/api/documents/upload` | Required | Upload a file. Checks `project:edit` FGA. Writes to SeaweedFS, creates DB row, triggers ingestion via `POST /v1/ingest` on Python backend. | `multipart/form-data` with `projectId` + `file` | `{ documentId, jobId?, status, filename }` |
| `POST` | `/api/documents/search` | Required | Document-centric **semantic search** over a project's corpus (deterministic vector search, no LLM). Checks `project:view` FGA (via `listDocuments`), resolves the project's RAG collection, and proxies to the backend `POST /v1/collections/{c}/search` (`{ query, top_k: 40, top_k_files: topK }`). Backend hits (one per file, best snippet, score-descending) are joined to the project's own file rows **by filename** (`hit.file_name === file.filename`; a filename collision resolves to the most-recent row), so every result is a real, visible document with its live status/metadata plus match evidence. Fail-open: a backend error/timeout yields `{ hits: [] }`, never a 5xx. Body is zod-validated (`q` 1–1000 chars; `topK` 1–100, default 20). | `{ projectId, q, topK? }` | `{ hits: [{ id, filename, status, ..., snippet, page, score }] }` (reordered by score) |
| `GET` | `/api/documents/{id}/download` | Required | Get a presigned download URL for a document. Verifies org ownership + `project:view` FGA. | — | `{ downloadUrl, filename, contentType, fileSize }` |
| `GET` | `/api/documents/{id}/preview` | Required | Presigned inline preview URL (PDF/image types only; 415 otherwise). Verifies org ownership + `project:view` FGA. | — | `{ url, contentType, filename }` |
| `GET` | `/api/documents/{id}/file` | Required | Stream a stored **PDF**'s bytes from THIS origin, inline (`application/pdf` only — 415 for everything else, including SVG, which must never be served inline same-origin because it can carry script into this origin). Verifies org ownership, then `project:view` FGA for a project document; an org-wide Archiv document (NULL `projectId`) is readable by any org member without it. Exists because the in-app PDF viewer *fetches* the file to build a text layer for the cited-passage highlight, and the presigned `/preview` URL is cross-origin with no CORS policy on the object store — a URL the browser can navigate to but not read. Sends `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` so the viewer's iframe fallback can render it (next.config carries a matching route-scoped override). | — | PDF/image bytes, `Cache-Control: private, max-age=300` |
| `GET` | `/api/documents/{id}/status` | Required | Get document ingestion status. Verifies org ownership + `project:view` FGA. Also merges the read-only document metadata (`summary`, `pageCount`, `chunkCount`, `contentTypes`) from the backend collection listing when available. | — | `{ id, status, filename, fileSize, contentType, collectionName, errorMessage?, createdAt, updatedAt, summary?, pageCount?, chunkCount?, contentTypes? }` |
| `POST` | `/api/documents/{id}/reingest` | Required | Re-dispatch a previously-**failed** document to the ingest pipeline (re-runs the same `POST /v1/ingest` call the upload path uses). Verifies org ownership + `project:edit` FGA. Rejects documents not in `failed` status with `409 CONFLICT`. | — | `{ id, status, jobId }` (status `pending` on success, `failed` if dispatch fails again) |
| `PATCH` | `/api/documents/{id}/tags` | Required | Replace a document's controlled ingestion tags. Verifies org ownership + `project:edit` FGA. Tags are validated against the mirrored controlled vocabulary (`ALLOWED_TAGS`) — off-vocabulary values are rejected fast with `400 BAD_REQUEST` (`invalidTags` in `details`) before any backend round-trip; the zod schema caps the count at `MAX_TAGS` (5, each 1–128 chars). An empty list clears the tags. Proxied to the backend `PATCH /v1/collections/{c}/documents/{f}/tags` (keyed by the document's `collectionName` + `filename`), which is the authority on the vocabulary and cap; a missing summary row surfaces as `404 NOT_FOUND`, an unreachable/failed backend as `502 UPSTREAM_ERROR`. The one-sentence summary is never touched. | `{ tags: string[] }` | `{ id, tags }` |
| `GET` | `/api/documents/{id}/visual-details` | Required | Per-page VLM descriptions of a document's visual chunks (drawings/images/charts) for the file-preview "detailed information" section. Verifies org ownership + `project:view` FGA. Proxied to the backend `GET /v1/collections/{c}/documents/{f}/visual-details`. Read-only and fail-soft: any backend hiccup or an unsupported backend yields `{ details: [] }` rather than an error. | — | `{ id, details: [{ page, contentType, drawingType, scale, text }] }` |
| `PATCH` | `/api/documents/{id}` | Required | **Rename** a document — the label, never the file. Scope-aware (unlike `DELETE` below): `renameDocument` resolves the permission from the row, so a project document needs `project:documents:write`/`project:edit` and an org-wide Archiv document needs `org:archiv:manage`. Writes `documents.display_name` (migration 0046) and mirrors the value to the backend's metadata row via `PATCH /v1/collections/{c}/documents/{f}/display-title`, so citation chips follow the rename with **no re-ingestion**; that mirror is best-effort (a 404 for a document with no summary row, or an unreachable backend, does not fail the rename — the BFF row is the durable one). `filename` is NEVER touched: it is the join key to the stored object and to the document's chunks. A name equal to the file name, or an explicit `null`, CLEARS the rename. Names are validated with `validateDocumentName` (trimmed, 1–200 chars, no path separators or control characters) → `400 BAD_REQUEST` with `reason` in `details`. Audits `document.renamed` / `archiv.document.renamed` with the old and new label beside the unchanged filename. | `{ displayName: string \| null }` | `{ id, filename, displayName }` |
| `DELETE` | `/api/documents/{id}` | Required | Delete a project document: purges the RAG chunks (best-effort), removes the SeaweedFS object, deletes the row, audits (`document.deleted`). Verifies org ownership + `project:edit` FGA. Org-wide Archiv documents (NULL `projectId`) are not deletable here — they surface as `404 NOT_FOUND` and go through `DELETE /api/archiv/documents/{id}` instead. | — | `204 No Content` |

Document upload stores files in SeaweedFS at key `{orgId}/{projectId}/{documentId}/{filename}`. Presigned URLs expire after `SEAWEED_PRESIGNED_URL_TTL_SECONDS` (default 600s). Ingestion is best-effort: on the first upload a failed backend dispatch marks the document `failed` with an `errorMessage`; `POST /api/documents/{id}/reingest` lets the user retry that dispatch from the Files workspace.

Source: `frontends/ui/src/app/api/documents/route.ts`, `frontends/ui/src/app/api/documents/upload/route.ts`, `frontends/ui/src/app/api/documents/search/route.ts`, `frontends/ui/src/app/api/documents/[id]/route.ts`, `frontends/ui/src/app/api/documents/[id]/download/route.ts`, `frontends/ui/src/app/api/documents/[id]/file/route.ts`, `frontends/ui/src/app/api/documents/[id]/status/route.ts`, `frontends/ui/src/app/api/documents/[id]/reingest/route.ts`, `frontends/ui/src/app/api/documents/[id]/tags/route.ts`, `frontends/ui/src/app/api/documents/[id]/visual-details/route.ts`

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
| `POST` | `/api/jobs/async/submit` | Varies | Submit a new async job. Proxies to `POST /v1/jobs/async/submit`. **Fixed 2026-07-16**: resolves the caller's active model overrides (`getActiveModelOverrides`) and forwards them, plus the signed `X-Grid-Request-Context` envelope, alongside `X-Grid-Collection-Scope` — jobs submitted here now apply the org's active model-config version (ADR-0014) exactly like the WS chat path and the skill fire path (`/api/internal/skills/fire`); see `docs/architecture/org-model-configuration.md`. | `{ agent_type, input, job_id?, expiry_seconds?, data_sources? }` | `{ job_id, status, agent_type }` |
| `GET` | `/api/jobs/async/job/{job_id}` | Varies | Get job status. Proxies to `GET /v1/jobs/async/job/{id}`. | — | `{ job_id, status, error?, created_at }` |
| `GET` | `/api/jobs/async/job/{job_id}/stream` | Varies | SSE stream from beginning. Proxies to `GET /v1/jobs/async/job/{id}/stream`. Supports `?token=` for EventSource auth fallback. | — | SSE stream (`text/event-stream`) |
| `GET` | `/api/jobs/async/job/{job_id}/stream/{last_event_id}` | Varies | SSE stream reconnection from event ID. | — | SSE stream |
| `POST` | `/api/jobs/async/job/{job_id}/cancel` | Varies | Cancel a running job. Proxies to `POST /v1/jobs/async/job/{id}/cancel`. | — | `{ job_id, status, task_cancelled }` |
| `DELETE` | `/api/jobs/async/job/{job_id}/cancel` | Varies | Same as POST cancel. | — | `{ job_id, status, task_cancelled }` |
| `GET` | `/api/jobs/async/job/{job_id}/state` | Varies | Get job artifacts (tool calls, outputs, sources). Proxies to `GET /v1/jobs/async/job/{id}/state`. | — | `{ job_id, has_state, artifacts }` |
| `GET` | `/api/jobs/async/job/{job_id}/report` | Varies | Get final report. Proxies to `GET /v1/jobs/async/job/{id}/report`. | — | `{ job_id, has_report, report }` |

SSE streams pass through the response body unmodified. The `?token=` query parameter provides an auth fallback for `EventSource` connections that cannot set custom headers (token is extracted and forwarded as `Authorization: Bearer`, not passed to the backend in the URL).

Source: `frontends/ui/src/app/api/jobs/async/[...path]/route.ts`

## Agent Skills (ADR-0046, feature-gated)

All routes 403 (`feature-disabled`) unless the skills feature is on (`skills` WorkOS flag under enforcement, else `GRID_SKILLS_ENABLED=true`). Authorization is enforced in `lib/skills/service.ts`, not in the routes (ADR-0017); every query is additionally org-filtered.

The org toolbox:

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/skills` | org member | The merged toolbox: platform builtins plus the org's own rows, org rows shadowing a builtin of the same name. | — | `{ skills }` |
| `POST` | `/api/skills` | org:skills:manage | Author a skill. Validates the SKILL.md name/description rules and the reserved `grid-cards` value; `clonedFrom` records a platform clone. | `{ name, description, body, metadata?, clonedFrom?, enabled? }` | `{ skill }` (201) |
| `PATCH` | `/api/skills/{skillId}` | org:skills:manage | Update an org skill. | partial create body | `{ skill }` |
| `DELETE` | `/api/skills/{skillId}` | org:skills:manage | Delete an org skill. | — | `{ deleted: true }` |
| `GET` | `/api/skills/invocable` | org member | The `/name` composer picker's list: enabled skills a chat turn can actually run, **name + description only** — the same progressive-disclosure level 1 the agent is given. Invoking is use, not administration, so any member may read it. | — | `{ skills }` |
| `GET` | `/api/skills/attachable` | org member | The job builder's skill picker: the skills the chosen output kind can run (`chat` → `shallow_researcher`, `deep-research` → `deep_researcher`, both via `grid-agents`). Carries bodies, because the builder previews the composed prompt. | `?output=chat\|deep-research` | `{ skills }` |

Project jobs — a prompt on a timer, with an optional skill attached (read = `project:view`, mutate/run = `project:skills:manage` via `requireProjectAccess`):

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/projects/{id}/jobs` | project:view | List the project's jobs (each carrying its skill snapshot, when it has one). | — | `{ jobs }` |
| `POST` | `/api/projects/{id}/jobs` | project:skills:manage | Create. `prompt` is required (1–8000 chars); `skillName` is optional — when given it is resolved (org row first, builtin fallback; unknown → 404) and snapshotted, and `skill_name`/`skill_snapshot` are always written as a pair. Validates cron (+ min interval, IANA timezone) and computes `next_run_at`. | `{ name, prompt, output, skillName?, dataSources?, enabled?, scheduleCron?, scheduleTimezone? }` | `{ job }` (201) |
| `GET` | `/api/projects/{id}/jobs/{jobId}` | project:view | Get one job. | — | `{ job }` |
| `PATCH` | `/api/projects/{id}/jobs/{jobId}` | project:skills:manage | Update; re-resolves the snapshot and recomputes `next_run_at`. `skillName: null` detaches the skill, omitting it leaves the attachment alone. | partial create body | `{ job }` |
| `DELETE` | `/api/projects/{id}/jobs/{jobId}` | project:skills:manage | Delete the job (runs cascade). | — | `{ deleted: true }` |
| `POST` | `/api/projects/{id}/jobs/{jobId}/run` | project:skills:manage | Manual "Run now" through the shared fire path. 409 when disabled; a backend 429 (job caps) comes back as a `skipped` run, not an error. | — | `{ run }` |
| `GET` | `/api/projects/{id}/jobs/{jobId}/runs` | project:view | Run history, newest first. | `?limit&offset` | `{ runs }` |

`dataSources` on create/PATCH is the list of **additional** sources; the `knowledge_layer` source (project documents + OIB base corpus) is always included — the service prepends it on save and again at fire time — so a stored non-null array always contains it. `null` still means all sources.

Source: `frontends/ui/src/app/api/skills/…` and `…/api/projects/[id]/jobs/…`; the toolbox service is `frontends/ui/src/lib/skills/`, the jobs service `frontends/ui/src/lib/jobs/`. See `docs/architecture/agent-skills.md`.

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
| `GET` | `/api/platform/cards` | Platform owner | The agent's presentation vocabulary: every card type it can render, with each card's purpose, its fields (type, requiredness, description, constraints), the shapes those fields reference, and a worked example where one exists — plus the GitHub feature-request link for a card, or a value on one, Grid cannot render yet. Read-through of the backend's `GET /v1/platform/cards`, which derives the list from the Pydantic card union, so it cannot drift from what the product renders. A backend outage answers `502` rather than an empty catalog, which would read as "Grid has no such card". | `{ cards, buildingBlocks, cardCount, featureRequest }` |
| `GET` | `/api/widgets/token?org=platform&scope=…` | Platform owner | Widget token minted against the GRID Platform organization (platform dashboard widgets). | `{ token }` |

`POST /api/organizations` now returns stable error codes (`self-serve-disabled` 403 when `GRID_DISABLE_SELF_SERVE_ORGS=true`, `create-failed` 500) — never raw provider messages. Org routes are permission-gated per area (`org:models:manage`, `org:budgets:manage`, `org:compliance:manage`; see `lib/authz/permissions.ts`).

### Internal service endpoints (service token, not user-facing)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/internal/memory` | `x-grid-internal-token` | Backend `remember`/reflection memory writes (single-writer bridge). Optional `supersedesContent` — the verbatim text of an entry the finding makes obsolete, quoted from the digest the agent was shown: it is resolved to an active item in the same scope, which is then marked `superseded` and linked via `supersedes_id`. Unresolvable quotes are ignored and human-curated entries (pinned / `user_confirmed` / user-authored) are never retired this way, so the write always lands; the response's `supersededId` reports which entry (if any) was actually retired. |
| `POST` | `/api/internal/usage` | `x-grid-internal-token` | Backend cost tracker's LLM usage-event batches into the `llm_usage_events` ledger. Org-less (anonymous) events are skipped. |
| `POST` | `/api/internal/citation-events` | `x-grid-internal-token` | Backend citation-health emitter's per-turn batches into the `citation_events` ledger (`src/aiq_agent/common/citation_events.py`). One row per `(turnId, kind)`; conflicts are ignored so a retried flush cannot double-count. |
| `POST` | `/api/internal/skills/fire` | `x-grid-internal-token` | Scheduler-fired job run (`{ scheduleId }` — the pre-jobs spelling of a `jobs.id`, kept because the scheduler container and the BFF deploy separately). Re-checks `enabled` + the org's skills gate, then submits through the shared fire path (ADR-0046). |
| `GET` | `/api/internal/model-overrides?organizationId=` | `x-grid-internal-token` | **New 2026-07-16.** Just-in-time org model-override resolution (ADR-0014) for backend call sites whose request carries no `x-grid-model-overrides`/`X-Grid-Request-Context` header — `common/model_overrides.py`'s `resolve_org_model_overrides()` calls this, cached in-process. Returns `{ overrides: {group: modelId} \| null }`; reuses the write-invalidated cache inside `getActiveModelOverrides`, so a config save is visible on the next backend fetch. |
| `GET` | `/api/internal/document-file?collection=&filename=` | `x-grid-internal-token` | **New 2026-08-03.** Just-in-time storage-key resolution for the backend's `view_knowledge_image` tool (ADR-0039): maps the `(collection, filename)` pair the backend carries to the SeaweedFS `storage_key` in the `documents` table. Returns `{ storageKey, contentType }` (404 when unknown); the backend fetches the bytes itself via boto3. Collection name is the tenancy boundary (`proj_<uuid>`/`archiv_<orgId>`), so no per-org FGA — read-only metadata. Declares `tenancy: { fromPayload }`; when the backend supplies no `organizationId` (every `proj_` collection) the lookup runs under an explicit platform scope, so row-level security does **not** constrain it — the unguessable collection name is still the only boundary on that path (ADR-0041). |
| `GET` | `/api/internal/retrieval-settings` | `x-grid-internal-token` | **New 2026-07-31.** Just-in-time fleet retrieval-count resolution for backend tools (knowledge retrieval, surface documents, web/RIS search): `common/retrieval_settings.py`'s `get_retrieval_setting()` calls this, TTL-cached in-process (60s positive / 30s negative) and fail-open to the build-time YAML values. Returns `{ settings: {key: value} }` — only the pinned (non-default) keys. |
| `POST` | `/api/internal/storage/alerts` | `x-grid-internal-token` | **New 2026-08-07.** Storage-quota alert sweep (ADR-0042), called hourly by the `storage-alerts` CronJob. One grouped cross-tenant aggregate finds each organization's stored bytes; the sweep then re-enters each org with `withTenant` (so the inbox writes stay under row-level security despite the route's `crossTenant` declaration) and raises a `storage.quota_warning` inbox item for every active holder of `org:settings:manage` once usage crosses the configured threshold (`GRID_STORAGE_ALERT_THRESHOLD_PERCENT`, default 80; auto-escalating at 90/100). **Idempotent across sequential calls** — an already-live row suppresses re-emission, which is what makes at-least-once CronJob delivery safe — while a drop below the threshold archives the outstanding rows and re-arms the next crossing. Returns `{ organizationsChecked, alerted, notified, retired, thresholdPercent }`. |

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

## BIM / IFC models (ADR-0045)

Every route is gated by the `ifc-models` WorkOS flag AND the document's own
access rule: a project model goes through `requireProjectAccess(project:view)`,
an Archiv model (no project) is readable by any member of the owning
organization. Cross-tenant and no-access both surface as 404.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/{id}/bim/models` | Models in scope for a project — its own plus the org Archiv's. |
| `GET` | `/api/bim/models/{modelId}` | Model header + summary (spatial tree, storeys, type counts, totals, validation findings). |
| `POST` | `/api/bim/models/{modelId}/query` | Run one structured query (below). A read, POSTed because the request is a nested filter object. |
| `GET` | `/api/bim/models/{modelId}/source` | Short-lived presigned URL for the raw `.ifc` — the 3D viewport's input, signed against the browser-reachable endpoint. |
| `GET`/`POST`/`DELETE` | `/api/projects/{id}/bim/checks` | Human confirmations on rule verdicts. `GET` needs `project:view` (a confirmation is part of the record everyone reads); `POST`/`DELETE` need `project:edit`. The confirming identity comes from the SESSION, never the body, and the `modelId` is re-resolved through `getAccessibleModel` so a confirmation cannot be pinned to another tenant's revision. |
| `GET` | `/api/projects/{id}/bim/checks/export` | The Prüfbuch's open items as a BCF 2.1 archive (`?modelId=…` **or** `?model=<file name>`, plus `&gebaeudeklasse=…&hauptnutzung=…`). The file-name form exists so a chat answer can link the download without carrying a UUID through a conversation; it resolves within the project, exact match first, newest wins, `ready` models only. A `GET` so the browser's own download path handles it and the URL is shareable; `project:view`, and the model must belong to the project (or be an Archiv model) so an archive cannot be built from one building's verdicts and another's confirmations. Runs the same `compliance` op the panel reads. `X-Grid-Bcf-Topics` carries the topic count. |
| `POST` | `/api/internal/bim/query` | Service-token route for the agent's `ifc_query` tool. Resolves models by project + file name so no UUID travels through a conversation. |

### The query contract

`POST /api/bim/models/{modelId}/query` takes a discriminated union on `op`
(`lib/bim/query.ts`, validated with zod before anything reaches SQL):

| `op` | Answers |
|---|---|
| `overview` | What the model is: project/site/building, storeys, totals, areas. |
| `health` | The validation report — see below. |
| `types` | Element counts per IFC type, from the rows. |
| `properties` | The model's own property vocabulary: which sets exist, which properties, and the values they actually take with counts. Past ~5 000 in-scope elements the catalog is built from a sample stratified **by IFC type** (up to 200 elements per type), and `propertyScan: { scanned, total, complete }` says so; the names stay authoritative, the counts become counts over the sample and the rendered summary states that. Reading the whole model instead was measured past the 30 s `statement_timeout` at 400 k elements — an HTTP 500 where a catalog was asked for. |
| `elements` | Matching elements, paged. `total` stops counting at 10 000 (`COUNT_CEILING`): past that it is a **lower bound**, `totalIsLowerBound` is `true`, `truncated` is `true` and the summary reads "Mindestens 10000 Bauteile". An exact `count(*)` beside the page query measured 15.8 s warm / 21.9 s cold on a filtered 400 k-element model, holding a second pool slot for the whole time. The page itself is planned rather than left to the planner — see the deep dive's "Two plans, and why the application picks" — because a property filter matching one element and one matching a quarter of the model want opposite plans and Postgres cannot tell them apart. |
| `element` | One element in full, by IFC GlobalId. |
| `aggregate` | `count`/`sum`/`avg`/`min`/`max` over the filtered set, optionally grouped by `ifcType`, `storey`, `predefinedType`, `typeName`, `material` or a property. |
| `compare` | What changed against another revision, matched by GlobalId. |
| `schedule` | The Raumbuch: every room with its storey, area and volume, plus per-storey and building totals — and `roomsWithoutArea`, the count each total excludes. |
| `takeoff` | Massenermittlung: one `quantity` summed per element type, optionally split by material (`byMaterial`). Each row carries `missing`, the elements that publish no value. |
| `compliance` | The OIB rule catalog (`lib/bim/rules.ts`) evaluated against the model's published values: per requirement, how many elements are `pass` / `fail` / **`undecidable`**, the threshold applied, the failing and undecidable GlobalIds, and the exact property paths that would make the undecidable ones decidable. Takes `gebaeudeklasse` / `hauptnutzung`; a rule needing a fact it was not given stands down WITH its reason rather than assuming one. |
| `compliance-diff` | The same catalog over two revisions (`baseModelId`), reporting only the requirements whose status MOVED — including one that stopped being decidable because the re-export dropped a property. |
| `profile` | Project-brief facts the model implies (storeys above/below ground, Fluchtniveau band, main use, room count), each with its evidence and a confidence. Proposals — the agent offers them through a `project_profile_patch` card, never as settled values. |

Filters accept `ifcTypes`, `storeys` (name or GlobalId), `nameContains`,
`material`, `classification`, `globalIds`, and up to ten property predicates
(`set?`, `name`, `operator`, `value`, `source: property|quantity`) with
operators `eq | neq | contains | gt | gte | lt | lte | exists | missing`.

The vocabulary is **closed**: every field is an enum or a schema-validated
string and every value is a bound parameter, so a model-authored filter cannot
become model-authored SQL. String comparison is case-insensitive; numeric
comparison is guarded by a `CASE` so a jsonb boolean beside a numeric property
cannot fail the whole query.

`schedule`, `takeoff` and `profile` are computed over the FULL element set on
the server, not over the page of elements the browser holds — summing a capped
element list would produce a Flächenaufstellung that is short by however many
rows did not fit, silently and only for large models. The model page and the
agent therefore read the same numbers from the same code path.

### The caveat field

Results for `overview`, `types`, `elements` and `aggregate` carry a `caveat`
string (or `null`) derived from the validation findings — for example
`Hinweis zum Modell: 43 Bauteile sind keinem Geschoss zugeordnet …`. The agent
is instructed to report it verbatim: a storey breakdown over a model with
unplaced elements is a subset presented as a total.
