# BFF API Routes

All BFF (Backend-for-Frontend) routes are under `frontends/ui/src/app/api/`. They proxy to the Python backend, handle auth, and inject collection scope headers.

> **Not exhaustive, and the gap is old.** A walk of `app/api/**/route.ts` on
> 2026-08-20 found 157 route directories, of which **51 have no entry in this
> file or in [`collaboration-routes.md`](collaboration-routes.md)** — chiefly the
> project surfaces (`folders`, `memory`, `overview`, `profile`,
> `profile/patches`, `intake-definition`, `generate-summary`, `reindex`,
> `restore`), `documents/{id}/{thumbnail,image}`, the session-attached document
> shelf (`/api/session/documents/*`), legal holds and `/api/deletions`, the org
> BYOK/memory/storage routes, several platform-tier routes (norms, storage,
> profiler, reasoning efforts, vector reconcile), `citations/format`,
> `skills/review`, `healthz`, and nine `/api/internal/*` service endpoints. The
> route file is the source of truth; absence here means undocumented, never
> non-existent.

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

## PDF export

| Method | Path | Auth | Description | Request Body | Response |
|--------|------|------|-------------|-------------|----------|
| `POST` | `/api/generate-pdf` | Session only | Render caller-supplied Markdown as a PDF the browser downloads — the *Download PDF* button in the research panel's report tab (`use-download-pdf.ts`) and in `ReportCard`'s footer. No backend, no database, no object store: the bytes come from the request and go straight back. **Not** the filed-report renderer — this one prints no AI notice and no provenance line, because it is a person exporting prose they have read on screen (`MarkdownPdfOptions.aiProvenance` is opt-in for exactly that reason; the report filed into a project turns it on). Two bounds, both explicit because the App Router supplies neither: the JSON body is refused ahead of `request.json()` past **1 MiB** (`413 PAYLOAD_TOO_LARGE`, the ceiling the Pages Router used to apply for free), and `markdown` is capped at **65 536 characters** (`MAX_MARKDOWN_PDF_CHARS`) — the schema refuses past it with `400 BAD_REQUEST`, and the renderer refuses on its own behalf (`MarkdownTooLongError`) so the second caller cannot forget the bound. The cap is an ADMISSION control, not a performance tweak: `renderToStream`'s layout pass is one synchronous block, so a timeout cannot enforce anything (a 3 s timer armed before a 128 KiB table-heavy render fired at 32.5 s and the work ran to completion anyway) and Node serves nobody else meanwhile. Measured at 64 KiB: 1.0 s/189 MB as prose, 11.0 s/387 MB as dense tables; at 256 KiB the table shape reaches 141.7 s and 1.19 GB peak RSS, which is an OOM rather than a slow response. Rate-limited by the factory's `DEFAULT_MUTATION_LIMIT` (300/min, burst 40/2s) per member. `authz: { sessionOnly }`: it reads nothing and owns nothing, so there is no resource to authorize against — only a rendering cost that must not be free to the internet. | `{ markdown }` (1–65 536 characters) | `application/pdf` bytes, `Content-Disposition: attachment; filename="report.pdf"`, `Cache-Control: no-store` |

Moved out of `src/pages/api/generate-pdf.ts` on 2026-08-20 at the same path. The
Pages handler had **no session check at all** and was invisible to
`app/api/authz-coverage.spec.ts`, which walks `app/api/**/route.ts`; `src/pages/`
is gone entirely so the next handler cannot land in the same blind spot.

