# BFF API Routes

All BFF (Backend-for-Frontend) routes are under `frontends/ui/src/app/api/`. They proxy to the Python backend, handle auth, and inject collection scope headers.

## Auth

| Method | Path | Auth | Description | Request | Response |
|--------|------|------|-------------|---------|----------|
| `GET` | `/api/auth/callback` | No | WorkOS AuthKit callback handler. Delegates to `@workos-inc/authkit-nextjs`'s `handleAuth()`. | Query params from WorkOS OAuth redirect | Redirect to app |
| `GET` | `/api/auth/websocket-scope` | Varies | Internal endpoint called by `server.js` during WebSocket upgrade. Resolves collection scope, auth headers, and returns base64url-encoded scope + org/user IDs + access token. | `?projectId=&conversationId=` | `{ scope, header, organizationId?, userId?, accessToken? }` |

Source: `frontends/ui/src/app/api/auth/callback/route.ts`, `frontends/ui/src/app/api/auth/websocket-scope/route.ts`

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

All conversation routes access the PostgreSQL database directly (not proxied to Python). They enforce org-level scoping by filtering on `conversations.organizationId`.

Source: `frontends/ui/src/app/api/conversations/route.ts`, `frontends/ui/src/app/api/conversations/[id]/route.ts`, `frontends/ui/src/app/api/conversations/[id]/messages/route.ts`

## Projects

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `GET` | `/api/projects` | Required | List all projects in the current org. | — | `[{ id, name, collectionName, createdAt, ... }]` |
| `POST` | `/api/projects` | Required | Create a project. Inserts DB row + creates WorkOS FGA resource + assigns creator as `project-admin`. | `{ name }` | `{ id, name, collectionName, ... }` (201) |
| `GET` | `/api/projects/{id}` | Required | Get project details. Checks `project:view` FGA permission. | — | `{ id, name, collectionName, ... }` |
| `PATCH` | `/api/projects/{id}` | Required | Rename a project. Checks `project:manage` FGA permission. | `{ name }` | `{ id, name, ... }` |
| `DELETE` | `/api/projects/{id}` | Required | Delete a project. Checks `project:manage` FGA permission. Removes WorkOS FGA resource + DB row. | — | `204 No Content` |
| `GET` | `/api/projects/{id}/members` | Required | List project members. Checks `project:manage`. Merges FGA role assignments with WorkOS user list. | — | `{ members: [{ organizationMembershipId, userId, email, name, role }] }` |
| `POST` | `/api/projects/{id}/members` | Required | Add a member. Checks `project:manage`. Assigns a project-level FGA role. | `{ organizationMembershipId, roleSlug }` | `201 No Content` |
| `DELETE` | `/api/projects/{id}/members/{assignmentId}` | Required | Remove a member. Checks `project:manage`. Removes WorkOS FGA role assignment. | — | `204 No Content` |

Source: `frontends/ui/src/app/api/projects/route.ts`, `frontends/ui/src/app/api/projects/[id]/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/[assignmentId]/route.ts`

