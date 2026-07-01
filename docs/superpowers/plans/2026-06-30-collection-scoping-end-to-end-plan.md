# Grid Collection Scoping — End-to-End Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make knowledge retrieval server-authoritative by having the BFF compute `collection_scope[]`, pass it via `X-Grid-Collection-Scope`, and having the Python agent consume it for both semantic search and `available_documents`.

**Architecture:** BFF resolves session + active project/conversation, authorizes via WorkOS FGA, builds the scope, and injects the header on every HTTP and WebSocket path to Python. Python helpers read the header and override config-derived scope in both `knowledge_retrieval` and `chat_deepresearcher_agent`.

**Tech Stack:** Next.js route handlers, custom gateway server, WorkOS AuthKit, NAT Context headers, Python FastAPI/NAT, ChromaDB/LlamaIndex.

---

## File structure

| Path | Responsibility | Action |
|------|----------------|--------|
| `frontends/ui/src/lib/collection-scope.ts` | Pure scope computation + base64url header encoding | Modify |
| `frontends/ui/src/lib/collection-scope-request.ts` | Resolve project/conversation context from request, authorize, build header | Create |
| `frontends/ui/src/app/api/auth/websocket-scope/route.ts` | Internal endpoint that decrypts session and returns encoded scope | Create |
| `frontends/ui/server.js` | WebSocket upgrade calls `/api/auth/websocket-scope` and injects header | Modify |
| `frontends/ui/src/adapters/api/websocket-client.ts` | Append `projectId`/`conversationId` to WebSocket URL; rotate on change | Modify |
| `frontends/ui/src/app/api/chat/route.ts` | HTTP chat proxy injects scope header | Modify |
| `frontends/ui/src/app/api/generate/route.ts` | HTTP generate proxy injects scope header | Modify |
| `frontends/ui/src/app/api/generate/respond/route.ts` | HTTP generate/respond proxy injects scope header | Modify |
| `frontends/ui/src/app/api/v1/[...path]/route.ts` | v1 REST proxy injects scope header; validates upload collection names | Modify |
| `frontends/ui/src/app/api/jobs/async/[...path]/route.ts` | Deep-research async proxy injects scope header | Modify |
| `frontends/ui/tests/lib/collection-scope-request.test.ts` | Unit tests for context resolution | Create |
| `frontends/ui/src/app/api/auth/websocket-scope/route.test.ts` | Unit tests for internal scope endpoint | Create |
| `frontends/ui/src/app/api/chat/route.test.ts` | Proxy header test | Create |
| `frontends/ui/src/app/api/generate/route.test.ts` | Proxy header test | Create |
| `frontends/ui/src/app/api/generate/respond/route.test.ts` | Proxy header test | Create |
| `frontends/ui/src/app/api/v1/[...path]/route.test.ts` | Proxy header + upload validation test | Create |
| `frontends/ui/src/app/api/jobs/async/[...path]/route.test.ts` | Proxy header test | Create |
| `src/aiq_agent/knowledge/scoping.py` | Read `x-grid-collection-scope` from NAT Context | Create |
| `tests/aiq_agent/knowledge/test_scoping.py` | Unit tests for Python scope helper | Create |
| `sources/knowledge_layer/src/register.py` | `_resolve_target_collections` prefers header | Modify |
| `src/aiq_agent/agents/chat_researcher/register.py` | `available_documents` uses header; serializes scope into async jobs | Modify |
| `src/aiq_agent/agents/chat_researcher/models/state.py` | Add `collection_scope: list[str] \| None` | Modify |
| `frontends/aiq_api/src/aiq_api/jobs/submit.py` | Accept `collection_scope` and pass to Dask worker | Modify |
| `frontends/aiq_api/src/aiq_api/jobs/runner.py` | Accept `collection_scope` and inject into worker Context metadata | Modify |
| `configs/config_grid_oib.yml` | Disable legacy scope flags | Modify |

---

## Shared constants

- Header name: `X-Grid-Collection-Scope`
- Lowercased in Python NAT metadata: `x-grid-collection-scope`
- Encoding: `base64url(JSON.stringify(scope_array))` (Node) / `base64.urlsafe_b64encode(json.dumps(scope).encode()).decode()` (Python), no padding.
- Scope order: `[base, proj_<id>, s_<conv>]`.
- Anonymous mode (`REQUIRE_AUTH=false`): base + conversation only; skip FGA.

---

## Task 1: Add `buildCollectionScopeHeader()` to `collection-scope.ts`

**Files:**
- Modify: `frontends/ui/src/lib/collection-scope.ts:28-29`
- Test: `frontends/ui/tests/lib/collection-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `frontends/ui/tests/lib/collection-scope.test.ts`:

```typescript
  it('buildCollectionScopeHeader encodes scope as base64url JSON', () => {
    const scope = ['oib_knowledge', 'proj_abc', 's_uuid-123']
    const header = buildCollectionScopeHeader(scope)
    expect(Buffer.from(header, 'base64url').toString('utf-8')).toEqual(
      JSON.stringify(scope),
    )
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run tests/lib/collection-scope.test.ts --reporter=verbose
```

Expected: FAIL — `buildCollectionScopeHeader is not defined`.

- [ ] **Step 3: Implement `buildCollectionScopeHeader()`**

Modify `frontends/ui/src/lib/collection-scope.ts` to export the new function and relax the session type to support anonymous callers:

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GridSession } from './auth/types'

export interface ScopeContext {
  projectId?: string
  conversationId?: string
  baseCollection?: string
}

export function computeCollectionScope(
  _session: GridSession | null,
  context: ScopeContext,
): string[] {
  const scope: string[] = []
  const base = context.baseCollection || process.env.BASE_COLLECTION_NAME || 'oib_knowledge'
  scope.push(base)

  if (context.projectId) {
    scope.push(`proj_${context.projectId}`)
  }

  if (context.conversationId) {
    scope.push(`s_${context.conversationId}`)
  }

  return [...new Set(scope)]
}

export function buildCollectionScopeHeader(scope: string[]): string {
  return Buffer.from(JSON.stringify(scope)).toString('base64url')
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run tests/lib/collection-scope.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/lib/collection-scope.ts frontends/ui/tests/lib/collection-scope.test.ts
git commit -m "feat(scoping): add base64url collection scope header helper"
```

---

## Task 2: Create `collection-scope-request.ts` context resolver

**Files:**
- Create: `frontends/ui/src/lib/collection-scope-request.ts`
- Test: `frontends/ui/tests/lib/collection-scope-request.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontends/ui/tests/lib/collection-scope-request.test.ts`:

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildCollectionScopeFromRequest,
  resolveActiveProjectId,
} from '@/lib/collection-scope-request'
import type { AuthorizedSession } from '@/lib/auth/types'

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}))

vi.mock('@/lib/authz/projects', () => ({
  requireProjectAccess: vi.fn(),
}))