Source: `frontends/ui/src/app/api/generate-pdf/route.ts` (renderer:
`frontends/ui/src/lib/pdf/markdown-pdf.ts`, which owns `MAX_MARKDOWN_PDF_CHARS`
and the measurements behind it)

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
| `POST` | `/api/projects/{id}/diagrams` | Required | File a diagram the BROWSER drew as **two** documents in the project: the SVG (`image/svg+xml`, previews in the Files pane and carries the mermaid/excalidraw source in its `<metadata>` so the drawing can be regenerated later) and a PDF wrapping the same geometry as `@react-pdf/renderer` `<Svg>` primitives (the artifact that gets attached to an Einreichung). Both go through `fileGeneratedDocument`, so both are `authored_by='agent'`, `status='stored'`, **never ingested**, `Unvergeben` on arrival and charged to the quota; the producers are `diagram_svg` and `diagram_pdf`. Authorization is `project:documents:write` (or the legacy `project:edit` umbrella) **and** `project:documents:generate`, both enforced inside the service before a byte is stored, behind the `agent-authored-documents` flag. The second permission is what an organization withholds to let Piloti answer without writing into its file system; the umbrella deliberately does not satisfy it ([ADR-0047's third addendum](../adr/0047-assignment-is-not-access.md)). `runId` identifies the diagram — the answer id plus a hash of its source — and is half the idempotency key: it lands in `authored_by_ref` with `authored_by_ref_kind = 'answer_artifact'` (migrations `0065`/`0066`; the request field keeps the old name), so posting twice files once and the retry after a partial failure files only the missing half. **The provenance here is CLIENT-ASSERTED**, unlike the research report's: the browser lays the graph out (production has no browser) and this route files what it sends, so a hand-crafted POST from any member holding the permission can put chosen bytes into a row that reads `authored_by='agent'`, under a reference naming no real answer. What the label means and what it does not — and why the forgeable shelf is the *less* capable one, since nothing agent-authored is indexable, searchable or citable — is [ADR-0047's second addendum](../adr/0047-assignment-is-not-access.md#addendum-2026-08-20-for-a-filed-diagram-the-client-asserts-the-provenance). Do not read `authored_by` as a warrant about whose hand wrote the bytes. The SVG is **parsed, allow-listed and re-serialised server-side**; a refusal names its rule in the reader's locale (`400 BAD_REQUEST`): a `<script>`, a `<foreignObject>`, a `<style>`, an `on*` handler, any `href`/`url()` that is not a fragment, a DOCTYPE/entity declaration, malformed XML, an unsupported element (including a `<metadata>` anywhere but as a direct child of the root, which is the only position the server writes one in and replaces), a missing viewport, nesting deeper than 64 elements (`too-deep` — the parse and the PDF conversion each recurse per level), or either payload over its cap (1 MiB SVG; 32 KiB mermaid / 512 KiB excalidraw source). The two caps are also declared on the schema and the whole JSON body is bounded ahead of `request.json()` (`413` past ~3 MB), because an App Router handler has no body limit of its own. | `{ runId, title, sourceKind: 'mermaid'\|'excalidraw', source, svg }` | `{ svg: { documentId, filename, folderId, alreadyFiled }, pdf: { … } \| null }` (201) — `pdf` is **null** when only the SVG landed: it is filed and quota-charged either way, so a partial filing is a 201 that names which half exists and not an error, and filing again adds only the missing half. |
| `POST` | `/api/projects/{id}/consistency-check` | Required | End-of-wizard **free-text** intake consistency check (FB-13). Checks `project:edit` FGA (as of commit 873754b — aligned with the profile save/summary flow; only editors save the wizard). Proxies the backend `POST /v1/consistency-check`, which asks an LLM whether the free-text answers contradict the structured answers (passed as read-only context) or each other. **Fully fail-open**: always `200`; any backend non-200/transport failure or missing-LLM config degrades to `{ findings: null, error }` so a check outage never blocks the save. `findings: []` = consistent. | `{ freeText: [{field,value}] (≤50), structured?: [{field,value}] (≤200), locale? }` | `{ findings: [{ kind:'ai', fields, severity:'warning'\|'inconsistency', message }] \| null, error? }` |
| `GET` | `/api/projects/{id}/folders` | Required | List the project's folders, ordered by materialised `path`. Checks `project:view`. | — | `{ folders: [{ id, projectId, parentId, name, path, createdAt, updatedAt }] }` |
| `POST` | `/api/projects/{id}/folders` | Required | Create a folder. Checks `project:documents:write`. `path` is materialised from the parent's path + the validated name. | `{ name, parentId? }` | `{ folder }` (201) |
| `PATCH` | `/api/projects/{id}/folders/{folderId}` | Required | **Rename and/or move** a folder. Checks `project:documents:write`. `parentId` is `.nullable().optional()` on purpose: absent leaves the parent alone, explicit `null` moves the folder to the project root. Rejects a move into the folder itself or into its own subtree (a cycle would be invisible until something walked the tree, because `path` is materialised). On success the whole subtree's `path` is rewritten in one SQL prefix-replace inside the same transaction — descendants never keep a stale path, and the same prefix rewrite is mirrored onto the Python backend's document metadata (`PATCH /v1/collections/{c}/folder-paths`, best-effort — ADR-0049) so the agent stops describing a folder the user renamed. Validation failures (bad name, unknown parent, cycle) come back as `400 BAD_REQUEST`. | `{ name?, parentId? }` (at least one) | `{ folder }` |
| `DELETE` | `/api/projects/{id}/folders/{folderId}` | Required | Delete a folder **without deleting what was filed in it**. Checks `project:documents:write`. `documents.folder_id` is `ON DELETE CASCADE`, so the service first re-files the folder's documents and re-parents its child folders (subtree paths rewritten with them) into the deleted folder's own parent — the project root when it had none — and only then removes the row. The counts come back so the surface can say where the files went. The collapse is mirrored onto the backend as one prefix rewrite from the folder's path to its parent's (ADR-0049). | — | `{ documentsMoved, foldersMoved }` |

Source: `frontends/ui/src/app/api/projects/route.ts`, `frontends/ui/src/app/api/projects/[id]/route.ts`, `frontends/ui/src/app/api/projects/[id]/diagrams/route.ts` (services: `frontends/ui/src/lib/diagrams/`), `frontends/ui/src/app/api/projects/[id]/members/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/[assignmentId]/route.ts`, `frontends/ui/src/app/api/projects/[id]/consistency-check/route.ts` (service: `frontends/ui/src/lib/project-profile/profile-service.ts`)
Source: `frontends/ui/src/app/api/projects/route.ts`, `frontends/ui/src/app/api/projects/[id]/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/route.ts`, `frontends/ui/src/app/api/projects/[id]/members/[assignmentId]/route.ts`, `frontends/ui/src/app/api/projects/[id]/consistency-check/route.ts`, `frontends/ui/src/app/api/projects/[id]/folders/route.ts`, `frontends/ui/src/app/api/projects/[id]/folders/[folderId]/route.ts` (services: `frontends/ui/src/lib/project-profile/profile-service.ts`, `frontends/ui/src/lib/projects/folder-service.ts`)

## Documents

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/documents` | Required | List documents for a project. Requires `projectId` query param. Checks `project:view` FGA. Read-only document metadata (`summary`, `pageCount`, `chunkCount`, `contentTypes`) is merged from the backend collection listing when available; the internal `metadata` jsonb (ingest job id) is never returned. Lists the `project` shelf only — an Archiv or session-attached document has no project and never appears here. **`authoredBy` (2026-08-20)** narrows the listing to one hand and is the query behind the „Von Piloti" filter chip: validated against `DOCUMENT_AUTHORS` (`user` \| `agent`), so an unknown value is a `400` rather than a silently empty list, and pushed down to the query (partial index `documents_agent_authored_idx`, migration 0063) rather than filtered after the fact. Omitted is not the same as `user`: unfiltered is the whole project's estate. | `?projectId=&authoredBy=user\|agent` | `{ documents: [{ id, filename, fileSize, contentType, status, authoredBy, errorMessage?, summary?, pageCount?, chunkCount?, contentTypes?, displayName?, ... }] }` (`displayName` is the rename, `null` when the document has never been renamed — surfaces show `displayName ?? filename` via `documentDisplayName`; `authoredBy` is on the LIST row because „Von Piloti erstellt" is a line in the Files pane and the pane never loads the full document) |
| `POST` | `/api/documents/upload` | Required | Upload a file. Checks `project:edit` FGA. Writes to SeaweedFS, creates DB row, triggers ingestion via `POST /v1/ingest` on Python backend. | `multipart/form-data` with `projectId` + `file` | `{ documentId, jobId?, status, filename }` |
| `POST` | `/api/documents/search` | Required | Document-centric **semantic search** over a project's corpus (deterministic vector search, no LLM). Checks `project:view` FGA (via `listDocuments`), resolves the project's RAG collection, and proxies to the backend `POST /v1/collections/{c}/search` (`{ query, top_k: 40, top_k_files: topK }`). Backend hits (one per file, best snippet, score-descending) are joined to the project's own file rows **by filename** (`hit.file_name === file.filename`; a filename collision resolves to the most-recent row), so every result is a real, visible document with its live status/metadata plus match evidence. Fail-open: a backend error/timeout yields `{ hits: [] }`, never a 5xx. Body is zod-validated (`q` 1–1000 chars; `topK` 1–100, default 20). | `{ projectId, q, topK? }` | `{ hits: [{ id, filename, status, ..., snippet, page, score }] }` (reordered by score) |
| `GET` | `/api/documents/{id}/download` | Required | Get a presigned download URL for a document. Verifies org ownership + `project:view` FGA. | — | `{ downloadUrl, filename, contentType, fileSize }` |
| `GET` | `/api/documents/{id}/preview` | Required | Presigned inline preview URL (PDF/image types only; 415 otherwise). Verifies org ownership + `project:view` FGA. | — | `{ url, contentType, filename }` |
| `GET` | `/api/documents/{id}/file` | Required | Stream a stored **PDF**'s bytes from THIS origin, inline (`application/pdf` only — 415 for everything else, including SVG, which must never be served inline same-origin because it can carry script into this origin). Verifies org ownership, then `project:view` FGA for a project document; an org-wide Archiv document (NULL `projectId`) is readable by any org member without it. Exists because the in-app PDF viewer *fetches* the file to build a text layer for the cited-passage highlight, and the presigned `/preview` URL is cross-origin with no CORS policy on the object store — a URL the browser can navigate to but not read. Sends `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'` so the viewer's iframe fallback can render it (next.config carries a matching route-scoped override). | — | PDF/image bytes, `Cache-Control: private, max-age=300` |
| `GET` | `/api/documents/{id}/status` | Required | Get document ingestion status. Verifies org ownership + `project:view` FGA. Also merges the read-only document metadata (`summary`, `pageCount`, `chunkCount`, `contentTypes`) from the backend collection listing when available. | — | `{ id, status, filename, fileSize, contentType, collectionName, errorMessage?, createdAt, updatedAt, summary?, pageCount?, chunkCount?, contentTypes? }` |
| `POST` | `/api/documents/{id}/reingest` | Required | Re-dispatch a previously-**failed** document to the ingest pipeline (re-runs the same `POST /v1/ingest` call the upload path uses). Verifies org ownership + `project:edit` FGA. Rejects documents not in `failed` status with `409 CONFLICT`. | — | `{ id, status, jobId }` (status `pending` on success, `failed` if dispatch fails again) |
| `PATCH` | `/api/documents/{id}/tags` | Required | Replace a document's controlled ingestion tags. Verifies org ownership + `project:edit` FGA. Tags are validated against the mirrored controlled vocabulary (`ALLOWED_TAGS`) — off-vocabulary values are rejected fast with `400 BAD_REQUEST` (`invalidTags` in `details`) before any backend round-trip; the zod schema caps the count at `MAX_TAGS` (5, each 1–128 chars). An empty list clears the tags. Proxied to the backend `PATCH /v1/collections/{c}/documents/{f}/tags` (keyed by the document's `collectionName` + `filename`), which is the authority on the vocabulary and cap; a missing summary row surfaces as `404 NOT_FOUND`, an unreachable/failed backend as `502 UPSTREAM_ERROR`. The one-sentence summary is never touched. | `{ tags: string[] }` | `{ id, tags }` |
| `GET` | `/api/documents/{id}/visual-details` | Required | Per-page VLM descriptions of a document's visual chunks (drawings/images/charts) for the file-preview "detailed information" section. Verifies org ownership + `project:view` FGA. Proxied to the backend `GET /v1/collections/{c}/documents/{f}/visual-details`. Read-only and fail-soft: any backend hiccup or an unsupported backend yields `{ details: [] }` rather than an error. | — | `{ id, details: [{ page, contentType, drawingType, scale, text }] }` |
| `PATCH` | `/api/documents/{id}` | Required | **Rename** a document — the label, never the file. Scope-aware (unlike `DELETE` below): `renameDocument` resolves the permission from the row, so a project document needs `project:documents:write`/`project:edit` and an org-wide Archiv document needs `org:archiv:manage`. Writes `documents.display_name` (migration 0048) and mirrors the value to the backend's metadata row via `PATCH /v1/collections/{c}/documents/{f}/display-title`, so citation chips follow the rename with **no re-ingestion**; that mirror is best-effort (a 404 for a document with no summary row, or an unreachable backend, does not fail the rename — the BFF row is the durable one). `filename` is NEVER touched: it is the join key to the stored object and to the document's chunks. A name equal to the file name, or an explicit `null`, CLEARS the rename. Names are validated with `validateDocumentName` (trimmed, 1–200 chars, no path separators or control characters) → `400 BAD_REQUEST` with `reason` in `details`. Audits `document.renamed` / `archiv.document.renamed` with the old and new label beside the unchanged filename. | `{ displayName: string \| null }` | `{ id, filename, displayName }` |
| `PATCH` | `/api/documents/{id}/folder` | Required | **Re-file a project document** into another folder. Its own route rather than a field on `PATCH /api/documents/{id}`: that one is scope-aware and renames org-wide Archiv documents too, and folders are a project-only concept — an Archiv or chat-session document has no folder, and asking to move one is refused rather than quietly ignored. The document is resolved org-scoped first (a document in another tenant is simply not found), then `project:documents:write` is checked against the project that owns it, then the DESTINATION is verified to belong to that same project — without which a folder id would be a forgeable pointer into another project's tree. `folderId: null` files the document at the project root, so the field is nullable rather than optional. Mirrors the new path onto the backend's `document_metadata.folder_path` (ADR-0049) via `PATCH /v1/collections/{c}/documents/{f}/folder-path`, best-effort: the row is the durable record. A no-op move writes nothing and mirrors nothing. | `{ folderId: string \| null }` | `{ id, folderId }` |
| `DELETE` | `/api/documents/{id}` | Required | Delete a project document: purges the RAG chunks (best-effort), removes the SeaweedFS object, deletes the row, audits (`document.deleted`). Verifies org ownership + `project:edit` FGA. Org-wide Archiv documents (NULL `projectId`) are not deletable here — they surface as `404 NOT_FOUND` and go through `DELETE /api/archiv/documents/{id}` instead. | — | `204 No Content` |

Document upload stores files in SeaweedFS at key `{orgId}/{projectId}/{documentId}/{filename}`. Presigned URLs expire after `SEAWEED_PRESIGNED_URL_TTL_SECONDS` (default 600s). Ingestion is best-effort: on the first upload a failed backend dispatch marks the document `failed` with an `errorMessage`; `POST /api/documents/{id}/reingest` lets the user retry that dispatch from the Files workspace.

Source: `frontends/ui/src/app/api/documents/route.ts`, `frontends/ui/src/app/api/documents/upload/route.ts`, `frontends/ui/src/app/api/documents/search/route.ts`, `frontends/ui/src/app/api/documents/[id]/route.ts`, `frontends/ui/src/app/api/documents/[id]/download/route.ts`, `frontends/ui/src/app/api/documents/[id]/file/route.ts`, `frontends/ui/src/app/api/documents/[id]/status/route.ts`, `frontends/ui/src/app/api/documents/[id]/reingest/route.ts`, `frontends/ui/src/app/api/documents/[id]/tags/route.ts`, `frontends/ui/src/app/api/documents/[id]/folder/route.ts`, `frontends/ui/src/app/api/documents/[id]/visual-details/route.ts`

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
| `POST` | `/api/feedback/answers` | Required | Upsert the caller's vote on one answer. `reason` (fixed keys `inaccurate`/`too_slow`/`wrong_source`/`other`) and optional `comment` (free-text, max 2000) are only valid with `verdict: "down"`. | `{ messageId, verdict: 'up'\|'down', reason?, comment?, conversationId?, projectId? }` | `{ messageId, verdict, reason, comment }` |
| `DELETE` | `/api/feedback/answers?messageId=` | Required | Retract (toggle off) the caller's vote. Idempotent. | — | `204 No Content` |
| `GET` | `/api/feedback/answers?conversationId=` | Required | The caller's own votes in one conversation (bounded to 200), for client hydration. | — | `{ feedback: [{ messageId, verdict, reason, comment }] }` |

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
| `POST` | `/api/platform/knowledge/reingest` | Platform owner | Rebuild the chunks of SELECTED base-corpus documents (proxies `POST /v1/admin/oib/reingest`). Distinct from `sync`, which is incremental and gates on each PDF's sha256 and so does nothing for an unchanged file — this forces the rebuild, which is what is needed after a change to how chunks are *built* (chunking, embedding model, a half-failed ingest). Returns as soon as the work is queued; each document then reads `pending` in `/api/knowledge-base` until its chunks exist again. Unknown names are reported in `unknown` rather than failing the call. | `{ fileNames: string[] }` (non-empty) | `{ status: 'pending'\|'noop', queued, unknown, message }` |

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
| `GET` | `/api/jobs/async/job/{job_id}/report` | Varies | Get final report. Proxies to `GET /v1/jobs/async/job/{id}/report`. **2026-08-20**: this is also where the BFF observes a commissioned run finishing and files the report into the project as a `documents` row (`fileResearchReport` → `fileGeneratedDocument`), which is why the response gained the additive `filed` / `filingFailed` keys below. The upstream additively returns `cards` — the run's Grid cards as the runner persisted them — and the BFF passes them through unchanged AND uses them to render the filed PDF's „Rechtsgrundlagen" section (`legalBasisSection`); a non-array is dropped rather than iterated. The filed artifact is a **PDF** rendered from the report's Markdown with the AI notice and the provenance metadata on, not the `.docx` the saved-answer export produces. | `projectId` (query, optional) — the project to file into. **Absent is not "do not file"**: `buildCollectionScopeFromRequest` falls back to the caller's stored `active_project_id` preference (authorized with `project:view`, silently dropped if that has gone stale), so a client that sends nothing may still file into whatever project the user last had open. | `{ job_id, has_report, report, cards?, filed? \| filingFailed? }` |

SSE streams pass through the response body unmodified. The `?token=` query parameter provides an auth fallback for `EventSource` connections that cannot set custom headers (token is extracted and forwarded as `Authorization: Bearer`, not passed to the backend in the URL).

### `filed` / `filingFailed` on the report response (additive, 2026-08-20)

```jsonc
{
  "job_id": "…",
  "has_report": true,
  "report": "# Fluchtweglängen …",
  "cards": [ … ],                  // the run's cards, from the upstream (2026-08-20)
  "filed": {                       // present ONLY when a document now exists
    "documentId": "…",             // the `/files?doc=` deep-link target
    "filename": "fluchtweglangen-gk-4-2026-08-20.pdf",
    "alreadyFiled": false          // false on the fetch that created the row
  }
  // …or, mutually exclusive with `filed`:
  // "filingFailed": true          // a filing was attempted for this report and did not land
}
```

`cards` is passed through exactly as
[`python-endpoints.md`](python-endpoints.md) describes it — every card type the
run produced, not only `legal_basis`, and opaque objects rather than a validated
union — so the filed PDF and the chat thread cannot disagree about one run. This
route checks only that the value is a non-empty array; the renderer narrows
structurally on its own (`legalBasisSection` keeps the `legal_basis` cards and
prints no heading at all when none of them is printable, because a heading over
nothing in a submission document reads as "the citations were lost").

**Three shapes, and the third is the point.** Every field the response already
had is untouched, so a client that has never heard of either key keeps working.

| Shape | Means |
|---|---|
| `filed: { … }` | The document exists. `alreadyFiled` distinguishes the fetch that created the row from the re-reads that follow — a report is fetched again every time its tab is opened, and filing is idempotent per run. |
| `filingFailed: true` | A filing was attempted for this report and did not land: storage admission refused the bytes (`admitOrDiscard`, quota), the audit write failed (in which case the document is un-filed again, row and object both), or the caller does not hold both `project:documents:write` and `project:documents:generate` on the project — or the deployment has switched filing off entirely (`GRID_AGENT_AUTHORED_DOCUMENTS_ENABLED=false` / the per-org `agent-authored-documents` flag). **No reason travels.** A quota refusal, a revoked permission and an object store that is down are one fact to this reader — the document is not there — and the messages that separate them name buckets and limits, which belong in the server log that already has them. |
| neither key | No promise was made: this is not a report request, there is no report yet, no session (which is also the scheduled-run guard — a cron run has no live principal whose permission could authorize a write, design decision 10), or no project could be resolved, meaning neither a `projectId` on the request nor a reachable `active_project_id` preference to fall back on. |

The distinction exists because the banner promises the filing before the run
starts („Der fertige Bericht wird in diesem Projekt unter ‚Berichte' abgelegt.").
A reader shown a plain success who then found nothing in Berichte had no way to
learn why — the only record was a server log. **The client reads it**: the chat
adapter carries `filingFailed` through the report boundary
(`adapters/api/deep-research-client.ts`, which REBUILDS the body, so a key it
does not name is a key no caller sees), the hooks record it on the run's success
banner, and the banner prints one muted line taking the promise back
(`deepResearch.success.filingFailedLine`) — no reason, no colour, no error
state. Filing itself stays best-effort: none of this fails the request, and the
user waited minutes for the report and gets it regardless.

The document is written with `authored_by = 'agent'`, `status = 'stored'` and
**zero assignees**, and is **never ingested** — see
[../superpowers/specs/2026-08-20-agent-authored-documents-design.md](../superpowers/specs/2026-08-20-agent-authored-documents-design.md)
and [../user-guides/agent-authored-reports.md](../user-guides/agent-authored-reports.md).

Source: `frontends/ui/src/app/api/jobs/async/[...path]/route.ts`

## Agent Skills (ADR-0046, feature-gated)

All routes 403 (`feature-disabled`) unless the skills feature is on (`skills` WorkOS flag under enforcement, else `GRID_SKILLS_ENABLED=true`). Authorization is enforced in `lib/skills/service.ts`, not in the routes (ADR-0017); every query is additionally org-filtered.

The org toolbox:

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/skills` | org member | The org's own rows plus the platform's **offers** (each carrying this org's on/off decision), org rows shadowing an offer of the same name. Never the pipeline machinery, and never a platform **standard** skill — those run for every org but are not a tenant's decision. | — | `{ skills }` |
| `POST` | `/api/skills` | org:skills:manage | Author a skill. Validates the SKILL.md name/description rules and the reserved `grid-cards` value; `clonedFrom` records a platform clone. 409s a name reserved by a published platform **standard** skill (such a row could never resolve, so accepting it would mean a green save and an agent that never follows it). | `{ name, description, body, metadata?, clonedFrom?, enabled? }` | `{ skill }` (201) |
| `PATCH` | `/api/skills/{skillId}` | org:skills:manage | Update an org skill. 409s when the row's **current** name is standardised (such a row is inert, so a successful save would be the same green-save-no-effect trap) and when a rename would take a standardised name. Deleting the row still works. | partial create body | `{ skill }` |
| `DELETE` | `/api/skills/{skillId}` | org:skills:manage | Delete an org skill. | — | `{ deleted: true }` |
| `PATCH` | `/api/skills/curated/{name}` | org:skills:manage | Switch a platform **offer** on or off for this organization. Addressed by NAME, because the catalogue's id belongs to the fleet's copy. 404s any name that is not a published offer, so neither the machinery nor a standard skill can be switched off by hand-crafting a request. | `{ enabled }` | `{ skill }` |
| `GET` | `/api/skills/invocable` | org member | The `/name` composer picker's list: enabled skills a chat turn can actually run, **name + description only** — the same progressive-disclosure level 1 the agent is given. Invoking is use, not administration, so any member may read it. Excludes platform standard skills: they run for this org, but they are not the org's to invoke by name. | — | `{ skills }` |
| `GET` | `/api/skills/attachable` | org member | The job builder's skill picker: the skills the chosen output kind can run (`chat` → `shallow_researcher`, `deep-research` → `deep_researcher`, both via `grid-agents`). Carries bodies, because the builder previews the composed prompt. Excludes platform standard skills — the snapshot path refuses them, so offering one would 404 on save. | `?output=chat\|deep-research` | `{ skills }` |

The platform catalogue — platform owners only (ADR-0016, `platformApiRoute`), no per-org feature flag; this is the layer *under* every tenant's skill list:

| Method | Path | Auth | Description | Request Body / Params | Response |
|--------|------|------|-------------|-----------------------|----------|
| `GET` | `/api/platform/skills` | platform owner | The whole fleet-wide catalogue, drafts included, each row carrying its `published` and `delivery` state. | — | `{ skills }` |
| `POST` | `/api/platform/skills` | platform owner | Add one. Created as a DRAFT and as an OFFER unless told otherwise — both defaults closed, so imposing on the fleet takes two deliberate words. A name belonging to a builtin is refused. | `{ name, description, body, metadata?, published?, delivery? }` | `{ skill }` (201) |
| `PATCH` | `/api/platform/skills/{skillId}` | platform owner | Edit, publish/withdraw, or move between deliveries. **offer → standard** starts every organization running it, including ones that had switched it off; **standard → offer** is a fleet-wide deactivation, since each org stops until it switches the skill on. | partial create body | `{ skill }` |
| `DELETE` | `/api/platform/skills/{skillId}` | platform owner | Withdraw from the fleet. Activation rows are left alone, so re-creating the skill under the same name restores the fleet as it was. | — | `{ deleted: true }` |

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

### Tasks (ADR-0051)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/projects/[id]/tasks` | Session, `project:view` | A project's delegated work, newest first (bounded): one row per run with the pinned requester, lifecycle status, filing outcome (`filedDocumentId`, `filingStatus`) and review. Gated on the skills feature like the jobs routes. |
| `POST` | `/api/projects/[id]/tasks/[taskId]/review` | Session, `project:edit` | Record a person's judgement of a finished task: `{ decision: accepted \| rejected, reason? }`. 409 while the task is still running. A rejection's reason reaches the next run of the same job as a `PREVIOUS_DECISIONS` block. Audited as `task.reviewed`. |

Source: `frontends/ui/src/app/api/projects/[id]/tasks/…`; the service is `frontends/ui/src/lib/tasks/`.

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
| `POST` | `/api/internal/jobs/[jobId]/outcome` | `x-grid-internal-token` | The worker reports how a background run ended (`{ organizationId, status: success \| failure \| interrupted, error?, report?, cards? }`), by the backend job id — the one id it holds. Looks the `job_runs` row up under narrow platform access, cross-checks the tenant, closes the run's task (ADR-0051) — filing a finished deep-research report into the project as the task's pinned requester — then emits a `job.completed` / `job.failed` inbox item to the job's creator as that tenant, naming the filed document. 404 for a backend id with no run (an interactive deep-research job), which the worker treats as "nobody to tell". |
| `GET` | `/api/internal/model-overrides?organizationId=` | `x-grid-internal-token` | **New 2026-07-16.** Just-in-time org model-override resolution (ADR-0014) for backend call sites whose request carries no `x-grid-model-overrides`/`X-Grid-Request-Context` header — `common/model_overrides.py`'s `resolve_org_model_overrides()` calls this, cached in-process. Returns `{ overrides: {group: modelId} \| null }`; reuses the write-invalidated cache inside `getActiveModelOverrides`, so a config save is visible on the next backend fetch. |
| `GET` | `/api/internal/document-file?collection=&filename=[&imageIndex=]` | `x-grid-internal-token` | **New 2026-08-03.** Just-in-time storage-key resolution for the backend's `view_knowledge_image` tool (ADR-0039): maps the `(collection, filename)` pair the backend carries to the SeaweedFS `storage_key` in the `documents` table. Returns `{ storageKey, storageBucket, contentType }` (404 when unknown); the backend fetches the bytes itself via boto3. With `imageIndex` (integer ≥ 0) it returns the key of the `_img/<index>.jpg` raster the ingest pipeline stored beside the document, built from the row's own storage key by `buildImageStorageKey` — the backend never names a derived key, only a bounded integer, so a derived read cannot leave the owning document's prefix. Collection name is the tenancy boundary (`proj_<uuid>`/`archiv_<orgId>`), so no per-org FGA — read-only metadata. Declares `tenancy: { fromPayload }`; when the backend supplies no `organizationId` (every `proj_` collection) the lookup runs under an explicit platform scope, so row-level security does **not** constrain it — the unguessable collection name is still the only boundary on that path (ADR-0041). |
| `POST` | `/api/internal/document-image-upload-url` | `x-grid-internal-token` | **New 2026-09-02.** One presigned PUT slot for a raster the ingest pipeline cut out of a PDF (`{ documentId, collection, imageIndex, organizationId? }` → `{ uploadUrl, storageKey }`). The backend holds a read-only object-store credential, so it writes derived objects through this the way it writes the thumbnail — per image rather than pre-issued in the ingest body, because the count is unknown until extraction has run and most documents hold none. The key is `<doc dir>/_img/<index>.jpg` from the row's own storage key; `MAX_STORED_IMAGES_PER_DOCUMENT` (`lib/s3.ts`, 64) is enforced here as a 404 the backend reads as "stop". Row addressed by document id AND collection (both unguessable); `organizationId` narrows the lookup when sent. Deleted with the document by the `_img/` sweep in `lib/documents/object-cleanup.ts`. |
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
access rule, resolved from the document's **shelf** (`documents.scope`,
ADR-0047) rather than from whether it has a project:

| Shelf | Who may read the model |
|---|---|
| `project` | `requireProjectAccess(project:view)` on the document's project. |
| `archiv` | Any member of the owning organization (ADR-0024 — the Archiv is shared knowledge). |
| `session` | Only inside the conversation the file was attached to (`requireResourceAccess(conversation, viewer)`). |

Cross-tenant and no-access both surface as 404. The shelf is what decides
because two of the three have no project: reading "no project" as "the Archiv"
served a private chat attachment's building — and a presigned URL for its
bytes — to every member of the organization.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects/{id}/bim/models` | Models in scope for a project — its own plus the org Archiv's. "The Archiv's" is `documents.scope = 'archiv'`, not "no project": a chat attachment (`scope = 'session'`) is also project-less and must never appear here. |
| `GET` | `/api/documents/{id}/model` | The model read from ONE document, on any shelf — the question a file preview actually has the answer to, and the only way a model in the org-wide Archiv (which has no project) can be resolved at all. `{ model: null }` when the file has no model yet (still extracting) or is not a model; authorization is the document's own shelf rule. |
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
