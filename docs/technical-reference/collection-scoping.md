# Collection Scoping

Controls which ChromaDB collections are searched for each knowledge retrieval request. The scope is computed in the Next.js BFF and propagated to the Python backend via an HTTP header.

---

## Purpose

When a user asks a question, the AI needs to know which knowledge sources to search. Collection scoping solves this by building an **ordered, deduplicated list of collection names** per request that includes:

- The base OIB knowledge collection (always)
- The org-wide Archiv collection (`archiv_{orgId}`, when the Archiv feature is enabled for the org — ADR-0024)
- The active project collection (`proj_{projectId}`, if working in a project)
- The restricted-folder collections the session is cleared for
  (`<project collection>_r<12 hex>`, interactive chat turns only — ADR-0084, see
  [Restricted folders](#restricted-folders-adr-0084-adr-0085))
- The session collection (`s_{conversationId}`, if in a conversation)

This page is about which collections a request READS. What writes into the
session collection is the session-document pipeline, not the browser:
`POST /api/session/documents/upload` stores the file as a `session` document row
and dispatches it into `s_{conversationId}`, the listing and delete go through
`/api/session/documents`, and `DELETE /api/conversations/[id]` erases the whole
collection. The `/api/v1` proxy only reads an `s_` collection
([BFF routes](../api/bff-routes.md#chat-attachments-session-documents-adr-0047-phase-2)).

The Archiv collection is injected in `buildCollectionScopeFromRequest` (which has `session.organizationId`) and passed to `computeCollectionScope` as `archivCollectionName`; it rides right after the base corpus, so every project in the org retrieves across the shared Archiv with no per-project configuration.

---

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js BFF)                   │
│                                                                  │
│  computeCollectionScope(session, context) → string[]             │
│  buildCollectionScopeHeader(scope) → base64url(json)             │
│  buildCollectionScopeFromRequest(session, context) → {scope,     │
│    headerValue, projectId, conversationId}                       │
└────┬─────────────────────────────────────────────────────────┬───┘
     │ SSE (/api/generate, /api/chat)                          │ WebSocket upgrade
     │ X-Grid-Collection-Scope header                          │ calls /api/auth/websocket-scope
     ▼                                                          ▼
┌────────────────────────────────────────────────────────────────┐
│                   Python Backend (NAT context)                  │
│                                                                  │
│  get_collection_scope_from_context() → list[str] | None         │
│    Reads X-Grid-Collection-Scope from Context.metadata.headers   │
│                                                                  │
│  get_collection_scope_from_context_or(config, session_id)        │
│    → Falls back to config-based resolution if header missing     │
│                                                                  │
│  _resolve_target_collections(config, session_id) → list[str]     │
│    → Legacy: use_fixed_collection, include_base_collection,      │
│      include_session_collection, project_collections             │
└────────────────────────────────────────────────────────────────┘
```

---

## Frontend: `collection-scope.ts`

**File**: `frontends/ui/src/lib/collection-scope.ts`

### `computeCollectionScope(session, context)`

Builds an ordered deduplicated list of collection names:

```typescript
function computeCollectionScope(
  session: GridSession | null,
  context: ScopeContext
): string[]
```

**ScopeContext**:
- `projectId?: string` — if present, adds `proj_{projectId}`
- `conversationId?: string` — if present, adds `s_{conversationId}`
- `baseCollection?: string` — defaults to `process.env.BASE_COLLECTION_NAME || 'oib_knowledge'`
- `restrictedCollections?: readonly string[]` — restricted-folder collections, placed right
  after the project collection. Only `buildCollectionScopeFromRequest` passes them, and only for
  an interactive chat turn; the session-less scheduled-run path (`jobs/service.ts`) never does

### `buildCollectionScopeHeader(scope)`

Encodes the scope array into a base64url-encoded header value:

```typescript
function buildCollectionScopeHeader(scope: string[]): string
// Example output: "WyJvaWJfa25vd2xlZGdlIiwicHJval8xMjMiLCJzX2FiYyJd"
// Decodes to: ["oib_knowledge","proj_123","s_abc"]
```

---

## Frontend BFF: `collection-scope-request.ts`

**File**: `frontends/ui/src/lib/collection-scope-request.ts`

### `buildCollectionScopeFromRequest(session, context)`

The main entry point for SSE and WebSocket routes. It:

1. Resolves the active project ID:
   - Uses the explicit `projectId` from the request body if provided
   - Otherwise reads `active_project_id` from the user's `user_preferences` Drizzle row

2. Enforces project access via `requireProjectAccess(session, projectId, 'project:view')` when auth is required

3. Calls `computeCollectionScope` and `buildCollectionScopeHeader`

4. Returns `{ scope, headerValue, projectId, conversationId }`

```typescript
async function buildCollectionScopeFromRequest(
  session: GridSession | null,
  context: RequestContext
): Promise<{ scope: string[], headerValue: string, projectId?: string, conversationId?: string }>
```

---

## Restricted folders (ADR-0084, ADR-0085)

A folder whose own access list does not include every project member
(`project_folder_grants` without `*`, migration 0109) restricts READING. A
document under it lives in the collection of its nearest such folder,
`<project collection>_r<12 hex of the folder id>` (`restrictedCollectionName`
in `lib/authz/folder-access-rule.ts`). Who may WRITE never moves anything:
collections key on read. Retrieval keeps the collection out of reach by leaving
it out of the scope; no Python read path needs to know.

`buildCollectionScopeFromRequest` adds a project's restricted collections, with
shelf `project`, only when ALL of these hold:

- the caller passed `interactiveChat: true`. Only the WebSocket upgrade
  (`/api/auth/websocket-scope`) does. Deep research (`/api/jobs/async/*`, whose
  context comes from `parseBodyContext`/`parseQueryContext` and cannot carry
  the flag), the `/api/v1` proxy and scheduled or commissioned runs
  (`submitAgentRun`, session-less) never get one: their reports are filed for
  the whole project;
- the session may read the folder (`effectiveFolderLevel` over its roles, read
  from the WorkOS membership at most 60 s ago);
- everyone the conversation is shared with may read it too
  (`restrictedCollectionsForChatScope` in `lib/conversations/restricted-use.ts`).

The same rule gates the collection proxy: `/api/v1/collections/<name>` with a
restricted name is authorized as its project's collection and then 404s unless
the session may read the folder (`lib/proxy/collection-authz.ts`).

### Per person, by what the conversation used

A conversation is restricted by what it USED, recorded per source folder in
`conversation_restricted_folders` (migration 0110): content from a folder not
every member may read entered the model's context. Being able to search a
folder is not use. Each use is ADMITTED by the BFF
(`POST /api/internal/conversations/[id]/restricted-use`) before the content
reaches the model, against the asker and everyone the conversation is shared
with, under the same advisory lock every widening of the audience takes, so a
share and an admission cannot both go through:

- at turn start the agent offers the restricted collections of its signed
  scope and gets back the ones it may draw on (`drawable`) and whether the
  conversation already recorded a folder (`recorded`). It binds the answer per
  turn (`aiq_agent.knowledge.restricted_use`), and
  `get_scoped_collections_from_context` keeps only the drawable ones, so every
  read path searches only what everyone reading the conversation may read. A
  thread shared since the socket was signed loses those collections from the
  next turn on; the socket is not closed;
- a tool round's results are admitted before the model reads them
  (`PilotiAgent._tools_node` → `admit_tool_results`); a result carrying a
  refused collection is replaced by a notice;
- a subject document from a restricted folder is admitted by the BFF before it
  is sent;
- listing is not use: restricted collections stay out of the inventory block,
  `list_files` and the document cards, so a name or a summary never reaches the
  prompt without an admission.

Sharing (`assertMayWidenConversation`, `widenConversationAudience`) allows a
new reader exactly when they may read every recorded folder NOW; a folder
opened to every member drops out, and a deleted folder's tombstone (0109) keeps
answering with the access it had. The doors that write something the whole
project reads refuse a conversation with a record
(`lib/conversations/restricted-egress.ts`); deep research and tasks stay
refused for such a conversation for now.

A socket answers for one conversation only: the signed `conversationId`.
A frame naming another is refused with `conversation_mismatch` before anything
runs (`ChatSocket._admit`), so a restricted scope cannot be pointed at a
different thread over the same socket.

## WebSocket Scope

**File**: `frontends/ui/server.js` (lines 198–258)

During WebSocket upgrade (`/websocket` path):

1. `server.js` parses `projectId` and `conversationId` from the WebSocket URL query string
2. Calls `fetchCollectionScopeHeader()` which makes an internal HTTP GET to `http://127.0.0.1:{port}/api/auth/websocket-scope?projectId=...&conversationId=...`
3. The `websocket-scope` route resolves the session from cookies, calls `buildCollectionScopeFromRequest`, and returns the header value
4. `server.js` injects `x-grid-collection-scope` into the proxied WebSocket upgrade request headers
5. Also forwards `x-grid-organization-id`, `x-grid-user-id`, and `authorization` (Bearer token) for user context

**File**: `frontends/ui/src/app/api/auth/websocket-scope/route.ts`

Internal endpoint that:
- Reads `projectId` and `conversationId` from query params
- Asks for an interactive chat scope (`interactiveChat: true`), the only scope that may carry
  restricted-folder collections
- Resolves the Grid session from the encrypted WorkOS cookie
- Enforces project access if auth is required
- Returns JSON with `{ scope, header, organizationId, userId, accessToken }`

On 401/403, the WebSocket connection is rejected with the appropriate status code.

---

## SSE Routes

**File**: `frontends/ui/src/app/api/generate/route.ts`

The `POST /api/generate` route reads `projectId` and `conversationId` from the request body, calls `buildCollectionScopeFromRequest`, and includes the header when proxying to the backend:

```typescript
const { headerValue } = await buildCollectionScopeFromRequest(session, {
  projectId: body.projectId,
  conversationId,
})
// Forwarded as: 'X-Grid-Collection-Scope': headerValue
```

The same pattern is used in:
- `frontends/ui/src/app/api/chat/route.ts` — `POST /api/chat`
- `frontends/ui/src/app/api/generate/respond/route.ts` — response follow-ups
- `frontends/ui/src/app/api/v1/[...path]/route.ts` — generic API proxy
- `frontends/ui/src/app/api/jobs/async/[...path]/route.ts` — async job proxy

---

## Python: `scoping.py`

**File**: `src/aiq_agent/knowledge/scoping.py`

### `get_collection_scope_from_context()`

Reads and decodes the `X-Grid-Collection-Scope` header from NAT context:

```python
def get_collection_scope_from_context() -> list[str] | None:
```

- Accesses `Context.get().metadata.headers['x-grid-collection-scope']`
- Base64url-decodes and JSON-parses the value
- Validates it is a list of strings
- Returns deduplicated list (preserving order), or `None` if missing/malformed

### `get_collection_scope_from_context_or(config, session_id)`

Tries the header-based scope first, falls back to legacy config-based resolution:

```python
def get_collection_scope_from_context_or(
    config: Any,
    session_id: str | None,
) -> list[str]:
```

The fallback calls `_resolve_target_collections()` from the `knowledge_layer` register module.

---

## Python Legacy: `_resolve_target_collections()`

**File**: `sources/knowledge_layer/src/register.py` (line 220)

Config-based collection resolution when no scope header is present:

```python
def _resolve_target_collections(
    config: KnowledgeRetrievalConfig,
    session_id: str | None,
) -> list[str]:
```

Layers (in order):
1. **Base collection** — `config.collection_name` if `config.include_base_collection` is True
2. **Session collection** — `session_id` if `config.include_session_collection` is True (default: True)
3. **Project collections** — `config.project_collections` (list of additional named collections)

If `config.use_fixed_collection` is True, only the base `collection_name` is returned (legacy pinned behavior).

If all layers are empty, it falls back to `[config.collection_name]`.

---

## Upper Bound: `MAX_SCOPE_COLLECTIONS`

The maximum number of collections that can be searched per request is defined in `register.py` via `MAX_SCOPE_COLLECTIONS` (currently **5**).

This limit is relevant in multi-tenant or multi-project setups where many collections could theoretically be in scope. The scope is truncated to this upper bound.

---

## Async Deep-Research Jobs: Collection-Scope Re-injection Gap (fixed 2026-07-16, `f8093a0`)

The scope header described above governs synchronous chat requests. Async
deep-research jobs are different: the `X-Grid-Collection-Scope` header is
read **once, at job submit time**, in `piloti/conversation_register.py`, and
carried through as a `collection_scope` field on the job payload rather than
as a live header.

When the Dask worker later runs the job, `frontends/aiq_api/src/aiq_api/jobs/runner.py:641`
re-injects it into the worker's own request context **only when present**:

```python
if collection_scope is not None:
    encoded = base64.urlsafe_b64encode(json.dumps(collection_scope).encode()).rstrip(b"=").decode()
    # ... set back onto the header the worker's NAT context reads
```

If `collection_scope` is `None` at submit time (e.g. the request bypassed the
BFF, or came from an older client that never set the header),
`knowledge_retrieval` inside the worker has no header to read and falls back
to `_resolve_target_collections()` — priority 2 in the table below — using
**base collection + session collection only**. Because `project_collections`
is `[]` in the shipped configs, project collections are **never** searched in
that fallback for the affected job. The fallback behavior itself is
unchanged — this is still a real degradation for the affected job — but it is
no longer silent: the `elif` branch for `deep_research_agent` jobs now logs a
one-time WARNING (job id, whether the request looked
authenticated/project-scoped) at exactly the point re-injection would
otherwise be skipped, so the gap is diagnosable from logs instead of
invisible.

---

## Summary of Scope Resolution Priority

| Priority | Source | When |
|----------|--------|------|
| 1 (highest) | `X-Grid-Collection-Scope` header | Present in SSE and WebSocket upgrades |
| 2 | `_resolve_target_collections()` config | Header absent (legacy/fallback) |

The header is always set for SSE requests (`/api/generate`, `/api/chat`) and WebSocket upgrades. It is absent only when requests bypass the BFF or when the NAT context has no metadata headers.