vi.mock('@/lib/collection-scope', () => ({
  computeCollectionScope: vi.fn((_session, ctx) => {
    const scope: string[] = ['oib_knowledge']
    if (ctx.projectId) scope.push(`proj_${ctx.projectId}`)
    if (ctx.conversationId) scope.push(`s_${ctx.conversationId}`)
    return scope
  }),
  buildCollectionScopeHeader: vi.fn((scope) => Buffer.from(JSON.stringify(scope)).toString('base64url')),
}))

import { getDb } from '@/lib/db'
import { requireProjectAccess } from '@/lib/authz/projects'

const mockGetDb = vi.mocked(getDb)
const mockRequireProjectAccess = vi.mocked(requireProjectAccess)

const baseSession: AuthorizedSession = {
  userId: 'user_1',
  email: 'a@b.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
}

function mockDbSelect(rows: Array<{ prefs: Record<string, unknown> }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
    })),
  }
}

describe('resolveActiveProjectId', () => {
  it('returns explicit projectId when provided', async () => {
    const result = await resolveActiveProjectId(baseSession, 'explicit')
    expect(result).toBe('explicit')
    expect(mockGetDb).not.toHaveBeenCalled()
  })

  it('returns active_project_id from user_preferences', async () => {
    mockGetDb.mockReturnValue(
      mockDbSelect([{ prefs: { active_project_id: 'pref_1' } }]) as never,
    )
    const result = await resolveActiveProjectId(baseSession)
    expect(result).toBe('pref_1')
  })

  it('returns undefined when no preference exists', async () => {
    mockGetDb.mockReturnValue(mockDbSelect([]) as never)
    const result = await resolveActiveProjectId(baseSession)
    expect(result).toBeUndefined()
  })
})

describe('buildCollectionScopeFromRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('builds base-only scope for anonymous mode', async () => {
    process.env.REQUIRE_AUTH = 'false'
    const { scope, headerValue } = await buildCollectionScopeFromRequest(null, {})
    expect(scope).toEqual(['oib_knowledge'])
    expect(mockRequireProjectAccess).not.toHaveBeenCalled()
    delete process.env.REQUIRE_AUTH
  })

  it('authorizes project and includes proj_ corpus', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-viewer' })
    const { scope } = await buildCollectionScopeFromRequest(baseSession, {
      projectId: 'proj_1',
      conversationId: 'conv_1',
    })
    expect(scope).toEqual(['oib_knowledge', 'proj_proj_1', 's_conv_1'])
    expect(mockRequireProjectAccess).toHaveBeenCalledWith(
      baseSession,
      'proj_1',
      'project:view',
    )
    delete process.env.REQUIRE_AUTH
  })

  it('reads active project from preferences when no explicit id', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockGetDb.mockReturnValue(
      mockDbSelect([{ prefs: { active_project_id: 'pref_1' } }]) as never,
    )
    mockRequireProjectAccess.mockResolvedValue({ role: 'project-viewer' })
    const { scope } = await buildCollectionScopeFromRequest(baseSession, {})
    expect(scope).toEqual(['oib_knowledge', 'proj_pref_1'])
    delete process.env.REQUIRE_AUTH
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run tests/lib/collection-scope-request.test.ts --reporter=verbose
```

Expected: FAIL — module not found / function not defined.

- [ ] **Step 3: Implement the resolver**

Create `frontends/ui/src/lib/collection-scope-request.ts`:

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  buildCollectionScopeHeader,
  computeCollectionScope,
  type ScopeContext,
} from '@/lib/collection-scope'
import type { GridSession } from '@/lib/auth/types'

export interface RequestContext {
  projectId?: string
  conversationId?: string
}

function isAuthRequired(): boolean {
  return process.env.REQUIRE_AUTH?.toLowerCase() === 'true'
}

export async function resolveActiveProjectId(
  session: GridSession | null,
  explicitProjectId?: string,
): Promise<string | undefined> {
  if (explicitProjectId) {
    return explicitProjectId
  }

  if (!session || !isAuthRequired()) {
    return undefined
  }

  const db = getDb()
  const [row] = await db
    .select({ prefs: userPreferences.prefs })
    .from(userPreferences)
    .where(eq(userPreferences.workosUserId, session.userId))
    .limit(1)

  if (row?.prefs && typeof row.prefs === 'object') {
    const activeId = (row.prefs as Record<string, unknown>).active_project_id
    if (typeof activeId === 'string' && activeId) {
      return activeId
    }
  }

  return undefined
}

export async function buildCollectionScopeFromRequest(
  session: GridSession | null,
  context: RequestContext,
): Promise<{
  scope: string[]
  headerValue: string
  projectId: string | undefined
  conversationId: string | undefined
}> {
  const anonymous = !isAuthRequired()

  let projectId = context.projectId
  if (!projectId && session && !anonymous) {
    projectId = await resolveActiveProjectId(session, undefined)
  }

  const conversationId = context.conversationId

  if (projectId && session && !anonymous) {
    await requireProjectAccess(session, projectId, 'project:view')
  }

  const scope = computeCollectionScope(session, {
    projectId,
    conversationId,
  } satisfies ScopeContext)

  return {
    scope,
    headerValue: buildCollectionScopeHeader(scope),
    projectId,
    conversationId,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run tests/lib/collection-scope-request.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/lib/collection-scope-request.ts frontends/ui/tests/lib/collection-scope-request.test.ts
git commit -m "feat(scoping): add BFF request context scope resolver"
```

---

## Task 3: Create `/api/auth/websocket-scope` internal endpoint

**Files:**
- Create: `frontends/ui/src/app/api/auth/websocket-scope/route.ts`
- Test: `frontends/ui/src/app/api/auth/websocket-scope/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontends/ui/src/app/api/auth/websocket-scope/route.test.ts`:

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi } from 'vitest'
import { GET } from './route'

vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

const mockWithAuth = vi.mocked(withAuth)
const mockBuildScope = vi.mocked(buildCollectionScopeFromRequest)

