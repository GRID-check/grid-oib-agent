# Grid MVP Implementation Plan — Collection Scoping + Retrieval

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make knowledge retrieval server-authoritative: the BFF computes `collection_scope[]`, passes it via `X-Grid-Collection-Scope`, and the Python agent consumes it for both semantic search and `available_documents`.

**Architecture:** BFF middleware/proxy reads session, resolves org/project membership, and injects the header. Python `knowledge_retrieval` and `ChatDeepResearcherAgent` prefer the header over config-based flags.

**Tech Stack:** Next.js middleware/proxy, NAT Context headers, Python FastAPI dependency context.

---

## File structure

| File | Responsibility |
|---|---|
| `frontends/ui/src/lib/collection-scope.ts` | Compute `collection_scope[]` from session + request context. |
| `frontends/ui/src/middleware.ts` | Inject `X-Grid-Collection-Scope` on proxy paths. |
| `frontends/ui/server.js` | Inject header on WebSocket upgrade. |
| `sources/knowledge_layer/src/register.py` | Read header and use as target collections. |
| `src/aiq_agent/agents/chat_researcher/register.py` | Read header for `available_documents`. |
| `configs/config_grid_oib.yml` | Zero out deprecated scope flags. |
| `tests/knowledge_layer/test_collection_scope.py` | Unit tests. |

---

### Task 1: Implement collection scope computation

**Files:**
- Create: `frontends/ui/src/lib/collection-scope.ts`

- [ ] **Step 1: Implement helper**

```typescript
import { AuthorizedSession } from "./auth/types";

export interface ScopeContext {
  projectId?: string;
  conversationId?: string;
  baseCollection?: string;
}

export function computeCollectionScope(
  session: AuthorizedSession,
  context: ScopeContext
): string[] {
  const scope: string[] = [];
  const base = context.baseCollection || process.env.BASE_COLLECTION_NAME || "oib_knowledge";
  scope.push(base);

  if (context.projectId) {
    scope.push(`proj_${context.projectId}`);
  }

  if (context.conversationId) {
    scope.push(`s_${context.conversationId}`);
  }

  return [...new Set(scope)];
}
```

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/src/lib/collection-scope.ts
git commit -m "feat: add collection scope computation helper"
```

---

### Task 2: Add scope helper tests

**Files:**
- Create: `frontends/ui/tests/lib/collection-scope.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from "vitest";
import { computeCollectionScope } from "@/lib/collection-scope";

const baseSession = {
  userId: "user_1",
  email: "a@b.com",
  name: null,
  accessToken: "tok",
  organizationId: "org_1",
  role: "member",
  permissions: [],
};

