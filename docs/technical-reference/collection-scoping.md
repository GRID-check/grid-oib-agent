# Collection Scoping

Controls which ChromaDB collections are searched for each knowledge retrieval request. The scope is computed in the Next.js BFF and propagated to the Python backend via an HTTP header.

---

## Purpose

When a user asks a question, the AI needs to know which knowledge sources to search. Collection scoping solves this by building an **ordered, deduplicated list of collection names** per request that includes:

- The base OIB knowledge collection (always)
- The org-wide Archiv collection (`archiv_{orgId}`, when the Archiv feature is enabled for the org — ADR-0024)
- The active project collection (`proj_{projectId}`, if working in a project)
- The session collection (`s_{conversationId}`, if in a conversation)

The Archiv collection is injected in `buildCollectionScopeFromRequest` (which has `session.organizationId`) and passed to `computeCollectionScope` as `archivCollectionName`; it rides right after the base corpus, so every project in the org retrieves across the shared Archiv with no per-project configuration.

### Request scope: `project` or `workspace`

`RequestContext.scope` names the surface the turn is asked from
([ADR-0054](../adr/0054-workspace-chat-mounts-projects-on-demand.md)). It
defaults to `project`, so every caller written before the Büro-Chat is unchanged.

| `scope` | Collections | Active-project fallback | Project access check |
|---|---|---|---|
| `project` (default) | `[base, archiv_<org>?, proj_<id>?, s_<conversation>?]` | Yes — an absent `projectId` falls back to the stored `active_project_id` preference, degrading to no project when that project is unreadable | `project:chat` on an explicit `projectId`; the same check, swallowed, on the fallback |
| `workspace` | `[base, archiv_<org>?, proj_<mounted>*, s_<conversation>?]` | **Never.** `includeProject` is false before any of that logic runs, so no preference is read and no FGA call is made | None for the turn itself; `project:chat` per MOUNTED project, re-run on every upgrade |

A `projectId` passed alongside `scope: 'workspace'` is dropped, not honoured: the
office surface must not acquire a project implicitly *or* explicitly through a
channel that was never meant to carry one (spec KH-5, MG-3). The only project a
workspace turn reads is one that was **mounted**.

### Mounted projects (ADR-0054, spec MT-7)