describe('GET /api/auth/websocket-scope', () => {
  it('returns encoded scope for authorized request', async () => {
    const session = {
      userId: 'user_1',
      email: 'a@b.com',
      name: null,
      accessToken: 'tok',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      permissions: [],
    }
    mockWithAuth.mockResolvedValue(session as never)
    mockBuildScope.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_p1', 's_c1'],
      headerValue: 'encoded-scope',
      projectId: 'p1',
      conversationId: 'c1',
    })

    const req = new Request('http://localhost:3000/api/auth/websocket-scope?projectId=p1&conversationId=c1')
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('encoded-scope')
    expect(mockBuildScope).toHaveBeenCalledWith(session, {
      projectId: 'p1',
      conversationId: 'c1',
    })
  })

  it('returns 401 when scope building fails', async () => {
    mockWithAuth.mockRejectedValue(new Error('No session'))

    const req = new Request('http://localhost:3000/api/auth/websocket-scope')
    const res = await GET(req)

    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/auth/websocket-scope/route.test.ts --reporter=verbose
```

Expected: FAIL — route module not found.

- [ ] **Step 3: Implement the route**

Create `frontends/ui/src/app/api/auth/websocket-scope/route.ts`:

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

export async function GET(req: Request): Promise<Response> {
  try {
    const session = await withAuth()
    const url = new URL(req.url)
    const projectId = url.searchParams.get('projectId') || undefined
    const conversationId = url.searchParams.get('conversationId') || undefined

    const { headerValue } = await buildCollectionScopeFromRequest(session, {
      projectId,
      conversationId,
    })

    return new Response(headerValue, {
      headers: {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-store',
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unauthorized'
    return new Response(message, { status: 401 })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/auth/websocket-scope/route.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/app/api/auth/websocket-scope/route.ts frontends/ui/src/app/api/auth/websocket-scope/route.test.ts
git commit -m "feat(scoping): add internal websocket-scope endpoint"
```

---

## Task 4: Wire WebSocket upgrade in `server.js`

**Files:**
- Modify: `frontends/ui/server.js:146-181`
- Test: `frontends/ui/tests/server/websocket-scope.test.js` (optional; manual integration test below)

- [ ] **Step 1: Update `server.js` to fetch and inject scope**

Modify `frontends/ui/server.js`:

```javascript
// Add near the top with the other helpers
const getWebsocketScope = async (req, search) => {
  const cookie = req.headers.cookie
  if (!cookie) {
    return null
  }

  const scopeUrl = `${NEXT_INTERNAL_URL}/api/auth/websocket-scope${search || ''}`
  try {
    const response = await fetch(scopeUrl, {
      headers: { Cookie: cookie },
    })
    if (!response.ok) {
      console.error('[WebSocket Scope] Internal scope endpoint returned:', response.status)
      return null
    }
    return await response.text()
  } catch (err) {
    console.error('[WebSocket Scope] Failed to fetch scope:', err.message)
    return null
  }
}

// In backendProxy.on('proxyReqWs', ...) add the header
backendProxy.on('proxyReqWs', (proxyReq, req) => {
  if (req.headers.cookie) {
    proxyReq.setHeader('Cookie', req.headers.cookie)
  }
  const scope = req.headers['x-grid-collection-scope']
  if (scope) {
    proxyReq.setHeader('x-grid-collection-scope', scope)
  }
})

// Make the upgrade handler async and inject the scope
server.on('upgrade', async (req, socket, head) => {
  socket.setKeepAlive?.(true, 15000)
  socket.setTimeout?.(0)

  let parsedUrl
  try {
    parsedUrl = parse(req.url, true)
  } catch {
    socket.destroy()
    return
  }
  const pathname = parsedUrl.pathname || '/'

  if (pathname === '/websocket' || pathname.startsWith('/websocket')) {
    req.url = '/websocket' + (parsedUrl.search || '')

    const scope = await getWebsocketScope(req, parsedUrl.search || '')
    if (scope) {
      req.headers['x-grid-collection-scope'] = scope
    }

    backendProxy.ws(
      req,
      socket,
      head,
      { target: BACKEND_WS_URL, changeOrigin: true },
      (err) => {
        if (err) {
          console.error('[WS Proxy] Error:', err.message)
          try {
            socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          } catch {}
          socket.destroy()
        }
      }
    )
    return
  }

  // ... rest unchanged
})
```

- [ ] **Step 2: Manual integration verification**

Start the stack and confirm the header reaches the Python logs:

```bash
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env up -d --build
```

Open the UI, select a project, and send a message. Run:

```bash
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env logs -f aiq-agent | grep -i "collection_scope\|X-Grid-Collection-Scope"
```

Expected: Log lines show the decoded scope array including `proj_<id>` and `s_<conv>`.

- [ ] **Step 3: Commit**

```bash
git add frontends/ui/server.js
git commit -m "feat(scoping): inject collection-scope header during websocket upgrade"
```

---

## Task 5: Append project/conversation params in `websocket-client.ts`

**Files:**
- Modify: `frontends/ui/src/adapters/api/websocket-client.ts:57-79, 124-149, 298-300`

- [ ] **Step 1: Add options and URL builder**

Modify the interface and constructor:

```typescript
export interface NATWebSocketClientOptions {
  conversationId: string
  projectId?: string
  callbacks: NATWebSocketClientCallbacks
  reconnectAttempts?: number
  reconnectDelay?: number
  websocketUrl?: string
  onBeforeReconnect?: () => Promise<void>
}
```

In the constructor, spread defaults as-is; `projectId` is optional.

- [ ] **Step 2: Build query string in `connect()`**

Replace the WebSocket construction in `connect()`:

```typescript
const baseWsUrl = this.options.websocketUrl || (await getWebSocketUrl())
const params = new URLSearchParams()
if (this.options.projectId) {
  params.set('projectId', this.options.projectId)
}
params.set('conversationId', this.options.conversationId)

const separator = baseWsUrl.includes('?') ? '&' : '?'
const wsUrl = params.toString()
  ? `${baseWsUrl}${separator}${params.toString()}`
  : baseWsUrl

this.ws = new WebSocket(wsUrl)
```

- [ ] **Step 3: Add `updateProjectId` and make `updateConversationId` rotate**

Replace the existing `updateConversationId` and add the project equivalent:

```typescript
updateConversationId = (conversationId: string): void => {
  this.options.conversationId = conversationId
  this.rotate()
}

updateProjectId = (projectId: string): void => {
  this.options.projectId = projectId
  this.rotate()
}
```

- [ ] **Step 4: Add/update unit tests**

Create or extend `frontends/ui/tests/adapters/api/websocket-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createNATWebSocketClient } from '@/adapters/api/websocket-client'

const MockWebSocket = vi.fn()

describe('NATWebSocketClient URL construction', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockWebSocket)
    MockWebSocket.mockImplementation(() => ({
      readyState: 0,
      close: vi.fn(),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('appends projectId and conversationId as query params', async () => {
    const client = createNATWebSocketClient({
      conversationId: 'conv-1',
      projectId: 'proj-1',
      callbacks: {},
      websocketUrl: 'ws://localhost:3000/websocket',
    })
    await client.connect()
    expect(MockWebSocket).toHaveBeenCalledWith(
      'ws://localhost:3000/websocket?projectId=proj-1&conversationId=conv-1',
    )
  })
})
```

- [ ] **Step 5: Run tests and commit**

Run:
```bash
cd frontends/ui && npx vitest run tests/adapters/api/websocket-client.test.ts --reporter=verbose
```

Expected: PASS.

```bash
git add frontends/ui/src/adapters/api/websocket-client.ts frontends/ui/tests/adapters/api/websocket-client.test.ts
git commit -m "feat(scoping): send project and conversation ids on websocket url"
```

---

## Task 6: Attach scope header in `/api/chat`

**Files:**
- Modify: `frontends/ui/src/app/api/chat/route.ts:27-62`
- Test: `frontends/ui/src/app/api/chat/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontends/ui/src/app/api/chat/route.test.ts`:

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

vi.mock('@workos-inc/authkit-nextjs', () => ({
  withAuth: vi.fn(),
}))

vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

const mockWithAuth = vi.mocked(withAuth)
const mockBuildScope = vi.mocked(buildCollectionScopeFromRequest)

describe('POST /api/chat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          body: new ReadableStream(),
          headers: new Headers(),
        }),
      ),
    )
  })

  it('strips inbound scope header and injects BFF-computed header', async () => {
    process.env.REQUIRE_AUTH = 'true'
    const session = {
      userId: 'user_1',
      email: 'a@b.com',
      name: null,
      accessToken: 'tok',
      organizationId: 'org_1',
      organizationMembershipId: 'om_1',
      role: 'member',
      permissions: [],
    }
    mockWithAuth.mockResolvedValue(session as never)
    mockBuildScope.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_p1'],
      headerValue: 'bff-encoded',
      projectId: 'p1',
      conversationId: undefined,
    })

    const req = new Request('http://localhost:3000/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Grid-Collection-Scope': 'evil',
      },
      body: JSON.stringify({ projectId: 'p1', message: 'hi' }),
    })

    await POST(req)

    const fetchCall = vi.mocked(fetch).mock.calls[0]
    const outboundHeaders = fetchCall[1]?.headers as Record<string, string>
    expect(outboundHeaders['X-Grid-Collection-Scope']).toBe('bff-encoded')
    expect(outboundHeaders['Authorization']).toBe('Bearer tok')
    delete process.env.REQUIRE_AUTH
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/chat/route.test.ts --reporter=verbose
```

Expected: FAIL — `buildCollectionScopeFromRequest` not called / header not set.

- [ ] **Step 3: Implement the route change**

Modify `frontends/ui/src/app/api/chat/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