## Documents

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/documents` | Required | List documents for a project. Requires `projectId` query param. Filters by org. | `?projectId=` | `{ documents: [{ id, filename, fileSize, contentType, status, ... }] }` |
| `POST` | `/api/documents/upload` | Required | Upload a file. Checks `project:edit` FGA. Writes to MinIO, creates DB row, triggers ingestion via `POST /v1/ingest` on Python backend. | `multipart/form-data` with `projectId` + `file` | `{ documentId, jobId?, status, filename }` |
| `GET` | `/api/documents/{id}/download` | Required | Get a presigned download URL for a document. Verifies org ownership. | — | `{ downloadUrl, filename, contentType, fileSize }` |
| `GET` | `/api/documents/{id}/status` | Required | Get document ingestion status. Verifies org ownership. | — | `{ id, status, filename, fileSize, errorMessage?, createdAt, updatedAt }` |

Document upload stores files in MinIO at key `{orgId}/{projectId}/{documentId}/{filename}`. Presigned URLs expire after `MINIO_PRESIGNED_URL_TTL_SECONDS` (default 600s). Ingestion is best-effort: if the backend call fails, the document remains in `uploaded` status.

Source: `frontends/ui/src/app/api/documents/route.ts`, `frontends/ui/src/app/api/documents/upload/route.ts`, `frontends/ui/src/app/api/documents/[id]/download/route.ts`, `frontends/ui/src/app/api/documents/[id]/status/route.ts`

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
| `POST` | `/api/jobs/async/submit` | Varies | Submit a new async job. Proxies to `POST /v1/jobs/async/submit`. | `{ agent_type, input, job_id?, expiry_seconds?, data_sources? }` | `{ job_id, status, agent_type }` |
| `GET` | `/api/jobs/async/job/{job_id}` | Varies | Get job status. Proxies to `GET /v1/jobs/async/job/{id}`. | — | `{ job_id, status, error?, created_at }` |
| `GET` | `/api/jobs/async/job/{job_id}/stream` | Varies | SSE stream from beginning. Proxies to `GET /v1/jobs/async/job/{id}/stream`. Supports `?token=` for EventSource auth fallback. | — | SSE stream (`text/event-stream`) |
| `GET` | `/api/jobs/async/job/{job_id}/stream/{last_event_id}` | Varies | SSE stream reconnection from event ID. | — | SSE stream |
| `POST` | `/api/jobs/async/job/{job_id}/cancel` | Varies | Cancel a running job. Proxies to `POST /v1/jobs/async/job/{id}/cancel`. | — | `{ job_id, status, task_cancelled }` |
| `DELETE` | `/api/jobs/async/job/{job_id}/cancel` | Varies | Same as POST cancel. | — | `{ job_id, status, task_cancelled }` |
| `GET` | `/api/jobs/async/job/{job_id}/state` | Varies | Get job artifacts (tool calls, outputs, sources). Proxies to `GET /v1/jobs/async/job/{id}/state`. | — | `{ job_id, has_state, artifacts }` |
| `GET` | `/api/jobs/async/job/{job_id}/report` | Varies | Get final report. Proxies to `GET /v1/jobs/async/job/{id}/report`. | — | `{ job_id, has_report, report }` |

SSE streams pass through the response body unmodified. The `?token=` query parameter provides an auth fallback for `EventSource` connections that cannot set custom headers (token is extracted and forwarded as `Authorization: Bearer`, not passed to the backend in the URL).

Source: `frontends/ui/src/app/api/jobs/async/[...path]/route.ts`

## Organizations

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `POST` | `/api/organizations` | Required | Create a new WorkOS organization. Makes the caller an admin member. Refreshes the AuthKit session with the new `org_id` claim. | `{ name }` | `{ organizationId }` |

Source: `frontends/ui/src/app/api/organizations/route.ts`

### Organization settings, model configuration, budgets & usage

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `GET` | `/api/organization/model-config` | Org admin | Agent-group registry + active model-config version (ADR-0014). | — | `{ agentGroups, activeVersion, updatedBy, updatedAt }` |
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
| `POST` | `/api/platform/audit-portal` | Platform owner | Admin Portal audit-logs link for the GRID Platform org (platform trail incl. break-glass events). 404 = platform org not provisioned. | `{ link }` |
| `GET` | `/api/widgets/token?org=platform&scope=…` | Platform owner | Widget token minted against the GRID Platform organization (platform dashboard widgets). | `{ token }` |

`POST /api/organizations` now returns stable error codes (`self-serve-disabled` 403 when `GRID_DISABLE_SELF_SERVE_ORGS=true`, `create-failed` 500) — never raw provider messages. Org routes are permission-gated per area (`org:models:manage`, `org:budgets:manage`, `org:compliance:manage`; see `lib/authz/permissions.ts`).

### Internal service endpoints (service token, not user-facing)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/internal/memory` | `x-grid-internal-token` | Backend `remember`/reflection memory writes (single-writer bridge). |
| `POST` | `/api/internal/usage` | `x-grid-internal-token` | Backend cost tracker's LLM usage-event batches into the `llm_usage_events` ledger. Org-less (anonymous) events are skipped. |

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
