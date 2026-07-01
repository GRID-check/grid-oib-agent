# Collection Scoping

Controls which ChromaDB collections are searched for each knowledge retrieval request. The scope is computed in the Next.js BFF and propagated to the Python backend via an HTTP header.

---

## Purpose

When a user asks a question, the AI needs to know which knowledge sources to search. Collection scoping solves this by building an **ordered, deduplicated list of collection names** per request that includes:

- The base OIB knowledge collection (always)
- The active project collection (`proj_{projectId}`, if working in a project)
- The session collection (`s_{conversationId}`, if in a conversation)

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

## Summary of Scope Resolution Priority

| Priority | Source | When |
|----------|--------|------|
| 1 (highest) | `X-Grid-Collection-Scope` header | Present in SSE and WebSocket upgrades |
| 2 | `_resolve_target_collections()` config | Header absent (legacy/fallback) |

The header is always set for SSE requests (`/api/generate`, `/api/chat`) and WebSocket upgrades. It is absent only when requests bypass the BFF or when the NAT context has no metadata headers.