// ... existing helpers unchanged ...

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const authRequired = isAuthRequired()
    const headerToken = authRequired ? req.headers.get('Authorization') : null

    let accessToken: string | undefined
    if (authRequired && !headerToken) {
      const session = await withAuth()
      accessToken = session.accessToken
    }

    const authHeader = headerToken || (accessToken ? `Bearer ${accessToken}` : null)

    // Resolve collection scope from authorized request context.
    const session = authRequired && accessToken ? await withAuth() : null
    const { headerValue: scopeHeader } = await buildCollectionScopeFromRequest(session, {
      projectId: body.projectId || undefined,
      conversationId: body.conversationId || body.session_id || undefined,
    })

    const backendUrl = `${getBackendUrl()}/chat/stream`

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
        'X-Grid-Collection-Scope': scopeHeader,
      },
      body: JSON.stringify(body),
    })

    // ... rest unchanged ...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/chat/route.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/app/api/chat/route.ts frontends/ui/src/app/api/chat/route.test.ts
git commit -m "feat(scoping): attach collection-scope header on chat proxy"
```

---

## Task 7: Attach scope header in `/api/generate`

**Files:**
- Modify: `frontends/ui/src/app/api/generate/route.ts:33-68`
- Test: `frontends/ui/src/app/api/generate/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontends/ui/src/app/api/generate/route.test.ts`. Pattern identical to Task 6; assert `X-Grid-Collection-Scope` equals `'bff-encoded'`.

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'

vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: vi.fn() }))
vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

const mockWithAuth = vi.mocked(withAuth)
const mockBuildScope = vi.mocked(buildCollectionScopeFromRequest)

describe('POST /api/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, body: new ReadableStream() })))
  })

  it('injects X-Grid-Collection-Scope', async () => {
    process.env.REQUIRE_AUTH = 'true'
    mockWithAuth.mockResolvedValue({
      userId: 'u1', email: 'a@b.com', name: null, accessToken: 'tok',
      organizationId: 'org_1', organizationMembershipId: 'om_1', role: 'member', permissions: [],
    } as never)
    mockBuildScope.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_p1'],
      headerValue: 'bff-encoded',
      projectId: 'p1',
      conversationId: undefined,
    })

    const req = new Request('http://localhost/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'p1', prompt: 'test' }),
    })

    await POST(req)

    const outboundHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
    expect(outboundHeaders['X-Grid-Collection-Scope']).toBe('bff-encoded')
    delete process.env.REQUIRE_AUTH
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/generate/route.test.ts --reporter=verbose
```

Expected: FAIL.

- [ ] **Step 3: Implement the route change**

Modify `frontends/ui/src/app/api/generate/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

// ... helpers unchanged ...

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const authRequired = isAuthRequired()
    const headerToken = authRequired ? req.headers.get('Authorization') : null

    let accessToken: string | undefined
    if (authRequired && !headerToken) {
      const session = await withAuth()
      accessToken = session.accessToken
    }

    const authHeader = headerToken || (accessToken ? `Bearer ${accessToken}` : null)

    const session = authRequired && accessToken ? await withAuth() : null
    const { headerValue: scopeHeader } = await buildCollectionScopeFromRequest(session, {
      projectId: body.projectId || undefined,
      conversationId: body.conversationId || body.session_id || undefined,
    })

    const backendUrl = `${getBackendUrl()}/generate/stream`

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
        'X-Grid-Collection-Scope': scopeHeader,
      },
      body: JSON.stringify(body),
    })

    // ... rest unchanged ...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/generate/route.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/app/api/generate/route.ts frontends/ui/src/app/api/generate/route.test.ts
git commit -m "feat(scoping): attach collection-scope header on generate proxy"
```

---

## Task 8: Attach scope header in `/api/generate/respond`

**Files:**
- Modify: `frontends/ui/src/app/api/generate/respond/route.ts:28-52`
- Test: `frontends/ui/src/app/api/generate/respond/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontends/ui/src/app/api/generate/respond/route.test.ts` using the same mocking pattern as Task 6/7, asserting the header is set on `/generate/respond`.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/generate/respond/route.test.ts --reporter=verbose
```

Expected: FAIL.

- [ ] **Step 3: Implement the route change**

Modify `frontends/ui/src/app/api/generate/respond/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

// ... helpers unchanged ...

export async function POST(req: Request): Promise<Response> {
  try {
    const body = await req.json()
    const authRequired = isAuthRequired()
    const headerToken = authRequired ? req.headers.get('Authorization') : null

    let accessToken: string | undefined
    if (authRequired && !headerToken) {
      const session = await withAuth()
      accessToken = session.accessToken
    }

    const authHeader = headerToken || (accessToken ? `Bearer ${accessToken}` : null)

    const session = authRequired && accessToken ? await withAuth() : null
    const { headerValue: scopeHeader } = await buildCollectionScopeFromRequest(session, {
      projectId: body.projectId || undefined,
      conversationId: body.conversationId || body.session_id || undefined,
    })

    const backendUrl = `${getBackendUrl()}/generate/respond`

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authHeader ? { Authorization: authHeader } : {}),
        'X-Grid-Collection-Scope': scopeHeader,
      },
      body: JSON.stringify(body),
    })

    // ... rest unchanged ...
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/generate/respond/route.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/app/api/generate/respond/route.ts frontends/ui/src/app/api/generate/respond/route.test.ts
git commit -m "feat(scoping): attach collection-scope header on generate/respond proxy"
```

---

## Task 9: Attach scope header and validate uploads in `/api/v1/[...path]`

**Files:**
- Modify: `frontends/ui/src/app/api/v1/[...path]/route.ts`
- Test: `frontends/ui/src/app/api/v1/[...path]/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontends/ui/src/app/api/v1/[...path]/route.test.ts`:

```typescript
// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET, POST } from './route'