A Büro conversation's mounts are rows in `conversation_mounts`, written by the
mounts endpoint ([`bff-routes.md`](../api/bff-routes.md#conversations)). The
workspace branch of `buildCollectionScopeFromRequest` loads them and
**re-authorizes every one** with `project:chat`, concurrently, before any of
them reaches the scope (`listAuthorizedMounts`). That re-authorization is the
whole revocation story for a mount: a permission taken away between two turns
narrows the scope at the next WebSocket upgrade, and the grant's 15-minute
lifetime bounds the window in between.

Each check **fails closed on its own**: a project whose check errors is dropped
from the scope and the rest of the turn proceeds, because the alternative to a
narrower answer is no answer at all. The whole leg is non-fatal for the same
reason the Archiv and memory legs are — failing this way can only ever REMOVE
collections from a scope, never add one.

Mounted collections sit **after** the office's own shelves and **before** the
conversation's private one, which is the knowledge hierarchy's order. A project
chat asks for no mounts at all: it has its one locked project, and the query's
answer would always be empty.

**Header budget.** Each mount adds a collection name plus its project's id and
name to the scope header, which rides the WebSocket upgrade as a request header
where 8 KB is the ceiling every proxy in the path agrees on. At the default cap
of five mounts with 80-character names the encoded header stays well under it,
and `collection-scope-request.spec.ts` asserts that bound rather than trusting
it.

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
- `mountedCollectionNames?: readonly string[]` — the collections of the projects this conversation has MOUNTED (ADR-0054), **already re-authorized by the caller**. Passed in rather than resolved here, because deciding which mounts survive is an authorization question and this function is pure
- `baseCollection?: string` — defaults to `process.env.BASE_COLLECTION_NAME || 'oib_knowledge'`

### `CollectionShelf` — the shelf a collection sits on

The wire shelf enum (ADR-0047), carried explicitly on every scope entry and
never derived from an `archiv_`/`proj_`/`s_` name prefix:

| Shelf | What sits on it | German label (rendering only) |
|---|---|---|
| `base` | The platform's OIB corpus. | Basiswissen |
| `archiv` | The organisation's shared Archiv (ADR-0024). | Büroarchiv |
| `register` | The Projektregister — one bounded *Steckbrief* per project (ADR-0054). | Projektregister |
| `project` | A mounted project's own corpus. | Projektwissen |
| `session` | A file the user attached to one conversation. | Private Sitzung |

The order above is the knowledge hierarchy (spec KH-1), and it is the order
every surface that ranks or groups by level uses.

`register` is a level in its own right and deliberately **not** folded into
`project` (spec KH-2), because the two carry different licences: a `project` hit
is a passage from a document and may ground a claim about the project's content;
a `register` hit is navigation and structured fact — the agent may name the
project and quote a profile fact from its Steckbrief, and may not say what its
drawings show (spec PR-14, PR-15). A Steckbrief's source KIND stays `projekt`.

### `projectId` / `projectName` — which project a collection belongs to

`ScopedCollection` carries two more optional fields (ADR-0054, spec KH-13), set
only on a mounted project's entry:

```typescript
interface ScopedCollection {
  collection: string
  shelf?: CollectionShelf
  projectId?: string
  projectName?: string
}
```

The shelf says a chunk came from *a* project; in the Büro that is not enough,
because a turn can read five of them and a citation that cannot name its project
is a citation nobody can act on. Both fields are set at the one point where they
are known for free — the BFF builds the scope, so it already holds the project's
id and name — and travel as DATA the whole way down, exactly as the shelf does.
Nothing downstream parses `proj_<uuid>` to recover them. Absent means "not a
project collection", never "we could not tell". The Python twin is
`ScopedCollection(project_id=…, project_name=…)` in
`src/aiq_agent/knowledge/scoping.py`.

The enum is declared twice on purpose and the two copies must change together
— `frontends/ui/src/lib/collection-scope.ts` (`CollectionShelf`, the transport
type) and `frontends/ui/src/features/chat/lib/source-kinds.ts` (`Shelf`, the
rendering type), mirrored by `src/aiq_agent/common/source_kinds.py`. Both fail
CLOSED on an unknown member: a shelf added on one side renders unattributed on
the other until both are updated, which is the behaviour ADR-0047 chose over
guessing.

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

3. In the `workspace` branch only: loads the conversation's mounts and
   re-authorizes each with `project:chat` (see *Mounted projects* above)

4. Calls `computeCollectionScope` and `buildCollectionScopeHeader`

5. Returns `{ scope, scopedCollections, headerValue, projectId, conversationId }`

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

1. `server.js` parses `projectId`, `conversationId` and `scope` from the WebSocket URL query string
2. Calls `fetchCollectionScopeHeader()` which makes an internal HTTP GET to `http://127.0.0.1:{port}/api/auth/websocket-scope?projectId=...&conversationId=...&scope=...` (`scope` omitted when absent). The per-process memo in front of that call is keyed on `(cookie, projectId, conversationId, scope)` — `scope` included, because a Büro upgrade and a project upgrade share a cookie and the Büro one carries no `projectId`, so without it the two would collapse onto one cache entry
3. The `websocket-scope` route resolves the session from cookies, calls `buildCollectionScopeFromRequest`, and returns the header value
4. `server.js` injects `x-grid-collection-scope` into the proxied WebSocket upgrade request headers
5. Also forwards `x-grid-organization-id`, `x-grid-user-id`, and `authorization` (Bearer token) for user context

**File**: `frontends/ui/src/app/api/auth/websocket-scope/route.ts`

Internal endpoint that:
- Reads `projectId`, `conversationId` and `scope` from query params. `scope` is `project` (the default when absent) or `workspace`; anything else is a **400**
- Resolves the Grid session from the encrypted WorkOS cookie
- Requires the `workspace-chat` feature flag for `scope=workspace` (fail-open while `GRID_ENFORCE_FEATURE_FLAGS` is off, 403 otherwise)
- Enforces project access if auth is required
- Skips `loadProjectPromptView` / `loadProjectBundesland` and returns no `projectId` / `projectContext` for `scope=workspace`; the memory digest still runs and carries organisation memory into the office turn, and proposal decisions are built only when a project exists
- Returns JSON with `{ scope, header, organizationId, userId, accessToken }`

On 400/401/403, the WebSocket connection is rejected with the appropriate status code.

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

### In-turn widening: a mount grant (ADR-0054, spec MT-6)

`get_scoped_collections_from_context()` — the shelf-bearing form of the reader
above — unions **this turn's verified mounts** onto the header scope *after*
parsing it (`_with_turn_mounts`). That is the one way a collection the signed
header never named becomes readable, and it exists because a Büro turn can
decide mid-answer that it needs a project's documents, long after the scope was
signed at the WebSocket upgrade.

The authority is still the BFF's (ADR-0006). `open_project` asks the mounts
endpoint, which checks the ACTING USER's `project:chat` and returns a
short-lived signed grant; `knowledge/mounts.py` verifies it — HMAC-SHA256 with
`GRID_INTERNAL_API_TOKEN` (the request-envelope's secret), version, shelf,
expiry, organisation and conversation — and only then adds it to a **per-turn
`ContextVar` registry** bound and reset by the chat entrypoint. Consequences
worth stating:

- an unsigned, tampered, expired or foreign grant widens nothing and is logged;
- a mount lives for exactly one turn in this process. Its durable half is the
  BFF's `conversation_mounts` row, which reaches the next turn on the ordinary
  signed header after the BFF re-authorizes it — that re-authorization is the
  revocation path;
- a mount widens the CEILING, it does not aim the search:
  `_restrict_scope_to_turn` still subtracts the shelves the composer did not ask
  for;
- entries carry `projectId`/`projectName` (camelCase on the wire), which
  `_retrieve_collection` stamps onto every chunk and the citation wire carries
  as `project_id`/`project_name`, so a Büro answer can name the project a
  passage came from.

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

## Upper bound on collections

There is no cap in code. `MAX_SCOPE_COLLECTIONS` was documented here as a
constant in `register.py` that truncated the scope to five collections; no such
constant exists, and the knowledge layer fans out one retrieval per collection
in the scope (`sources/knowledge_layer/src/register.py`, `_retrieve_collection`),
doubled by the HyDE draft and multiplied by the requery loop. The bound is
therefore whatever the BFF puts in the header: base, the Archiv, one project and
the session collection today. The Büro-Chat bounds it explicitly with
`GRID_WORKSPACE_MAX_MOUNTED_PROJECTS` at the mounts endpoint
([ADR-0054](../adr/0054-workspace-chat-mounts-projects-on-demand.md)).

---

## Async Deep-Research Jobs: Collection-Scope Re-injection Gap (fixed 2026-07-16, `f8093a0`)

The scope header described above governs synchronous chat requests. Async
deep-research jobs are different: the scope is read **once, at job submit
time**, in `chat_researcher/register.py`, and carried through as a
`collection_scope` field on the job payload rather than as a live header.

What is read at that moment is `_escalation_collection_scope`, i.e. the LIVE
scope — the header plus whatever this turn mounted (above) — serialized back
into the wire entries (`scope_entries_to_wire`), so a run escalated after
"Projekt Seestadt einblenden" reads Seestadt too (ADR-0054, spec DR-1). Both
wire shapes travel: bare names from older callers, entry objects with shelf and
project identity from the Büro. The worker re-injects them verbatim
(`_collection_scope_header`), and `_derive_project_collection` reads names out
of either shape — returning **no** project for a run that read several, because
a Büro run belongs to the organisation and not to one of its projects (DR-2).

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
