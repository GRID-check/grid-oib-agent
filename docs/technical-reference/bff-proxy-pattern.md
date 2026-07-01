# BFF (Backend-for-Frontend) Proxy Pattern

The Next.js app acts as a BFF layer between the browser and the Python FastAPI backend. Client-side code never calls the Python API directly — all requests go through Next.js API routes on the same origin.

## Why BFF

- **Avoid CORS issues**: Browser requests stay on the same origin (`localhost:3000` in dev, single domain in production).
- **Centralize auth**: The BFF resolves Grid sessions (WorkOS AuthKit) and forwards credentials as `Authorization` headers. Anonymous mode skips auth entirely.
- **Inject collection scope**: Every upstream request gets an `X-Grid-Collection-Scope` header that tells the Python backend which knowledge collections to query.
- **Normalize errors**: Authz errors from FGA are translated to `403`/`404` HTTP responses. Backend errors are wrapped in a consistent `{ error: { code, message } }` envelope.

## Pattern

Each BFF route is a `route.ts` file in `frontends/ui/src/app/api/` that exports HTTP method handlers (`GET`, `POST`, `PATCH`, `DELETE`).

### Common structure

```
import { NextResponse } from 'next/server'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { buildCollectionScopeFromRequest } from '@/lib/collection-scope-request'

export async function GET(req: Request, { params }): Promise<Response> {
  try {
    // 1. Resolve session
    const session = await resolveSession() // null in anon mode

    // 2. Build collection scope header
    const { headerValue } = await buildCollectionScopeFromRequest(session, context)

    // 3. Set auth headers
    const authHeaders = session ? { Authorization: `Bearer ${session.accessToken}` } : {}

    // 4. Proxy to backend
    const response = await fetch(backendUrl, {
      headers: { ...authHeaders, 'X-Grid-Collection-Scope': headerValue },
    })

    // 5. Handle errors / return response
    return NextResponse.json(data)
  } catch (error) {
    // Authz errors → 403/404, redirect errors re-thrown, others → 500
  }
}
```

## Auth handling

Two helpers control authentication:

| Helper | Behavior |
|--------|----------|
| `resolveSession()` | Returns `null` when `REQUIRE_AUTH=false`. Calls `requireAuthorizedSession()` when auth is required. |
| `requireAuthorizedSession()` | Reads the WorkOS session from the `idToken` cookie via `@workos-inc/authkit-nextjs`. Redirects to login if missing. |

Source: `frontends/ui/src/app/api/v1/[...path]/route.ts:84`

## Scope injection

`buildCollectionScopeFromRequest(session, { projectId?, conversationId? })` builds an ordered `X-Grid-Collection-Scope` header:

1. The base collection (e.g., `oib_knowledge`).
2. If `projectId` is set: the project's collection (`proj_{projectId}`).
3. If `conversationId` is set: the conversation's session-scoped collection (`s_{conversationId}`).

The result is a base64url-encoded JSON array sent to the backend.

Source: `frontends/ui/src/lib/collection-scope-request`

## Auth forwarding headers

When auth is required, these headers are forwarded:

| Header | Value |
|--------|-------|
| `Authorization` | `Bearer {session.accessToken}` — the WorkOS JWT |
| `X-Grid-Organization-Id` | `session.organizationId` |
| `X-Grid-User-Id` | `session.userId` |

Source: `frontends/ui/src/app/api/v1/[...path]/route.ts:175`

## Error handling

| Error type | HTTP status | Error code |
|-----------|-------------|------------|
| Authz "Not found" | `404` | `NOT_FOUND` |
| Authz "Forbidden" / "Unauthorized" | `403` | `FORBIDDEN` |
| Backend returned error | Passthrough status | `BACKEND_ERROR` |
| Proxy fetch failure | `500` | `PROXY_ERROR` |
| Next.js redirect | Re-thrown (handled by Next) | — |

Authz errors are intentionally normalized to `"Not found"` before they reach the FGA check, and `requireProjectAccess` throws `"Not found"` for both missing projects and unauthorized access (information disclosure prevention).

Source: `frontends/ui/src/app/api/v1/[...path]/route.ts:48`

## Generic proxy route

`/api/v1/[...path]` is a catch-all route that proxies all `/v1/*` Python API calls. It includes additional collection validation:

```
validateCollectionName(path, session, context):
  - path[0] === 'collections' ? required
  - collection === base collection? → 400 (uploads to base corpus not allowed)
  - collection starts with 'proj_'? → requireProjectAccess(session, id, 'project:edit')
  - collection starts with 's_'? → verify matches conversationId
  - else → 400 INVALID_COLLECTION
```

Source: `frontends/ui/src/app/api/v1/[...path]/route.ts:119`

## Streaming routes

Chat and generation routes (`/api/chat`, `/api/generate`, `/api/generate/respond`, `/api/jobs/async/[...path]`) proxy SSE streams without buffering:

```typescript
return new NextResponse(response.body, {
  headers: {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  },
})
```

The `response.body` (a `ReadableStream`) is passed directly to `NextResponse` — no buffering. The backend's SSE events flow through unchanged. Streaming routes also support query-token auth for EventSource connections that cannot set custom headers (used by SSE reconnection from the frontend).

Source: `frontends/ui/src/app/api/chat/route.ts:117`, `frontends/ui/src/app/api/jobs/async/[...path]/route.ts:182`

## WebSocket proxy

WebSocket connections are proxied at the gateway level (`server.js`), not through Next.js API routes. The upgrade handler calls `GET /api/auth/websocket-scope` internally to resolve the collection scope and auth headers, then forwards them to the backend WebSocket via `backendProxy.ws()`.

Source: `docs/technical-reference/websocket-gateway.md`