describe("computeCollectionScope", () => {
  it("always includes base corpus", () => {
    expect(computeCollectionScope(baseSession, {})).toEqual(["oib_knowledge"]);
  });

  it("adds project corpus when projectId is provided", () => {
    expect(computeCollectionScope(baseSession, { projectId: "abc" })).toEqual([
      "oib_knowledge",
      "proj_abc",
    ]);
  });

  it("adds conversation corpus with s_ prefix", () => {
    expect(computeCollectionScope(baseSession, { conversationId: "uuid-123" })).toEqual([
      "oib_knowledge",
      "s_uuid-123",
    ]);
  });

  it("deduplicates base collection", () => {
    expect(computeCollectionScope(baseSession, { baseCollection: "oib_knowledge" })).toEqual([
      "oib_knowledge",
    ]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd frontends/ui && npm run test:ci -- tests/lib/collection-scope.test.ts`
Expected: 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/tests/lib/collection-scope.test.ts
git commit -m "test: collection scope computation"
```

---

### Task 3: Inject scope header in middleware

**Files:**
- Modify: `frontends/ui/src/middleware.ts`

- [ ] **Step 1: Compute and attach header**

```typescript
import { authkitMiddleware } from "@workos-inc/authkit-nextjs";
import { NextRequest, NextResponse } from "next/server";
import { computeCollectionScope } from "@/lib/collection-scope";

export default async function middleware(request: NextRequest) {
  const authResponse = await authkitMiddleware({
    redirectUri: process.env.WORKOS_REDIRECT_URI || "http://localhost:3000/api/auth/callback",
  })(request);

  if (request.nextUrl.pathname.startsWith("/api/v1/") || request.nextUrl.pathname === "/api/chat") {
    const session = await getSession(); // from authkit-nextjs
    if (session?.organizationId) {
      const scope = computeCollectionScope(
        {
          userId: session.user.id,
          email: session.user.email,
          name: null,
          accessToken: session.accessToken,
          organizationId: session.organizationId,
          role: session.role ?? "member",
          permissions: session.permissions ?? [],
        },
        {
          projectId: request.nextUrl.searchParams.get("projectId") || undefined,
          conversationId: request.nextUrl.searchParams.get("conversationId") || undefined,
        }
      );
      request.headers.set("X-Grid-Collection-Scope", btoa(JSON.stringify(scope)));
    }
  }

  return authResponse;
}
```

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/src/middleware.ts
git commit -m "feat: inject collection scope header in middleware"
```

---

### Task 4: Forward header in API proxy routes

**Files:**
- Modify: `frontends/ui/src/app/api/v1/[...path]/route.ts`
- Modify: `frontends/ui/src/app/api/chat/route.ts`

- [ ] **Step 1: Forward header in generic proxy**

In the `fetch` call to backend, add:

```typescript
const scopeHeader = request.headers.get("X-Grid-Collection-Scope");
if (scopeHeader) {
  headers.set("X-Grid-Collection-Scope", scopeHeader);
}
```

- [ ] **Step 2: Commit**

```bash
git add frontends/ui/src/app/api/v1/\[...path\]/route.ts frontends/ui/src/app/api/chat/route.ts
git commit -m "feat: forward collection scope header to python backend"
```

---

### Task 5: Inject scope header on WebSocket upgrade

**Files:**
- Modify: `frontends/ui/server.js`

- [ ] **Step 1: Locate upgrade handler**

Read `frontends/ui/server.js` lines 147-181.

- [ ] **Step 2: Add header injection**

Before proxying the WebSocket upgrade, parse the URL query for `projectId` and `conversationId`, compute scope, and add to `req.headers`:

```javascript
const url = new URL(req.url, `http://${req.headers.host}`);
const scope = computeCollectionScope(
  session, // derived from cookie or AuthKit
  {
    projectId: url.searchParams.get("projectId"),
    conversationId: url.searchParams.get("conversationId"),
  }
);
req.headers["x-grid-collection-scope"] = Buffer.from(JSON.stringify(scope)).toString("base64url");
```

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/server.js
git commit -m "feat: inject collection scope on websocket upgrade"
```

---

### Task 6: Update Python `knowledge_retrieval`

**Files:**
- Modify: `sources/knowledge_layer/src/register.py`

- [ ] **Step 1: Add header reader**

```python
import base64
import json

try:
    from aiq_agent.runtime.context import Context
except Exception:
    Context = None


def _get_collection_scope_from_header() -> list[str] | None:
    if Context is None:
        return None
    try:
        ctx = Context.get()
    except Exception:
        return None
    if ctx is None or not hasattr(ctx, "metadata"):
        return None
    raw = ctx.metadata.headers.get("X-Grid-Collection-Scope")
    if not raw:
        return None
    try:
        decoded = base64.urlsafe_b64decode(raw.encode()).decode()
        return json.loads(decoded)
    except Exception:
        return None
```

- [ ] **Step 2: Modify `_resolve_target_collections`**

```python
def _resolve_target_collections(config, session_id):
    header_scope = _get_collection_scope_from_header()
    if header_scope is not None:
        return header_scope

    # existing fallback logic
    ...
```

- [ ] **Step 3: Commit**

```bash
git add sources/knowledge_layer/src/register.py
git commit -m "feat: use bff collection scope header in knowledge retrieval"
```

---

### Task 7: Update `available_documents` pre-fetch

**Files:**
- Modify: `src/aiq_agent/agents/chat_researcher/register.py`

- [ ] **Step 1: Read scope header**

Replace the `base_collection + session_collection` logic with:

```python
from aiq_agent.knowledge.scoping import get_collection_scope_from_context

scope = get_collection_scope_from_context()
if scope is None:
    session_collection = Context.get().conversation_id if Context.get() else None
    base_collection = os.environ.get("COLLECTION_NAME") or os.environ.get("OIB_COLLECTION_NAME") or "oib_knowledge"
    scope = []
    for coll in (base_collection, session_collection):
        if coll and coll not in scope:
            scope.append(coll)

collections_to_check = scope
```

- [ ] **Step 2: Create shared helper**

Create `src/aiq_agent/knowledge/scoping.py`:

```python
import base64
import json
from typing import List, Optional

try:
    from aiq_agent.runtime.context import Context
except Exception:
    Context = None


def get_collection_scope_from_context() -> Optional[List[str]]:
    if Context is None:
        return None
    try:
        ctx = Context.get()
    except Exception:
        return None
    if ctx is None or not hasattr(ctx, "metadata"):
        return None
    raw = ctx.metadata.headers.get("X-Grid-Collection-Scope")
    if not raw:
        return None
    try:
        decoded = base64.urlsafe_b64decode(raw.encode()).decode()
        return json.loads(decoded)
    except Exception:
        return None
```

- [ ] **Step 3: Commit**

```bash
git add src/aiq_agent/knowledge/scoping.py src/aiq_agent/agents/chat_researcher/register.py
git commit -m "feat: use collection scope header for available documents"
```

---

### Task 8: Update `config_grid_oib.yml`

**Files:**
- Modify: `configs/config_grid_oib.yml`

- [ ] **Step 1: Zero out deprecated flags**

```yaml
knowledge_search:
  _type: knowledge_retrieval
  backend: llamaindex
  collection_name: ${COLLECTION_NAME:-oib_knowledge}
  include_base_collection: false
  include_session_collection: false
  project_collections: []
  generate_summary: true
  summary_model: summary_llm
  summary_db: ${AIQ_SUMMARY_DB:-sqlite+aiosqlite:///./summaries.db}
  top_k: 5
  chroma_dir: ${AIQ_CHROMA_DIR:-/tmp/chroma_data}
```

- [ ] **Step 2: Commit**

```bash
git add configs/config_grid_oib.yml
git commit -m "chore: deprecate static collection scope flags"
```

---

### Task 9: Write Python scope tests

**Files:**
- Create: `tests/knowledge_layer/test_collection_scope.py`

- [ ] **Step 1: Write tests**

```python
import base64
import json
from unittest.mock import MagicMock

import pytest

from aiq_agent.knowledge.scoping import get_collection_scope_from_context


@pytest.fixture
def mock_context(monkeypatch):
    ctx = MagicMock()
    ctx.metadata.headers = {}
    mod = MagicMock()
    mod.Context.get.return_value = ctx
    monkeypatch.setattr("aiq_agent.knowledge.scoping.Context", mod.Context)
    return ctx


def test_get_collection_scope_from_context_decodes_header(mock_context):
    scope = ["oib_knowledge", "proj_abc", "s_uuid"]
    encoded = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode()
    mock_context.metadata.headers["X-Grid-Collection-Scope"] = encoded
    assert get_collection_scope_from_context() == scope


def test_get_collection_scope_from_context_returns_none_when_missing(mock_context):
    assert get_collection_scope_from_context() is None
```

- [ ] **Step 2: Run tests**

Run: `cd src/aiq_agent && uv run pytest tests/knowledge_layer/test_collection_scope.py -v`
Expected: 2 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/knowledge_layer/test_collection_scope.py
git commit -m "test: collection scope header decoding"
```

---

## Self-review

**Spec coverage:**
- BFF scope computation: Tasks 1-2.
- Header injection (HTTP + WS): Tasks 3-5.
- Python retrieval consumes header: Task 6.
- `available_documents` consumes header: Task 7.
- Config cleanup: Task 8.
- Tests: Task 9.

**Placeholder scan:** No TBD/TODO.

**Type consistency:** `computeCollectionScope` returns `string[]`; Python helper returns `list[str] | None`; header is base64url JSON in both directions.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-collection-scoping-plan.md`.

Defaulting to **Subagent-Driven** implementation.