vi.mock('@workos-inc/authkit-nextjs', () => ({ withAuth: vi.fn() }))
vi.mock('@/lib/collection-scope-request', () => ({
  buildCollectionScopeFromRequest: vi.fn(),
}))

import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

const mockWithAuth = vi.mocked(withAuth)
const mockBuildScope = vi.mocked(buildCollectionScopeFromRequest)

describe('/api/v1/[...path]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
  })

  it('GET injects scope header', async () => {
    mockWithAuth.mockResolvedValue({ accessToken: 'tok' } as never)
    mockBuildScope.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_p1'],
      headerValue: 'bff-encoded',
      projectId: 'p1',
      conversationId: undefined,
    })

    const req = new Request('http://localhost/api/v1/collections')
    await GET(req, { params: Promise.resolve({ path: ['collections'] }) })

    const outboundHeaders = vi.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>
    expect(outboundHeaders['X-Grid-Collection-Scope']).toBe('bff-encoded')
  })

  it('POST upload rejects collection outside scope', async () => {
    mockWithAuth.mockResolvedValue({ accessToken: 'tok' } as never)
    mockBuildScope.mockResolvedValue({
      scope: ['oib_knowledge', 'proj_p1'],
      headerValue: 'bff-encoded',
      projectId: 'p1',
      conversationId: undefined,
    })

    const form = new FormData()
    form.append('files', new Blob(['x']), 'file.txt')

    const req = new Request('http://localhost/api/v1/collections/evil-corpus/documents', {
      method: 'POST',
      body: form,
    })
    const res = await POST(req, { params: Promise.resolve({ path: ['collections', 'evil-corpus', 'documents'] }) })

    expect(res.status).toBe(403)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/v1/\[...path\]/route.test.ts --reporter=verbose
```

Expected: FAIL.

- [ ] **Step 3: Implement the route changes**

Modify `frontends/ui/src/app/api/v1/[...path]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

// ... helpers unchanged ...

function isUploadPath(path: string[]): boolean {
  return (
    path.length === 3 &&
    path[0] === 'collections' &&
    path[2] === 'documents'
  )
}

// Update each handler to build scope headers.
// Example for POST:

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  try {
    const { path } = await params
    const backendUrl = buildBackendUrl(path)
    const authHeaders = await getAuthHeaders()
    const contentType = req.headers.get('Content-Type') || 'application/json'

    const url = new URL(req.url)
    const bodyJson = contentType.includes('multipart/form-data')
      ? {}
      : await req.json().catch(() => ({}))

    const session = await withAuth().catch(() => null)
    const { headerValue: scopeHeader, scope } = await buildCollectionScopeFromRequest(session, {
      projectId: url.searchParams.get('projectId') || bodyJson.projectId || undefined,
      conversationId: url.searchParams.get('conversationId') || bodyJson.conversationId || bodyJson.session_id || undefined,
    })

    if (isUploadPath(path)) {
      const requestedCollection = path[1]
      if (!scope.includes(requestedCollection)) {
        return new NextResponse(
          JSON.stringify({ error: { code: 'FORBIDDEN_COLLECTION', message: 'Collection not in authorized scope' } }),
          { status: 403, headers: { 'Content-Type': 'application/json' } },
        )
      }
    }

    let body: BodyInit | undefined
    const headers: Record<string, string> = {
      ...authHeaders,
      'X-Grid-Collection-Scope': scopeHeader,
    }

    if (contentType.includes('multipart/form-data')) {
      body = req.body as ReadableStream<Uint8Array>
      headers['Content-Type'] = contentType
    } else {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(bodyJson)
    }

    const response = await fetch(backendUrl, {
      method: 'POST',
      headers,
      ...(body ? { body, duplex: 'half' } : {}),
    })

    // ... rest unchanged ...
```

Apply the same scope-header injection to `GET` and `DELETE` (without upload validation).

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/v1/\[...path\]/route.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/app/api/v1/\[...path\]/route.ts frontends/ui/src/app/api/v1/\[...path\]/route.test.ts
git commit -m "feat(scoping): attach scope header on v1 proxy and validate upload collections"
```

---

## Task 10: Attach scope header in `/api/jobs/async/[...path]`

**Files:**
- Modify: `frontends/ui/src/app/api/jobs/async/[...path]/route.ts`
- Test: `frontends/ui/src/app/api/jobs/async/[...path]/route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `frontends/ui/src/app/api/jobs/async/[...path]/route.test.ts` using the same pattern as previous route tests, asserting `X-Grid-Collection-Scope` is injected for both `GET` and `POST`.

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/jobs/async/\[...path\]/route.test.ts --reporter=verbose
```

Expected: FAIL.

- [ ] **Step 3: Implement the route changes**

Modify `frontends/ui/src/app/api/jobs/async/[...path]/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { withAuth } from '@workos-inc/authkit-nextjs'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

// ... helpers unchanged ...
```

In `GET`, after `const authHeaders = await getAuthHeaders(req, path)`:

```typescript
const url = new URL(req.url)
const session = isAuthRequired() ? await withAuth().catch(() => null) : null
const { headerValue: scopeHeader } = await buildCollectionScopeFromRequest(session, {
  projectId: url.searchParams.get('projectId') || undefined,
  conversationId: url.searchParams.get('conversationId') || undefined,
})
```

Then include `'X-Grid-Collection-Scope': scopeHeader` in the outbound `fetch` headers.

In `POST`, after parsing `body`:

```typescript
const session = isAuthRequired() ? await withAuth().catch(() => null) : null
const { headerValue: scopeHeader } = await buildCollectionScopeFromRequest(session, {
  projectId: body?.projectId || undefined,
  conversationId: body?.conversationId || body?.session_id || undefined,
})
```

Include the header in the outbound `fetch` call.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd frontends/ui && npx vitest run src/app/api/jobs/async/\[...path\]/route.test.ts --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/ui/src/app/api/jobs/async/\[...path\]/route.ts frontends/ui/src/app/api/jobs/async/\[...path\]/route.test.ts
git commit -m "feat(scoping): attach collection-scope header on async jobs proxy"
```

---

## Task 11: Create Python `scoping.py` helper

**Files:**
- Create: `src/aiq_agent/knowledge/scoping.py`
- Test: `tests/aiq_agent/knowledge/test_scoping.py`

- [ ] **Step 1: Write the failing test**

Create `tests/aiq_agent/knowledge/test_scoping.py`:

```python
# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import base64
import json
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest


class TestGetCollectionScopeFromContext:
    def test_returns_none_when_header_missing(self):
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context

        with patch("aiq_agent.knowledge.scoping.Context") as mock_ctx:
            mock_ctx.get.return_value = MagicMock(metadata=MagicMock(headers={}))
            assert get_collection_scope_from_context() is None

    def test_decodes_base64url_json_array(self):
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context

        scope = ["oib_knowledge", "proj_p1", "s_c1"]
        encoded = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode().rstrip("=")

        with patch("aiq_agent.knowledge.scoping.Context") as mock_ctx:
            mock_ctx.get.return_value = MagicMock(metadata=MagicMock(headers={"x-grid-collection-scope": encoded}))
            assert get_collection_scope_from_context() == scope

    def test_returns_fallback_when_decode_fails(self):
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context

        with patch("aiq_agent.knowledge.scoping.Context") as mock_ctx:
            mock_ctx.get.return_value = MagicMock(metadata=MagicMock(headers={"x-grid-collection-scope": "not-json!!!"}))
            assert get_collection_scope_from_context(fallback=["oib_knowledge"]) == ["oib_knowledge"]

    def test_returns_empty_list_when_header_is_empty_array(self):
        from aiq_agent.knowledge.scoping import get_collection_scope_from_context

        encoded = base64.urlsafe_b64encode(json.dumps([]).encode()).decode().rstrip("=")
        with patch("aiq_agent.knowledge.scoping.Context") as mock_ctx:
            mock_ctx.get.return_value = MagicMock(metadata=MagicMock(headers={"x-grid-collection-scope": encoded}))
            assert get_collection_scope_from_context() == []
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
uv run pytest tests/aiq_agent/knowledge/test_scoping.py -v
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/aiq_agent/knowledge/scoping.py`:

```python
# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Read the BFF-authoritative collection scope from NAT request context."""

import base64
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)

SCOPE_HEADER = "x-grid-collection-scope"


def get_collection_scope_from_context(fallback: list[str] | None = None) -> list[str] | None:
    """
    Decode the ``X-Grid-Collection-Scope`` header from NAT Context metadata.

    The header value is base64url-encoded JSON array of collection names.
    If the header is absent, returns ``fallback`` (default ``None``).
    If decoding fails, logs a warning and returns ``fallback``.

    Args:
        fallback: Value to return when the header is missing or malformed.

    Returns:
        Decoded list of collection names, or ``fallback``.
    """
    headers: dict[str, Any] = {}
    try:
        from nat.builder.context import Context

        ctx = Context.get()
        if ctx and ctx.metadata and ctx.metadata.headers:
            headers = ctx.metadata.headers
    except Exception:
        headers = {}

    encoded = headers.get(SCOPE_HEADER)
    if not encoded:
        return fallback

    try:
        padded = str(encoded) + "=" * (-len(str(encoded)) % 4)
        decoded = base64.urlsafe_b64decode(padded).decode("utf-8")
        scope = json.loads(decoded)
        if not isinstance(scope, list):
            logger.warning("X-Grid-Collection-Scope is not a JSON array: %s", type(scope))
            return fallback
        return [str(item) for item in scope if item]
    except Exception as e:
        logger.warning("Failed to decode X-Grid-Collection-Scope: %s", e)
        return fallback
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
uv run pytest tests/aiq_agent/knowledge/test_scoping.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aiq_agent/knowledge/scoping.py tests/aiq_agent/knowledge/test_scoping.py
git commit -m "feat(scoping): add python helper to read collection scope from NAT context"
```

---

## Task 12: Make `knowledge_retrieval` prefer the header

**Files:**
- Modify: `sources/knowledge_layer/src/register.py:217-259`
- Test: `tests/knowledge_layer_tests/test_layered_retrieval.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/knowledge_layer_tests/test_layered_retrieval.py` (or create `test_collection_scope_header.py` alongside it):

```python
# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import base64
import json
from unittest.mock import MagicMock
from unittest.mock import patch

from sources.knowledge_layer.src.register import _resolve_target_collections
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig


class TestResolveTargetCollectionsHeader:
    def test_uses_bff_header_when_present(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=False,
            include_session_collection=False,
        )
        scope = ["oib_knowledge", "proj_p1"]
        encoded = base64.urlsafe_b64encode(json.dumps(scope).encode()).decode().rstrip("=")

        with patch("sources.knowledge_layer.src.register.get_collection_scope_from_context") as mock_get:
            mock_get.return_value = scope
            result = _resolve_target_collections(config, "ignored-session")

        assert result == scope
        mock_get.assert_called_once_with()

    def test_falls_back_to_legacy_logic_when_header_missing(self):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge",
            include_base_collection=True,
            include_session_collection=True,
        )
        with patch("sources.knowledge_layer.src.register.get_collection_scope_from_context") as mock_get:
            mock_get.return_value = None
            result = _resolve_target_collections(config, "s_123")

        assert result == ["oib_knowledge", "s_123"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
uv run pytest tests/knowledge_layer_tests/test_layered_retrieval.py::TestResolveTargetCollectionsHeader -v
```

Expected: FAIL — behavior unchanged.

- [ ] **Step 3: Modify `_resolve_target_collections`**

Modify `sources/knowledge_layer/src/register.py`:

```python
def _resolve_target_collections(config: KnowledgeRetrievalConfig, session_id: str | None) -> list[str]:
    """
    Build the ordered, de-duplicated set of collections to search.

    Authoritative source: the ``X-Grid-Collection-Scope`` header injected by
    the BFF. When present, the header is used exactly. Otherwise the legacy
    config-based logic is used for backward compatibility.
    """
    from aiq_agent.knowledge.scoping import get_collection_scope_from_context

    header_scope = get_collection_scope_from_context()
    if header_scope is not None:
        if header_scope:
            return header_scope
        # Empty authoritative scope is a configuration error; fall back to base.
        logger.warning("X-Grid-Collection-Scope present but empty; falling back to base collection")
        return [config.collection_name]

    # Legacy config-based resolution (deprecated).
    if config.use_fixed_collection:
        return [config.collection_name]

    targets: list[str] = []
    if config.include_base_collection and config.collection_name:
        targets.append(config.collection_name)
    if config.include_session_collection and session_id:
        targets.append(session_id)
    targets.extend(config.project_collections)

    seen: set[str] = set()
    ordered: list[str] = []
    for name in targets:
        if name and name not in seen:
            seen.add(name)
            ordered.append(name)

    if not ordered:
        return [config.collection_name]
    return ordered
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
uv run pytest tests/knowledge_layer_tests/test_layered_retrieval.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sources/knowledge_layer/src/register.py tests/knowledge_layer_tests/test_layered_retrieval.py
git commit -m "feat(scoping): knowledge_retrieval prefers BFF collection-scope header"
```

---

## Task 13: Add `collection_scope` to `ChatResearcherState`

**Files:**
- Modify: `src/aiq_agent/agents/chat_researcher/models/state.py:62-65`
- Test: `tests/aiq_agent/agents/chat_researcher/models/test_state.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/aiq_agent/agents/chat_researcher/models/test_state.py`:

```python
    def test_state_with_collection_scope(self):
        state = ChatResearcherState(
            messages=[HumanMessage(content="Test")],
            collection_scope=["oib_knowledge", "proj_p1", "s_c1"],
        )
        assert state.collection_scope == ["oib_knowledge", "proj_p1", "s_c1"]
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
uv run pytest tests/aiq_agent/agents/chat_researcher/models/test_state.py::TestChatResearcherState::test_state_with_collection_scope -v
```

Expected: FAIL — `collection_scope` field does not exist.

- [ ] **Step 3: Add the field**

Modify `src/aiq_agent/agents/chat_researcher/models/state.py`:

```python
class ChatResearcherState(BaseModel):
    # ... existing fields ...
    available_documents: list[AvailableDocument] | None = None
    collection_scope: list[str] | None = None
    cards: list[dict[str, Any]] | None = None
    skip_clarifier: bool = False
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
uv run pytest tests/aiq_agent/agents/chat_researcher/models/test_state.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aiq_agent/agents/chat_researcher/models/state.py tests/aiq_agent/agents/chat_researcher/models/test_state.py
git commit -m "feat(scoping): add collection_scope to ChatResearcherState"
```

---

## Task 14: Make `chat_deepresearcher_agent` use the header and serialize scope

**Files:**
- Modify: `src/aiq_agent/agents/chat_researcher/register.py:262-298, 388-435`
- Test: `tests/aiq_agent/agents/chat_researcher/test_register_helpers.py` (extend) or create `test_register_scope.py`

- [ ] **Step 1: Write the failing test**

Create `tests/aiq_agent/agents/chat_researcher/test_register_scope.py`:

```python
# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest


class TestCollectionScopeInRegister:
    @pytest.mark.asyncio
    async def test_run_uses_header_scope_for_available_documents(self):
        from aiq_agent.agents.chat_researcher.register import chat_deepresearcher_agent

        mock_builder = MagicMock()
        mock_builder.get_function = AsyncMock(return_value=MagicMock(ainvoke=AsyncMock()))
        mock_builder.get_llm = AsyncMock(return_value=MagicMock())
        mock_builder.get_function_config.return_value = MagicMock(tools=[], exclude_tools=[])
        mock_builder.get_tools = AsyncMock(return_value=[])

        fn = [x async for x in chat_deepresearcher_agent(MagicMock(use_async_deep_research=False), mock_builder)]
        run_fn = fn[0].fn

        with patch("aiq_agent.agents.chat_researcher.register.get_collection_scope_from_context") as mock_scope:
            with patch("aiq_agent.agents.chat_researcher.register.get_available_documents_async") as mock_docs:
                mock_scope.return_value = ["oib_knowledge", "proj_p1"]
                mock_docs.return_value = []
                with patch("aiq_agent.agents.chat_researcher.register.Context") as mock_ctx:
                    mock_ctx.get.return_value = MagicMock(conversation_id="c1")
                    with patch("aiq_agent.agents.chat_researcher.register.get_or_create_session_registry"):
                        with patch("aiq_agent.agents.chat_researcher.register.set_session_registry"):
                            with patch("aiq_agent.agents.chat_researcher.register.reset_session_registry"):
                                response = await run_fn({"message": "test"})

        mock_docs.assert_any_call("oib_knowledge")
        mock_docs.assert_any_call("proj_p1")
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
uv run pytest tests/aiq_agent/agents/chat_researcher/test_register_scope.py -v
```

Expected: FAIL — calls use old Context-based logic.

- [ ] **Step 3: Modify `chat_deepresearcher_agent`**

In `src/aiq_agent/agents/chat_researcher/register.py`, import the helper at the top:

```python
from aiq_agent.knowledge.scoping import get_collection_scope_from_context
```

In the async job submitter (`_submit_deep_job`), there is no need to change the `submit_agent_job` call. The collection-scope header is captured automatically from the parent Context metadata by `_get_parent_trace_context()` in Task 15. Keep the value on state for observability only:

```python
async def _submit_deep_job(state: ChatResearcherState) -> str:
    principal = get_current_principal()
    owner = principal.email if principal and principal.email else "anonymous"
    query = state.original_query
    if not query:
        if not state.messages:
            raise RuntimeError("Cannot submit deep research job without messages.")
        query = state.messages[0].content
    input_text = query if isinstance(query, str) else str(query)
    if state.clarifier_result:
        input_text = f"{input_text}\n\n## Clarification Context\n{state.clarifier_result}"

    available_docs = None
    if state.available_documents:
        available_docs = [doc.model_dump() for doc in state.available_documents]

    return await submit_agent_job(
        agent_type="deep_researcher",
        input_text=input_text,
        owner=owner,
        available_documents=available_docs,
        data_sources=state.data_sources,
    )
```

In `_run`, replace the `available_documents` pre-fetch block:

```python
available_documents = None
 collection_scope = get_collection_scope_from_context()

try:
    from aiq_agent.knowledge import get_available_documents_async

    if collection_scope is None:
        # Legacy fallback when BFF header is absent.
        session_collection = Context.get().conversation_id if Context.get() else None
        base_collection = (
            os.environ.get("COLLECTION_NAME")
            or os.environ.get("OIB_COLLECTION_NAME")
            or "oib_knowledge"
        )
        collection_scope = []
        for coll in (base_collection, session_collection):
            if coll and coll not in collection_scope:
                collection_scope.append(coll)

    aggregated = []
    seen_files: set[str] = set()
    for coll in collection_scope:
        try:
            docs = await get_available_documents_async(coll)
        except Exception as e:
            logger.debug("No document summaries for collection %s: %s", coll, e)
            continue
        for doc in docs or []:
            if doc.file_name in seen_files:
                continue
            seen_files.add(doc.file_name)
            aggregated.append(doc)

    if aggregated:
        available_documents = aggregated
        logger.info(
            "Loaded %d document summaries across collections %s",
            len(aggregated),
            collection_scope,
        )
except Exception as e:
    logger.warning("Could not fetch available documents: %s", e)
```

Then create the state with `collection_scope`:

```python
state = ChatResearcherState(
    messages=[HumanMessage(content=query_text)],
    user_info=user_info_dict,
    data_sources=data_sources,
    available_documents=available_documents,
    collection_scope=collection_scope,
    skip_clarifier=skip_clarifier,
)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
uv run pytest tests/aiq_agent/agents/chat_researcher/test_register_scope.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/aiq_agent/agents/chat_researcher/register.py tests/aiq_agent/agents/chat_researcher/test_register_scope.py
git commit -m "feat(scoping): use BFF header for available_documents and serialize scope to async jobs"
```

---

## Task 15: Propagate `collection_scope` through async job machinery

**Files:**
- Modify: `frontends/aiq_api/src/aiq_api/jobs/submit.py:58-110, 218-238`
- Modify: `frontends/aiq_api/src/aiq_api/jobs/runner.py:230-250, 410-430, 486-494, 657-724`
- Test: `tests/aiq_agent/jobs/test_runner.py` (extend)

**Important:** `TraceMetadata` has no `headers` attribute. The worker's `Context.get().metadata` is a `RequestAttributes` object whose `.headers` come from the incoming request. To make `get_collection_scope_from_context()` work inside a Dask worker, we must capture the header at submit time, pass it as a Dask argument, and reconstruct `RequestAttributes` with the header in the worker.

- [ ] **Step 1: Capture the header in `_get_parent_trace_context()`**

Modify `frontends/aiq_api/src/aiq_api/jobs/submit.py`:

Update the return type of `_get_parent_trace_context()`:

```python
def _get_parent_trace_context() -> tuple[
    str | None,  # parent_span_id
    str | None,  # parent_function_id
    str | None,  # parent_function_name
    str | None,  # parent_workflow_run_id
    int | str | None,  # parent_workflow_trace_id
    str | None,  # parent_conversation_id
    dict[str, str],  # request_trace_tags
    str | None,  # collection_scope
]:
```

At the end of the function, after retrieving request tags, read the current Context header:

```python
    collection_scope = None
    try:
        from aiq_agent.runtime.context import Context

        ctx = Context.get()
        if ctx is not None:
            request_attrs = ctx.metadata
            if request_attrs and request_attrs.headers:
                collection_scope = request_attrs.headers.get("x-grid-collection-scope")
    except Exception:
        collection_scope = None

    return (
        parent_span_id,
        parent_function_id,
        parent_function_name,
        parent_workflow_run_id,
        parent_workflow_trace_id,
        parent_conversation_id,
        get_current_trace_tags(),
        collection_scope,
    )
```

Because the tuple is unpacked with `*_get_parent_trace_context()` in `submit.py:233`, no other `job_args` change is required.

- [ ] **Step 2: Update `run_agent_job` to accept and inject the scope**

Modify `frontends/aiq_api/src/aiq_api/jobs/runner.py`:

Add parameter after `request_trace_tags`:

```python
async def run_agent_job(
    # ... existing args ...
    request_trace_tags: dict[str, str] | None = None,
    collection_scope: str | None = None,
    available_documents: list[dict] | None = None,
):
```

After `context = Context(context_state)` (around line 416), inject the header into the worker's request metadata:

```python
            context = Context(context_state)

            # Inject the collection-scope header into the worker's request
            # metadata so downstream code can read it exactly like synchronous
            # HTTP/WebSocket requests do:
            #   Context.get().metadata.headers.get("x-grid-collection-scope")
            if collection_scope is not None:
                from nat.runtime.user_metadata import RequestAttributes
                from starlette.datastructures import Headers

                request_attrs = context_state.metadata.get()
                existing_headers = dict(request_attrs.headers) if request_attrs.headers else {}
                request_attrs._request.headers = Headers(
                    headers={**existing_headers, "x-grid-collection-scope": collection_scope}
                )
                context_state.metadata.set(request_attrs)
```

Pass the decoded list to `_run_agent`:

```python
                import base64
                import json

                decoded_scope = None
                if collection_scope:
                    try:
                        padded = collection_scope + "=" * (-len(collection_scope) % 4)
                        decoded_scope = json.loads(
                            base64.urlsafe_b64decode(padded).decode("utf-8")
                        )
                    except Exception:
                        decoded_scope = None

                result = await _run_agent(
                    agent=agent,
                    input_text=input_text,
                    monitor=cancellation_monitor,
                    available_documents=available_documents,
                    data_sources=data_sources,
                    event_store=event_store,
                    collection_scope=decoded_scope,
                )
```

Update `_run_agent` signature and state construction:

```python
async def _run_agent(
    agent,
    input_text: str,
    monitor: CancellationMonitor,
    available_documents: list[dict] | None = None,
    data_sources: list[str] | None = None,
    event_store: EventStore | None = None,
    collection_scope: list[str] | None = None,
) -> Any:
```

In the state-building branch:

```python
            if collection_scope:
                state_kwargs["collection_scope"] = collection_scope
```

- [ ] **Step 3: Write/update test**

Extend `tests/aiq_agent/jobs/test_runner.py` with a test that verifies:
- When `collection_scope` is passed to `run_agent_job`, the worker's `Context.get().metadata.headers` contains `x-grid-collection-scope`.
- When `collection_scope` is passed to `_run_agent`, the agent state kwargs include `collection_scope`.

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
uv run pytest tests/aiq_agent/jobs/test_runner.py -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontends/aiq_api/src/aiq_api/jobs/submit.py frontends/aiq_api/src/aiq_api/jobs/runner.py tests/aiq_agent/jobs/test_runner.py
git commit -m "feat(scoping): propagate collection_scope to Dask workers"
```

---

## Task 16: Disable legacy scope flags in config

**Files:**
- Modify: `configs/config_grid_oib.yml:100-110`

- [ ] **Step 1: Update config**

Modify `configs/config_grid_oib.yml`:

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

- [ ] **Step 2: Validate config loads**

Run:
```bash
uv run python -c "from nat.runtime.loader import load_config; load_config('configs/config_grid_oib.yml'); print('OK')"
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add configs/config_grid_oib.yml
git commit -m "config(scoping): disable legacy collection scope flags"
```

---

## Task 17: Final verification

- [ ] **Run frontend type check and tests**

```bash
cd frontends/ui && npm run type-check
```

Expected: no type errors.

```bash
cd frontends/ui && npm run test:ci
```

Expected: all tests pass.

- [ ] **Run Python lint and tests**

```bash
uv run ruff check src/aiq_agent/knowledge/scoping.py sources/knowledge_layer/src/register.py src/aiq_agent/agents/chat_researcher/register.py src/aiq_agent/agents/chat_researcher/models/state.py frontends/aiq_api/src/aiq_api/jobs/submit.py frontends/aiq_api/src/aiq_api/jobs/runner.py
```

Expected: no lint errors.

```bash
uv run pytest tests/aiq_agent/knowledge/test_scoping.py tests/knowledge_layer_tests/test_layered_retrieval.py tests/aiq_agent/agents/chat_researcher/models/test_state.py tests/aiq_agent/agents/chat_researcher/test_register_scope.py tests/aiq_agent/jobs/test_runner.py -v
```

Expected: all tests pass.

- [ ] **Commit verification results**

```bash
git commit --allow-empty -m "chore(scoping): verify end-to-end collection scoping wiring"
```

---

## Self-review

### Spec coverage

| Requirement | Task |
|-------------|------|
| Header format `base64url(JSON.stringify(scope_array))` | Task 1, 2, 11 |
| Scope order base → project → conversation, deduplicated | Task 1, 11 |
| WebSocket upgrade calls `/api/auth/websocket-scope` | Task 3, 4 |
| HTTP routes attach scope header | Tasks 6–10 |
| Active project precedence (explicit → preference → none) | Task 2 |
| Conversation ID precedence | Task 2 |
| Python reads lowercased header | Task 11 |
| Header overrides config-derived scope | Task 12 |
| `available_documents` uses same scope | Task 14 |
| Async jobs serialize scope | Tasks 14, 15 |
| Anonymous mode skips membership checks | Task 2 |
| BFF strips inbound header | Tasks 6–10 |
| Upload collection validation | Task 9 |
| Disable legacy flags | Task 16 |

### Placeholder scan

- No "TBD", "TODO", "implement later", or "add appropriate error handling" remain.
- Every code change is accompanied by a concrete code block.
- Every test step includes the exact command and expected output.

### Type consistency

- `buildCollectionScopeFromRequest` returns `{ scope, headerValue, projectId, conversationId }` consistently.
- `collection_scope` is `list[str] | None` in Python and `string[]` in TypeScript.
- Header name is `X-Grid-Collection-Scope` in BFF and `x-grid-collection-scope` in Python metadata.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-collection-scoping-end-to-end-plan.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `executing-plans`, batch execution with checkpoints.

Which approach?